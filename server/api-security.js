const { createHash, timingSafeEqual } = require("node:crypto");

const MIN_TOKEN_LENGTH = 32;
const MAX_TOKEN_LENGTH = 512;
// SHANAYA_API_TOKEN is the pre-rename variable name; keep accepting it so
// existing deployments do not fail closed after the HANNAH rename.
const rawConfiguredToken = process.env.HANNAH_API_TOKEN || process.env.SHANAYA_API_TOKEN;
const configuredToken = typeof rawConfiguredToken === "string"
  ? rawConfiguredToken.trim()
  : "";
const configuredTokenIsValid = configuredToken.length >= MIN_TOKEN_LENGTH
  && configuredToken.length <= MAX_TOKEN_LENGTH
  && !/[\r\n]/.test(configuredToken);
const configuredTokenDigest = configuredTokenIsValid
  ? createHash("sha256").update(configuredToken).digest()
  : null;

function assertProductionApiToken() {
  if (process.env.NODE_ENV === "production" && !configuredTokenIsValid) {
    throw new Error("Set HANNAH_API_TOKEN (or the legacy SHANAYA_API_TOKEN) to a random value of at least 32 characters before starting HANNAH in production.");
  }
}

function requireApiToken(req, res, next) {
  if (req.path === "/health" || req.path === "/presence") return next();
  if (!configuredTokenIsValid || !configuredTokenDigest) {
    return res.status(503).json({ error: "API authentication is not configured on this server." });
  }

  const match = /^Bearer\s+([^\s]+)$/i.exec(req.get("authorization") || "");
  if (!match || match[1].length > MAX_TOKEN_LENGTH) {
    res.setHeader("WWW-Authenticate", "Bearer");
    return res.status(401).json({ error: "A valid HANNAH API bearer token is required." });
  }

  const candidateDigest = createHash("sha256").update(match[1]).digest();
  if (!timingSafeEqual(candidateDigest, configuredTokenDigest)) {
    res.setHeader("WWW-Authenticate", "Bearer");
    return res.status(401).json({ error: "A valid HANNAH API bearer token is required." });
  }

  res.locals.hannahApiTokenId = candidateDigest.toString("hex");
  return next();
}

function positiveInteger(value, fallback, maximum) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : fallback;
}

function createRateLimiter({ limit, windowMs }) {
  const buckets = new Map();
  const maxBuckets = 10_000;

  return function rateLimitByApiToken(_req, res, next) {
    const tokenId = res.locals.hannahApiTokenId;
    if (!tokenId) return res.status(401).json({ error: "A valid HANNAH API bearer token is required." });

    const now = Date.now();
    let bucket = buckets.get(tokenId);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(tokenId, bucket);
    }

    if (buckets.size > maxBuckets) {
      for (const [key, item] of buckets) {
        if (now >= item.resetAt) buckets.delete(key);
      }
    }

    res.setHeader("RateLimit-Limit", String(limit));
    res.setHeader("RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count >= limit) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader("RateLimit-Remaining", "0");
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({ error: "The HANNAH API rate limit was reached. Try again later." });
    }

    bucket.count += 1;
    res.setHeader("RateLimit-Remaining", String(Math.max(0, limit - bucket.count)));
    return next();
  };
}

function rateLimitSettings() {
  const windowMs = positiveInteger(process.env.HANNAH_RATE_LIMIT_WINDOW_MS, 60_000, 3_600_000);
  return {
    chat: { limit: positiveInteger(process.env.HANNAH_RATE_LIMIT_CHAT_MAX, 30, 100_000), windowMs },
    agent: { limit: positiveInteger(process.env.HANNAH_RATE_LIMIT_AGENT_MAX, 60, 100_000), windowMs },
    desktop: { limit: positiveInteger(process.env.HANNAH_RATE_LIMIT_DESKTOP_MAX, 20, 100_000), windowMs },
    feedback: { limit: positiveInteger(process.env.HANNAH_RATE_LIMIT_FEEDBACK_MAX, 10, 100_000), windowMs },
    contentReport: { limit: positiveInteger(process.env.HANNAH_RATE_LIMIT_CONTENT_REPORT_MAX, 10, 100_000), windowMs },
    events: { limit: positiveInteger(process.env.HANNAH_RATE_LIMIT_EVENTS_MAX, 60, 100_000), windowMs },
  };
}

module.exports = {
  assertProductionApiToken,
  createRateLimiter,
  rateLimitSettings,
  requireApiToken,
};
