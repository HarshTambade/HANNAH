/**
 * The "Hey HANNAH" wake-word model.
 *
 * The speech model (Vosk small English, Apache-2.0, ~41 MB) is too large to
 * commit or to put in every installer. The web build downloads the official
 * archive once, checks its SHA-256, repackages it as the .tar.gz vosk-browser
 * reads (it drops the first path component, so files stay in their top
 * folder), and serves it at
 * /models/wake/<WAKE_MODEL_FILE>. The desktop and Android apps download it
 * from the website the first time the wake word is turned on, and keep it.
 */
import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, inflateRawSync } from "node:zlib";
import type { Plugin } from "vite";

export const WAKE_MODEL_FILE = "vosk-model-small-en-us-0.15.tar.gz";
const SOURCE_URL = "https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip";
const SOURCE_SHA256 = "30f26242c4eb449f948e42cb302dd7a686cb29a3423a8367f99ff41780942498";
const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = resolve(clientRoot, ".cache", "wake-model");
const cachedModel = resolve(cacheDir, WAKE_MODEL_FILE);

type ZipEntry = { name: string; data: Buffer };

/** Read every file from a zip archive (stored or deflated entries). Exported for tests. */
export function readZip(zip: Buffer): ZipEntry[] {
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error("Not a zip archive.");
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error("Damaged zip directory.");
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = zip.subarray(start, start + compressedSize);
    if (method !== 0 && method !== 8) throw new Error(`Unsupported zip compression in ${name}.`);
    entries.push({ name, data: method === 8 ? inflateRawSync(raw) : Buffer.from(raw) });
  }
  return entries;
}

function tarHeader(name: string, size: number, type: "0" | "5" = "0") {
  if (Buffer.byteLength(name) > 100) throw new Error(`Path too long for tar: ${name}`);
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, "utf8");
  header.write(type === "5" ? "0000755\0" : "0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.write("        ", 148);
  header.write(type, 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return header;
}

/** A gzipped tar of the given files. Exported for tests. */
export function makeTarGz(files: ZipEntry[]) {
  const parts: Buffer[] = [];
  // Folders first: the extractor writes files into folders that must already exist.
  const folders = new Set<string>();
  for (const file of files) {
    const segments = file.name.split("/").slice(0, -1);
    for (let index = 1; index <= segments.length; index += 1) folders.add(`${segments.slice(0, index).join("/")}/`);
  }
  for (const folder of [...folders].sort()) parts.push(tarHeader(folder, 0, "5"));
  for (const file of files) {
    parts.push(tarHeader(file.name, file.data.length), file.data);
    const padding = (512 - (file.data.length % 512)) % 512;
    if (padding) parts.push(Buffer.alloc(padding, 0));
  }
  parts.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(parts), { level: 6 });
}

/** The repackaged model on disk, downloading and checking it the first time. */
export async function ensureWakeModel(log: (message: string) => void = console.log): Promise<string> {
  if (existsSync(cachedModel) && statSync(cachedModel).size > 1_000_000) return cachedModel;
  log(`Downloading the wake-word model from ${SOURCE_URL} (about 41 MB, once)…`);
  const response = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`The wake-word model download failed with HTTP ${response.status}.`);
  const zip = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(zip).digest("hex");
  if (digest !== SOURCE_SHA256) throw new Error(`The wake-word model archive didn't match its pinned SHA-256 (got ${digest}). Not using it.`);
  // Keep the archive's top folder: vosk-browser strips the first path component when extracting.
  const files = readZip(zip);
  if (!files.every((entry) => /^vosk-model-small-en-us-0\.15\//.test(entry.name))) throw new Error("The wake-word model archive has an unexpected layout.");
  mkdirSync(cacheDir, { recursive: true });
  const partial = `${cachedModel}.partial`;
  writeFileSync(partial, makeTarGz(files));
  renameSync(partial, cachedModel);
  log(`Wake-word model ready: ${cachedModel}`);
  return cachedModel;
}

/** Website builds (Vercel) include the model; app builds don't. */
const bundlesModel = () => process.env.VERCEL === "1" || process.env.HANNAH_WAKE_MODEL === "bundle";

export function wakeModelPlugin(): Plugin {
  let outDir = resolve(clientRoot, "dist");
  const route = `/models/wake/${WAKE_MODEL_FILE}`;
  const serve = (server: { middlewares: { use: (handler: (req: { url?: string }, res: import("node:http").ServerResponse, next: () => void) => void) => void } }) => {
    server.middlewares.use((req, res, next) => {
      if (req.url?.split("?")[0] !== route) return next();
      ensureWakeModel().then((path) => {
        res.setHeader("Content-Type", "application/gzip");
        res.setHeader("Content-Length", String(statSync(path).size));
        res.setHeader("Access-Control-Allow-Origin", "*");
        createReadStream(path).pipe(res);
      }, (error: unknown) => {
        res.statusCode = 503;
        res.end(error instanceof Error ? error.message : "The wake-word model isn't available.");
      });
    });
  };
  return {
    name: "hannah-wake-model",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    configureServer: serve,
    configurePreviewServer: serve,
    async writeBundle() {
      if (!bundlesModel()) return;
      try {
        const path = await ensureWakeModel((message) => this.info(message));
        mkdirSync(resolve(outDir, "models", "wake"), { recursive: true });
        copyFileSync(path, resolve(outDir, "models", "wake", WAKE_MODEL_FILE));
      } catch (error) {
        // The site still works; only the wake word says its model isn't available.
        this.warn(`Wake-word model not included: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

