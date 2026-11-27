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
// control, TTS, calls and sync still require the operator token.
// Paths are relative to the /api or /v1 mount.
// Feedback, AI content reports and usage events are open to anyone using the
// app (validated, stored without account ids, and limited per network address
// as well as per credential, since a visitor's key isn't checked on these
// routes): app stores require in-app reporting of AI replies for everyone.
const BYOK_PATHS = new Set(["/feedback", "/report-content", "/events", "/agent", "/chat", "/models", "/providers", "/catalog", "/chat/completions", "/usage", "/orchestrate", "/voice/transcribe", "/voice/speak", "/voice/providers", "/vision/describe", "/a2a", "/route/preview", "/connectors/discover", "/connectors/register", "/connectors/token", "/connectors/rpc", "/web/search", "/web/read", "/research", "/documents/compose", "/documents/create", "/documents/read", "/documents/convert", "/setup/hosting/discover", "/setup/hosting/database", "/setup/hosting/status", "/setup/hosting/finish"]);
// Open without any credential, for the directory's own connectors only:
// connecting Notion or Linear doesn't use an AI model, so it shouldn't need an
// AI key. server/connectors.js refuses a guest any address outside its catalog,
// so these routes can't be used as a relay to arbitrary servers, and guests
// have their own, lower, per-address limit there.
const GUEST_PATHS = new Set(["/connectors/discover", "/connectors/register", "/connectors/token", "/connectors/rpc"]);
// Open to everyone: sign-in itself and the database status the app needs before sign-in.
// The calendar/email sign-in callbacks are opened by Google or Microsoft; the single-use state identifies the user.
const PUBLIC_PATHS = new Set(["/health", "/presence", "/account/status", "/account/register", "/account/login", "/account/logout", "/db/status", "/a2a/agent-card", "/account/connections/google/callback", "/account/connections/microsoft/callback", "/workflows/catalog", "/workflows/tick", "/workforce/tick", "/session/key", "/connectors/catalog"]);
// Workflow webhooks are called by other services. Each one authenticates
// itself (a secret token or an HMAC signature) in server/workflows/router.js;
// the cron tick checks CRON_SECRET. Nothing else under these paths is public.
// A robot's own endpoints: enrollment is proven by a one-time code, every sync
// by the robot's signature (server/robotics/service.js). No account session.
// A device hub's endpoints work the same way (server/devices/service.js).
// A Robot OS bridge envelope authenticates itself with its own HMAC signature
// (server/robotics/robot_os_auth.js); the router is opt-in and returns 404 when disabled.
const PUBLIC_PREFIXES = ["/hooks/", "/robots/device/", "/hubs/device/", "/robotos/"];
const ROBOT_ENROLL_PATH = "/robots/enroll";
const HUB_ENROLL_PATH = "/hubs/enroll";
function isPublic(path) {
  return PUBLIC_PATHS.has(path) || path === ROBOT_ENROLL_PATH || path === HUB_ENROLL_PATH || PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix));
}
// A signed-in account (session or developer API key) may use the model routes
// plus its own account and sync routes. Operator-only routes stay closed.
function accountMayUse(path) {
  return BYOK_PATHS.has(path) || path === "/sync/memory" || path === "/account" || path.startsWith("/account/")
    || path === "/workflows" || path.startsWith("/workflows/") || path === "/notifications" || path.startsWith("/notifications/")
    || path.startsWith("/phone/") || path.startsWith("/connectors/") || path.startsWith("/web/") || path.startsWith("/setup/hosting/") || path === "/channels" || path.startsWith("/channels/")
    // The Action Engine and the coding service: an account's own actions, permissions, repositories and tasks.
    || path === "/actions" || path.startsWith("/actions/") || path.startsWith("/coding/")
    // An account's own robots, their missions and telemetry.
    || path === "/robots" || path.startsWith("/robots/")
    // An account's own hubs, the devices behind them and their automations.
    || path === "/hubs" || path.startsWith("/hubs/") || path === "/devices" || path.startsWith("/devices/") || path === "/inventory"
    // The AI workforce: teammates, computers, tasks, skills, routines, vault and approvals.
    || path === "/workforce" || path.startsWith("/workforce/");
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
  if (!authorization && (req.path === "/workforce" || req.path.startsWith("/workforce/"))) {
    res.setHeader("WWW-Authenticate", "Bearer");
    return res.status(401).json({
      error: "Sign in or create a HANNAH account to use AI Workforce. A Groq key alone can connect for chat.",
      reason: "signin-required",
    });
  }
  if (!authorization) {
    const visitorKey = req.get("x-groq-api-key")?.trim();
    if (BYOK_PATHS.has(req.path) && isGroqKey(visitorKey)) {
      res.locals.hannahByok = true;
      res.locals.hannahApiTokenId = `byok:${createHash("sha256").update(visitorKey).digest("hex")}`;
      return next();
    }
    if (GUEST_PATHS.has(req.path)) {
      res.locals.hannahGuest = true;
      res.locals.hannahApiTokenId = `guest:${createHash("sha256").update(addressKey(clientAddress(req))).digest("hex")}`;
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

const net = require("node:net");

/** Loopback, private and link-local addresses: where a reverse proxy in front of HANNAH connects from. */
function isPrivateAddress(address) {
  const value = String(address || "").replace(/^::ffff:/, "");
  if (net.isIPv4(value)) {
    const [a, b] = value.split(".").map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return value === "::1" || /^f[cd][0-9a-f]{2}:/i.test(value) || /^fe80:/i.test(value);
}

/** One key per client: IPv4 as is, IPv6 by its /64 network (one household or device gets a whole /64). */
function addressKey(address) {
  const value = String(address || "unknown").replace(/^::ffff:/, "");
  if (!net.isIPv6(value)) return value;
  const [head] = value.split("::");
  const groups = head.split(":").filter(Boolean);
  // A "::" in the first four groups means the rest of the /64 is zeros.
  const full = value.includes("::") && groups.length < 4 ? [...groups, ...Array(4 - groups.length).fill("0")] : value.split(":");
  return `${full.slice(0, 4).map((group) => group.toLowerCase().replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/**
 * The caller's network address for rate limiting:
 * - on Vercel, x-real-ip, which Vercel's edge sets (a client can't forge it);
 * - behind a reverse proxy on this machine or a private network (Docker with
 *   Caddy or nginx), the first X-Forwarded-For entry; also anywhere when
 *   HANNAH_TRUST_PROXY=true says a trusted proxy always sets it;
 * - otherwise the connection's own address. A forged X-Forwarded-For from
 *   the internet changes nothing.
 */
function clientAddress(req) {
  if (process.env.VERCEL && req.get("x-real-ip")) return String(req.get("x-real-ip")).trim();
  const peer = req.socket?.remoteAddress || "unknown";
  const trustForwarded = String(process.env.HANNAH_TRUST_PROXY || "").toLowerCase() === "true" || isPrivateAddress(peer);
  if (trustForwarded) {
    const forwarded = String(req.get("x-forwarded-for") || "").split(",")[0].trim();
    if (forwarded && net.isIP(forwarded.replace(/^::ffff:/, ""))) return forwarded;
  }
  return peer;
}

/** One shared count in the database: an atomic upsert per request. Returns { count, resetAt }. */
async function countInDatabase(db, key, windowMs, now) {
  await db.query(
    `INSERT INTO hannah_rate_limits (key, count, reset_at) VALUES ($1, 1, $2)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN hannah_rate_limits.reset_at <= $3 THEN 1 ELSE hannah_rate_limits.count + 1 END,
       reset_at = CASE WHEN hannah_rate_limits.reset_at <= $3 THEN excluded.reset_at ELSE hannah_rate_limits.reset_at END`,
    [key, now + windowMs, now],
  );
  const { rows: [row] } = await db.query("SELECT count, reset_at FROM hannah_rate_limits WHERE key = $1", [key]);
  // Now and then, clear finished windows so the table stays small.
  if (Math.random() < 0.01) await db.query("DELETE FROM hannah_rate_limits WHERE reset_at <= $1", [now]).catch(() => {});
  return { count: Number(row?.count) || 1, resetAt: Number(row?.reset_at) || now + windowMs };
}

/**
 * A limit per network address, for public write routes where credentials can
 * be made up.
 * - On a serverless host with a database (Vercel), the count is shared in the
 *   database, so every instance enforces the same limit. If the database
 *   errors, this request is counted in memory instead.
 * - Otherwise it's kept in this process's memory (one long-running server).
 */
function createAddressRateLimiter({ limit, windowMs, maxBuckets = 10_000, name = "address", shared = () => Boolean(process.env.VERCEL) && require("./db").databaseConfigured(), database = () => require("./db").getDatabase() }) {
  const buckets = new Map();
  const inMemory = (key, now) => {
    let bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.delete(key);
      buckets.set(key, bucket);
    }
    if (buckets.size > maxBuckets) {
      // Drop expired ones; if that isn't enough, the oldest (a Map keeps insertion order), so the next request doesn't scan again.
      for (const [address, item] of buckets) if (now >= item.resetAt) buckets.delete(address);
      for (const address of buckets.keys()) {
        if (buckets.size <= maxBuckets * 0.9) break;
        if (address !== key) buckets.delete(address);
      }
    }
    if (bucket.count < limit) bucket.count += 1;
    else return { count: limit + 1, resetAt: bucket.resetAt };
    return bucket;
  };
  return async function rateLimitByAddress(req, res, next) {
    const now = Date.now();
    const key = addressKey(clientAddress(req));
    let counted;
    if (shared()) {
      try {
        counted = await countInDatabase(await database(), `${name}:${key}`, windowMs, now);
      } catch {
        counted = null;
      }
    }
    counted ??= inMemory(key, now);
    if (counted.count > limit) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((counted.resetAt - now) / 1000))));
      return res.status(429).json({ error: "Too many requests from this network. Try again later." });
    }
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
    // Per network address, per 15 minutes (see createAddressRateLimiter).
    feedbackPerAddress: { limit: positiveInteger(process.env.HANNAH_RATE_LIMIT_FEEDBACK_PER_ADDRESS, 20, 100_000), windowMs: 15 * 60_000 },
    contentReportPerAddress: { limit: positiveInteger(process.env.HANNAH_RATE_LIMIT_CONTENT_REPORT_PER_ADDRESS, 30, 100_000), windowMs: 15 * 60_000 },
    eventsPerAddress: { limit: positiveInteger(process.env.HANNAH_RATE_LIMIT_EVENTS_PER_ADDRESS, 300, 100_000), windowMs: 15 * 60_000 },
    // Guesses at a robot's one-time enrollment code, per network address.
    robotEnrollPerAddress: { limit: positiveInteger(process.env.HANNAH_RATE_LIMIT_ROBOT_ENROLL_PER_ADDRESS, 10, 100_000), windowMs: 15 * 60_000 },
  };
}

module.exports = {
  accountMayUse,
  assertProductionApiToken,
  BYOK_PATHS,
  addressKey,
  clientAddress,
  countInDatabase,
  createAddressRateLimiter,
  createRateLimiter,
  isGroqKey,
  rateLimitSettings,
  requireApiToken,
};
