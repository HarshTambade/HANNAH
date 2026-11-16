"use strict";

/**
 * Hosted voice engines behind one API, so the app can switch engines without
 * knowing provider details. On-device engines (system TTS, browser or device
 * speech recognition) run in the client and never reach this server.
 *
 *   GET  /voice/providers   which hosted engines this caller can use
 *   POST /voice/speak       text → speech (OpenAI TTS), returns audio/mpeg
 *   POST /voice/transcribe  speech → text (Groq Whisper); raw audio body
 *
 * Keys follow the same rules as chat: an account's saved key, a visitor's own
 * Groq key (Groq only), or the operator's server key.
 */

const express = require("express");

const OPENAI_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"];
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const AUDIO_TYPES = new Set(["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav", "audio/x-wav", "audio/flac", "audio/m4a", "audio/x-m4a"]);

function createVoiceRouter({ getRequestProvider, allowedProviderIds, timeoutMs = 60_000 }) {
  const router = express.Router();

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

  router.get("/voice/providers", (req, res) => {
    res.json({
      tts: [{ id: "openai", label: "OpenAI voices", hosted: true, available: Boolean(available(req, res, "openai")), voices: OPENAI_VOICES, model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts" }],
      stt: [{ id: "groq-whisper", label: "Groq Whisper", hosted: true, available: Boolean(available(req, res, "groq")), model: process.env.GROQ_STT_MODEL || "whisper-large-v3-turbo" }],
      mithi: Boolean(String(process.env.MITHI_TTS_URL || "").trim()) && !res.locals.hannahByok && !res.locals.hannahAccount,
    });
  });

  router.post("/voice/speak", async (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    const voice = OPENAI_VOICES.includes(req.body?.voice) ? req.body.voice : "coral";
    const instructions = typeof req.body?.instructions === "string" ? req.body.instructions.trim().slice(0, 300) : "Speak warmly and naturally, at a calm, friendly pace.";
    if (!text || text.length > 4000) return res.status(400).json({ error: "Send 1–4,000 characters of text." });
    const target = available(req, res, "openai");
    if (!target) return res.status(403).json({ error: "OpenAI voices need an OpenAI key, saved to your account or set on the server.", reason: "voice-unavailable" });
    const model = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
    try {
      const response = await fetch(`${target.provider.baseUrl}/audio/speech`, {
        method: "POST",
        headers: { Authorization: `Bearer ${target.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, voice, input: text, response_format: "mp3", ...(model.startsWith("gpt-4o") ? { instructions } : {}) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        const status = response.status === 401 || response.status === 403 ? 401 : response.status === 429 ? 429 : 502;
        return res.status(status).json({ error: status === 401 ? "OpenAI rejected the API key." : status === 429 ? "OpenAI's rate limit was reached. Try again shortly." : "OpenAI couldn't synthesize speech." });
      }
      const audio = Buffer.from(await response.arrayBuffer());
      if (!audio.length || audio.length > 20 * 1024 * 1024) return res.status(502).json({ error: "OpenAI returned no audio." });
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-HANNAH-Voice", `openai/${voice}`);
      return res.send(audio);
    } catch (error) {
      console.error(`Voice synthesis failed (${error?.name || "request error"}).`);
      return res.status(502).json({ error: "Couldn't reach OpenAI for speech." });
    }
  });

  router.post("/voice/transcribe", express.raw({ type: (req) => String(req.headers["content-type"] || "").startsWith("audio/"), limit: MAX_AUDIO_BYTES }), async (req, res) => {
    const type = String(req.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!AUDIO_TYPES.has(type)) return res.status(415).json({ error: "Send audio as webm, ogg, mp4, mpeg, wav or flac." });
    if (!Buffer.isBuffer(req.body) || req.body.length < 100) return res.status(400).json({ error: "The recording is empty." });
    const target = available(req, res, "groq");
    if (!target) return res.status(403).json({ error: "Groq Whisper needs a Groq key: yours, your account's, or the server's.", reason: "voice-unavailable" });
    const language = /^[a-z]{2}$/.test(String(req.query.language || "")) ? String(req.query.language) : "";
    const extension = type.split("/")[1].replace("x-", "").replace("mpeg", "mp3");
    const form = new FormData();
    form.append("file", new Blob([req.body], { type }), `speech.${extension}`);
    form.append("model", process.env.GROQ_STT_MODEL || "whisper-large-v3-turbo");
    form.append("response_format", "json");
    form.append("temperature", "0");
    if (language) form.append("language", language);
    try {
      const response = await fetch(`${target.provider.baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${target.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const status = response.status === 401 || response.status === 403 ? 401 : response.status === 429 ? 429 : 502;
        return res.status(status).json({ error: status === 401 ? "Groq rejected the API key." : status === 429 ? "Groq's rate limit was reached. Try again shortly." : "Groq couldn't transcribe that recording." });
      }
      return res.json({ text: typeof data.text === "string" ? data.text.trim() : "", engine: "groq-whisper" });
    } catch (error) {
      console.error(`Transcription failed (${error?.name || "request error"}).`);
      return res.status(502).json({ error: "Couldn't reach Groq for transcription." });
    }
  });

  return router;
}

module.exports = { createVoiceRouter, OPENAI_VOICES };
