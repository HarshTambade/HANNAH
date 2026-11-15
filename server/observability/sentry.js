"use strict";

/**
 * Optional Sentry initialization for the Express API.
 *
 * Init happens before Express is imported so the SDK can instrument the
 * framework. The DSN is read only from server-side environment variables; it is
 * never sent to the browser. `sendDefaultPii` is forced off and every event is
 * passed through the scrubbers in ./privacy.js.
 */

const { sanitizeBreadcrumb, sanitizeSentryEvent, sanitizeSentryTransaction } = require("./privacy");

let sentry = null;
let enabled = false;

function sampleRate(rawValue, fallback) {
  const parsed = Number.parseFloat(rawValue);
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : fallback;
}

function initServerSentry() {
  if (enabled) return true;
  if (process.env.SENTRY_ENABLED === "false") return false;
  const dsn = typeof process.env.SENTRY_DSN === "string" ? process.env.SENTRY_DSN.trim() : "";
  if (!dsn) return false;

  let sdk;
  try {
    // Kept lazy so local development works without the optional package.
    sdk = require("@sentry/node");
  } catch {
    console.warn("[observability] SENTRY_DSN is set but @sentry/node is not installed; error tracking is disabled.");
    return false;
  }

  try {
    sdk.init({
      dsn,
      environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development",
      release: process.env.SENTRY_RELEASE || undefined,
      sendDefaultPii: false,
      attachStacktrace: true,
      maxBreadcrumbs: 20,
      tracesSampleRate: sampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE, 0.1),
      initialScope: { tags: { service: "shanaya-api" } },
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
  } catch (error) {
    // Telemetry must never prevent the API from starting. Log only the error
    // class, never the DSN or any environment value.
    console.warn(`[observability] Sentry could not initialize (${error?.name || "configuration error"}); error tracking is disabled.`);
    return false;
  }

  sentry = sdk;
  enabled = true;
  console.info("[observability] Sentry error tracking enabled for the API.");
  return true;
}

function isSentryEnabled() {
  return enabled && Boolean(sentry);
}

/** Install after all routes, before any custom error middleware. */
function setupSentryErrorHandler(app) {
  if (!isSentryEnabled()) return;
  sentry.setupExpressErrorHandler(app, {
    // Malformed requests and validation failures are client errors, not API
    // defects. Skipping them keeps event volume low and avoids ingesting
    // request bodies that triggered the failure.
    shouldHandleError(error) {
      return !(Number.isInteger(error?.status) && error.status >= 400 && error.status < 500);
    },
  });
}

function captureSentryException(error, context = {}) {
  if (!isSentryEnabled()) return;
  sentry.captureException(error, {
    tags: {
      ...(context.tags && typeof context.tags === "object" ? context.tags : {}),
    },
    extra: context.extra && typeof context.extra === "object" ? context.extra : undefined,
  });
}

module.exports = {
  captureSentryException,
  initServerSentry,
  isSentryEnabled,
  setupSentryErrorHandler,
};
