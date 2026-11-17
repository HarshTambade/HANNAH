#!/usr/bin/env node
/**
 * Secret scan: fail if a tracked file holds something that looks like a real
 * credential. Runs in CI before tests and before a release is published.
 *
 *   node scripts/scan-secrets.mjs                scan every tracked file
 *   node scripts/scan-secrets.mjs --file a --file b   scan these files only
 *
 * What counts: provider API keys (Groq, OpenAI, Anthropic, Google, GitHub,
 * Slack, AWS), private key blocks, signed JWTs, Slack and Discord webhook
 * URLs, database URLs with a password, and `secret = "…"` style assignments.
 *
 * Allowlist (`.secretscan-allow`, one entry per line, `#` comments):
 *   path:<glob>      files whose fixtures are fake by design (tests, examples)
 *   value:<text>     a specific fake value that may appear anywhere
 * A line may also carry `secretscan:allow` to allow just that line.
 * Everything else that matches fails the scan, so a key pasted into a doc,
 * a config or a script can't reach the repository unnoticed.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

const RULES = [
  { id: "groq-key", pattern: /\bgsk_[A-Za-z0-9]{20,}\b/g },
  { id: "openai-or-anthropic-key", pattern: /\bsk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g },
  { id: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
  { id: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: "private-key-block", pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g },
  { id: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{16,}\b/g },
  { id: "slack-webhook", pattern: /hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]{20,}/g },
  { id: "discord-webhook", pattern: /discord(?:app)?\.com\/api\/webhooks\/\d{10,}\/[A-Za-z0-9_-]{30,}/g },
  { id: "database-url-with-password", pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/'"`]+:[^\s@/'"`]{4,}@[^\s'"`]+/g },
  { id: "assigned-secret", pattern: /\b(?:api[_-]?key|secret[_-]?key|client[_-]?secret|private[_-]?key|access[_-]?token|auth[_-]?token|password)\b\s*[:=]\s*["'`]([A-Za-z0-9+/=_.-]{20,})["'`]/gi },
];

// Obvious placeholders never fail the scan.
const PLACEHOLDER = /(?:example|placeholder|your[_-]?|xxxx|0123456789|abcdefghij|changeme|dummy|sample|fake|test|redacted|\$\{|<[a-z-]+>|\*{4,}|\.{3})/i;
const SKIP_EXTENSIONS = /\.(?:png|jpg|jpeg|gif|webp|ico|icns|svg|glb|gltf|bin|wasm|woff2?|ttf|otf|mp3|wav|ogg|mp4|zip|gz|tgz|jar|keystore|jks|p12|pdf|lock|lockb|tsbuildinfo|map)$/i;
const SKIP_PATHS = /(?:^|\/)(?:node_modules|dist|build|\.git|coverage|playwright-report|test-results|__pycache__)(?:\/|$)|(?:^|\/)package-lock\.json$/;

function loadAllowlist() {
  const file = resolve(root, ".secretscan-allow");
  const entries = { paths: [], values: [] };
  if (!existsSync(file)) return entries;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("path:")) entries.paths.push(globToRegExp(line.slice(5).trim()));
    else if (line.startsWith("value:")) entries.values.push(line.slice(6).trim());
  }
  return entries;
}

function globToRegExp(glob) {
  // Placeholders first, so a replacement's own characters aren't rewritten by the next step.
  const tokens = glob.replace(/\*\*\//g, "\u0001").replace(/\*\*/g, "\u0002").replace(/\*/g, "\u0003").replace(/\?/g, "\u0004");
  const escaped = tokens.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\u0001/g, "(?:.*/)?").replace(/\u0002/g, ".*").replace(/\u0003/g, "[^/]*").replace(/\u0004/g, "[^/]");
  return new RegExp(`^${escaped}$`);
}

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
}

const allow = loadAllowlist();
const files = [];
for (let index = 0; index < args.length; index += 1) if (args[index] === "--file" && args[index + 1]) files.push(args[++index]);
const targets = files.length ? files : trackedFiles();
const findings = [];
let scanned = 0;

for (const file of targets) {
  if (SKIP_PATHS.test(file) || SKIP_EXTENSIONS.test(file) || allow.paths.some((pattern) => pattern.test(file))) continue;
  let text;
  try {
    const buffer = readFileSync(resolve(root, file));
    if (buffer.length > 4 * 1024 * 1024 || buffer.subarray(0, 8000).includes(0)) continue;
    text = buffer.toString("utf8");
  } catch {
    continue;
  }
  scanned += 1;
  const lines = text.split("\n");
  for (const rule of RULES) {
    for (const match of text.matchAll(rule.pattern)) {
      const value = match[1] ?? match[0];
      if (PLACEHOLDER.test(value) || allow.values.includes(value)) continue;
      const lineNumber = text.slice(0, match.index).split("\n").length;
      const line = lines[lineNumber - 1] ?? "";
      if (line.includes("secretscan:allow")) continue;
      findings.push({ file, line: lineNumber, rule: rule.id, preview: `${value.slice(0, 6)}…${value.slice(-3)}` });
    }
  }
}

if (findings.length) {
  console.error(`Secret scan: ${findings.length} finding${findings.length === 1 ? "" : "s"} in ${scanned} files.`);
  for (const finding of findings) console.error(`  ${finding.file}:${finding.line}  ${finding.rule}  (${finding.preview})`);
  console.error("\nIf a value is a fake fixture, add `value:<it>` or `path:<glob>` to .secretscan-allow, or put `secretscan:allow` on its line. A real credential must be removed and rotated.");
  process.exit(1);
}
console.log(`Secret scan: no findings in ${scanned} files.`);
