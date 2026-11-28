"use strict";

/**
 * Where raw black box recordings live: file storage, never database rows.
 *
 * A store has four calls: put(key, buffer), get(key) → buffer | null,
 * remove(key), and `durable` (whether what is put survives a restart). Two
 * come with HANNAH:
 *
 *   file    a directory (HANNAH_BLACKBOX_DIR, default ~/.hannah/blackbox),
 *           files readable only by the server's user. The default.
 *   memory  for tests.
 *
 * Another (S3, Supabase Storage, Vercel Blob) is the same four calls passed
 * to createBlackBoxService({ store }). On a serverless host the local disk is
 * temporary, so unless HANNAH_BLACKBOX_DIR points at persistent storage the
 * file store reports durable: false and the server refuses segment uploads
 * rather than accept recordings it would lose.
 */
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const SAFE_KEY = /^[A-Za-z0-9_-]{1,64}(\/[A-Za-z0-9_.-]{1,96}){1,3}$/;

function checkKey(key) {
  if (!SAFE_KEY.test(String(key)) || String(key).includes("..")) throw Object.assign(new Error("Bad storage key."), { status: 400, reason: "bad-key" });
  return String(key);
}

function createFileStore({ root = process.env.HANNAH_BLACKBOX_DIR || path.join(os.homedir(), ".hannah", "blackbox") } = {}) {
  const base = path.resolve(root);
  const serverless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  const file = (key) => path.join(base, ...checkKey(key).split("/"));
  return {
    kind: "file",
    durable: !serverless || Boolean(process.env.HANNAH_BLACKBOX_DIR),
    async put(key, buffer) {
      const target = file(key);
      await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const temporary = `${target}.${process.pid}.tmp`;
      await fsp.writeFile(temporary, buffer, { mode: 0o600 });
      await fsp.rename(temporary, target);
    },
    async get(key) {
      try { return await fsp.readFile(file(key)); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    },
    async remove(key) {
      await fsp.rm(file(key), { force: true });
    },
  };
}

function createMemoryStore() {
  const items = new Map();
  return {
    kind: "memory",
    durable: true,
    items,
    async put(key, buffer) { items.set(checkKey(key), Buffer.from(buffer)); },
    async get(key) { return items.get(checkKey(key)) || null; },
    async remove(key) { items.delete(checkKey(key)); },
  };
}

function createBlackBoxStore() {
  return process.env.HANNAH_BLACKBOX_STORE === "memory" ? createMemoryStore() : createFileStore();
}

module.exports = { createBlackBoxStore, createFileStore, createMemoryStore };
