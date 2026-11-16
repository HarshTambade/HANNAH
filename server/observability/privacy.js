"use strict";

/**
 * Privacy scrubbers shared by the API error tracker.
 *
 * HANNAH never needs prompt text, completion text, provider keys, access
 * tokens, or user file paths in an error report. These helpers intentionally
 * redact by key name, URL component, and known credential shape before Sentry
 * receives an event. They are pure functions so they can be unit tested without
 * a Sentry DSN or network access.
 */

const SENSITIVE_KEY_PATTERN = /(?:^|[._-])(?:api[_-]?key|apikey|authorization|auth|bearer|cookie|credentials?|password|passwd|secret|token|session[_-]?id|prompt|messages?|completion|reply|content|transcript|conversation|chat|file[_-]?path|filepath|filename|path|input|body|query|statement|text|email|phone|address|ip[_-]?address)$/i;
const URL_KEY_PATTERN = /(?:^|[._-])(?:url|uri|href|referrer|referer)$/i;
const SAFE_HEADER_NAMES = new Set(["accept", "accept-language", "content-type", "content-length"]);
const MAX_STRING_LENGTH = 2000;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 100;
const MAX_DEPTH = 6;

const CREDENTIAL_PATTERNS = [
  /\b(?:gsk|sk|rk|pk)_[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
];

const FILE_PATH_PATTERNS = [
  /(?:file:\/\/)?\/(?:Users|home|private\/var|var\/folders|tmp|mnt\/[a-zA-Z])\/[^\s"'<>)]{2,}/g,
  /\b[A-Za-z]:\\[^\s"'<>)]{2,}/g,
  /\\\\[^\s"'<>)]{2,}/g,
];
const URL_IN_TEXT_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/gi;

/** Fold camelCase and acronym boundaries so key policy also catches `accessToken`. */
function normalizeKey(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

function isSensitiveKey(key) {
  return typeof key === "string" && SENSITIVE_KEY_PATTERN.test(normalizeKey(key));
}

function isUrlKey(key) {
  return typeof key === "string" && URL_KEY_PATTERN.test(normalizeKey(key));
}

/** Replace credential-looking substrings and local filesystem paths. */
function redactSensitiveText(value, maxLength = MAX_STRING_LENGTH, scrubUrls = true) {
  if (typeof value !== "string") return value;
  let redacted = scrubUrls ? scrubUrlsInText(value) : value;
  for (const pattern of CREDENTIAL_PATTERNS) {
    redacted = redacted.replace(pattern, (match) => (match.toLowerCase().startsWith("bearer") ? "Bearer <redacted>" : "<redacted>"));
  }
  for (const pattern of FILE_PATH_PATTERNS) {
    redacted = redacted.replace(pattern, "<file-path>");
  }
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}…` : redacted;
}

/** Strip credentials, query strings, and fragments from URLs embedded in text. */
function scrubUrlsInText(value) {
  return value.replace(URL_IN_TEXT_PATTERN, (match) => {
    try {
      const parsed = new URL(match);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return match;
      parsed.username = "";
      parsed.password = "";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return match;
    }
  });
}

/** Keep only the origin/path of an HTTP URL and remove all query data. */
function sanitizeUrl(value) {
  if (typeof value !== "string") return redactSensitiveText(value);
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return redactSensitiveText(value);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    parsed.pathname = redactSensitiveText(parsed.pathname);
    return parsed.toString();
  } catch {
    return redactSensitiveText(value, MAX_STRING_LENGTH, false);
  }
}

function sanitizeValue(value, key = "", depth = 0) {
  if (depth > MAX_DEPTH) return "<depth-limited>";
  if (isSensitiveKey(key)) return "<redacted>";
  if (typeof value === "string") return isUrlKey(key) ? sanitizeUrl(value) : redactSensitiveText(value);
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return "<unsupported>";
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue(item, key, depth + 1));
  }
  if (typeof value === "object") {
    const result = {};
    for (const childKey of Object.keys(value).slice(0, MAX_OBJECT_KEYS)) {
      result[childKey] = sanitizeValue(value[childKey], childKey, depth + 1);
    }
    return result;
  }
  return redactSensitiveText(String(value));
}

function sanitizeMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = {};
  for (const key of Object.keys(value).slice(0, MAX_OBJECT_KEYS)) {
    result[key] = sanitizeValue(value[key], key, 0);
  }
  return result;
}

function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== "object") return headers;
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = String(name).toLowerCase();
    // Never forward credentials, even if a future SDK changes header casing.
    if (!SAFE_HEADER_NAMES.has(lower) || isSensitiveKey(lower)) continue;
    result[name] = redactSensitiveText(String(value), 300);
  }
  return result;
}

function sanitizeBreadcrumb(breadcrumb) {
  if (!breadcrumb || typeof breadcrumb !== "object") return breadcrumb;
  const result = { ...breadcrumb };
  const category = String(result.category || "").toLowerCase();
  if (category === "console" || category === "ui.input") {
    delete result.data;
    result.message = "[redacted]";
    return result;
  }
  if (result.message) result.message = redactSensitiveText(result.message, 500);
  if (result.data) result.data = sanitizeMap(result.data);
  return result;
}

function sanitizeException(exception) {
  if (!exception || typeof exception !== "object") return exception;
  const result = {
    ...exception,
    value: typeof exception.value === "string" ? redactSensitiveText(exception.value, 1000) : exception.value,
  };
  const stacktrace = exception.stacktrace;
  if (stacktrace && typeof stacktrace === "object" && Array.isArray(stacktrace.frames)) {
    result.stacktrace = {
      ...stacktrace,
      frames: stacktrace.frames.slice(0, 200).map((frame) => {
        if (!frame || typeof frame !== "object") return frame;
        const clean = { ...frame };
        for (const key of ["filename", "abs_path"]) {
          if (typeof clean[key] === "string") clean[key] = scrubFilePath(clean[key]);
        }
        // Local variables and source context can contain prompts, tokens, or
        // file contents. Keep only the location needed to debug a frame.
        for (const key of ["vars", "context_line", "pre_context", "post_context"]) delete clean[key];
        return clean;
      }),
    };
  }
  return result;
}

/**
 * Keep the basename for debuggability while removing an operator's local
 * directory structure from stack frames.
 */
function scrubFilePath(value) {
  const redacted = redactSensitiveText(value, 500);
  if (redacted !== "<file-path>") return redacted;
  const parts = value.split(/[\\/]/).filter(Boolean);
  const basename = parts[parts.length - 1];
  return basename ? `<file-path>/${basename}` : "<file-path>";
}

function sanitizeSentryEvent(event) {
  if (!event || typeof event !== "object") return event;

  // Identity is never attached by HANNAH, and Sentry must not infer it.
  delete event.user;
  delete event.server_name;

  if (event.message) event.message = redactSensitiveText(event.message, 1000);
  if (event.transaction) event.transaction = redactSensitiveText(event.transaction, 500);

  if (event.request && typeof event.request === "object") {
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.query_string;
    delete event.request.env;
    if (event.request.url) event.request.url = sanitizeUrl(event.request.url);
    if (event.request.headers) event.request.headers = sanitizeHeaders(event.request.headers);
  }

  if (event.extra) event.extra = sanitizeMap(event.extra);
  if (event.contexts) event.contexts = sanitizeMap(event.contexts);
  if (event.tags) event.tags = sanitizeMap(event.tags);

  if (Array.isArray(event.breadcrumbs)) {
    event.breadcrumbs = event.breadcrumbs.slice(-20).map(sanitizeBreadcrumb);
  }
  if (event.exception?.values) {
    event.exception = {
      ...event.exception,
      values: event.exception.values.map(sanitizeException),
    };
  }
  return event;
}

function sanitizeSentryTransaction(event) {
  const sanitized = sanitizeSentryEvent(event);
  if (Array.isArray(sanitized.spans)) {
    sanitized.spans = sanitized.spans.slice(0, 200).map((span) => {
      if (!span || typeof span !== "object") return span;
      const next = { ...span };
      if (next.description) next.description = redactSensitiveText(next.description, 500);
      if (next.data) next.data = sanitizeMap(next.data);
      return next;
    });
  }
  return sanitized;
}

module.exports = {
  isSensitiveKey,
  redactSensitiveText,
  sanitizeBreadcrumb,
  sanitizeHeaders,
  sanitizeSentryEvent,
  sanitizeSentryTransaction,
  sanitizeUrl,
  sanitizeValue,
};
