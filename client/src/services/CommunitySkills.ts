/**
 * Community skills from a HANNAH skill manifest.
 *
 * Only instruction skills install today: text guidance that shapes replies,
 * with no code, tools, network access or permissions. Manifests that declare
 * executable code or MCP servers are rejected until package signing and
 * sandboxed execution exist. Instructions are screened for prompt-injection
 * patterns, and the server labels them as untrusted guidance that can't change
 * HANNAH's safety or approval rules.
 *
 * Manifest (manifestVersion 1):
 * {
 *   "manifestVersion": 1,
 *   "id": "dev.example.concise-notes",          // lowercase, dots/dashes
 *   "type": "instruction-skill",
 *   "name": "Concise notes",
 *   "description": "…",
 *   "version": "1.0.0",                          // semver
 *   "publisher": { "name": "Example", "url": "https://example.dev" },
 *   "category": "Productivity",
 *   "license": "MIT",
 *   "permissions": [],                           // must be empty for instruction skills
 *   "privacy": { "dataLeavesDevice": false, "notes": "…" },
 *   "instructions": "…",                         // ≤ 1200 characters
 *   "integrity": { "sha256": "<hex of instructions>" },  // optional
 *   "signature": { "alg": "Ed25519", "publicKey": "<base64>", "value": "<base64>" }  // optional
 * }
 *
 * Signatures cover the whole manifest with keys sorted and "signature" removed.
 * Publishers sign with server/scripts/sign-skill.js. Keys listed in
 * shared/trusted-publishers.json show as a trusted publisher; any other valid
 * signature shows as "signed by an unknown key" with its fingerprint.
 */
import trustedPublisherData from "../../../shared/trusted-publishers.json";

export const MANIFEST_VERSION = 1;
const STORAGE_KEY = "hannah.communitySkills.v1";
export const COMMUNITY_SKILLS_EVENT = "hannah:community-skills";
export const MAX_INSTRUCTIONS = 1200;
export const MAX_ENABLED = 3;

export type SkillManifest = {
  manifestVersion: 1;
  id: string;
  type: "instruction-skill";
  name: string;
  description: string;
  version: string;
  publisher: { name: string; url?: string };
  category: string;
  license: string;
  permissions: string[];
  privacy: { dataLeavesDevice: boolean; notes?: string };
  instructions: string;
  integrity?: { sha256: string };
};

export type SignatureCheck = { status: "trusted" | "signed" | "none" | "unverifiable"; fingerprint?: string; trustedName?: string };
export type InstalledSkill = { manifest: SkillManifest; enabled: boolean; installedAt: number; integrity: "verified" | "unsigned"; signature?: SignatureCheck };
export type ValidationResult = { ok: true; manifest: SkillManifest; warnings: string[]; integrity: "verified" | "unsigned"; signature: SignatureCheck } | { ok: false; errors: string[] };

type TrustedPublisher = { name: string; publicKey: string };
const trustedPublishers: TrustedPublisher[] = Array.isArray((trustedPublisherData as { publishers?: unknown }).publishers)
  ? ((trustedPublisherData as { publishers: unknown[] }).publishers.filter((item): item is TrustedPublisher => Boolean(item && typeof (item as TrustedPublisher).publicKey === "string" && typeof (item as TrustedPublisher).name === "string")))
  : [];

/** JSON with object keys sorted at every level: what a signature covers. Exported for tests. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function base64Bytes(value: unknown, length: number) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  try {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    return bytes.length === length ? bytes : null;
  } catch {
    return null;
  }
}

async function checkSignature(raw: Record<string, unknown>): Promise<SignatureCheck | { error: string }> {
  const signature = raw.signature;
  if (signature === undefined) return { status: "none" };
  if (!isPlainObject(signature) || signature.alg !== "Ed25519") return { error: `"signature.alg" must be "Ed25519".` };
  const publicKey = base64Bytes(signature.publicKey, 32);
  const value = base64Bytes(signature.value, 64);
  if (!publicKey || !value) return { error: "The signature's public key or value isn't valid base64 of the right length." };
  let fingerprint: string | undefined;
  if (crypto?.subtle?.digest) {
    try {
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", publicKey));
      fingerprint = [...digest.slice(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("").replace(/(.{4})(?=.)/g, "$1 ");
    } catch {
      fingerprint = undefined;
    }
  }
  const { signature: _omit, ...signed } = raw;
  if (!crypto?.subtle?.importKey) {
    return { status: "unverifiable", ...(fingerprint ? { fingerprint } : {}) };
  }
  let valid: boolean;
  try {
    const key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
    valid = await crypto.subtle.verify({ name: "Ed25519" }, key, value, new TextEncoder().encode(canonicalJson(signed)));
  } catch {
    // Older browsers lack Ed25519 in WebCrypto: say so instead of guessing.
    return { status: "unverifiable", ...(fingerprint ? { fingerprint } : {}) };
  }
  if (!valid) return { error: "The signature doesn't match this manifest, so it may have been altered after signing." };
  const trusted = trustedPublishers.find((item) => item.publicKey === signature.publicKey);
  return trusted ? { status: "trusted", fingerprint, trustedName: trusted.name } : { status: "signed", fingerprint };
}

const INJECTION_PATTERNS: Array<[RegExp, string]> = [
  [/ignore (all |any )?(previous|prior|above|earlier) (instructions|rules|messages)/i, "tries to override earlier instructions"],
  [/(reveal|print|show|repeat).{0,30}(system prompt|hidden instructions|developer message)/i, "asks to reveal the system prompt"],
  [/(bypass|skip|disable|turn off).{0,30}(approval|confirmation|guardian|safety|guardrail)/i, "tries to switch off approvals or safety checks"],
  [/(api[ _-]?key|password|token|secret).{0,40}(send|post|upload|share|include)/i, "asks for credentials to be shared"],
  [/(send|post|upload|exfiltrate).{0,40}(https?:\/\/|webhook)/i, "asks to send data to an outside address"],
  [/you (are|have) no (rules|restrictions|limits)|jailbreak|developer mode/i, "uses jailbreak language"],
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function sha256Hex(text: string) {
  if (!crypto?.subtle?.digest) throw new Error("This browser can't compute SHA-256.");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Check a manifest before anything is installed. Never executes anything. */
export async function validateManifest(input: unknown): Promise<ValidationResult> {
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      return { ok: false, errors: ["The manifest isn't valid JSON."] };
    }
  }
  if (!isPlainObject(value)) return { ok: false, errors: ["The manifest must be a JSON object."] };
  const errors: string[] = [];
  const warnings: string[] = [];
  const text = (key: string, max: number, min = 1) => {
    const field = value as Record<string, unknown>;
    const raw = field[key];
    if (typeof raw !== "string" || raw.trim().length < min || raw.length > max) {
      errors.push(`"${key}" must be text of ${min}–${max} characters.`);
      return "";
    }
    return raw.trim();
  };

  if (value.manifestVersion !== MANIFEST_VERSION) errors.push(`"manifestVersion" must be ${MANIFEST_VERSION}.`);
  if (value.type === "executable-plugin" || value.type === "mcp-server" || value.type === "plugin") {
    return { ok: false, errors: ["Executable plugins and MCP servers can't be installed yet. HANNAH needs package signing and sandboxed execution first. Instruction skills are supported."] };
  }
  if (value.type !== "instruction-skill") errors.push(`"type" must be "instruction-skill".`);
  const id = text("id", 64, 3);
  if (id && !/^[a-z0-9][a-z0-9.-]{2,63}$/.test(id)) errors.push(`"id" may only use lowercase letters, digits, dots and dashes.`);
  const name = text("name", 60);
  const description = text("description", 300);
  const version = text("version", 32);
  if (version && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) errors.push(`"version" must be semantic, for example 1.0.0.`);
  const category = text("category", 40);
  const license = text("license", 60);
  const instructions = text("instructions", MAX_INSTRUCTIONS, 10);

  let publisher: SkillManifest["publisher"] = { name: "" };
  if (!isPlainObject(value.publisher) || typeof value.publisher.name !== "string" || !value.publisher.name.trim() || value.publisher.name.length > 80) {
    errors.push(`"publisher.name" is required.`);
  } else {
    publisher = { name: value.publisher.name.trim() };
    if (value.publisher.url !== undefined) {
      try {
        const url = new URL(String(value.publisher.url));
        if (url.protocol !== "https:") throw new Error("https");
        publisher.url = url.toString();
      } catch {
        errors.push(`"publisher.url" must be an https:// address.`);
      }
    }
  }

  const permissions = Array.isArray(value.permissions) ? value.permissions.filter((item): item is string => typeof item === "string") : null;
  if (!permissions) errors.push(`"permissions" must be a list (empty for instruction skills).`);
  else if (permissions.length) errors.push(`Instruction skills can't request permissions (${permissions.join(", ")}). They only add guidance text.`);

  if (!isPlainObject(value.privacy) || typeof value.privacy.dataLeavesDevice !== "boolean") errors.push(`"privacy.dataLeavesDevice" (true or false) is required.`);
  const privacy = isPlainObject(value.privacy) ? { dataLeavesDevice: Boolean(value.privacy.dataLeavesDevice), notes: typeof value.privacy.notes === "string" ? value.privacy.notes.slice(0, 300) : undefined } : { dataLeavesDevice: false };

  for (const [pattern, reason] of INJECTION_PATTERNS) {
    if (instructions && pattern.test(instructions)) errors.push(`The instructions were rejected: the text ${reason}.`);
  }

  let integrity: "verified" | "unsigned" = "unsigned";
  if (value.integrity !== undefined) {
    const declared = isPlainObject(value.integrity) && typeof value.integrity.sha256 === "string" ? value.integrity.sha256.toLowerCase() : "";
    if (!/^[a-f0-9]{64}$/.test(declared)) errors.push(`"integrity.sha256" must be a 64-character hex digest.`);
    else {
      try {
        if (instructions && declared !== await sha256Hex(instructions)) errors.push("The integrity hash doesn't match the instructions, so they may have been altered.");
        else integrity = "verified";
      } catch {
        warnings.push("This browser can't check the integrity hash, so it wasn't verified.");
      }
    }
  } else {
    warnings.push("No integrity hash: HANNAH can't confirm the instructions match what the publisher released.");
  }
  const signature = await checkSignature(value);
  if ("error" in signature) errors.push(signature.error);
  else if (signature.status === "trusted") {
    if (signature.trustedName !== publisher.name) warnings.push(`Signed by ${signature.trustedName}, a trusted publisher, though the manifest names "${publisher.name}".`);
  } else if (signature.status === "signed") warnings.push(`Signed, but by a key HANNAH doesn't know (fingerprint ${signature.fingerprint}). Check it with the publisher before trusting it.`);
  else if (signature.status === "unverifiable") warnings.push("This browser can't check Ed25519 signatures, so the signature wasn't verified.");
  else warnings.push("Not signed: HANNAH can't confirm who published it. Only install skills from people you trust.");

  if (errors.length) return { ok: false, errors };
  const signatureCheck = signature as SignatureCheck;
  return {
    ok: true,
    integrity,
    signature: signatureCheck,
    warnings,
    manifest: { manifestVersion: 1, id, type: "instruction-skill", name, description, version, publisher, category, license, permissions: [], privacy, instructions, ...(integrity === "verified" ? { integrity: { sha256: String((value.integrity as Record<string, unknown>).sha256).toLowerCase() } } : {}) },
  };
}

function read(): InstalledSkill[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is InstalledSkill => isPlainObject(item) && isPlainObject(item.manifest) && typeof item.manifest.id === "string") : [];
  } catch {
    return [];
  }
}

function write(skills: InstalledSkill[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(skills));
  } catch {
    // Best effort.
  }
  try {
    window.dispatchEvent(new Event(COMMUNITY_SKILLS_EVENT));
  } catch {
    // No window events in some environments.
  }
}

export const CommunitySkills = {
  list() {
    return read();
  },
  install(manifest: SkillManifest, integrity: InstalledSkill["integrity"], signature?: SignatureCheck) {
    const others = read().filter((item) => item.manifest.id !== manifest.id);
    write([...others, { manifest, integrity, ...(signature ? { signature } : {}), enabled: false, installedAt: Date.now() }]);
  },
  setEnabled(id: string, enabled: boolean) {
    const skills = read();
    if (enabled && skills.filter((item) => item.enabled && item.manifest.id !== id).length >= MAX_ENABLED) {
      throw new Error(`Up to ${MAX_ENABLED} community skills can be on at once.`);
    }
    write(skills.map((item) => (item.manifest.id === id ? { ...item, enabled } : item)));
  },
  uninstall(id: string) {
    write(read().filter((item) => item.manifest.id !== id));
  },
  /** What the agent sends: enabled skills' names and instructions only. */
  runtimeSkills() {
    return read().filter((item) => item.enabled).slice(0, MAX_ENABLED).map((item) => ({ name: item.manifest.name, instructions: item.manifest.instructions }));
  },
};
