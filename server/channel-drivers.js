"use strict";

/**
 * Chat app drivers for server/channels.js. Each one knows one platform's
 * real API and its way of proving a request came from it:
 *
 *   telegram  Bot API; webhook with a secret header                  (reply after: sendMessage)
 *   slack     Events API; signing secret HMAC (v0, 5-minute window)   (ack, then chat.postMessage)
 *   discord   Interactions endpoint; Ed25519 signature; /hannah        (deferred, then edit the reply)
 *   gchat     Google Chat HTTP endpoint; Google-signed JWT (project)  (reply in the response)
 *   teams     Azure Bot / Bot Framework; Microsoft-signed JWT         (ack, then reply to the activity)
 *   whatsapp  WhatsApp Cloud API (Meta's official API); X-Hub-Signature-256 HMAC (ack, then send)
 *
 * A driver:
 *   validate(input)                 → { secrets, config } after checking the shape
 *   connect({ secrets, config, hookUrl, call }) → { name, config, setup }   (real API call)
 *   handshake({ req, body, raw, row, secrets, config }) → { status, body } | null   (URL checks)
 *   verify({ req, raw, body, row, secrets, config, call }) → true | false
 *   parse(body, { config }) → { eventId, senderId, senderName, chatId, private, text, reply } | null
 *   send({ secrets, config, message, text, call })
 *   mode: "inline" (reply, then answer the webhook), "after" (answer at once, reply after), "sync" (the reply is the answer)
 */
const crypto = require("node:crypto");

const API = {
  telegram: process.env.HANNAH_TELEGRAM_API || "https://api.telegram.org",
  slack: process.env.HANNAH_SLACK_API || "https://slack.com/api",
  discord: process.env.HANNAH_DISCORD_API || "https://discord.com/api/v10",
  graph: process.env.HANNAH_WHATSAPP_API || "https://graph.facebook.com/v21.0",
  msLogin: process.env.HANNAH_MS_LOGIN || "https://login.microsoftonline.com",
  botOpenId: process.env.HANNAH_BOTFRAMEWORK_OPENID || "https://login.botframework.com/v1/.well-known/openidconfiguration",
  googleChatCerts: process.env.HANNAH_GCHAT_CERTS || "https://www.googleapis.com/service_accounts/v1/metadata/x509/chat@system.gserviceaccount.com",
};
const fail = (status, message, reason) => Object.assign(new Error(message), { status, reason });
const safeEqual = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};
const hmacHex = (key, data) => crypto.createHmac("sha256", key).update(data).digest("hex");
const clip = (text, limit) => String(text || "").slice(0, limit);

/** One JSON call to a platform, with its error turned into a clear message. */
async function callJson(fetchImpl, url, { method = "GET", headers = {}, body, form, label }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : form ? new URLSearchParams(form).toString() : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw fail(502, `${label} didn't answer.`, "unreachable");
  }
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 300) }; }
  return { status: response.status, ok: response.ok, data };
}

// ----- signed tokens (Teams, Google Chat) -----

const keyCache = new Map(); // url → { at, keys: Map(kid → { key, endorsements }) }
async function signingKeys(fetchImpl, url, kind) {
  const cached = keyCache.get(url);
  if (cached && Date.now() - cached.at < 3_600_000) return cached.keys;
  const keys = new Map();
  if (kind === "openid") {
    const config = await callJson(fetchImpl, url, { label: "Microsoft" });
    const jwks = await callJson(fetchImpl, String(config.data?.jwks_uri || ""), { label: "Microsoft" });
    for (const jwk of jwks.data?.keys || []) {
      try { keys.set(jwk.kid, { key: crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: "jwk" }), endorsements: jwk.endorsements || null }); } catch { /* skip */ }
    }
  } else {
    const certs = await callJson(fetchImpl, url, { label: "Google" });
    for (const [kid, pem] of Object.entries(certs.data || {})) {
      try { keys.set(kid, { key: crypto.createPublicKey(String(pem)), endorsements: null }); } catch { /* skip */ }
    }
  }
  if (keys.size) keyCache.set(url, { at: Date.now(), keys });
  return keys;
}
/** Verify an RS256 JWT against a key set; returns its claims or null. */
async function verifyJwt(fetchImpl, token, { keysUrl, kind, issuer, audience, now = Date.now() }) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  let header;
  let claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || !header.kid) return null;
  const keys = await signingKeys(fetchImpl, keysUrl, kind);
  const entry = keys.get(header.kid);
  if (!entry) return null;
  const valid = crypto.verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), entry.key, Buffer.from(parts[2], "base64url"));
  if (!valid) return null;
  const seconds = now / 1000;
  if (typeof claims.exp !== "number" || claims.exp + 300 < seconds || (typeof claims.nbf === "number" && claims.nbf - 300 > seconds)) return null;
  if (claims.iss !== issuer) return null;
  if ((Array.isArray(claims.aud) ? claims.aud : [claims.aud]).map(String).indexOf(String(audience)) < 0) return null;
  return { claims, endorsements: entry.endorsements };
}

// ----- the drivers -----

const telegram = {
  kind: "telegram",
  label: "Telegram",
  mode: "inline",
  validate(input) {
    const botToken = String(input?.botToken || "").trim();
    if (!/^\d{5,15}:[A-Za-z0-9_-]{30,64}$/.test(botToken)) throw fail(400, "That doesn't look like a Telegram bot token (it looks like 123456789:AAE…). Get it from @BotFather.", "invalid-token");
    return { secrets: { botToken }, config: {} };
  },
  async api(call, botToken, method, body) {
    const result = await call(`${API.telegram}/bot${botToken}/${method}`, { method: "POST", body: body || {}, label: "Telegram" });
    if (!result.data?.ok) {
      const badToken = result.status === 401 || result.status === 404;
      throw fail(badToken ? 400 : 502, badToken ? "Telegram didn't accept that bot token. Copy it again from @BotFather." : `Telegram: ${clip(result.data?.description || result.status, 200)}`, "telegram");
    }
    return result.data.result;
  },
  async connect({ secrets, hookUrl, webhookSecret, call }) {
    const me = await telegram.api(call, secrets.botToken, "getMe");
    await telegram.api(call, secrets.botToken, "setWebhook", { url: hookUrl, secret_token: webhookSecret, allowed_updates: ["message"], drop_pending_updates: true });
    return { name: `@${me.username}`, config: { username: me.username }, setup: { done: true } };
  },
  pairingLink: (config, code) => (config.username ? `https://t.me/${config.username}?start=${code}` : null),
  verify: ({ req, row }) => {
    const given = String(req.get("x-telegram-bot-api-secret-token") || "");
    return Boolean(given) && safeEqual(crypto.createHash("sha256").update(given).digest("hex"), row.webhook_secret_hash);
  },
  parse(body) {
    const message = body?.message;
    if (!message?.chat || typeof body.update_id !== "number" || typeof message.text !== "string") return null;
    const name = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ") || message.from?.username || "";
    return { eventId: `u${body.update_id}`, updateId: body.update_id, senderId: String(message.from?.id ?? message.chat.id), senderName: name, chatId: String(message.chat.id), chatRef: message.chat.id, private: message.chat.type === "private", text: message.text, codeText: /^\/start\s+(\S+)/.exec(message.text)?.[1] };
  },
  async send({ secrets, message, text, call }) {
    await telegram.api(call, secrets.botToken, "sendMessage", { chat_id: message.chatRef ?? message.chatId, text: clip(text, 4000) });
  },
  async disconnect({ secrets, call }) {
    await telegram.api(call, secrets.botToken, "deleteWebhook", { drop_pending_updates: true }).catch(() => {});
  },
};

const slack = {
  kind: "slack",
  label: "Slack",
  mode: "after",
  validate(input) {
    const botToken = String(input?.botToken || "").trim();
    const signingSecret = String(input?.signingSecret || "").trim();
    if (!/^xoxb-[A-Za-z0-9-]{20,}$/.test(botToken)) throw fail(400, "That isn't a Slack bot token. It starts with xoxb- (OAuth & Permissions → Bot User OAuth Token).", "invalid-token");
    if (!/^[a-f0-9]{32}$/.test(signingSecret)) throw fail(400, "That isn't a Slack signing secret (32 letters and digits, under Basic Information → App Credentials).", "invalid-secret");
    return { secrets: { botToken, signingSecret }, config: {} };
  },
  async connect({ secrets, hookUrl, call }) {
    const result = await call(`${slack.base()}/auth.test`, { method: "POST", headers: { Authorization: `Bearer ${secrets.botToken}` }, label: "Slack" });
    if (!result.data?.ok) throw fail(400, result.data?.error === "invalid_auth" ? "Slack didn't accept that bot token." : `Slack: ${clip(result.data?.error || result.status, 120)}`, "slack");
    return {
      name: `${result.data.team} · @${result.data.user}`,
      config: { team: result.data.team, teamId: result.data.team_id, botUserId: result.data.user_id },
      setup: {
        done: false,
        webhookUrl: hookUrl,
        steps: [
          "In your Slack app → Event Subscriptions, turn on events and paste the Request URL below. Slack checks it right away.",
          "Under Subscribe to bot events, add message.im and save.",
          "App Home → Messages Tab: turn it on and allow messages from the tab. Reinstall the app if Slack asks.",
          "In Slack, open a direct message with the app and send the pairing code.",
        ],
      },
    };
  },
  base: () => API.slack,
  verify({ req, raw, secrets, now = Date.now() }) {
    const timestamp = Number(req.get("x-slack-request-timestamp"));
    const signature = String(req.get("x-slack-signature") || "");
    if (!Number.isFinite(timestamp) || Math.abs(now / 1000 - timestamp) > 300) return false;
    return safeEqual(signature, `v0=${hmacHex(secrets.signingSecret, `v0:${timestamp}:${raw.toString("utf8")}`)}`);
  },
  handshake({ body }) {
    return body?.type === "url_verification" ? { status: 200, body: { challenge: String(body.challenge || "") }, verified: true } : null;
  },
  parse(body, { config }) {
    const event = body?.event;
    if (body?.type !== "event_callback" || event?.type !== "message" || event.subtype || event.bot_id || typeof event.text !== "string") return null;
    if (event.user && event.user === config.botUserId) return null;
    return { eventId: String(body.event_id || event.client_msg_id || event.ts), senderId: String(event.user || ""), senderName: "", chatId: String(event.channel), private: event.channel_type === "im", text: event.text };
  },
  async send({ secrets, message, text, call }) {
    const result = await call(`${slack.base()}/chat.postMessage`, { method: "POST", headers: { Authorization: `Bearer ${secrets.botToken}` }, body: { channel: message.chatId, text: clip(text, 3900) }, label: "Slack" });
    if (!result.data?.ok) throw fail(502, `Slack: ${clip(result.data?.error, 120)}`, "slack");
  },
  async disconnect() {},
};

const DISCORD_SPKI = Buffer.from("302a300506032b6570032100", "hex");
const discord = {
  kind: "discord",
  label: "Discord",
  mode: "after",
  validate(input) {
    const botToken = String(input?.botToken || "").trim();
    if (!/^[A-Za-z0-9._-]{50,100}$/.test(botToken)) throw fail(400, "That isn't a Discord bot token (Developer Portal → your app → Bot → Reset Token).", "invalid-token");
    return { secrets: { botToken }, config: {} };
  },
  async connect({ secrets, hookUrl, call }) {
    const auth = { Authorization: `Bot ${secrets.botToken}` };
    const me = await call(`${API.discord}/applications/@me`, { headers: auth, label: "Discord" });
    if (me.status === 401) throw fail(400, "Discord didn't accept that bot token.", "discord");
    if (!me.ok || !me.data?.id || !/^[a-f0-9]{64}$/.test(String(me.data.verify_key || ""))) throw fail(502, `Discord: ${clip(me.data?.message || me.status, 120)}`, "discord");
    // /hannah message:<text>, usable in DMs with the app and wherever it's installed.
    const command = await call(`${API.discord}/applications/${me.data.id}/commands`, {
      method: "PUT", headers: auth, label: "Discord",
      body: [{ name: "hannah", description: "Talk to HANNAH", type: 1, integration_types: [0, 1], contexts: [0, 1, 2], options: [{ type: 3, name: "message", description: "What to say to HANNAH", required: true, max_length: 2000 }] }],
    });
    if (!command.ok) throw fail(502, `Discord didn't register the /hannah command: ${clip(command.data?.message || command.status, 120)}`, "discord");
    return {
      name: `${me.data.name} (Discord)`,
      config: { applicationId: me.data.id, publicKey: me.data.verify_key },
      setup: {
        done: false,
        webhookUrl: hookUrl,
        installUrl: `https://discord.com/oauth2/authorize?client_id=${me.data.id}&integration_type=1&scope=applications.commands`,
        steps: [
          "Developer Portal → your app → General Information: paste the Interactions Endpoint URL below and save. Discord checks it right away.",
          "Add the app to your account with the install link (User Install).",
          "In any DM, type /hannah and send the pairing code as the message.",
        ],
      },
    };
  },
  verify({ req, raw, config }) {
    try {
      const signature = Buffer.from(String(req.get("x-signature-ed25519") || ""), "hex");
      const timestamp = String(req.get("x-signature-timestamp") || "");
      if (signature.length !== 64 || !timestamp || !config.publicKey) return false;
      const key = crypto.createPublicKey({ key: Buffer.concat([DISCORD_SPKI, Buffer.from(config.publicKey, "hex")]), format: "der", type: "spki" });
      return crypto.verify(null, Buffer.concat([Buffer.from(timestamp), raw]), key, signature);
    } catch {
      return false;
    }
  },
  handshake({ body }) {
    return body?.type === 1 ? { status: 200, body: { type: 1 }, verified: true } : null;
  },
  parse(body) {
    if (body?.type !== 2 || body.data?.name !== "hannah") return null;
    const user = body.member?.user || body.user || {};
    const text = (body.data.options || []).find((option) => option.name === "message")?.value;
    if (typeof text !== "string") return null;
    const inDm = body.context === 1 || body.channel?.type === 1;
    return { eventId: String(body.id), senderId: String(user.id || ""), senderName: user.global_name || user.username || "", chatId: String(body.channel_id || body.channel?.id || user.id), private: true, ephemeral: !inDm, interactionToken: String(body.token || ""), text };
  },
  // Discord needs an answer within 3 seconds: "thinking…", then the reply replaces it.
  ack: (message) => ({ type: 5, data: message?.ephemeral ? { flags: 64 } : {} }),
  async send({ config, message, text, call }) {
    const result = await call(`${API.discord}/webhooks/${config.applicationId}/${message.interactionToken}/messages/@original`, { method: "PATCH", body: { content: clip(text, 2000) }, label: "Discord" });
    if (!result.ok) throw fail(502, `Discord: ${clip(result.data?.message || result.status, 120)}`, "discord");
  },
  async disconnect() {},
};

const gchat = {
  kind: "gchat",
  label: "Google Chat",
  mode: "sync",
  validate(input) {
    const projectNumber = String(input?.projectNumber || "").trim();
    if (!/^\d{6,20}$/.test(projectNumber)) throw fail(400, "That isn't a Google Cloud project number (digits only, on the project's dashboard).", "invalid-project");
    return { secrets: { projectNumber }, config: { projectNumber } };
  },
  // Google Chat signs every request; there's no token to check beforehand.
  async connect({ config, hookUrl }) {
    return {
      name: `Google Chat (project ${config.projectNumber})`,
      config,
      setup: {
        done: false,
        webhookUrl: hookUrl,
        steps: [
          "Google Cloud console → APIs & Services → enable the Google Chat API → Configuration.",
          "App name HANNAH; Connection settings: HTTP endpoint URL (paste the URL below); Authentication Audience: Project Number.",
          "Visibility: yourself (or people you choose), then save.",
          "In Google Chat, start a chat with HANNAH and send the pairing code.",
        ],
      },
    };
  },
  async verify({ req, config, fetchImpl }) {
    const token = /^Bearer\s+(.+)$/i.exec(String(req.get("authorization") || ""))?.[1];
    if (!token) return false;
    const result = await verifyJwt(fetchImpl, token, { keysUrl: API.googleChatCerts, kind: "x509", issuer: "chat@system.gserviceaccount.com", audience: config.projectNumber });
    return Boolean(result);
  },
  parse(body) {
    // Google Chat's HTTP event: { type, message: { name, text, argumentText, sender }, space: { type } }
    if (body?.type === "ADDED_TO_SPACE") return { eventId: `added:${body.space?.name}:${body.eventTime}`, senderId: String(body.user?.name || ""), senderName: body.user?.displayName || "", chatId: String(body.space?.name || ""), private: body.space?.type === "DM" || body.space?.spaceType === "DIRECT_MESSAGE", text: "", added: true };
    if (body?.type !== "MESSAGE" || !body.message) return null;
    const sender = body.message.sender || body.user || {};
    if (sender.type === "BOT") return null;
    return { eventId: String(body.message.name || body.eventTime), senderId: String(sender.name || ""), senderName: sender.displayName || "", chatId: String(body.space?.name || ""), private: body.space?.type === "DM" || body.space?.spaceType === "DIRECT_MESSAGE" || body.space?.singleUserBotDm === true, text: String(body.message.argumentText || body.message.text || "").trim() };
  },
  reply: (text) => ({ text: clip(text, 4000) }),
  async send() { throw fail(500, "Google Chat replies go in the response.", "internal"); },
  async disconnect() {},
};

const TEAMS_SERVICE_HOST = /^(?:[a-z0-9-]+\.)*(?:botframework\.com|botframework\.us|trafficmanager\.net|teams\.microsoft\.com)$/i;
const teams = {
  kind: "teams",
  label: "Microsoft Teams",
  mode: "after",
  validate(input) {
    const appId = String(input?.appId || "").trim().toLowerCase();
    const appPassword = String(input?.appPassword || "").trim();
    const tenantId = String(input?.tenantId || "").trim().toLowerCase();
    const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (!guid.test(appId)) throw fail(400, "That isn't a Microsoft App ID (a GUID, on the Azure Bot's Configuration page).", "invalid-app");
    if (appPassword.length < 20) throw fail(400, "Paste the client secret's value (Azure Bot → Configuration → Manage Password → New client secret).", "invalid-secret");
    if (tenantId && !guid.test(tenantId)) throw fail(400, "The tenant ID is a GUID (only for single-tenant bots).", "invalid-tenant");
    return { secrets: { appPassword }, config: { appId, tenantId: tenantId || null } };
  },
  async token({ secrets, config, call }) {
    const result = await call(`${API.msLogin}/${config.tenantId || "botframework.com"}/oauth2/v2.0/token`, { method: "POST", form: { grant_type: "client_credentials", client_id: config.appId, client_secret: secrets.appPassword, scope: "https://api.botframework.com/.default" }, label: "Microsoft" });
    if (!result.ok || !result.data?.access_token) throw fail(400, `Microsoft didn't accept the app ID and secret: ${clip(result.data?.error_description || result.data?.error || result.status, 200)}`, "teams");
    return result.data.access_token;
  },
  async connect({ secrets, config, hookUrl, call }) {
    await teams.token({ secrets, config, call });
    return {
      name: "Microsoft Teams bot",
      config,
      setup: {
        done: false,
        webhookUrl: hookUrl,
        steps: [
          "Azure portal → your Azure Bot → Configuration: paste the Messaging endpoint below and apply.",
          "Channels → Microsoft Teams: add it, then use “Open in Teams”.",
          "In the chat with the bot, send the pairing code.",
        ],
      },
    };
  },
  async verify({ req, body, config, fetchImpl }) {
    const token = /^Bearer\s+(.+)$/i.exec(String(req.get("authorization") || ""))?.[1];
    if (!token) return false;
    const result = await verifyJwt(fetchImpl, token, { keysUrl: API.botOpenId, kind: "openid", issuer: "https://api.botframework.com", audience: config.appId });
    if (!result) return false;
    // The token names the service the reply must go to; it must be the one in the activity.
    if (result.claims.serviceurl && String(result.claims.serviceurl).replace(/\/$/, "") !== String(body?.serviceUrl || "").replace(/\/$/, "")) return false;
    if (Array.isArray(result.endorsements) && body?.channelId && !result.endorsements.includes(body.channelId)) return false;
    return true;
  },
  parse(body) {
    if (body?.type !== "message" || typeof body.text !== "string") return null;
    let service;
    try { service = new URL(String(body.serviceUrl || "")); } catch { return null; }
    if (service.protocol !== "https:" || !TEAMS_SERVICE_HOST.test(service.hostname)) return null;
    const text = body.text.replace(/<at>[^<]*<\/at>/g, "").replace(/<[^>]+>/g, "").trim();
    return { eventId: String(body.id), senderId: String(body.from?.aadObjectId || body.from?.id || ""), senderName: body.from?.name || "", chatId: String(body.conversation?.id || ""), private: body.conversation?.conversationType === "personal", text, serviceUrl: service.href.replace(/\/?$/, "/"), activityId: String(body.id), bot: body.recipient || null, from: body.from || null };
  },
  async send({ secrets, config, message, text, call }) {
    const token = await teams.token({ secrets, config, call });
    const result = await call(`${message.serviceUrl}v3/conversations/${encodeURIComponent(message.chatId)}/activities/${encodeURIComponent(message.activityId)}`, {
      method: "POST", headers: { Authorization: `Bearer ${token}` }, label: "Microsoft Teams",
      body: { type: "message", text: clip(text, 4000), from: message.bot, recipient: message.from, replyToId: message.activityId },
    });
    if (!result.ok) throw fail(502, `Teams: ${clip(result.data?.error?.message || result.status, 120)}`, "teams");
  },
  async disconnect() {},
};

const whatsapp = {
  kind: "whatsapp",
  label: "WhatsApp",
  mode: "after",
  validate(input) {
    const phoneNumberId = String(input?.phoneNumberId || "").trim();
    const accessToken = String(input?.accessToken || "").trim();
    const appSecret = String(input?.appSecret || "").trim();
    if (!/^\d{8,20}$/.test(phoneNumberId)) throw fail(400, "That isn't a WhatsApp phone number ID (digits, under WhatsApp → API Setup).", "invalid-number");
    if (accessToken.length < 40) throw fail(400, "Paste a permanent access token (a system user token with whatsapp_business_messaging).", "invalid-token");
    if (!/^[a-f0-9]{32}$/.test(appSecret)) throw fail(400, "That isn't a Meta app secret (32 letters and digits, App settings → Basic).", "invalid-secret");
    return { secrets: { accessToken, appSecret }, config: { phoneNumberId } };
  },
  async connect({ secrets, config, hookUrl, verifyToken, call }) {
    const result = await call(`${API.graph}/${config.phoneNumberId}?fields=display_phone_number,verified_name`, { headers: { Authorization: `Bearer ${secrets.accessToken}` }, label: "Meta" });
    if (!result.ok) throw fail(400, `Meta didn't accept the phone number ID and token: ${clip(result.data?.error?.message || result.status, 200)}`, "whatsapp");
    const number = String(result.data.display_phone_number || "");
    return {
      name: `${result.data.verified_name || "WhatsApp"} (${number})`,
      config: { ...config, displayNumber: number },
      setup: {
        done: false,
        webhookUrl: hookUrl,
        verifyToken,
        steps: [
          "Meta for Developers → your app → WhatsApp → Configuration → Webhook: paste the Callback URL and Verify token below, then Verify and save.",
          "Under Webhook fields, subscribe to messages.",
          "From your phone, send the pairing code to the business number (the link fills it in).",
        ],
      },
    };
  },
  pairingLink: (config, code) => (config.displayNumber ? `https://wa.me/${config.displayNumber.replace(/\D/g, "")}?text=${encodeURIComponent(code)}` : null),
  handshake({ req, row }) {
    if (req.method !== "GET") return null;
    const given = String(req.query["hub.verify_token"] || "");
    if (req.query["hub.mode"] !== "subscribe" || !given || !safeEqual(crypto.createHash("sha256").update(given).digest("hex"), row.webhook_secret_hash)) return { status: 403, body: { error: "Not authorized." } };
    return { status: 200, text: String(req.query["hub.challenge"] || ""), verified: true };
  },
  verify({ req, raw, secrets }) {
    const signature = String(req.get("x-hub-signature-256") || "");
    return Boolean(signature) && safeEqual(signature, `sha256=${hmacHex(secrets.appSecret, raw)}`);
  },
  parse(body, { config }) {
    for (const entry of body?.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        if (value.metadata?.phone_number_id && value.metadata.phone_number_id !== config.phoneNumberId) continue;
        const message = (value.messages || []).find((item) => item.type === "text" && item.text?.body);
        if (!message) continue;
        const contact = (value.contacts || []).find((item) => item.wa_id === message.from) || value.contacts?.[0];
        return { eventId: String(message.id), senderId: String(message.from), senderName: contact?.profile?.name || "", chatId: String(message.from), private: true, text: message.text.body };
      }
    }
    return null;
  },
  async send({ secrets, config, message, text, call }) {
    const result = await call(`${API.graph}/${config.phoneNumberId}/messages`, { method: "POST", headers: { Authorization: `Bearer ${secrets.accessToken}` }, body: { messaging_product: "whatsapp", to: message.chatId, type: "text", text: { body: clip(text, 4000) } }, label: "WhatsApp" });
    if (!result.ok) throw fail(502, `WhatsApp: ${clip(result.data?.error?.message || result.status, 160)}`, "whatsapp");
  },
  async disconnect() {},
};

const DRIVERS = { telegram, slack, discord, gchat, teams, whatsapp };

module.exports = { DRIVERS, callJson, verifyJwt, safeEqual };
