import * as Sentry from "@sentry/react";
import type { Breadcrumb, ErrorEvent } from "@sentry/react";
import { getAppVersion, detectPlatform } from "./appInfo";

// Sentry v10 does not re-export TransactionEvent from @sentry/react; derive it
// from the init callback so the scrubber stays in lockstep with the SDK.
type TransactionEvent = Parameters<NonNullable<Parameters<typeof Sentry.init>[0]["beforeSendTransaction"]>>[0];

/**
 * Privacy-preserving browser error tracking.
 *
 * Sentry is initialized only when VITE_SENTRY_DSN is present. `sendDefaultPii`
 * is forced off, Session Replay is never enabled, and every event is scrubbed
 * for provider keys, access tokens, user message fields, and local file paths.
 * Chat content is never attached by HANNAH in the first place; the scrubbers
 * are defence in depth for accidental breadcrumbs or error context.
 */

const SENSITIVE_KEY_PATTERN = /(?:^|[._-])(?:api[_-]?key|apikey|authorization|auth|bearer|cookie|credentials?|password|passwd|secret|token|session[_-]?id|prompt|messages?|completion|reply|content|transcript|conversation|chat|file[_-]?path|filepath|filename|path|input|body|query|statement|text|email|phone|address|ip[_-]?address)$/i;
const URL_KEY_PATTERN = /(?:^|[._-])(?:url|uri|href|referrer|referer)$/i;
const SAFE_HEADER_NAMES = new Set(["accept", "accept-language", "content-type", "content-length"]);

const CREDENTIAL_PATTERNS: RegExp[] = [
  /\b(?:gsk|sk|rk|pk)_[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
];

const FILE_PATH_PATTERNS: RegExp[] = [
  /(?:file:\/\/)?\/(?:Users|home|private\/var|var\/folders|tmp|mnt\/[a-zA-Z])\/[^\s"'<>)]{2,}/g,
  /\b[A-Za-z]:\\[^\s"'<>)]{2,}/g,
  /\\\\[^\s"'<>)]{2,}/g,
];
const URL_IN_TEXT_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/gi;

let initialized = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSensitiveKey(key: string) {
  return SENSITIVE_KEY_PATTERN.test(normalizeKey(key));
}

function isUrlKey(key: string) {
  return URL_KEY_PATTERN.test(normalizeKey(key));
}

/** Fold camelCase and acronym boundaries so key policy also catches `accessToken`. */
function normalizeKey(key: string) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

export function redactSensitiveText(value: string, maxLength = 2000, scrubUrls = true): string {
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
function scrubUrlsInText(value: string): string {
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

export function sanitizeUrl(value: string): string {
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
    return redactSensitiveText(value, 2000, false);
  }
}

function sanitizeValue(value: unknown, key = "", depth = 0): unknown {
  if (depth > 6) return "<depth-limited>";
  if (isSensitiveKey(key)) return "<redacted>";
  if (typeof value === "string") return isUrlKey(key) ? sanitizeUrl(value) : redactSensitiveText(value);
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeValue(item, key, depth + 1));
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const childKey of Object.keys(value).slice(0, 100)) {
      result[childKey] = sanitizeValue(value[childKey], childKey, depth + 1);
    }
    return result;
  }
  return redactSensitiveText(String(value));
}

function sanitizeMap(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).slice(0, 100)) {
    result[key] = sanitizeValue(value[key], key, 0);
  }
  return result;
}

export function sanitizeBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  const result: Breadcrumb = { ...breadcrumb };
  const category = String(result.category || "").toLowerCase();
  if (category === "console" || category === "ui.input") {
    delete result.data;
    result.message = "[redacted]";
    return result;
  }
  if (result.message) result.message = redactSensitiveText(result.message, 500);
  if (result.data) result.data = sanitizeMap(result.data) as Record<string, unknown>;
  return result;
}

/**
 * Keep the basename for debuggability while removing an operator's local
 * directory structure from stack frames.
 */
function scrubFilePath(value: string): string {
  const redacted = redactSensitiveText(value, 500);
  if (redacted !== "<file-path>") return redacted;
  const parts = value.split(/[\\/]/).filter(Boolean);
  const basename = parts[parts.length - 1];
  return basename ? `<file-path>/${basename}` : "<file-path>";
}

function sanitizeExceptionValue(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {
    ...value,
    ...(typeof value.value === "string" ? { value: redactSensitiveText(value.value, 1000) } : {}),
  };
  if (isRecord(value.stacktrace) && Array.isArray(value.stacktrace.frames)) {
    result.stacktrace = {
      ...value.stacktrace,
      frames: value.stacktrace.frames.slice(0, 200).map((frame) => {
        if (!isRecord(frame)) return frame;
        const clean: Record<string, unknown> = {
          ...frame,
          ...(typeof frame.filename === "string" ? { filename: scrubFilePath(frame.filename) } : {}),
          ...(typeof frame.abs_path === "string" ? { abs_path: scrubFilePath(frame.abs_path) } : {}),
        };
        // Local variables and source context can contain prompts, tokens, or
        // file contents. Keep only the location needed to debug a frame.
        for (const key of ["vars", "context_line", "pre_context", "post_context"]) delete clean[key];
        return clean;
      }),
    };
  }
  return result;
}

/** Shared by error and transaction events. */
export function sanitizeSentryEvent<T extends ErrorEvent | TransactionEvent>(event: T): T {
  const candidate = event as unknown as Record<string, unknown>;
  delete candidate.user;
  delete candidate.server_name;
  if (typeof candidate.message === "string") candidate.message = redactSensitiveText(candidate.message, 1000);
  if (typeof candidate.transaction === "string") candidate.transaction = redactSensitiveText(candidate.transaction, 500);

  const request = candidate.request;
  if (isRecord(request)) {
    delete request.data;
    delete request.cookies;
    delete request.query_string;
    delete request.env;
    if (typeof request.url === "string") request.url = sanitizeUrl(request.url);
    if (isRecord(request.headers)) {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        const lower = name.toLowerCase();
        if (!SAFE_HEADER_NAMES.has(lower) || isSensitiveKey(lower)) continue;
        headers[name] = redactSensitiveText(String(value), 300);
      }
      request.headers = headers;
    }
  }

  if (candidate.extra) candidate.extra = sanitizeMap(candidate.extra);
  if (candidate.contexts) candidate.contexts = sanitizeMap(candidate.contexts);
  if (candidate.tags) candidate.tags = sanitizeMap(candidate.tags);

  if (Array.isArray(candidate.breadcrumbs)) {
    candidate.breadcrumbs = (candidate.breadcrumbs as Breadcrumb[]).slice(-20).map(sanitizeBreadcrumb);
  }

  if (isRecord(candidate.exception) && Array.isArray(candidate.exception.values)) {
    candidate.exception = {
      ...candidate.exception,
      values: candidate.exception.values.map((value) => (isRecord(value) ? sanitizeExceptionValue(value) : value)),
    };
  }

  return event;
}

export function sanitizeSentryTransaction(event: TransactionEvent): TransactionEvent {
  const sanitized = sanitizeSentryEvent(event);
  const spans = (sanitized as unknown as Record<string, unknown>).spans;
  if (Array.isArray(spans)) {
    (sanitized as unknown as Record<string, unknown>).spans = spans.slice(0, 200).map((span) => {
      if (!isRecord(span)) return span;
      return {
        ...span,
        ...(typeof span.description === "string" ? { description: redactSensitiveText(span.description, 500) } : {}),
        ...(span.data ? { data: sanitizeMap(span.data) } : {}),
      };
    });
  }
  return sanitized;
}

function sampleRate(rawValue: string | undefined, fallback: number) {
  const parsed = Number.parseFloat(rawValue || "");
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : fallback;
}

export function initClientTelemetry(): boolean {
  if (initialized) return true;
  const dsn = import.meta.env.VITE_SENTRY_DSN?.trim();
  if (!dsn) return false;

  try {
    Sentry.init({
      dsn,
      environment: import.meta.env.VITE_SENTRY_ENVIRONMENT?.trim() || import.meta.env.MODE,
      release: import.meta.env.VITE_SENTRY_RELEASE?.trim() || `hannah-web@${getAppVersion()}`,
      sendDefaultPii: false,
      maxBreadcrumbs: 20,
      tracesSampleRate: sampleRate(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE, 0.05),
      initialScope: { tags: { service: "hannah-web", platform: detectPlatform() } },
      beforeSend(event) {
        return sanitizeSentryEvent(event);
      },
      beforeSendTransaction(event) {
        return sanitizeSentryTransaction(event);
      },
      beforeBreadcrumb(breadcrumb) {
        return sanitizeBreadcrumb(breadcrumb);
      },
    });
  } catch {
    // A malformed DSN or blocked SDK must not prevent the app from rendering.
    return false;
  }
  initialized = true;
  return true;
}

export function captureClientException(error: unknown, tags: Record<string, string> = {}) {
  if (!initialized) return;
  Sentry.captureException(error, { tags });
}
