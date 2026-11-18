// Chat apps that live on this computer: iMessage (macOS Messages) and Signal
// (signal-cli). The rules are enforced here, in Electron's main process:
//
// - Off until the person turns a channel on in a system dialog.
// - HANNAH reads only messages from people the person approved (each one in a
//   system dialog). Anyone else who writes is listed as "asking", never answered.
// - HANNAH can only reply: one reply to a message an approved person sent in
//   the last 15 minutes. She can't start conversations or message anyone else.
// - Messages are read on this computer; the reply is written by the person's
//   AI through HANNAH's server (the web page asks, then calls reply).
//
// iMessage: reads ~/Library/Messages/chat.db read-only with macOS's sqlite3
// (needs Full Disk Access for HANNAH) and sends with the Messages app through
// AppleScript (macOS asks once to let HANNAH control Messages). Use a separate
// Apple ID on this Mac for HANNAH, as OpenClaw recommends, so your own
// conversations aren't involved.
//
// Signal: signal-cli (https://github.com/AsamK/signal-cli) with an account you
// registered or linked to it (`signal-cli link -n HANNAH`). Works wherever
// signal-cli runs (macOS, Windows, Linux).
//
// No Electron imports, so the rules can be tested with plain Node.
import { execFile as nodeExecFile } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

export const MESSAGE_LIMITS = Object.freeze({ replyWindowMs: 15 * 60_000, repliesPerMinute: 20, replyChars: 2000, allowed: 20, asking: 20, perPoll: 20 });

class MessagesError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const fail = (code, message) => { throw new MessagesError(code, message); };

/** Normalise a phone number or email so "+91 98765-43210" and "+919876543210" match. Exported for tests. */
export function normalizeHandle(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text.includes("@")) return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? text : "";
  const digits = text.replace(/[^\d+]/g, "");
  return /^\+?\d{6,16}$/.test(digits) ? digits : "";
}

/**
 * The text of a Messages row whose `text` column is empty: newer macOS keeps it
 * in `attributedBody`, an NSAttributedString in Apple's typedstream format. The
 * string follows the "NSString" class name: a "+" marker, then its length
 * (one byte, or 0x81 + 2 bytes / 0x82 + 4 bytes, little-endian). Exported for tests.
 */
export function attributedBodyText(hex) {
  if (!hex) return "";
  const bytes = Buffer.from(String(hex), "hex");
  const at = bytes.indexOf(Buffer.from("NSString"));
  if (at < 0) return "";
  let index = bytes.indexOf(0x2b, at + 8);
  if (index < 0 || index > at + 20) return "";
  index += 1;
  let length = bytes[index];
  index += 1;
  if (length === 0x81) { length = bytes.readUInt16LE(index); index += 2; }
  else if (length === 0x82) { length = bytes.readUInt32LE(index); index += 4; }
  return bytes.subarray(index, index + length).toString("utf8");
}

function run(execFile, program, args, { timeout = 15_000, env } = {}) {
  return new Promise((resolve) => {
    execFile(program, args, { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env }, (error, stdout, stderr) => resolve({ ok: !error, code: error?.code, stdout: String(stdout || ""), stderr: String(stderr || "") }));
  });
}
const toolEnv = () => ({ ...process.env, PATH: [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(path.delimiter) });

const SEND_SCRIPT = [
  "on run argv",
  "  set theHandle to item 1 of argv",
  "  set theText to item 2 of argv",
  "  tell application \"Messages\"",
  "    set theService to 1st account whose service type = iMessage",
  "    send theText to participant theHandle of theService",
  "  end tell",
  "end run",
].join("\n");

/** macOS Messages. */
export function createIMessageAdapter({ execFile = nodeExecFile, home = os.homedir(), platform = process.platform } = {}) {
  const database = path.join(home, "Library", "Messages", "chat.db");
  const query = async (sql) => {
    const result = await run(execFile, "/usr/bin/sqlite3", ["-readonly", "-json", database, sql]);
    if (!result.ok) {
      if (/authorization denied|unable to open|operation not permitted/i.test(result.stderr)) fail("FULL_DISK_ACCESS", "macOS hasn't given HANNAH Full Disk Access, which reading Messages needs. Open System Settings → Privacy & Security → Full Disk Access, turn on HANNAH, then quit and reopen HANNAH.");
      fail("MESSAGES_FAILED", `Messages couldn't be read: ${result.stderr.trim().slice(0, 200) || "unknown error"}`);
    }
    return result.stdout.trim() ? JSON.parse(result.stdout) : [];
  };
  return {
    kind: "imessage",
    label: "iMessage",
    available: platform === "darwin",
    reason: platform === "darwin" ? null : "iMessage is only on macOS.",
    async check() {
      await query("SELECT 1 AS ok");
      return { ok: true };
    },
    async latest() {
      const [row] = await query("SELECT COALESCE(MAX(ROWID), 0) AS id FROM message");
      return Number(row?.id || 0);
    },
    async receive(after) {
      const since = Math.max(0, Math.floor(Number(after) || 0));
      const rows = await query(`SELECT m.ROWID AS id, m.text AS text, hex(m.attributedBody) AS body, h.id AS handle FROM message m JOIN handle h ON m.handle_id = h.ROWID WHERE m.ROWID > ${since} AND m.is_from_me = 0 AND m.item_type = 0 ORDER BY m.ROWID LIMIT ${MESSAGE_LIMITS.perPoll * 5}`);
      return rows.map((row) => ({ id: String(row.id), cursor: Number(row.id), from: normalizeHandle(row.handle), name: "", text: String(row.text || attributedBodyText(row.body) || "").trim() })).filter((message) => message.from && message.text);
    },
    async send(to, text) {
      const result = await run(execFile, "osascript", ["-e", SEND_SCRIPT, to, text], { timeout: 20_000 });
      if (!result.ok) fail("SEND_FAILED", /not authori[sz]ed|-1743/i.test(result.stderr) ? "macOS didn't let HANNAH control Messages. Allow it in System Settings → Privacy & Security → Automation → HANNAH → Messages." : `Messages couldn't send it: ${result.stderr.trim().slice(0, 200)}`);
    },
  };
}

/** Signal through signal-cli. */
export function createSignalAdapter({ execFile = nodeExecFile, account = "", program = "signal-cli" } = {}) {
  const cli = (args, timeout) => run(execFile, program, account ? ["-a", account, ...args] : args, { timeout, env: toolEnv() });
  return {
    kind: "signal",
    label: "Signal",
    available: true,
    reason: null,
    async check() {
      const version = await run(execFile, program, ["--version"], { env: toolEnv() });
      if (!version.ok) fail("NO_SIGNAL_CLI", "signal-cli isn't installed (or isn't on the PATH). Install it from github.com/AsamK/signal-cli, then link it with: signal-cli link -n HANNAH");
      if (!account) fail("NO_ACCOUNT", "Enter the Signal number signal-cli uses.");
      const accounts = await run(execFile, program, ["-o", "json", "listAccounts"], { env: toolEnv() });
      const known = accounts.ok ? accounts.stdout.includes(account) : false;
      if (!known) fail("NO_ACCOUNT", `signal-cli has no account ${account}. Register or link it first (signal-cli link -n HANNAH).`);
      return { ok: true, version: version.stdout.trim().slice(0, 40) };
    },
    async latest() { return 0; },
    async receive() {
      const result = await cli(["-o", "json", "receive", "--timeout", "1"], 30_000);
      if (!result.ok) fail("RECEIVE_FAILED", `signal-cli couldn't receive: ${result.stderr.trim().slice(0, 200)}`);
      const messages = [];
      for (const line of result.stdout.split(/\r?\n/)) {
        let item;
        try { item = JSON.parse(line); } catch { continue; }
        const envelope = item.envelope || item;
        const data = envelope.dataMessage;
        if (!data?.message || data.groupInfo) continue;
        messages.push({ id: `${envelope.sourceNumber || envelope.source}:${envelope.timestamp}`, cursor: 0, from: normalizeHandle(envelope.sourceNumber || envelope.source), name: String(envelope.sourceName || "").slice(0, 80), text: String(data.message).trim() });
      }
      return messages.filter((message) => message.from && message.text);
    },
    async send(to, text) {
      const result = await cli(["send", "-m", text, to], 30_000);
      if (!result.ok) fail("SEND_FAILED", `signal-cli couldn't send it: ${result.stderr.trim().slice(0, 200)}`);
    },
  };
}

/**
 * @param {{ storePath: string, confirm: Function, record: Function, adapters?: object, execFile?: Function, platform?: string, home?: string, now?: () => number }} deps
 */
export function createLocalChannels(deps) {
  const now = deps.now ?? Date.now;
  let state = null;
  const pendingReplies = new Map(); // `${kind}:${messageId}` → { to, at }
  let replies = [];

  async function load() {
    if (state) return state;
    try { state = JSON.parse(await fsp.readFile(deps.storePath, "utf8")); } catch { state = {}; }
    for (const kind of ["imessage", "signal"]) state[kind] = { enabled: false, allowed: [], asking: [], cursor: 0, account: "", lastError: null, ...(state[kind] || {}) };
    return state;
  }
  async function save() {
    await fsp.mkdir(path.dirname(deps.storePath), { recursive: true });
    const temp = `${deps.storePath}.${process.pid}.tmp`;
    await fsp.writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await fsp.rename(temp, deps.storePath);
  }
  const adapterFor = (kind, settings) => {
    if (deps.adapters?.[kind]) return deps.adapters[kind];
    if (kind === "imessage") return createIMessageAdapter({ execFile: deps.execFile, home: deps.home, platform: deps.platform });
    if (kind === "signal") return createSignalAdapter({ execFile: deps.execFile, account: settings.account });
    fail("INVALID", "Unknown chat app.");
  };
  const kindOf = (value) => (value === "imessage" || value === "signal" ? value : fail("INVALID", "The chat app is iMessage or Signal."));
  const publicState = (kind, settings) => {
    const adapter = adapterFor(kind, settings);
    return { kind, label: adapter.label, available: adapter.available, reason: adapter.reason, enabled: settings.enabled, account: settings.account || null, allowed: settings.allowed, asking: settings.asking, lastError: settings.lastError };
  };

  return {
    async localChannelsStatus() {
      const current = await load();
      return { channels: ["imessage", "signal"].map((kind) => publicState(kind, current[kind])) };
    },

    /** Turn a channel on: checks it can read and send, then asks in a system dialog. */
    async enableLocalChannel({ kind: rawKind, account } = {}) {
      const kind = kindOf(rawKind);
      const current = await load();
      const settings = current[kind];
      if (kind === "signal") {
        const number = normalizeHandle(account || settings.account);
        if (!number || number.includes("@")) fail("INVALID", "Enter the Signal phone number signal-cli uses, with its country code (+…).");
        settings.account = number;
      }
      const adapter = adapterFor(kind, settings);
      if (!adapter.available) fail("UNAVAILABLE", adapter.reason);
      await adapter.check();
      const choice = await deps.confirm({
        title: `Let HANNAH answer ${adapter.label} messages?`,
        message: `HANNAH will read ${adapter.label} messages on this computer from people you approve, and reply to them with your AI.`,
        detail: `She only replies to someone who just wrote to her, never starts a conversation, and ignores everyone you haven't approved (they're listed for you). Messages are read here; each one and its reply go to your AI model through HANNAH's server.${kind === "imessage" ? "\n\nTip: sign this Mac's Messages in to a separate Apple ID for HANNAH, so your own conversations aren't involved." : ""}\n\nTurn it off any time in Marketplace → Chat apps.`,
        buttons: [`Turn on ${adapter.label}`, "Cancel"],
      });
      if (choice !== 0) fail("DENIED", `You declined. ${adapter.label} stays off.`);
      settings.enabled = true;
      settings.lastError = null;
      settings.cursor = await adapter.latest(); // only new messages from now on
      await save();
      await deps.record({ kind: "local-channel-on", detail: kind });
      return publicState(kind, settings);
    },

    async disableLocalChannel({ kind: rawKind } = {}) {
      const kind = kindOf(rawKind);
      const current = await load();
      current[kind].enabled = false;
      await save();
      await deps.record({ kind: "local-channel-off", detail: kind });
      return publicState(kind, current[kind]);
    },

    /** Approve someone (a number or an email): a system dialog shows exactly who. */
    async allowLocalSender({ kind: rawKind, handle } = {}) {
      const kind = kindOf(rawKind);
      const who = normalizeHandle(handle);
      if (!who) fail("INVALID", "That isn't a phone number (with country code) or an email address.");
      const current = await load();
      const settings = current[kind];
      if (settings.allowed.includes(who)) return publicState(kind, settings);
      if (settings.allowed.length >= MESSAGE_LIMITS.allowed) fail("LIMIT", `Up to ${MESSAGE_LIMITS.allowed} people can be approved.`);
      const choice = await deps.confirm({ title: "Approve someone for HANNAH?", message: `HANNAH will reply to ${kind === "imessage" ? "iMessages" : "Signal messages"} from ${who}.`, detail: "Only approve people you trust to use your AI.", buttons: ["Approve", "Cancel"] });
      if (choice !== 0) fail("DENIED", "You declined.");
      settings.allowed.push(who);
      settings.asking = settings.asking.filter((person) => person.from !== who);
      await save();
      await deps.record({ kind: "local-channel-allowed", detail: `${kind}: ${who}` });
      return publicState(kind, settings);
    },

    async removeLocalSender({ kind: rawKind, handle } = {}) {
      const kind = kindOf(rawKind);
      const who = normalizeHandle(handle);
      const current = await load();
      current[kind].allowed = current[kind].allowed.filter((item) => item !== who);
      current[kind].asking = current[kind].asking.filter((person) => person.from !== who);
      await save();
      return publicState(kind, current[kind]);
    },

    /** New messages from approved people on the channels that are on. Others are listed as asking. */
    async pollLocalChannels() {
      const current = await load();
      const messages = [];
      for (const kind of ["imessage", "signal"]) {
        const settings = current[kind];
        if (!settings.enabled) continue;
        const adapter = adapterFor(kind, settings);
        try {
          const received = await adapter.receive(settings.cursor);
          settings.lastError = null;
          for (const message of received) {
            if (message.cursor) settings.cursor = Math.max(settings.cursor, message.cursor);
            if (!settings.allowed.includes(message.from)) {
              if (!settings.asking.some((person) => person.from === message.from) && settings.asking.length < MESSAGE_LIMITS.asking) settings.asking.push({ from: message.from, name: message.name || null, at: now(), preview: message.text.slice(0, 80) });
              continue;
            }
            if (messages.length >= MESSAGE_LIMITS.perPoll) continue;
            pendingReplies.set(`${kind}:${message.id}`, { to: message.from, at: now() });
            messages.push({ kind, id: message.id, from: message.from, name: message.name || "", text: message.text.slice(0, 4000) });
          }
        } catch (error) {
          settings.lastError = error.message;
        }
      }
      await save();
      return { messages };
    },

    /** One reply to a message an approved person just sent. */
    async replyLocalChannel({ kind: rawKind, messageId, text } = {}) {
      const kind = kindOf(rawKind);
      const key = `${kind}:${String(messageId || "")}`;
      const pending = pendingReplies.get(key);
      if (!pending || pending.at < now() - MESSAGE_LIMITS.replyWindowMs) fail("NOT_A_REPLY", "HANNAH can only reply to a message an approved person sent in the last 15 minutes.");
      const current = await load();
      const settings = current[kind];
      if (!settings.enabled || !settings.allowed.includes(pending.to)) fail("NOT_ALLOWED", "That person isn't approved, or the channel is off.");
      const body = String(text || "").trim();
      if (!body) fail("INVALID", "The reply is empty.");
      replies = replies.filter((at) => at > now() - 60_000);
      if (replies.length >= MESSAGE_LIMITS.repliesPerMinute) fail("TOO_MANY", "Too many replies this minute.");
      pendingReplies.delete(key);
      replies.push(now());
      await adapterFor(kind, settings).send(pending.to, body.slice(0, MESSAGE_LIMITS.replyChars));
      await deps.record({ kind: "local-channel-replied", detail: `${kind}: ${pending.to}` });
      return { sent: true, to: pending.to };
    },
  };
}

export const LOCAL_CHANNEL_METHODS = Object.freeze(["localChannelsStatus", "enableLocalChannel", "disableLocalChannel", "allowLocalSender", "removeLocalSender", "pollLocalChannels", "replyLocalChannel"]);
