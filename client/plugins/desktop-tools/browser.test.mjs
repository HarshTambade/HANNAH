// Run with: node --test client/plugins/desktop-tools
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { ASK_BEFORE_PRESS, NEVER_PRESS, createDesktopTools } from "./electron/dist/core.mjs";
import { inspectPdf, markdownToHtml, notesDocument, pdfFileName } from "./electron/dist/notes.mjs";

let sandbox;
before(async () => { sandbox = await mkdtemp(path.join(os.tmpdir(), "hannah-browser-")); });
after(() => rm(sandbox, { recursive: true, force: true }));

test("notes Markdown becomes escaped HTML: no tags from the model get through", () => {
  const html = markdownToHtml("## Key concepts\n- **Process**: a program\n- `fork()` makes a child\n\n1. First\n2. Second\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n[docs](https://example.com) [bad](javascript:alert(1))");
  assert.match(html, /<h3>Key concepts<\/h3>/);
  assert.match(html, /<ul><li><strong>Process<\/strong>: a program<\/li><li><code>fork\(\)<\/code> makes a child<\/li><\/ul>/);
  assert.match(html, /<ol><li>First<\/li><li>Second<\/li><\/ol>/);
  assert.match(html, /<table><thead><tr><th>A<\/th><th>B<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td>2<\/td><\/tr><\/tbody><\/table>/);
  assert.doesNotMatch(html, /<script|<img/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<a href="https:\/\/example.com">docs<\/a>/);
  assert.doesNotMatch(html, /href="javascript/);
  const listed = markdownToHtml("1. **Peterson**:\n   ```\n   flag[i] = TRUE;\n   while (turn == j) ;\n   ```\n2. Next");
  assert.match(listed, /<ol><li><strong>Peterson<\/strong>:<\/li><\/ol>\n<pre><code>flag\[i\] = TRUE;\nwhile \(turn == j\) ;<\/code><\/pre>\n<ol start="2"><li>Next<\/li><\/ol>/, "an indented fence inside a list is a code block in place, and numbering carries on");
});

test("the notes page names its source and says when no transcript was read", () => {
  const withTranscript = notesDocument({ title: "Deadlocks <GATE>", creator: "Gate Smashers", sourceUrl: "https://www.youtube.com/watch?v=abc", markdown: "## Summary\nText", transcriptBased: true, generatedAt: new Date("2026-11-18T00:00:00Z") });
  assert.match(withTranscript, /<h1>Deadlocks &lt;GATE&gt;<\/h1>/);
  assert.match(withTranscript, /Gate Smashers/);
  assert.match(withTranscript, /2026-11-18/);
  assert.match(withTranscript, /default-src 'none'/, "the page can't load anything");
  assert.doesNotMatch(withTranscript, /No transcript was available/);
  const without = notesDocument({ title: "X", sourceUrl: "https://youtu.be/abc", markdown: "x", transcriptBased: false });
  assert.match(without, /No transcript was available/);
});

test("PDF checks and file names", () => {
  const fake = Buffer.from("%PDF-1.7\n1 0 obj << /Type /Pages /Kids [2 0 R] >>\n2 0 obj << /Type /Page >>\n3 0 obj << /Type /Page >>\n%%EOF\n", "latin1");
  assert.deepEqual(inspectPdf(fake), { valid: true, pages: 2, bytes: fake.length });
  assert.equal(inspectPdf(Buffer.from("<html>not a pdf</html>")).valid, false);
  assert.equal(inspectPdf(fake.subarray(0, 40)).valid, false, "a cut-off file isn't valid");
  assert.equal(pdfFileName("OS: Deadlocks / Part 1?"), "OS Deadlocks Part 1.pdf");
  assert.equal(pdfFileName("../../etc/passwd"), ".. .. etc passwd.pdf");
  assert.equal(pdfFileName(""), "notes.pdf");
});

test("buttons HANNAH never presses, and ones she asks about", () => {
  for (const label of ["Place order", "Pay now", "Proceed to checkout", "Buy now", "Confirm order", "Complete purchase"]) assert.ok(NEVER_PRESS.test(label), label);
  for (const label of ["Show transcript", "More", "Next", "Search", "Play"]) assert.ok(!NEVER_PRESS.test(label) && !ASK_BEFORE_PRESS.test(label), label);
  for (const label of ["Add to cart", "Subscribe", "Post", "Send", "Follow", "Like", "Sign in", "Delete"]) assert.ok(ASK_BEFORE_PRESS.test(label), label);
});

function fakeBrowser(elements) {
  let open = false;
  const actions = [];
  let url = "about:blank";
  const page = () => ({ title: "Page", url, text: "text", textTruncated: false });
  return {
    actions,
    browser: {
      isOpen: () => open,
      open: async () => { open = true; },
      close: () => { open = false; },
      url: () => url,
      navigate: async (next) => { url = next; actions.push(["navigate", next]); return page(); },
      read: async () => page(),
      elements: async () => elements,
      describe: async (ref) => elements.find((item) => item.ref === ref) ?? null,
      click: async (ref) => { actions.push(["click", ref]); return { ...page(), navigated: false }; },
      type: async (ref, text, options) => { actions.push(["type", ref, text, options.submit]); return page(); },
      scroll: async (direction) => { actions.push(["scroll", direction]); return page(); },
      back: async () => page(),
      screenshot: async () => ({ image: "/9j/", mediaType: "image/jpeg", width: 10, height: 10 }),
      youtubeResults: async () => [{ title: "OS lecture", url: "https://www.youtube.com/watch?v=abc123", channel: "Gate" }],
      youtubeVideo: async () => (url.includes("notranscript") ? { title: "No words", channel: "C", description: "d", transcript: [], reason: "YouTube doesn't show a transcript for this video." } : { title: "Deadlocks", channel: "Gate Smashers", description: "d", transcript: [{ time: "0:00", text: "A deadlock is" }, { time: "0:05", text: "a set of blocked processes." }] }),
    },
  };
}

function harness({ elements = [], answers = [], pdf } = {}) {
  const asked = [];
  const queue = [...answers];
  const fake = fakeBrowser(elements);
  const rendered = [];
  const instance = createDesktopTools({
    storePath: path.join(sandbox, `store-${Math.random()}.json`),
    chooseFolder: async () => path.join(sandbox, "home", "notes"),
    confirm: async (request) => { asked.push(request); return queue.length ? queue.shift() : 0; },
    home: path.join(sandbox, "home"),
    lookup: async () => [{ address: "142.250.0.1" }],
    browser: fake.browser,
    renderPdf: async (html) => { rendered.push(html); return pdf ?? Buffer.from("%PDF-1.7\n<< /Type /Page >>\n%%EOF\n", "latin1"); },
  });
  return { instance, asked, actions: fake.actions, rendered };
}

const elements = [
  { ref: "e1", role: "searchbox", name: "Search", search: true, sensitive: false },
  { ref: "e2", role: "textbox", name: "Delivery note", search: false, sensitive: false },
  { ref: "e3", role: "textbox", name: "Password", type: "password", search: false, sensitive: true },
  { ref: "e4", role: "button", name: "Place order", submits: true },
  { ref: "e5", role: "button", name: "Add to cart", submits: false },
  { ref: "e6", role: "link", name: "Deadlocks lecture", href: "https://www.youtube.com/watch?v=abc123" },
  { ref: "e7", role: "button", name: "Show transcript", submits: false },
];

test("the browser starts with one yes; reading, searching and links don't ask again", async () => {
  const declined = harness({ answers: [1] });
  await assert.rejects(declined.instance.browserSearch({ query: "GATE OS", site: "youtube" }), /declined/);
  await assert.rejects(declined.instance.browserRead(), /isn't open/);

  const { instance, asked, actions } = harness({ elements });
  const search = await instance.browserSearch({ query: "GATE operating systems", site: "youtube" });
  assert.equal(search.results[0].title, "OS lecture");
  assert.deepEqual(actions[0], ["navigate", "https://www.youtube.com/results?search_query=GATE%20operating%20systems"]);
  assert.match(asked[0].detail, /never types passwords or card details, and never pays/);
  await instance.browserClick({ ref: "e6" });
  await instance.browserClick({ ref: "e7" });
  await instance.browserType({ ref: "e1", text: "deadlock", submit: true });
  await instance.browserScroll({ direction: "down" });
  assert.equal(asked.length, 1, "only the start asked");
  assert.deepEqual(actions.slice(1), [["click", "e6"], ["click", "e7"], ["type", "e1", "deadlock", true], ["scroll", "down"]]);
  await assert.rejects(instance.browserOpen({ url: "http://127.0.0.1:3000" }), /this computer itself/);
  await assert.rejects(instance.browserOpen({ url: "file:///etc/passwd" }), /http and https/);
});

test("the browser never types secrets or pays, and asks before changing things", async () => {
  const { instance, asked, actions } = harness({ elements, answers: [0, 1, 0, 1] });
  await instance.browserOpen({ url: "https://shop.example.com" });
  await assert.rejects(instance.browserType({ ref: "e3", text: "hunter2" }), /never types passwords/);
  await assert.rejects(instance.browserClick({ ref: "e4" }), /doesn't press “Place order”/);
  await assert.rejects(instance.browserClick({ ref: "e5" }), /declined/);
  assert.equal(asked.at(-1).message, "HANNAH wants to press “Add to cart” on shop.example.com.");
  await instance.browserClick({ ref: "e5" });
  await assert.rejects(instance.browserType({ ref: "e2", text: "Ring the bell" }), /declined/);
  assert.match(asked.at(-1).message, /type into “Delivery note”/);
  assert.equal(asked.at(-1).detail, "Ring the bell");
  assert.deepEqual(actions.filter(([kind]) => kind !== "navigate"), [["click", "e5"]], "nothing refused or declined reached the page");
  await assert.rejects(instance.browserClick({ ref: "e99" }), /no element e99/);
});

test("YouTube notes: transcript read when shown; PDF saved after a yes, checked on disk, honest without a transcript", async () => {
  await mkdir(path.join(sandbox, "home", "notes"), { recursive: true });
  const { instance, asked, rendered } = harness({ answers: [0, 0, 0, 0, 1] });
  const video = await instance.youtubeVideo({ url: "https://www.youtube.com/watch?v=abc123" });
  assert.equal(video.transcriptAvailable, true);
  assert.equal(video.transcript, "A deadlock is a set of blocked processes.");
  const { folder } = await instance.addFolder({ access: "read" });
  await assert.rejects(instance.saveNotesPdf({ folderId: folder.id, title: "Deadlocks", markdown: "## Summary\nx" }), /read-only/);
  await instance.setAccess({ id: folder.id, access: "read-write" });

  const saved = await instance.saveNotesPdf({ folderId: folder.id, title: "Deadlocks", creator: "HANNAH", sourceUrl: "https://www.youtube.com/watch?v=abc123", markdown: "## Summary\nA deadlock is…" });
  assert.equal(saved.verified, true);
  assert.equal(saved.transcriptBased, true);
  assert.equal(saved.path, "Deadlocks.pdf");
  assert.match(saved.outcome, /checked on disk/);
  assert.equal((await readFile(path.join(sandbox, "home", "notes", "Deadlocks.pdf"), "latin1")).slice(0, 5), "%PDF-");
  assert.doesNotMatch(rendered[0], /No transcript was available/);
  assert.match(rendered[0], /<dt>Creator<\/dt><dd>Gate Smashers<\/dd>/, "the channel YouTube showed is credited, not the name the model wrote");

  await instance.browserOpen({ url: "https://www.youtube.com/watch?v=notranscript" });
  const none = await instance.youtubeVideo({});
  assert.equal(none.transcriptAvailable, false);
  assert.match(none.reason, /doesn't show a transcript/);
  const honest = await instance.saveNotesPdf({ folderId: folder.id, fileName: "no words", title: "No words", sourceUrl: "https://www.youtube.com/watch?v=notranscript", markdown: "## Summary\nFrom the description." });
  assert.equal(honest.transcriptBased, false);
  assert.match(rendered[1], /No transcript was available/);
  assert.match(asked.at(-1).detail, /No transcript was read for this video/);

  await assert.rejects(instance.saveNotesPdf({ folderId: folder.id, title: "Declined", markdown: "x" }), /declined/);
});

test("a PDF that doesn't check out isn't saved", async () => {
  const { instance } = harness({ answers: [0, 0], pdf: Buffer.from("<html>oops</html>") });
  const { folder } = await instance.addFolder({ access: "read" });
  await instance.setAccess({ id: folder.id, access: "read-write" });
  await assert.rejects(instance.saveNotesPdf({ folderId: folder.id, title: "Broken", markdown: "x" }), /couldn't be made correctly/);
});
