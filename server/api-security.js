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

// Bring-your-own-key access: a visitor with only a Groq key may use these routes.
// Their key is forwarded to Groq's official API and nowhere else (see
// getRequestProviderApiKey in index.js); server-held provider keys, desktop
// control, TTS, calls, feedback and sync still require the operator token.
// Paths are relative to the /api or /v1 mount.
const BYOK_PATHS = new Set(["/agent", "/chat", "/models", "/providers", "/catalog", "/chat/completions", "/usage", "/orchestrate", "/voice/transcribe", "/voice/speak", "/voice/providers", "/vision/describe", "/a2a", "/route/preview"]);
// Open to everyone: sign-in itself and the database status the app needs before sign-in.
// The calendar/email sign-in callbacks are opened by Google or Microsoft; the single-use state identifies the user.
const PUBLIC_PATHS = new Set(["/health", "/presence", "/account/status", "/account/register", "/account/login", "/account/logout", "/db/status", "/a2a/agent-card", "/account/connections/google/callback", "/account/connections/microsoft/callback", "/workflows/catalog", "/workflows/tick"]);
// Workflow webhooks are called by other services. Each one authenticates
// itself (a secret token or an HMAC signature) in server/workflows/router.js;
// the cron tick checks CRON_SECRET. Nothing else under these paths is public.
const PUBLIC_PREFIXES = ["/hooks/"];
function isPublic(path) {
  return PUBLIC_PATHS.has(path) || PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix));
}
// A signed-in account (session or developer API key) may use the model routes
// plus its own account and sync routes. Operator-only routes stay closed.
function accountMayUse(path) {
  return BYOK_PATHS.has(path) || path === "/sync/memory" || path === "/account" || path.startsWith("/account/")
    || path === "/workflows" || path.startsWith("/workflows/") || path === "/notifications" || path.startsWith("/notifications/")
    || path.startsWith("/phone/");
}
const GROQ_KEY_PATTERN = /^gsk_[A-Za-z0-9]{20,200}$/;

function isGroqKey(value) {
  return typeof value === "string" && GROQ_KEY_PATTERN.test(value.trim());
}

function assertProductionApiToken() {
  // An unset token is allowed: the server then serves bring-your-own-key
  // visitors only. A token that is set but too weak is a misconfiguration.
  if (process.env.NODE_ENV === "production" && configuredToken && !configuredTokenIsValid) {
    throw new Error("HANNAH_API_TOKEN (or the legacy SHANAYA_API_TOKEN) must be 32–512 characters without line breaks.");
  }
  if (process.env.NODE_ENV === "production" && !configuredToken) {
    console.warn("HANNAH_API_TOKEN is not set: only visitors with their own Groq key can use this server.");
  }
}

function requireApiToken(req, res, next) {
  if (isPublic(req.path)) return next();
  if (res.locals.hannahAccount) {
    if (accountMayUse(req.path)) return next();
    return res.status(403).json({ error: "This needs the server operator's access token.", reason: "operator-only" });
  }
  if (res.locals.hannahAccountInvalid) {
    res.setHeader("WWW-Authenticate", "Bearer");
    return res.status(401).json({ error: res.locals.hannahAccountInvalid, reason: "session-invalid" });
  }

  const authorization = req.get("authorization") || "";
  if (!authorization) {
    const visitorKey = req.get("x-groq-api-key")?.trim();
    if (BYOK_PATHS.has(req.path) && isGroqKey(visitorKey)) {
      res.locals.hannahByok = true;
      res.locals.hannahApiTokenId = `byok:${createHash("sha256").update(visitorKey).digest("hex")}`;
      return next();
    }
  }

  if (!configuredTokenIsValid || !configuredTokenDigest) {
    if (!authorization) {
      return res.status(401).json({ error: "Add your Groq API key to use HANNAH.", reason: "byok-required" });
    }
    return res.status(503).json({ error: "API authentication is not configured on this server." });
  }

  if (!authorization) {
    res.setHeader("WWW-Authenticate", "Bearer");
    return res.status(401).json({ error: "Add your Groq API key or a HANNAH access token.", reason: "credentials-required" });
  }
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
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
  accountMayUse,
  assertProductionApiToken,
  BYOK_PATHS,
  createRateLimiter,
  isGroqKey,
  rateLimitSettings,
  requireApiToken,
};
