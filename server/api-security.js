const { createHash, timingSafeEqual } = require("node:crypto");

const MIN_TOKEN_LENGTH = 32;
const MAX_TOKEN_LENGTH = 512;
const configuredToken = typeof process.env.SHANAYA_API_TOKEN === "string"
  ? process.env.SHANAYA_API_TOKEN.trim()
  : "";
const configuredTokenIsValid = configuredToken.length >= MIN_TOKEN_LENGTH
  && configuredToken.length <= MAX_TOKEN_LENGTH
  && !/[\r\n]/.test(configuredToken);
const configuredTokenDigest = configuredTokenIsValid
  ? createHash("sha256").update(configuredToken).digest()
  : null;

function assertProductionApiToken() {
  if (process.env.NODE_ENV === "production" && !configuredTokenIsValid) {
    throw new Error("Set SHANAYA_API_TOKEN to a random value of at least 32 characters before starting Shanaya in production.");
  }
}

function requireApiToken(req, res, next) {
  if (req.path === "/health") return next();
  if (!configuredTokenIsValid || !configuredTokenDigest) {
    return res.status(503).json({ error: "API authentication is not configured on this server." });
  }

  const match = /^Bearer\s+([^\s]+)$/i.exec(req.get("authorization") || "");
  if (!match || match[1].length > MAX_TOKEN_LENGTH) {
    res.setHeader("WWW-Authenticate", "Bearer");
    return res.status(401).json({ error: "A valid Shanaya API bearer token is required." });
  }

  const candidateDigest = createHash("sha256").update(match[1]).digest();
  if (!timingSafeEqual(candidateDigest, configuredTokenDigest)) {
    res.setHeader("WWW-Authenticate", "Bearer");
    return res.status(401).json({ error: "A valid Shanaya API bearer token is required." });
  }

  res.locals.shanayaApiTokenId = candidateDigest.toString("hex");
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
    const tokenId = res.locals.shanayaApiTokenId;
    if (!tokenId) return res.status(401).json({ error: "A valid Shanaya API bearer token is required." });

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
      return res.status(429).json({ error: "The Shanaya API rate limit was reached. Try again later." });
    }

    bucket.count += 1;
    res.setHeader("RateLimit-Remaining", String(Math.max(0, limit - bucket.count)));
    return next();
  };
}

function rateLimitSettings() {
  const windowMs = positiveInteger(process.env.SHANAYA_RATE_LIMIT_WINDOW_MS, 60_000, 3_600_000);
  return {
    chat: { limit: positiveInteger(process.env.SHANAYA_RATE_LIMIT_CHAT_MAX, 30, 100_000), windowMs },
    agent: { limit: positiveInteger(process.env.SHANAYA_RATE_LIMIT_AGENT_MAX, 60, 100_000), windowMs },
    desktop: { limit: positiveInteger(process.env.SHANAYA_RATE_LIMIT_DESKTOP_MAX, 20, 100_000), windowMs },
    feedback: { limit: positiveInteger(process.env.SHANAYA_RATE_LIMIT_FEEDBACK_MAX, 10, 100_000), windowMs },
    contentReport: { limit: positiveInteger(process.env.SHANAYA_RATE_LIMIT_CONTENT_REPORT_MAX, 10, 100_000), windowMs },
  };
}

module.exports = {
  assertProductionApiToken,
  createRateLimiter,
  rateLimitSettings,
  requireApiToken,
};
