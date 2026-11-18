"use strict";

/**
 * More of the user's own mail and chat, through the same Google and Microsoft
 * connections (server/connections.js holds the tokens, sealed in the vault):
 *
 * - Reply drafts that stay in the conversation (Gmail threadId with
 *   In-Reply-To/References; Outlook createReply). Drafts only: sending is the
 *   separate, approved send.
 * - Mail that still needs a reply: the newest message in a conversation is
 *   from someone else and nothing was sent after it (Gmail threads; Outlook
 *   conversations checked against Sent Items). Automated senders are skipped.
 * - Organizing: archive and labels (Gmail, which needs the gmail.modify
 *   permission) or categories (Outlook).
 * - Attachments: names, types and sizes, and one file's bytes (up to 10 MB).
 * - Google Chat as the user: spaces they're in, recent messages there, and an
 *   approved message to a space. Only what the signed-in account can see;
 *   Google asks for these permissions separately ("Also connect Google Chat").
 *
 * Every function takes a fetch and an access token and does real API calls;
 * nothing here invents content. Errors from the provider become HTTP errors
 * with a message the person can act on.
 */

const fail = (status, message, reason) => Object.assign(new Error(message), { status, reason });

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const GRAPH = "https://graph.microsoft.com/v1.0/me";
const CHAT = "https://chat.googleapis.com/v1";
const GMAIL_MODIFY = "https://www.googleapis.com/auth/gmail.modify";
const CHAT_SCOPES = ["https://www.googleapis.com/auth/chat.spaces.readonly", "https://www.googleapis.com/auth/chat.messages.readonly", "https://www.googleapis.com/auth/chat.messages.create"];
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const AUTOMATED = /(^|[<\s"])(no-?reply|do-?not-?reply|notifications?|mailer-daemon|bounce|newsletter|marketing|updates?)@/i;

async function call(fetchImpl, token, url, { method = "GET", body, headers = {} } = {}) {
  const response = await fetchImpl(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!response.ok) {
    if (response.status === 403) throw fail(403, "The connected account didn't allow this. Reconnect it in Settings → Calendar and email and accept every permission HANNAH asks for.", "scope-missing");
    if (response.status === 404) throw fail(404, "That item wasn't found in the connected account.", "not-found");
    if (response.status === 429) throw Object.assign(fail(429, "The provider is limiting requests right now. Try again in a minute.", "rate-limited"), { retryAfter: Number(response.headers.get("retry-after")) || 60 });
    throw fail(response.status === 401 ? 401 : 502, `The provider answered ${response.status}.`, response.status === 401 ? "reconnect" : "provider-error");
  }
  return data;
}

const header = (headers, name) => (headers || []).find((item) => item.name?.toLowerCase() === name)?.value || "";
const addressOf = (value) => (/<([^>]+)>/.exec(String(value || ""))?.[1] || String(value || "")).trim().toLowerCase();
const encodedHeader = (text) => (/^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`);
const oneLine = (value, max = 998) => String(value ?? "").replace(/[\r\n]+/g, " ").slice(0, max);

/** Attachments of a Gmail message payload: the parts with a filename. */
function gmailAttachments(payload) {
  const out = [];
  const stack = [payload];
  while (stack.length) {
    const part = stack.shift();
    if (!part) continue;
    if (part.filename && part.body?.attachmentId) out.push({ id: part.body.attachmentId, name: part.filename.slice(0, 200), mimeType: part.mimeType || "application/octet-stream", size: Number(part.body.size) || 0 });
    stack.push(...(part.parts || []));
  }
  return out.slice(0, 50);
}

/** Details the reading view doesn't show: thread, Message-ID, labels and attachments. */
async function messageDetails(fetchImpl, providerId, token, id) {
  if (providerId === "google") {
    const item = await call(fetchImpl, token, `${GMAIL}/messages/${encodeURIComponent(id)}?format=full`);
    return { threadId: item.threadId, messageId: header(item.payload?.headers, "message-id"), labels: item.labelIds || [], attachments: gmailAttachments(item.payload) };
  }
  const item = await call(fetchImpl, token, `${GRAPH}/messages/${encodeURIComponent(id)}?$select=conversationId,internetMessageId,categories,hasAttachments`);
  const attachments = item.hasAttachments ? ((await call(fetchImpl, token, `${GRAPH}/messages/${encodeURIComponent(id)}/attachments?$select=id,name,contentType,size`)).value || []).map((entry) => ({ id: entry.id, name: String(entry.name || "").slice(0, 200), mimeType: entry.contentType || "application/octet-stream", size: Number(entry.size) || 0 })) : [];
  return { threadId: item.conversationId, messageId: item.internetMessageId || "", labels: item.categories || [], attachments };
}

/** One attachment's bytes. Refuses files over 10 MB rather than truncating them. */
async function attachment(fetchImpl, providerId, token, messageId, attachmentId) {
  const details = await messageDetails(fetchImpl, providerId, token, messageId);
  const meta = details.attachments.find((entry) => entry.id === attachmentId);
  if (!meta) throw fail(404, "That attachment isn't on this message.", "not-found");
  if (meta.size > MAX_ATTACHMENT_BYTES) throw fail(413, `${meta.name} is ${(meta.size / 1048576).toFixed(1)} MB; HANNAH reads attachments up to 10 MB. Open it in your mail app.`, "too-large");
  if (providerId === "google") {
    const data = await call(fetchImpl, token, `${GMAIL}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
    return { ...meta, bytes: Buffer.from(String(data.data || ""), "base64url") };
  }
  const data = await call(fetchImpl, token, `${GRAPH}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
  if (data["@odata.type"] && data["@odata.type"] !== "#microsoft.graph.fileAttachment") throw fail(415, "That attachment is a linked item, not a file.", "not-a-file");
  return { ...meta, bytes: Buffer.from(String(data.contentBytes || ""), "base64") };
}

/** A reply draft in the same conversation. The draft is saved, never sent. */
async function replyDraft(fetchImpl, providerId, token, { id, body, replyAll = false, me = "" }) {
  const text = String(body ?? "").slice(0, 50_000);
  if (!text.trim()) throw fail(400, "Write the reply.", "bad-request");
  if (providerId === "google") {
    const item = await call(fetchImpl, token, `${GMAIL}/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Reply-To`);
    const headers = item.payload?.headers;
    const messageId = oneLine(header(headers, "message-id"));
    const references = oneLine(`${header(headers, "references")} ${messageId}`.trim());
    const subject = header(headers, "subject");
    const replyTo = header(headers, "reply-to") || header(headers, "from");
    const mine = String(me || "").toLowerCase();
    const to = [replyTo];
    const cc = replyAll ? [...header(headers, "to").split(","), ...header(headers, "cc").split(",")].map((value) => value.trim()).filter((value) => value && addressOf(value) !== mine && addressOf(value) !== addressOf(replyTo)) : [];
    const lines = [
      `To: ${oneLine(to.join(", "))}`,
      ...(cc.length ? [`Cc: ${oneLine(cc.join(", "))}`] : []),
      `Subject: ${encodedHeader(oneLine(/^re:/i.test(subject) ? subject : `Re: ${subject}`, 300))}`,
      ...(messageId ? [`In-Reply-To: ${messageId}`, `References: ${references}`] : []),
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(text, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n"),
    ];
    const draft = await call(fetchImpl, token, `${GMAIL}/drafts`, { method: "POST", body: { message: { raw: Buffer.from(lines.join("\r\n")).toString("base64url"), threadId: item.threadId } } });
    return { provider: "google", id: draft.id, threadId: item.threadId, to: addressOf(replyTo), cc: cc.map(addressOf), link: "https://mail.google.com/mail/u/0/#drafts", sent: false };
  }
  // Outlook makes the reply itself (recipients, subject, quoted thread); the text goes on top.
  const draft = await call(fetchImpl, token, `${GRAPH}/messages/${encodeURIComponent(id)}/${replyAll ? "createReplyAll" : "createReply"}`, { method: "POST", body: { comment: text } });
  return { provider: "microsoft", id: draft.id, threadId: draft.conversationId, to: (draft.toRecipients || []).map((entry) => entry.emailAddress?.address).filter(Boolean), link: draft.webLink || "", sent: false };
}

/**
 * Conversations where the newest message is from someone else and nothing was
 * sent after it, newest first. Automated senders (no-reply, notifications,
 * newsletters) and Gmail's Promotions, Social and Updates tabs are left out.
 */
async function needsReply(fetchImpl, providerId, token, { days = 7, max = 15, me = "" } = {}) {
  const mine = String(me || "").toLowerCase();
  const window = Math.max(1, Math.min(30, Number(days) || 7));
  const limit = Math.max(1, Math.min(25, Number(max) || 15));
  if (providerId === "google") {
    const params = new URLSearchParams({ maxResults: String(Math.min(50, limit * 2)), q: `in:inbox newer_than:${window}d -category:promotions -category:social -category:updates -category:forums` });
    const list = await call(fetchImpl, token, `${GMAIL}/threads?${params}`);
    const threads = await Promise.all((list.threads || []).map((thread) => call(fetchImpl, token, `${GMAIL}/threads/${encodeURIComponent(thread.id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)));
    const out = [];
    for (const thread of threads) {
      const messages = thread.messages || [];
      const last = messages.at(-1);
      if (!last) continue;
      const from = header(last.payload?.headers, "from");
      if ((last.labelIds || []).includes("SENT") || (mine && addressOf(from) === mine) || AUTOMATED.test(from)) continue;
      out.push({ provider: "google", id: last.id, threadId: thread.id, from, subject: header(messages[0].payload?.headers, "subject") || "(no subject)", date: last.internalDate ? new Date(Number(last.internalDate)).toISOString() : "", snippet: last.snippet || "", messages: messages.length, unread: (last.labelIds || []).includes("UNREAD"), link: `https://mail.google.com/mail/u/0/#all/${thread.id}` });
      if (out.length >= limit) break;
    }
    return out;
  }
  const since = new Date(Date.now() - window * 86_400_000).toISOString();
  const params = new URLSearchParams({ $top: String(Math.min(50, limit * 2)), $filter: `receivedDateTime ge ${since}`, $orderby: "receivedDateTime desc", $select: "id,subject,from,receivedDateTime,bodyPreview,isRead,webLink,conversationId,inferenceClassification" });
  const inbox = await call(fetchImpl, token, `${GRAPH}/mailFolders/inbox/messages?${params}`);
  const seen = new Set();
  const out = [];
  for (const item of inbox.value || []) {
    if (seen.has(item.conversationId)) continue;
    seen.add(item.conversationId);
    const from = item.from?.emailAddress ? `${item.from.emailAddress.name || ""} <${item.from.emailAddress.address || ""}>`.trim() : "";
    if (item.inferenceClassification === "other" || AUTOMATED.test(from) || (mine && addressOf(from) === mine)) continue;
    const filter = new URLSearchParams({ $filter: `conversationId eq '${String(item.conversationId).replace(/'/g, "''")}'`, $select: "sentDateTime", $top: "10" });
    const sent = await call(fetchImpl, token, `${GRAPH}/mailFolders/sentitems/messages?${filter}`);
    if ((sent.value || []).some((entry) => Date.parse(entry.sentDateTime) >= Date.parse(item.receivedDateTime))) continue;
    out.push({ provider: "microsoft", id: item.id, threadId: item.conversationId, from, subject: item.subject || "(no subject)", date: item.receivedDateTime, snippet: item.bodyPreview || "", unread: item.isRead === false, link: item.webLink || "" });
    if (out.length >= limit) break;
  }
  return out;
}

/** Archive a message or add labels (Gmail) / categories (Outlook). Never deletes. */
async function organize(fetchImpl, providerId, token, { id, archive = false, labels = [], scopes = "" }) {
  const names = [...new Set((Array.isArray(labels) ? labels : []).map((label) => oneLine(label, 100).trim()).filter(Boolean))].slice(0, 5);
  if (!archive && !names.length) throw fail(400, "Say whether to archive it or which labels to add.", "bad-request");
  if (providerId === "google") {
    if (!String(scopes).split(/\s+/).includes(GMAIL_MODIFY)) throw fail(403, "Organizing Gmail needs one more permission. Disconnect and connect Google again in Settings → Calendar and email.", "scope-missing");
    const existing = names.length ? (await call(fetchImpl, token, `${GMAIL}/labels`)).labels || [] : [];
    const addLabelIds = [];
    for (const name of names) {
      const found = existing.find((label) => label.name.toLowerCase() === name.toLowerCase());
      addLabelIds.push(found ? found.id : (await call(fetchImpl, token, `${GMAIL}/labels`, { method: "POST", body: { name, labelListVisibility: "labelShow", messageListVisibility: "show" } })).id);
    }
    const result = await call(fetchImpl, token, `${GMAIL}/messages/${encodeURIComponent(id)}/modify`, { method: "POST", body: { addLabelIds, removeLabelIds: archive ? ["INBOX"] : [] } });
    return { provider: "google", id, archived: archive && !(result.labelIds || []).includes("INBOX"), labels: names };
  }
  let messageId = id;
  if (names.length) {
    const current = await call(fetchImpl, token, `${GRAPH}/messages/${encodeURIComponent(id)}?$select=categories`);
    await call(fetchImpl, token, `${GRAPH}/messages/${encodeURIComponent(id)}`, { method: "PATCH", body: { categories: [...new Set([...(current.categories || []), ...names])] } });
  }
  if (archive) messageId = (await call(fetchImpl, token, `${GRAPH}/messages/${encodeURIComponent(id)}/move`, { method: "POST", body: { destinationId: "archive" } })).id || id;
  return { provider: "microsoft", id: messageId, archived: Boolean(archive), labels: names };
}

// ---------- Google Chat, as the user ----------

const hasChatScopes = (scopes) => CHAT_SCOPES.slice(0, 2).every((scope) => String(scopes || "").split(/\s+/).includes(scope));
const SPACE = /^spaces\/[A-Za-z0-9_-]{1,100}$/;

async function chatSpaces(fetchImpl, token) {
  const out = [];
  let pageToken = "";
  for (let page = 0; page < 3; page += 1) {
    const params = new URLSearchParams({ pageSize: "100", ...(pageToken ? { pageToken } : {}) });
    const data = await call(fetchImpl, token, `${CHAT}/spaces?${params}`);
    for (const space of data.spaces || []) out.push({ name: space.name, displayName: space.displayName || (space.spaceType === "DIRECT_MESSAGE" ? "Direct message" : "Unnamed space"), type: space.spaceType || space.type || "SPACE", lastActiveTime: space.lastActiveTime || null });
    pageToken = data.nextPageToken || "";
    if (!pageToken) break;
  }
  return out.sort((a, b) => String(b.lastActiveTime || "").localeCompare(String(a.lastActiveTime || "")));
}

async function chatMessages(fetchImpl, token, space, { max = 25, since } = {}) {
  if (!SPACE.test(String(space))) throw fail(400, "That isn't a Google Chat space (spaces/…).", "bad-request");
  const params = new URLSearchParams({ pageSize: String(Math.max(1, Math.min(100, Number(max) || 25))), orderBy: "createTime desc", ...(since ? { filter: `createTime > "${new Date(since).toISOString()}"` } : {}) });
  const data = await call(fetchImpl, token, `${CHAT}/${space}/messages?${params}`);
  return (data.messages || []).map((message) => ({ name: message.name, sender: message.sender?.displayName || message.sender?.name || "", senderType: message.sender?.type || "", text: String(message.text || message.formattedText || "").slice(0, 4000), createTime: message.createTime, thread: message.thread?.name || null })).reverse();
}

async function chatSend(fetchImpl, token, space, { text, thread }) {
  if (!SPACE.test(String(space))) throw fail(400, "That isn't a Google Chat space (spaces/…).", "bad-request");
  const body = String(text ?? "").slice(0, 4000);
  if (!body.trim()) throw fail(400, "Write the message.", "bad-request");
  const params = thread ? `?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD` : "";
  const message = await call(fetchImpl, token, `${CHAT}/${space}/messages${params}`, { method: "POST", body: { text: body, ...(thread ? { thread: { name: String(thread) } } : {}) } });
  return { name: message.name, createTime: message.createTime, sent: true };
}

module.exports = { AUTOMATED, CHAT_SCOPES, GMAIL_MODIFY, MAX_ATTACHMENT_BYTES, attachment, chatMessages, chatSend, chatSpaces, gmailAttachments, hasChatScopes, messageDetails, needsReply, organize, replyDraft };
