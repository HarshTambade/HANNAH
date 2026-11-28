"use strict";

/**
 * Image and video generation for chat ("draw a red fox in snow", "make a
 * 5-second clip of waves").
 *
 *   GET  /media/providers                which engines this caller can use
 *   POST /media/image                    prompt → image(s), returned as base64
 *   POST /media/video                    prompt → a provider job to poll
 *   GET  /media/video/:provider/:id      the job's progress, then the mp4 as base64
 *
 * Keys follow the same rules as chat (server/index.js getRequestProvider): an
 * account's saved key, or the operator's server key. A visitor's Groq key
 * can't pay for these; Groq has no image or video models.
 *
 * Images use the OpenAI-compatible POST /images/generations that OpenAI, xAI
 * and Together all serve. Video uses xAI's documented asynchronous API
 * (POST /videos/generations, then GET /videos/{request_id}). Nothing is kept
 * on the server: the app stores what it receives with its other files.
 */

const express = require("express");
const { assertWithinBudget, budgetStatus, hydrateSpend, recordSpendUsd } = require("./gateway");
const { assertPublicUrl } = require("./webhooks");

const ASPECTS = ["1:1", "16:9", "9:16"];
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES = 60 * 1024 * 1024;
const USD_TICKS = 10_000_000_000;

/** OpenAI-compatible image engines, in the order HANNAH prefers them when the caller doesn't pick. */
const IMAGE_ENGINES = {
  openai: {
    label: "OpenAI",
    envModel: "OPENAI_IMAGE_MODEL",
    model: "gpt-image-2",
    body: ({ model, prompt, n, aspect }) => ({
      model, prompt, n,
      size: { "1:1": "1024x1024", "16:9": "1536x1024", "9:16": "1024x1536" }[aspect],
      // GPT image models always return base64; the legacy DALL·E models need asking.
      ...(model.startsWith("dall-e") ? { response_format: "b64_json" } : {}),
    }),
  },
  xai: {
    label: "xAI Grok",
    envModel: "XAI_IMAGE_MODEL",
    model: "grok-imagine-image-2.0",
    body: ({ model, prompt, n, aspect }) => ({ model, prompt, n, response_format: "b64_json", aspect_ratio: aspect }),
  },
  together: {
    label: "Together AI",
    envModel: "TOGETHER_IMAGE_MODEL",
    model: "black-forest-labs/FLUX.1-schnell",
    body: ({ model, prompt, n, aspect }) => ({ model, prompt, n, response_format: "base64", ...{ "1:1": { width: 1024, height: 1024 }, "16:9": { width: 1280, height: 720 }, "9:16": { width: 720, height: 1280 } }[aspect] }),
  },
};

/** Asynchronous video engines. Only xAI's is implemented: its API shape is documented at docs.x.ai. */
const VIDEO_ENGINES = {
  xai: { label: "xAI Grok", envModel: "XAI_VIDEO_MODEL", model: "grok-imagine-video-1.5", maxSeconds: 15 },
};

const modelOf = (engine) => String(process.env[engine.envModel] || "").trim() || engine.model;

// ——— What HANNAH won't make ———

const MINOR = /\b(child|children|childlike|kid|kids|minor|minors|under-?age|pre-?teens?|teens?|teenage|teenagers?|toddlers?|infants?|bab(y|ies)|school ?girls?|school ?boys?|lolis?|lolita|shota|little (girls?|boys?)|young (girls?|boys?)|([1-9]|1[0-7])[- ]?(yo|y\/o|years?[- ]old))\b/i;
const SEXUAL = /\b(nude|nudes|nudity|naked|nsfw|sex|sexual|sexuali[sz]ed|sexy|erotic|porn\w*|explicit|lingerie|topless|undress\w*|bikini|seductive|fetish\w*|genitals?|breasts?|xxx)\b/i;
const RELATION = /\b(my|our|his|her|their)\s+(ex|ex-?(girlfriend|boyfriend|wife|husband|partner)|neighbou?rs?|co-?workers?|colleagues?|boss|manager|classmates?|teachers?|professor|friends?|girlfriend|boyfriend|wife|husband|partner|crush|room-?mates?|flatmates?|sisters?|brothers?|mom|mum|dad|mother|father|cousins?|aunt|uncle|students?|employees?|landlord|landlady|tutor|nanny)\b/i;
const NAMED = /\b(named|called)\s+["“']?[A-Za-z]/;
const FULL_NAME = /\b[A-Z][a-z]{1,}\s+[A-Z][a-z]{1,}\b/;

/**
 * A plain refusal for a prompt HANNAH won't send, or null. These are
 * word-level checks: they catch the plain cases before any money is spent,
 * and the provider's own moderation still applies to everything else.
 */
function checkMediaPrompt(prompt) {
  const text = String(prompt || "");
  if (MINOR.test(text) && SEXUAL.test(text)) {
    return { reason: "minor-sexual", message: "I won't make sexual or suggestive images of children or anyone who might be under 18." };
  }
  const relation = RELATION.exec(text);
  if (relation) {
    const after = text.slice(relation.index + relation[0].length);
    const namesThem = NAMED.test(text) || /^\s*,?\s*["“']?[A-Z][a-z]+/.test(after) || FULL_NAME.test(text);
    if (namesThem || SEXUAL.test(text) || /\b(photo|photograph|photorealistic|realistic|deepfake|face swap|lookalike)\b/i.test(text)) {
      return { reason: "private-person", message: "I don't make pictures or videos of real private people, like someone you know. I can make a fictional character instead: describe how they look and I'll draw that." };
    }
  }
  if (SEXUAL.test(text) && FULL_NAME.test(text)) {
    return { reason: "real-person-sexual", message: "I don't make sexual images of real, named people." };
  }
  if (/\b(real|actual)\s+(photo|picture|image|video)s?\s+of\s+(a\s+)?(real\s+)?(person|someone|somebody|man|woman)\s+(named|called)\b/i.test(text)) {
    return { reason: "private-person", message: "I don't make pictures or videos of real private people. I can make a fictional character instead." };
  }
  return null;
}

// ——— Talking to providers ———

/** The provider's own words when it says no, with the key never included. */
async function providerFailure(response, label) {
  const data = await response.json().catch(() => ({}));
  const said = String(
    typeof data?.error === "string" ? data.error : data?.error?.message || data?.message || data?.detail || "",
  ).replace(/\b(sk|xai|gsk)-[A-Za-z0-9_-]{8,}/g, "[key]").slice(0, 400);
  const status = response.status;
  if (status === 401 || status === 403) return { status: 401, error: `${label} rejected the API key${said ? `: ${said}` : "."}`, reason: "key-rejected" };
  if (status === 429) return { status: 429, error: `${label}'s rate limit or spending limit was reached${said ? `: ${said}` : ". Try again shortly."}`, reason: "rate-limited" };
  if (status === 400 || status === 422) return { status: 400, error: `${label} declined this request${said ? `: ${said}` : "."}`, reason: "provider-refused" };
  return { status: 502, error: `${label} couldn't generate it${said ? `: ${said}` : ` (HTTP ${status}).`}`, reason: "provider-error" };
}

/**
 * Download a finished image or video the provider linked to. Only from the
 * provider's own origin or a public https address, re-checked on each redirect.
 */
/**
 * The default download: the address is checked when the socket connects (no
 * second DNS answer can point it inward), redirects stay on https, and reading
 * stops at the size cap instead of after the whole body.
 */
async function safeDownload(url, { maxBytes, kind, timeoutMs }) {
  const { safeRequest } = require("./workflows/http");
  let response;
  try {
    response = await safeRequest(url, { httpsOnly: true, maxRedirects: 3, maxBytes: maxBytes + 1, timeoutMs });
  } catch {
    throw Object.assign(new Error(`The provider's ${kind} link isn't a public https address, so HANNAH didn't fetch it.`), { status: 502 });
  }
  if (response.status < 200 || response.status >= 300) throw Object.assign(new Error(`The finished ${kind} couldn't be downloaded (HTTP ${response.status}).`), { status: 502 });
  if (response.truncated || response.body.length > maxBytes) throw Object.assign(new Error(`The ${kind} is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`), { status: 502 });
  if (!response.body.length) throw Object.assign(new Error(`The provider returned no usable ${kind}.`), { status: 502 });
  return { bytes: response.body, mime: String(response.headers["content-type"] || "").split(";")[0].trim().toLowerCase() };
}

async function downloadMedia(url, { provider, fetchImpl, lookup, maxBytes, kind, timeoutMs }) {
  if (!fetchImpl) {
    if (!/^https:\/\//i.test(String(url || ""))) throw Object.assign(new Error(`The provider's ${kind} link isn't a public https address, so HANNAH didn't fetch it.`), { status: 502 });
    return safeDownload(url, { maxBytes, kind, timeoutMs });
  }
  let target = String(url || "");
  for (let hop = 0; hop < 3; hop += 1) {
    let parsed;
    try { parsed = new URL(target); } catch { throw Object.assign(new Error(`The provider sent an unusable ${kind} link.`), { status: 502 }); }
    const sameOrigin = (() => { try { return new URL(provider.baseUrl).origin === parsed.origin; } catch { return false; } })();
    if (!sameOrigin) await assertPublicUrl(parsed.toString(), lookup ? { lookup } : {}).catch(() => { throw Object.assign(new Error(`The provider's ${kind} link isn't a public https address, so HANNAH didn't fetch it.`), { status: 502 }); });
    const response = await fetchImpl(parsed.toString(), { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      target = new URL(response.headers.get("location"), parsed).toString();
      continue;
    }
    if (!response.ok) throw Object.assign(new Error(`The finished ${kind} couldn't be downloaded (HTTP ${response.status}).`), { status: 502 });
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) throw Object.assign(new Error(`The ${kind} is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`), { status: 502 });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > maxBytes) throw Object.assign(new Error(`The provider returned no usable ${kind}.`), { status: 502 });
    return { bytes, mime: String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase() };
  }
  throw Object.assign(new Error(`The ${kind} link redirected too many times.`), { status: 502 });
}

/** The image type from its first bytes, so a mislabelled response is still saved correctly. */
function sniffImage(bytes) {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length > 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (bytes.length > 6 && bytes.toString("latin1", 0, 3) === "GIF") return "image/gif";
  return "";
}

function costFromUsage(data) {
  const ticks = Number(data?.usage?.cost_in_usd_ticks);
  return Number.isFinite(ticks) && ticks > 0 ? ticks / USD_TICKS : null;
}

function envCost(name) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function createMediaRouter({ getRequestProvider, allowedProviderIds, timeoutMs = 60_000, fetchImpl: injectedFetch, lookup } = {}) {
  const fetchImpl = injectedFetch ?? ((...args) => fetch(...args));
  // Provider links are downloaded with the guarded request unless a test injects its own fetch.
  const downloadFetch = injectedFetch;
  const router = express.Router();
  /** Video ids already charged in this process, so polling twice doesn't charge twice. */
  const charged = new Set();

  const available = (req, res, providerId) => {
    const allowed = allowedProviderIds(req, res);
    if (allowed && !allowed.has(providerId)) return null;
    try {
      const target = getRequestProvider(req, providerId);
      return target.apiKey ? target : null;
    } catch {
      return null;
    }
  };

  /** The engine to use: the one asked for when usable, else the first usable one. */
  const pick = (req, res, engines, wanted) => {
    const ids = Object.keys(engines);
    const order = ids.includes(wanted) ? [wanted, ...ids.filter((id) => id !== wanted)] : ids;
    for (const id of order) {
      const target = available(req, res, id);
      if (target) return { id, engine: engines[id], ...target };
    }
    return null;
  };

  const budgetGate = async (res, requested) => {
    const credentialId = res.locals.hannahApiTokenId;
    await hydrateSpend(credentialId);
    try {
      assertWithinBudget(credentialId, requested);
      return true;
    } catch (error) {
      res.status(429).json({ error: error.message, reason: "budget-exceeded", budget: budgetStatus(credentialId, requested) });
      return false;
    }
  };

  const readPrompt = (req, res) => {
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
    if (!prompt || prompt.length > 4000) {
      res.status(400).json({ error: "Describe what to make in 1–4,000 characters.", reason: "invalid-prompt" });
      return null;
    }
    const refused = checkMediaPrompt(prompt);
    if (refused) {
      res.status(422).json({ error: refused.message, reason: refused.reason });
      return null;
    }
    return prompt;
  };

  router.get("/media/providers", (req, res) => {
    const list = (engines) => Object.entries(engines).map(([id, engine]) => ({ id, label: engine.label, model: modelOf(engine), available: Boolean(available(req, res, id)), ...(engine.maxSeconds ? { maxSeconds: engine.maxSeconds } : {}) }));
    res.json({ image: list(IMAGE_ENGINES), video: list(VIDEO_ENGINES) });
  });

  router.post("/media/image", async (req, res) => {
    const prompt = readPrompt(req, res);
    if (!prompt) return undefined;
    const aspect = ASPECTS.includes(req.body?.aspect) ? req.body.aspect : "1:1";
    const n = Math.max(1, Math.min(4, Math.trunc(Number(req.body?.n) || 1)));
    const target = pick(req, res, IMAGE_ENGINES, typeof req.body?.provider === "string" ? req.body.provider : "");
    if (!target) return res.status(403).json({ error: "Image generation needs an OpenAI, xAI or Together AI key, saved to your account (Settings → Account) or set on the server.", reason: "media-unavailable" });
    if (!(await budgetGate(res, req.body?.budget?.dailyUsd))) return undefined;
    const model = modelOf(target.engine);
    let response;
    try {
      response = await fetchImpl(`${target.provider.baseUrl}/images/generations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${target.apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(target.engine.body({ model, prompt, n, aspect })),
        signal: AbortSignal.timeout(Math.max(timeoutMs, 120_000)),
      });
    } catch (error) {
      console.error(`Image generation request failed (${error?.name || "request error"}).`);
      return res.status(502).json({ error: `Couldn't reach ${target.engine.label} to make the image.`, reason: "provider-unreachable" });
    }
    if (!response.ok) {
      const failure = await providerFailure(response, target.engine.label);
      return res.status(failure.status).json({ error: failure.error, reason: failure.reason, provider: target.id });
    }
    const data = await response.json().catch(() => ({}));
    const items = Array.isArray(data?.data) ? data.data.slice(0, n) : [];
    const images = [];
    try {
      for (const item of items) {
        let bytes;
        let mime = typeof item?.mime_type === "string" ? item.mime_type : "";
        if (typeof item?.b64_json === "string" && item.b64_json) bytes = Buffer.from(item.b64_json, "base64");
        else if (typeof item?.url === "string" && item.url) {
          const got = await downloadMedia(item.url, { provider: target.provider, fetchImpl: downloadFetch, lookup, maxBytes: MAX_IMAGE_BYTES, kind: "image", timeoutMs });
          bytes = got.bytes;
          mime = mime || got.mime;
        }
        if (!bytes?.length || bytes.length > MAX_IMAGE_BYTES) continue;
        mime = sniffImage(bytes) || (mime.startsWith("image/") ? mime : "");
        if (!mime) continue;
        images.push({ mime, bytes: bytes.length, data: bytes.toString("base64"), ...(typeof item?.revised_prompt === "string" ? { revisedPrompt: item.revised_prompt.slice(0, 2000) } : {}) });
      }
    } catch (error) {
      return res.status(error.status || 502).json({ error: error.message, reason: "download-failed" });
    }
    if (!images.length) return res.status(502).json({ error: `${target.engine.label} returned no image. Its moderation may have withheld it.`, reason: "no-image" });
    const costUsd = costFromUsage(data) ?? (envCost("HANNAH_IMAGE_COST_USD") * images.length || null);
    if (costUsd) recordSpendUsd(res.locals.hannahApiTokenId, costUsd);
    return res.json({ provider: target.id, providerLabel: target.engine.label, model, aspect, images, ...(costUsd ? { costUsd: Number(costUsd.toFixed(4)) } : {}) });
  });

  router.post("/media/video", async (req, res) => {
    const prompt = readPrompt(req, res);
    if (!prompt) return undefined;
    const target = pick(req, res, VIDEO_ENGINES, typeof req.body?.provider === "string" ? req.body.provider : "");
    if (!target) return res.status(403).json({ error: "Video generation isn't set up: it needs an xAI key, saved to your account (Settings → Account) or set on the server as XAI_API_KEY.", reason: "media-unavailable" });
    const seconds = Math.max(1, Math.min(target.engine.maxSeconds, Math.trunc(Number(req.body?.seconds) || 5)));
    const aspect = ASPECTS.includes(req.body?.aspect) ? req.body.aspect : "16:9";
    if (!(await budgetGate(res, req.body?.budget?.dailyUsd))) return undefined;
    const model = modelOf(target.engine);
    let response;
    try {
      response = await fetchImpl(`${target.provider.baseUrl}/videos/generations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${target.apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ model, prompt, duration: seconds, aspect_ratio: aspect, resolution: "720p" }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      console.error(`Video generation request failed (${error?.name || "request error"}).`);
      return res.status(502).json({ error: `Couldn't reach ${target.engine.label} to start the video.`, reason: "provider-unreachable" });
    }
    if (!response.ok) {
      const failure = await providerFailure(response, target.engine.label);
      return res.status(failure.status).json({ error: failure.error, reason: failure.reason, provider: target.id });
    }
    const data = await response.json().catch(() => ({}));
    const id = typeof data?.request_id === "string" ? data.request_id : "";
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return res.status(502).json({ error: `${target.engine.label} didn't return a job id.`, reason: "provider-error" });
    return res.status(202).json({ job: { provider: target.id, id }, status: "pending", seconds, aspect, model, providerLabel: target.engine.label });
  });

  router.get("/media/video/:provider/:id", async (req, res) => {
    const engine = VIDEO_ENGINES[req.params.provider];
    const id = String(req.params.id || "");
    if (!engine || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return res.status(400).json({ error: "Unknown video job.", reason: "invalid-job" });
    const target = available(req, res, req.params.provider);
    if (!target) return res.status(403).json({ error: `Checking this video needs your ${engine.label} key.`, reason: "media-unavailable" });
    let response;
    try {
      response = await fetchImpl(`${target.provider.baseUrl}/videos/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${target.apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return res.status(502).json({ error: `Couldn't reach ${engine.label} to check the video.`, reason: "provider-unreachable", retryable: true });
    }
    if (!response.ok) {
      const failure = await providerFailure(response, engine.label);
      return res.status(failure.status).json({ error: failure.error, reason: failure.reason });
    }
    const data = await response.json().catch(() => ({}));
    const status = String(data?.status || "").toLowerCase();
    if (status === "failed") {
      const said = String(data?.error?.message || "").slice(0, 400);
      return res.status(422).json({ error: `${engine.label} couldn't make this video${said ? `: ${said}` : "."}`, reason: data?.error?.code === "permission_denied" ? "provider-refused" : "provider-failed" });
    }
    if (status === "expired") return res.status(410).json({ error: `${engine.label} says this video job expired before it was collected. Ask again to make a new one.`, reason: "expired" });
    if (status !== "done") {
      const progress = Number(data?.progress);
      return res.json({ status: "pending", ...(Number.isFinite(progress) ? { progress: Math.max(0, Math.min(99, Math.round(progress))) } : {}) });
    }
    const url = data?.video?.url;
    if (!url) {
      return res.status(422).json({ error: data?.video?.respect_moderation === false ? `${engine.label}'s moderation withheld this video.` : `${engine.label} finished but sent no video.`, reason: "provider-refused" });
    }
    let got;
    try {
      got = await downloadMedia(url, { provider: target.provider, fetchImpl: downloadFetch, lookup, maxBytes: MAX_VIDEO_BYTES, kind: "video", timeoutMs: Math.max(timeoutMs, 120_000) });
    } catch (error) {
      return res.status(error.status || 502).json({ error: error.message, reason: "download-failed" });
    }
    const duration = Number(data?.video?.duration);
    if (!charged.has(id)) {
      charged.add(id);
      if (charged.size > 500) charged.delete(charged.values().next().value);
      const costUsd = costFromUsage(data) ?? (envCost("HANNAH_VIDEO_COST_USD_PER_SECOND") * (Number.isFinite(duration) ? duration : 0) || null);
      if (costUsd) recordSpendUsd(res.locals.hannahApiTokenId, costUsd);
    }
    return res.json({
      status: "done",
      model: typeof data?.model === "string" ? data.model : modelOf(engine),
      video: { mime: got.mime.startsWith("video/") ? got.mime : "video/mp4", bytes: got.bytes.length, data: got.bytes.toString("base64"), ...(Number.isFinite(duration) ? { duration } : {}) },
    });
  });

  return router;
}

module.exports = { createMediaRouter, checkMediaPrompt, IMAGE_ENGINES, VIDEO_ENGINES, downloadMedia };
