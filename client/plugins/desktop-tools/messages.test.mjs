// Rules for iMessage and Signal on this computer (electron/dist/messages.mjs),
// with stand-in adapters for the messages; the decoding of Messages' stored
// text and the handle matching are tested on real-shaped data.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { attributedBodyText, createIMessageAdapter, createLocalChannels, createSignalAdapter, normalizeHandle } from "./electron/dist/messages.mjs";

function setup({ answers = [] } = {}) {
  const inbox = [];
  const outbox = [];
  const adapter = (kind) => ({
    kind, label: kind === "imessage" ? "iMessage" : "Signal", available: true, reason: null,
    check: async () => ({ ok: true }),
    latest: async () => 100,
    receive: async (after) => inbox.filter((message) => message.kind === kind && (!message.cursor || message.cursor > after)).splice(0),
    send: async (to, text) => { outbox.push({ kind, to, text }); },
  });
  const dialogs = [];
  let clock = 1_000_000;
  const channels = createLocalChannels({
    storePath: path.join(mkdtempSync(path.join(tmpdir(), "hannah-local-")), "local-channels.json"),
    confirm: async (request) => { dialogs.push(request); return answers.length ? answers.shift() : 0; },
    record: async () => {},
    adapters: { imessage: adapter("imessage"), signal: adapter("signal") },
    now: () => clock,
  });
  const deliver = (kind, message) => { inbox.length = 0; inbox.push({ kind, ...message }); };
  return { channels, deliver, outbox, dialogs, tick: (ms) => { clock += ms; } };
}

test("off until turned on in a dialog; only approved people are read; others are listed as asking", async () => {
  const { channels, deliver, dialogs } = setup({ answers: [1] });
  await assert.rejects(channels.enableLocalChannel({ kind: "imessage" }), { code: "DENIED" });
  deliver("imessage", { id: "1", cursor: 101, from: "+919800000001", text: "hi" });
  assert.deepEqual((await channels.pollLocalChannels()).messages, [], "a channel that's off reads nothing");
  await channels.enableLocalChannel({ kind: "imessage" });
  assert.match(dialogs.at(-1).detail, /separate Apple ID/);
  deliver("imessage", { id: "2", cursor: 102, from: "+919800000002", text: "who are you?", name: "Stranger" });
  assert.deepEqual((await channels.pollLocalChannels()).messages, []);
  assert.equal((await channels.localChannelsStatus()).channels[0].asking[0].from, "+919800000002");
  await channels.allowLocalSender({ kind: "imessage", handle: "+91 98000-00002" });
  assert.match(dialogs.at(-1).message, /\+919800000002/);
  assert.deepEqual((await channels.localChannelsStatus()).channels[0].asking, [], "approving removes the request");
  deliver("imessage", { id: "3", cursor: 103, from: "+919800000002", text: "now?" });
  assert.deepEqual((await channels.pollLocalChannels()).messages.map((message) => message.text), ["now?"]);
});

test("replies only once, only to a message an approved person just sent", async () => {
  const { channels, deliver, outbox, tick } = setup();
  await channels.enableLocalChannel({ kind: "signal", account: "+1 555 010 0000" });
  await channels.allowLocalSender({ kind: "signal", handle: "+15550100001" });
  await assert.rejects(channels.replyLocalChannel({ kind: "signal", messageId: "made-up", text: "hello" }), { code: "NOT_A_REPLY" }, "can't start a conversation");
  deliver("signal", { id: "s1", from: "+15550100001", text: "What's 2+2?" });
  const [message] = (await channels.pollLocalChannels()).messages;
  assert.deepEqual(await channels.replyLocalChannel({ kind: "signal", messageId: message.id, text: "It's 4." }), { sent: true, to: "+15550100001" });
  assert.deepEqual(outbox, [{ kind: "signal", to: "+15550100001", text: "It's 4." }]);
  await assert.rejects(channels.replyLocalChannel({ kind: "signal", messageId: message.id, text: "again" }), { code: "NOT_A_REPLY" }, "one reply per message");
  deliver("signal", { id: "s2", from: "+15550100001", text: "late" });
  await channels.pollLocalChannels();
  tick(16 * 60_000);
  await assert.rejects(channels.replyLocalChannel({ kind: "signal", messageId: "s2", text: "too late" }), { code: "NOT_A_REPLY" });
  deliver("signal", { id: "s3", from: "+15550100001", text: "removed soon" });
  await channels.pollLocalChannels();
  await channels.removeLocalSender({ kind: "signal", handle: "+15550100001" });
  await assert.rejects(channels.replyLocalChannel({ kind: "signal", messageId: "s3", text: "no" }), { code: "NOT_ALLOWED" });
});

test("handles match however they're written; Messages' stored text is decoded", () => {
  assert.equal(normalizeHandle("+91 98765-43210"), "+919876543210");
  assert.equal(normalizeHandle("Harsh@Example.com"), "harsh@example.com");
  assert.equal(normalizeHandle("not a number"), "");
  // attributedBody as macOS stores it: …NSString, a marker, '+', the length, the UTF-8 text…
  const short = Buffer.concat([Buffer.from("040b73747265616d747970656481e803840140848484124e5341747472696275746564537472696e67", "hex"), Buffer.from("NSString"), Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b, 11]), Buffer.from("Hello there"), Buffer.from([0x86, 0x84])]);
  assert.equal(attributedBodyText(short.toString("hex")), "Hello there");
  const text = "é".repeat(150);
  const long = Buffer.concat([Buffer.from("NSString"), Buffer.from([0x01, 0x95, 0x84, 0x01, 0x2b, 0x81]), Buffer.from([Buffer.byteLength(text) & 0xff, Buffer.byteLength(text) >> 8]), Buffer.from(text)]);
  assert.equal(attributedBodyText(long.toString("hex")), text);
  assert.equal(attributedBodyText(""), "");
});

test("iMessage is macOS only; reading without Full Disk Access says how to allow it", async () => {
  assert.equal(createIMessageAdapter({ platform: "linux" }).available, false);
  const denied = createIMessageAdapter({ platform: "darwin", home: "/Users/x", execFile: (_program, _args, _options, callback) => callback(new Error("exit 1"), "", "Error: unable to open database \"/Users/x/Library/Messages/chat.db\": authorization denied") });
  await assert.rejects(denied.check(), { code: "FULL_DISK_ACCESS" });
  const calls = [];
  const sending = createIMessageAdapter({ platform: "darwin", execFile: (program, args, _options, callback) => { calls.push([program, args]); callback(null, "", ""); } });
  await sending.send("+919800000002", "hi \" & do shell script \"rm -rf ~\"");
  assert.equal(calls[0][0], "osascript");
  assert.deepEqual(calls[0][1].slice(2), ["+919800000002", "hi \" & do shell script \"rm -rf ~\""], "the text is an argument, never part of the script");
});

test("Signal: needs signal-cli and an account it knows; receive reads its JSON", async () => {
  const missing = createSignalAdapter({ account: "+15550100000", execFile: (_program, _args, _options, callback) => callback(Object.assign(new Error("spawn signal-cli ENOENT"), { code: "ENOENT" }), "", "") });
  await assert.rejects(missing.check(), { code: "NO_SIGNAL_CLI" });
  const lines = [JSON.stringify({ envelope: { sourceNumber: "+15550100001", sourceName: "Asha", timestamp: 1, dataMessage: { message: "hi" } } }), JSON.stringify({ envelope: { sourceNumber: "+15550100002", timestamp: 2, dataMessage: { message: "group", groupInfo: { groupId: "g" } } } }), "not json"];
  const working = createSignalAdapter({ account: "+15550100000", execFile: (_program, args, _options, callback) => callback(null, args.includes("receive") ? lines.join("\n") : args.includes("listAccounts") ? "[{\"number\":\"+15550100000\"}]" : "signal-cli 0.13.9", "") });
  await working.check();
  assert.deepEqual(await working.receive(), [{ id: "+15550100001:1", cursor: 0, from: "+15550100001", name: "Asha", text: "hi" }], "group messages are ignored");
});
