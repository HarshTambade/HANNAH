const assert = require("node:assert/strict");
const { once } = require("node:events");
const { test } = require("node:test");
const express = require("express");
const { createDownloadRouter, pickAsset, PACKAGES } = require("./downloads");

const asset = (name, tag = "v1.3.0") => ({ name, browser_download_url: `https://github.com/o/r/releases/download/${tag}/${name}` });

// Newest first, as GitHub returns them.
const releases = [
  { tag_name: "v1.4.0-beta", prerelease: true, draft: false, assets: [asset("HANNAH-Android.apk", "v1.4.0-beta")] },
  { tag_name: "v1.3.0", prerelease: false, draft: false, assets: [asset("HANNAH-Windows.exe"), asset("HANNAH-macOS-AppleSilicon.dmg"), asset("HANNAH-macOS-AppleSilicon.dmg.blockmap")] },
  { tag_name: "v1.0.2", prerelease: false, draft: false, assets: [asset("Shanaya-Android.apk", "v1.0.2"), asset("Shanaya-macOS.dmg", "v1.0.2"), asset("Shanaya-Linux.AppImage", "v1.0.2")] },
];

async function serve(fetchImpl) {
  const app = express();
  app.use("/download", createDownloadRouter({ fetchImpl, repository: "o/r", token: "" }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, get: (path) => fetch(`${base}${path}`, { redirect: "manual" }) };
}

test("prefers the exact current name in the newest published release", () => {
  assert.equal(pickAsset(releases, PACKAGES.windows).asset.name, "HANNAH-Windows.exe");
  assert.equal(pickAsset(releases, PACKAGES["macos-arm64"]).asset.name, "HANNAH-macOS-AppleSilicon.dmg");
});

test("skips prereleases and falls back to older names", () => {
  const android = pickAsset(releases, PACKAGES.android);
  assert.equal(android.release.tag_name, "v1.0.2");
  assert.equal(android.asset.name, "Shanaya-Android.apk");
  assert.equal(pickAsset(releases, PACKAGES["linux-appimage"]).asset.name, "Shanaya-Linux.AppImage");
});

test("never hands an Apple silicon build to an Intel Mac", () => {
  assert.equal(pickAsset(releases, PACKAGES["macos-intel"]), null);
  assert.equal(pickAsset([{ assets: [asset("HANNAH-1.3.0-x64.dmg")] }], PACKAGES["macos-arm64"]), null);
});

test("redirects straight to the file and caches the release list", async () => {
  let calls = 0;
  const { server, get } = await serve(async () => { calls += 1; return new Response(JSON.stringify(releases), { status: 200 }); });
  try {
    const windows = await get("/download/windows");
    assert.equal(windows.status, 302);
    assert.equal(windows.headers.get("location"), "https://github.com/o/r/releases/download/v1.3.0/HANNAH-Windows.exe");
    assert.equal(windows.headers.get("x-hannah-release"), "v1.3.0");
    const android = await get("/download/android");
    assert.equal(android.headers.get("location"), "https://github.com/o/r/releases/download/v1.0.2/Shanaya-Android.apk");
    assert.equal(calls, 1);
  } finally {
    server.close();
  }
});

test("explains a missing package on HANNAH's own page instead of a GitHub 404", async () => {
  const { server, get } = await serve(async () => new Response(JSON.stringify(releases), { status: 200 }));
  try {
    const deb = await get("/download/linux-deb");
    assert.equal(deb.status, 404);
    assert.match(await deb.text(), /Linux \.deb isn't available yet/);
    const unknown = await get("/download/<script>");
    assert.equal(unknown.status, 404);
    assert.doesNotMatch(await unknown.text(), /<script>/);
  } finally {
    server.close();
  }
});

test("falls back to GitHub's latest link when the API is unavailable", async () => {
  const { server, get } = await serve(async () => new Response("rate limited", { status: 403 }));
  try {
    const response = await get("/download/android");
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "https://github.com/o/r/releases/latest/download/HANNAH-Android.apk");
  } finally {
    server.close();
  }
});

test("lists the available package paths", async () => {
  const { server, get } = await serve(async () => new Response("[]", { status: 200 }));
  try {
    const body = await (await get("/download")).json();
    assert.deepEqual(body.packages.map((item) => item.path), Object.keys(PACKAGES).map((id) => `/download/${id}`));
  } finally {
    server.close();
  }
});
