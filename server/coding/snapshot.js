"use strict";

/**
 * A repository at one commit, as text files in memory. Two sources:
 *
 *   fromTarball(buffer)    the gzipped tar a host returns for a commit
 *   fromDirectory(root)    a local checkout, listing what git tracks
 *
 * Both return { files: Map<path, { size, text }>, skipped: [{ path, size, why }], truncated }.
 * Binary files, files over 400 KB and dependency or build folders are listed
 * as skipped with the reason, so a scan can say what it didn't read. Nothing
 * is written to disk and nothing from the repository is executed.
 */
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { execFile } = require("node:child_process");

const MAX_FILE = 400 * 1024;
const MAX_TOTAL = 48 * 1024 * 1024;
const MAX_FILES = 20_000;
const SKIP_DIRS = /(^|\/)(node_modules|vendor|bower_components|\.git|dist|build|out|target|\.next|\.nuxt|\.venv|venv|__pycache__|\.gradle|Pods|coverage|\.cache|\.turbo|\.idea)(\/|$)/;
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|icns|bmp|tiff?|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|class|exe|dll|so|dylib|a|o|wasm|woff2?|ttf|otf|eot|mp[34]|mov|avi|webm|ogg|wav|flac|glb|gltf|bin|dat|db|sqlite|psd|ai|sketch|fig|keystore|p12|pfx|der|onnx|pt|safetensors|gguf|pyc|lockb)$/i;
const LOCKFILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum|uv\.lock)$/;
const MINIFIED = /\.min\.(js|css)$|\.map$/i;

const fail = (status, message, reason) => Object.assign(new Error(message), { status, reason });

function createCollector() {
  const files = new Map();
  const skipped = [];
  let total = 0;
  let truncated = false;
  return {
    /** `read` returns the bytes; it's called only for files worth reading. */
    add(name, size, read) {
      if (files.size + skipped.length >= MAX_FILES) { truncated = true; return; }
      if (SKIP_DIRS.test(name)) return;
      if (BINARY_EXT.test(name)) { skipped.push({ path: name, size, why: "binary" }); return; }
      if (MINIFIED.test(name)) { skipped.push({ path: name, size, why: "minified or generated" }); return; }
      // Lock files are kept whole (dependency checks read them) up to a larger limit.
      const limit = LOCKFILES.test(name) ? 8 * 1024 * 1024 : MAX_FILE;
      if (size > limit) { skipped.push({ path: name, size, why: "larger than HANNAH reads" }); return; }
      if (total + size > MAX_TOTAL) { truncated = true; skipped.push({ path: name, size, why: "the repository is larger than HANNAH reads in one pass" }); return; }
      const bytes = read();
      if (bytes.subarray(0, 8000).includes(0)) { skipped.push({ path: name, size, why: "binary" }); return; }
      total += size;
      files.set(name, { size, text: bytes.toString("utf8") });
    },
    result: () => ({ files, skipped, truncated, bytes: total }),
  };
}

const octal = (buffer) => { const text = buffer.toString("ascii").replace(/\0.*$/, "").trim(); return text ? parseInt(text, 8) : 0; };
const cstring = (buffer) => { const end = buffer.indexOf(0); return buffer.subarray(0, end < 0 ? buffer.length : end).toString("utf8"); };

/** Read a .tar.gz. The first path component (the host's "owner-repo-sha/" folder) is dropped. */
function fromTarball(gz) {
  let tar;
  try {
    tar = zlib.gunzipSync(gz, { maxOutputLength: 400 * 1024 * 1024 });
  } catch (error) {
    throw fail(error?.code === "ERR_BUFFER_TOO_LARGE" ? 413 : 502, error?.code === "ERR_BUFFER_TOO_LARGE" ? "The repository is larger than HANNAH reads." : "The repository archive couldn't be read.", "bad-archive");
  }
  const collector = createCollector();
  let offset = 0;
  let longName = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) break;
    const size = octal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] || 48);
    const dataStart = offset;
    offset += Math.ceil(size / 512) * 512;
    if (type === "x" || type === "g") {
      // pax records: "<length> key=value\n"
      if (type === "x") {
        const text = tar.subarray(dataStart, dataStart + size).toString("utf8");
        const found = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(text);
        if (found) longName = found[1];
      }
      continue;
    }
    if (type === "L") { longName = cstring(tar.subarray(dataStart, dataStart + size)); continue; }
    const prefix = cstring(header.subarray(345, 500));
    const name = longName || (prefix ? `${prefix}/${cstring(header.subarray(0, 100))}` : cstring(header.subarray(0, 100)));
    longName = null;
    if (type !== "0" && type !== "\0") continue;
    const relative = name.split("/").slice(1).join("/");
    if (!relative || relative.includes("..")) continue;
    collector.add(relative, size, () => tar.subarray(dataStart, dataStart + size));
  }
  return collector.result();
}

function git(cwd, args, { timeoutMs = 30_000, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: timeoutMs, maxBuffer, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } }, (error, stdout, stderr) => {
      if (error) return reject(Object.assign(new Error(String(stderr || error.message).trim().split("\n").slice(-3).join(" ").slice(0, 400)), { code: error.code, stdout: String(stdout), stderr: String(stderr) }));
      return resolve(String(stdout));
    });
  });
}

/** A local checkout: the files git tracks plus untracked ones it doesn't ignore, read from disk as they are now. */
async function fromDirectory(root) {
  const listed = await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  const collector = createCollector();
  for (const name of listed.split("\0").filter(Boolean)) {
    const full = path.join(root, name);
    let stat;
    try { stat = fs.lstatSync(full); } catch { continue; }
    if (!stat.isFile()) continue;
    collector.add(name.split(path.sep).join("/"), stat.size, () => fs.readFileSync(full));
  }
  return collector.result();
}

module.exports = { LOCKFILES, MAX_FILE, SKIP_DIRS, fromDirectory, fromTarball, git };
