"use strict";
/**
 * A cloud computer's live view on the real app and a real headless Chromium:
 * the screencast stream, taking control, the person's own input, and the
 * teammate's browser waiting while the person has it. Skipped when
 * Playwright's Chromium isn't installed.
 */
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { after, before, test } = require("node:test");

process.env.NODE_ENV = "test";
process.env.HANNAH_API_TOKEN = "workforce-liveview-token-0123456789-abcdef";
process.env.DATABASE_URL = process.env.HANNAH_TEST_DB === "pglite" ? "postgres://pglite.local/hannah" : "sqlite::memory:";
process.env.HANNAH_VAULT_KEY = "e".repeat(64);
process.env.WORKFORCE_WORKER = "off";
// The test page is on this machine; the browser's proxy refuses internal addresses otherwise.
process.env.HANNAH_WORKFORCE_ALLOW_PRIVATE = "1";
process.env.HANNAH_WORKFORCE_DIR = require("node:path").join(require("node:os").tmpdir(), `hannah-liveview-${process.pid}`);
delete process.env.POSTGRES_URL;

const browser = require("./workforce/browser");

const PAGE = `<!doctype html><title>start</title>
<style>body{margin:0}#b{position:fixed;left:0;top:0;width:100vw;height:50vh}#q{position:fixed;left:0;top:50vh;width:100vw;height:50vh;font-size:40px}</style>
<button id="b" onclick="document.title='clicked:'+document.getElementById('q').value">Go</button><input id="q">`;

let site;
let server;
let base;
let session;

before(async () => {
  site = http.createServer((_req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(PAGE); }).listen(0, "127.0.0.1");
  await once(site, "listening");
  if (process.env.HANNAH_TEST_DB === "pglite") await require("./db").useDatabase(await require("./db/pglite-adapter").createPgliteAdapter());
  server = require("./index").listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}/api`;
  session = (await (await fetch(`${base}/account/register`, { method: "POST", headers: { "Content-Type": "application/json", "x-hannah-session": "bearer" }, body: JSON.stringify({ email: "watcher@example.com", password: "correct horse battery staple" }) })).json()).sessionToken;
});

after(async () => {
  await browser.closeAll();
  server?.close();
  site?.close();
  await require("./db").resetDatabase();
  await require("node:fs/promises").rm(process.env.HANNAH_WORKFORCE_DIR, { recursive: true, force: true });
});

const api = async (method, path, body) => {
  const response = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${session}` }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, body: parsed };
};

/** Read Server-Sent Events until `stop(events)` is true or the time runs out, then close the stream. */
async function readStream(path, stop, ms = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const response = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${session}` }, signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const events = [];
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const event = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (event) events.push({ event, data: data ? JSON.parse(data) : null });
      }
      if (stop(events)) break;
    }
  } catch (error) {
    if (error.name !== "AbortError") throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return events;
}

test("live view: a real screencast, taking control, the person's input, and the teammate waiting meanwhile", { skip: !browser.browserAvailable() && "Playwright's Chromium isn't installed" }, async () => {
  const computer = (await api("POST", "/workforce/computers", { name: "Cloud box", kind: "cloud" })).body.computer;
  const ses = (await api("POST", `/workforce/computers/${computer.id}/sessions`, {})).body.session;

  // No browser yet: the stream says so and ends.
  const idle = await readStream(`/workforce/sessions/${ses.id}/stream`, (events) => events.length > 0);
  assert.equal(idle[0].event, "idle");

  const pageUrl = `http://127.0.0.1:${site.address().port}/`;
  const opened = await api("POST", `/workforce/computers/${computer.id}/browser`, { sessionId: ses.id, action: { action: "navigate", url: pageUrl } });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));

  // Frames are real JPEGs from Chromium's screencast.
  const live = await readStream(`/workforce/sessions/${ses.id}/stream`, (events) => events.some((item) => item.event === "frame"));
  assert.equal(live[0].event, "live");
  const frame = live.find((item) => item.event === "frame").data;
  const jpeg = Buffer.from(frame.jpeg, "base64");
  assert.equal(jpeg[0], 0xff);
  assert.equal(jpeg[1], 0xd8);
  assert.ok(frame.width > 0 && frame.height > 0);

  // The person's input is refused until they take control.
  const early = await api("POST", `/workforce/sessions/${ses.id}/input`, { type: "click", x: 0.5, y: 0.25 });
  assert.equal(early.status, 409);
  assert.equal(early.body.reason, "not-waiting");

  const handoff = await api("POST", `/workforce/sessions/${ses.id}/handoff`, { reason: "You took control." });
  assert.equal(handoff.status, 200, JSON.stringify(handoff.body));
  assert.equal(handoff.body.status, "waiting-human");
  const waiting = (await api("GET", `/workforce/computers/${computer.id}/sessions`)).body.sessions.find((item) => item.id === ses.id);
  assert.equal(waiting.status, "waiting-human");
  assert.equal(waiting.checkpoint.handoff.reason, "You took control.", "the handoff is kept in the checkpoint");

  // While the person has it, the browser refuses everyone else's actions.
  const blocked = await api("POST", `/workforce/computers/${computer.id}/browser`, { sessionId: ses.id, action: { action: "navigate", url: pageUrl } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.reason, "person-has-control");

  // Their input reaches the page: focus the field, type, press the button.
  assert.equal((await api("POST", `/workforce/sessions/${ses.id}/input`, { type: "click", x: 0.5, y: 0.75 })).status, 200);
  assert.equal((await api("POST", `/workforce/sessions/${ses.id}/input`, { type: "text", text: "s3cret-code" })).status, 200);
  const pressed = await api("POST", `/workforce/sessions/${ses.id}/input`, { type: "click", x: 0.5, y: 0.25 });
  assert.equal(pressed.status, 200, JSON.stringify(pressed.body));
  assert.equal(pressed.body.title, "clicked:s3cret-code");
  for (const bad of [{ type: "click", x: 2, y: 0.5 }, { type: "key", key: "F12" }, { type: "text", text: "" }, { type: "drag" }]) {
    assert.equal((await api("POST", `/workforce/sessions/${ses.id}/input`, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await api("POST", `/workforce/sessions/${ses.id}/input`, { type: "key", key: "Tab" })).status, 200);

  // What was typed is never in the session's record.
  const sessions = (await api("GET", `/workforce/computers/${computer.id}/sessions`)).body.sessions;
  assert.doesNotMatch(JSON.stringify(sessions), /s3cret-code/);
  assert.ok(JSON.stringify(sessions).includes("human.input"));

  // Handing it back: the teammate's browser works again, and the person's input is refused.
  assert.equal((await api("POST", `/workforce/sessions/${ses.id}/resume`, {})).status, 200);
  assert.equal((await api("POST", `/workforce/computers/${computer.id}/browser`, { sessionId: ses.id, action: { action: "navigate", url: pageUrl } })).status, 200);
  assert.equal((await api("POST", `/workforce/sessions/${ses.id}/input`, { type: "click", x: 0.5, y: 0.25 })).status, 409);
});
