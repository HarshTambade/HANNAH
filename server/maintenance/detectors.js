"use strict";

/**
 * Anomaly detectors for predictive maintenance. Pure functions over numbers;
 * no I/O, no clock, no randomness except the seeded generator the isolation
 * forest is given, so a run can be repeated exactly.
 *
 * What each one answers, and what it doesn't:
 *
 *   threshold      a value crossed a fixed limit (a generic default or one a
 *                  person configured). It says nothing about why.
 *   robustZ        a value is far from the baseline's median, measured in
 *                  MADs (robust to the outliers a plain standard deviation
 *                  would absorb). Point anomalies: spikes and dips.
 *   ewma           an exponentially weighted moving average left the
 *                  baseline's control limits: a sustained shift that single
 *                  points are too noisy to show.
 *   trend          Theil-Sen slope with a Mann-Kendall significance test: the
 *                  measurement is drifting in one direction. A slope is not a
 *                  failure date, and none is derived from it.
 *   seasonal       compares each value with the baseline for its hour of the
 *                  day, so a robot that is always warm at 14:00 isn't flagged
 *                  at 14:00 but is flagged when it is that warm at 03:00.
 *   rateChange     an event count (link losses, failed missions) is higher
 *                  than the baseline rate (Poisson test on counts per exposure).
 *   isolationForest an unsupervised model over several metrics together
 *                  (Liu, Ting & Zhou 2008). It scores how easily a point is
 *                  isolated; it can't name a cause.
 *
 * Every detector returns measurements and statistics only. Labelling a result
 * as a suspected cause or a confirmed fault happens elsewhere, under stricter
 * rules (see service.js).
 */

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const round = (value, digits = 3) => (finite(value) ? Number(value.toFixed(digits)) : null);

// ---------- statistics ----------
function mean(values) {
  if (!values.length) return null;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}
function std(values, mu = mean(values)) {
  if (values.length < 2) return null;
  let sum = 0;
  for (const value of values) sum += (value - mu) ** 2;
  return Math.sqrt(sum / (values.length - 1));
}
function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}
const median = (values) => quantile(values, 0.5);
/** Median absolute deviation, unscaled. */
function mad(values, center = median(values)) {
  if (!values.length) return null;
  return median(values.map((value) => Math.abs(value - center)));
}
/** A robust scale estimate: 1.4826 × MAD, falling back to the scaled mean absolute deviation when half the values are identical. */
function robustScale(values, center = median(values)) {
  const m = mad(values, center);
  if (m === null) return null;
  if (m > 0) return 1.4826 * m;
  const meanAbs = mean(values.map((value) => Math.abs(value - center)));
  return meanAbs > 0 ? 1.2533 * meanAbs : 0;
}

/** Standard normal cumulative distribution (Abramowitz & Stegun 26.2.17, error < 7.5e-8). */
function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const tail = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - tail : tail;
}

/** Baseline statistics for a series of values (bucket means). */
function baselineOf(values) {
  const clean = values.filter(finite);
  if (!clean.length) return { n: 0 };
  const mu = mean(clean);
  const center = median(clean);
  return { n: clean.length, mean: mu, std: std(clean, mu), median: center, scale: robustScale(clean, center), p05: quantile(clean, 0.05), p95: quantile(clean, 0.95), min: Math.min(...clean), max: Math.max(...clean) };
}

// ---------- smoothing ----------
function movingAverage(values, window) {
  const out = [];
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index];
    if (index >= window) sum -= values[index - window];
    out.push(index >= window - 1 ? sum / window : null);
  }
  return out;
}
function ewmaSeries(values, lambda = 0.2, start = values[0]) {
  const out = [];
  let level = start;
  for (const value of values) {
    level = lambda * value + (1 - lambda) * level;
    out.push(level);
  }
  return out;
}

// ---------- detectors ----------
/** points: [{ at, value }]. limits: { warn?, critical?, direction: "above" | "below" }. */
function threshold(points, { warn = null, critical = null, direction = "above" } = {}) {
  const over = (value, limit) => finite(limit) && (direction === "below" ? value < limit : value > limit);
  const hits = [];
  for (const point of points) {
    const level = over(point.value, critical) ? "critical" : over(point.value, warn) ? "warn" : null;
    if (level) hits.push({ at: point.at, value: point.value, level, limit: level === "critical" ? critical : warn });
  }
  return hits;
}

/** Points more than `limit` robust standard deviations from the baseline median. Iglewicz & Hoaglin suggest 3.5. */
function robustZ(points, baseline, { limit = 3.5 } = {}) {
  if (!baseline || !finite(baseline.median) || !(baseline.scale > 0)) return [];
  const hits = [];
  for (const point of points) {
    const z = (point.value - baseline.median) / baseline.scale;
    if (Math.abs(z) > limit) hits.push({ at: point.at, value: point.value, z: round(z, 2) });
  }
  return hits;
}

/**
 * EWMA control chart (Roberts 1959). Steady-state limits
 * mean ± L·σ·sqrt(λ/(2−λ)). Returns the points where the average is outside,
 * and the first of them (where the shift was first seen).
 */
function ewma(points, baseline, { lambda = 0.2, L = 3.5, minRun = 4 } = {}) {
  if (!baseline || !finite(baseline.mean) || !(baseline.std > 0) || !points.length) return { shifted: false, hits: [] };
  const width = L * baseline.std * Math.sqrt(lambda / (2 - lambda));
  const levels = ewmaSeries(points.map((point) => point.value), lambda, baseline.mean);
  const hits = [];
  levels.forEach((level, index) => {
    if (Math.abs(level - baseline.mean) > width) hits.push({ at: points[index].at, value: points[index].value, ewma: round(level, 4), direction: level > baseline.mean ? "up" : "down" });
  });
  // A shift is a run of consecutive out-of-limit averages, not a single excursion.
  let run = 0;
  let longest = 0;
  levels.forEach((level) => { run = Math.abs(level - baseline.mean) > width ? run + 1 : 0; longest = Math.max(longest, run); });
  return { shifted: longest >= minRun, hits, upper: round(baseline.mean + width, 4), lower: round(baseline.mean - width, 4), last: round(levels[levels.length - 1], 4) };
}

/** Theil-Sen slope (median of pairwise slopes), per millisecond. O(n²); callers pass at most a few hundred points. */
function theilSen(points) {
  const slopes = [];
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const dt = points[j].at - points[i].at;
      if (dt !== 0) slopes.push((points[j].value - points[i].value) / dt);
    }
  }
  if (!slopes.length) return null;
  const slope = median(slopes);
  const intercept = median(points.map((point) => point.value - slope * point.at));
  return { slope, intercept };
}

/** Mann-Kendall trend test with the normal approximation (no tie correction beyond dropping equal pairs). */
function mannKendall(values) {
  const n = values.length;
  if (n < 4) return { s: 0, z: 0, p: 1 };
  let s = 0;
  for (let i = 0; i < n - 1; i += 1) for (let j = i + 1; j < n; j += 1) s += Math.sign(values[j] - values[i]);
  const variance = (n * (n - 1) * (2 * n + 5)) / 18;
  const z = s > 0 ? (s - 1) / Math.sqrt(variance) : s < 0 ? (s + 1) / Math.sqrt(variance) : 0;
  const p = 2 * (1 - normalCdf(Math.abs(z)));
  return { s, z, p };
}

/**
 * A monotonic trend: significant by Mann-Kendall at `alpha` AND large enough
 * to matter (the fitted change over the window is at least `minChange`, in
 * the metric's units, or `minRelative` of the baseline's spread).
 */
function trend(points, { alpha = 0.01, minPoints = 12, minChange = 0, minRelative = 1, spread = null } = {}) {
  if (points.length < minPoints) return { trending: false, reason: "not enough points", n: points.length };
  const fit = theilSen(points);
  const test = mannKendall(points.map((point) => point.value));
  if (!fit) return { trending: false, reason: "no time span", n: points.length };
  const spanMs = points[points.length - 1].at - points[0].at;
  const change = fit.slope * spanMs;
  const big = Math.abs(change) >= Math.max(minChange, finite(spread) ? minRelative * spread : 0);
  return { trending: test.p < alpha && big, direction: change > 0 ? "up" : change < 0 ? "down" : "flat", slopePerDay: round(fit.slope * 86_400_000, 4), changeOverWindow: round(change, 4), spanDays: round(spanMs / 86_400_000, 2), z: round(test.z, 2), p: round(test.p, 6), n: points.length };
}

/** Hour-of-day profile: for each hour (0–23, UTC), the median and robust scale of the values recorded in it. */
function seasonalProfile(points, { minPerHour = 4 } = {}) {
  const byHour = Array.from({ length: 24 }, () => []);
  for (const point of points) byHour[new Date(point.at).getUTCHours()].push(point.value);
  const profile = {};
  byHour.forEach((values, hour) => {
    if (values.length >= minPerHour) {
      const center = median(values);
      profile[hour] = { median: center, scale: robustScale(values, center), n: values.length };
    }
  });
  // The noise once each hour's own level is taken out, pooled over all hours. A single hour's spread,
  // from a few dozen values, can come out far too small by chance; it is never trusted below this.
  const residuals = [];
  byHour.forEach((values, hour) => { if (profile[hour]) for (const value of values) residuals.push(value - profile[hour].median); });
  Object.defineProperty(profile, "pooledScale", { value: residuals.length ? robustScale(residuals, 0) : null, enumerable: false });
  return profile;
}
/** Points far from their own hour's baseline. Hours without enough history are skipped, not guessed. */
function seasonal(points, profile, { limit = 4, floor = 0 } = {}) {
  const hits = [];
  for (const point of points) {
    const hour = profile?.[new Date(point.at).getUTCHours()];
    if (!hour) continue;
    const scale = Math.max(hour.scale || 0, floor, 0.8 * (profile.pooledScale || 0));
    if (!(scale > 0)) continue;
    const z = (point.value - hour.median) / scale;
    if (Math.abs(z) > limit) hits.push({ at: point.at, value: point.value, z: round(z, 2), hour: new Date(point.at).getUTCHours(), hourMedian: round(hour.median, 3) });
  }
  return hits;
}

/**
 * Is the recent event rate higher than the baseline rate? One-sided test on
 * a Poisson count: z = (k − λ) / √λ with λ = baseline rate × recent exposure,
 * with a continuity correction. Small expected counts need a large excess.
 */
function rateChange({ recentCount, recentExposure, baseCount, baseExposure }, { alpha = 0.01, minCount = 3 } = {}) {
  if (!(recentExposure > 0) || !(baseExposure > 0)) return { raised: false, reason: "no exposure" };
  const baseRate = (baseCount + 0.5) / baseExposure; // +0.5: a clean history is not a rate of exactly zero
  const expected = baseRate * recentExposure;
  const z = (recentCount - expected - 0.5) / Math.sqrt(expected);
  const p = 1 - normalCdf(z);
  return { raised: recentCount >= minCount && p < alpha, recentRate: round(recentCount / recentExposure, 4), baseRate: round(baseCount / baseExposure, 4), expected: round(expected, 2), z: round(z, 2), p: round(p, 6) };
}

// ---------- isolation forest ----------
/** Mulberry32: a small seeded generator, so a model fitted twice on the same data is the same model. */
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Average path length of an unsuccessful search in a binary search tree of n points (the normaliser c(n)). */
function averagePath(n) {
  if (n <= 1) return 0;
  if (n === 2) return 1;
  return 2 * (Math.log(n - 1) + 0.5772156649) - (2 * (n - 1)) / n;
}

/**
 * Fit an isolation forest. vectors: number[][] (same length each). Features
 * are standardised with the training median and robust scale so one metric's
 * units don't dominate. Returns { score(vector) → 0..1, threshold } where
 * the threshold is the training scores' `1 − contamination` quantile.
 */
function isolationForest(vectors, { trees = 100, sampleSize = 128, seed = 42, contamination = 0.01 } = {}) {
  const rows = vectors.filter((vector) => Array.isArray(vector) && vector.every(finite));
  if (rows.length < 16) return null;
  const dims = rows[0].length;
  const centers = [];
  const scales = [];
  for (let d = 0; d < dims; d += 1) {
    const column = rows.map((row) => row[d]);
    const center = median(column);
    centers.push(center);
    scales.push(robustScale(column, center) || std(column) || 1);
  }
  const norm = (vector) => vector.map((value, d) => (value - centers[d]) / scales[d]);
  const data = rows.map(norm);
  const random = seeded(seed);
  const size = Math.min(sampleSize, data.length);
  const limit = Math.ceil(Math.log2(size));
  const build = (points, depth) => {
    if (depth >= limit || points.length <= 1) return { size: points.length };
    const d = Math.floor(random() * dims);
    let low = Infinity;
    let high = -Infinity;
    for (const point of points) { if (point[d] < low) low = point[d]; if (point[d] > high) high = point[d]; }
    if (low === high) return { size: points.length };
    const split = low + random() * (high - low);
    const left = [];
    const right = [];
    for (const point of points) (point[d] < split ? left : right).push(point);
    return { d, split, left: build(left, depth + 1), right: build(right, depth + 1) };
  };
  const forest = [];
  for (let t = 0; t < trees; t += 1) {
    const sample = [];
    for (let i = 0; i < size; i += 1) sample.push(data[Math.floor(random() * data.length)]);
    forest.push(build(sample, 0));
  }
  const pathLength = (node, point, depth) => (node.left ? pathLength(point[node.d] < node.split ? node.left : node.right, point, depth + 1) : depth + averagePath(node.size));
  const normaliser = averagePath(size);
  const scoreNormalised = (point) => {
    let total = 0;
    for (const tree of forest) total += pathLength(tree, point, 0);
    return 2 ** (-(total / forest.length) / normaliser);
  };
  const trainingScores = data.map(scoreNormalised);
  const cut = quantile(trainingScores, 1 - contamination);
  return { score: (vector) => scoreNormalised(norm(vector)), threshold: Math.max(cut, 0.5), dims, trained: rows.length };
}

// ---------- evaluation (used by tests and shown with detector results) ----------
/** Precision and recall of detected indexes against the known anomalous ones, allowing `tolerance` positions of slack. */
function precisionRecall(detected, truth, { tolerance = 0 } = {}) {
  const truthList = [...new Set(truth)];
  const found = [...new Set(detected)];
  const near = (a, b) => Math.abs(a - b) <= tolerance;
  const tp = found.filter((index) => truthList.some((t) => near(index, t))).length;
  const hit = truthList.filter((t) => found.some((index) => near(index, t))).length;
  return { tp, fp: found.length - tp, fn: truthList.length - hit, precision: found.length ? tp / found.length : truthList.length ? 0 : 1, recall: truthList.length ? hit / truthList.length : 1 };
}

module.exports = {
  baselineOf, ewma, ewmaSeries, finite, isolationForest, mad, mannKendall, mean, median, movingAverage, normalCdf, precisionRecall,
  quantile, rateChange, robustScale, robustZ, round, seasonal, seasonalProfile, seeded, std, theilSen, threshold, trend,
};
