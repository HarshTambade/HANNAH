/**
 * Backup, restore and moving to a new device.
 *
 * A backup is one JSON file with what HANNAH keeps on this device: your
 * conversation, memories, reminders, automations, agent settings, skills,
 * style examples and preferences, plus which providers and models you chose.
 * It never holds credentials: not your Groq key, access token, account
 * session, device identity or sync bookkeeping. Those stay where they are, so
 * restoring on another device means signing in again there.
 *
 * - Integrity: a SHA-256 checksum over the contents; a changed file is refused.
 * - Encryption (optional): a passphrase derives an AES-256-GCM key with
 *   PBKDF2 (310,000 rounds). The file then holds only ciphertext.
 * - Versions: the file carries a format version; a file from a newer HANNAH
 *   is refused with a clear message instead of a half restore.
 * - Restore merges by default (adds what's missing, keeps the newer copy of
 *   anything both sides have), or replaces a section outright.
 */
import { detectPlatform, getAppVersion } from "./appInfo";

export const BACKUP_FORMAT = "hannah-backup";
export const BACKUP_VERSION = 1;
const PBKDF2_ITERATIONS = 310_000;

export type SectionId = "conversation" | "memories" | "knowledge" | "reminders" | "automations" | "agents" | "skills" | "personalization" | "settings" | "providers";
export type Section = { id: SectionId; label: string; what: string; keys: string[]; prefixes?: string[]; event?: string[] };

/** What a backup carries, by section. Everything else on the device is left out. */
export const SECTIONS: Section[] = [
  { id: "conversation", label: "Conversation", what: "your chat history", keys: ["hannah.chat.history.v1"], event: ["hannah:chat-history"] },
  { id: "memories", label: "Memories", what: "what HANNAH remembers and your memory settings", keys: ["hannah.memory.v1", "hannah.memory.settings.v1", "hannah.memoryConsent.v1"], event: ["hannah:memory", "hannah:memory-settings"] },
  { id: "knowledge", label: "Knowledge", what: "documents you added for HANNAH to search", keys: ["hannah.knowledge.v1"], event: ["hannah:knowledge"] },
  { id: "reminders", label: "Reminders", what: "upcoming and past reminders", keys: ["hannah.reminders.v1"], event: ["hannah:reminders"] },
  { id: "automations", label: "Automations", what: "saved automations, their schedules and run history", keys: ["hannah.tasks.v1", "hannah.automations.v1", "hannah.automation-runs.v1"], event: ["hannah:automations"] },
  { id: "agents", label: "Agents", what: "specialist settings and team run history", keys: ["hannah.specialists.v1", "hannah.teamRuns.v1", "hannah.agentRuns.v1", "hannah.guardian.strictness.v1", "hannah.guardian.log.v1"], event: ["hannah:specialists", "hannah:team-runs"] },
  { id: "skills", label: "Skills and plugins", what: "installed community skills and marketplace choices", keys: ["hannah.communitySkills.v1", "hannah.marketplace.v1", "hannah.plugins.v1"], event: ["hannah:community-skills"] },
  { id: "personalization", label: "Personalization", what: "style examples and what HANNAH has learned about how you like replies", keys: ["hannah.personalization.v1", "hannah.userModel"], event: ["hannah:settings"] },
  { id: "settings", label: "Preferences", what: "routing, budget, voice, language, wake word, hardware and other settings", keys: ["hannah.routing.v1", "hannah.budget.dailyUsd", "hannah.chat.mode", "hannah.chat.team", "hannah.voice.settings.v1", "hannah.voiceEnabled", "hannah.speechLanguage", "hannah.wakeWord.enabled", "hannah.briefing.v1", "hannah.hardware.v1", "hannah.deviceTasks.enabled", "hannah.onboarding.v1", "hannah.ageConsent.v1", "hannah.advisor.needs.v1", "hannah.permissions.v1"], event: ["hannah:settings", "hannah:routing-changed"] },
  { id: "providers", label: "Providers and models", what: "which provider and models you chose (never the keys themselves)", keys: ["hannah.cloudProvider", "hannah.ollamaModel"], prefixes: ["hannah.cloudModel:", "hannah.cloudModel.chosen:"], event: ["hannah:settings"] },
];

/** Keys that must never leave the device in a backup, whatever the sections say. Exported for tests. */
export const NEVER_BACKED_UP = [/^hannah\.session\./, /^hannah\.account\./, /^hannah\.credentials\./, /^hannah\.device/, /^hannah\.sync\./, /^hannah\.taskRuns\./, /^hannah\.dev\./, /^hannah\.connections\./];

export type BackupSections = Partial<Record<SectionId, Record<string, unknown>>>;
export type BackupManifest = { version: number; app: string; createdAt: string; platform: string; encrypted: boolean; sections: Array<{ id: SectionId; label: string; items: number }> };
export type Backup = { manifest: BackupManifest; sections: BackupSections };

export class BackupError extends Error {
  constructor(message: string, readonly reason: "not-a-backup" | "newer-version" | "needs-passphrase" | "wrong-passphrase" | "corrupt") {
    super(message);
    this.name = "BackupError";
  }
}

const TEXT = "$text";

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function allKeys(store: Storage): string[] {
  const keys: string[] = [];
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index);
    if (key) keys.push(key);
  }
  return keys;
}

const forbidden = (key: string) => NEVER_BACKED_UP.some((pattern) => pattern.test(key));

function sectionKeys(section: Section, store: Storage) {
  const present = new Set(allKeys(store));
  const keys = section.keys.filter((key) => present.has(key));
  for (const prefix of section.prefixes ?? []) for (const key of present) if (key.startsWith(prefix)) keys.push(key);
  return keys.filter((key) => !forbidden(key));
}

/** A stored value as it goes into the file: parsed JSON where it is JSON, otherwise `{ "$text": … }`. */
function encodeValue(raw: string): unknown {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && TEXT in (parsed as object)) return { [TEXT]: raw };
    return parsed;
  } catch {
    return { [TEXT]: raw };
  }
}

function decodeValue(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>)[TEXT] === "string") return (value as Record<string, string>)[TEXT];
  return JSON.stringify(value);
}

/** JSON with object keys in a fixed order, so the checksum doesn't depend on insertion order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const subtle = () => globalThis.crypto.subtle;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function sha256(text: string) {
  const digest = await subtle().digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number) {
  const material = await subtle().importKey("raw", encoder.encode(passphrase.normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

function countItems(values: Record<string, unknown>) {
  let items = 0;
  for (const value of Object.values(values)) items += Array.isArray(value) ? value.length : 1;
  return items;
}

/** Collect the chosen sections from this device. Exported for tests and previews. */
export function collect(ids: SectionId[] = SECTIONS.map((section) => section.id)): BackupSections {
  const store = storage();
  const result: BackupSections = {};
  if (!store) return result;
  for (const section of SECTIONS) {
    if (!ids.includes(section.id)) continue;
    const values: Record<string, unknown> = {};
    for (const key of sectionKeys(section, store)) {
      const raw = store.getItem(key);
      if (raw !== null) values[key] = encodeValue(raw);
    }
    if (Object.keys(values).length) result[section.id] = values;
  }
  return result;
}

/** What a backup would hold right now, for the Settings screen. */
export function preview() {
  const sections = collect();
  return SECTIONS.map((section) => ({ id: section.id, label: section.label, what: section.what, items: sections[section.id] ? countItems(sections[section.id]!) : 0 }));
}

/** The backup file's text. With a passphrase, everything but the header is encrypted. */
export async function createBackup(options: { passphrase?: string; sections?: SectionId[] } = {}): Promise<string> {
  const sections = collect(options.sections);
  const checksum = await sha256(canonical(sections));
  const header = { format: BACKUP_FORMAT, version: BACKUP_VERSION, app: getAppVersion(), createdAt: new Date().toISOString(), platform: detectPlatform() };
  const passphrase = options.passphrase?.trim() ?? "";
  if (!passphrase) return JSON.stringify({ ...header, sections, checksum }, null, 2);
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  const ciphertext = await subtle().encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, encoder.encode(JSON.stringify({ sections, checksum })));
  return JSON.stringify({
    ...header,
    encrypted: true,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: PBKDF2_ITERATIONS, salt: toBase64(salt) },
    cipher: { name: "AES-GCM", iv: toBase64(iv) },
    ciphertext: toBase64(new Uint8Array(ciphertext)),
  }, null, 2);
}

/** Read and check a backup file. Throws a BackupError that says what's wrong. */
export async function readBackup(text: string, passphrase = ""): Promise<Backup> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BackupError("This file isn't a HANNAH backup.", "not-a-backup");
  }
  if (!parsed || typeof parsed !== "object" || parsed.format !== BACKUP_FORMAT) throw new BackupError("This file isn't a HANNAH backup.", "not-a-backup");
  const version = Number(parsed.version);
  if (!Number.isInteger(version) || version < 1) throw new BackupError("This backup's version can't be read.", "corrupt");
  if (version > BACKUP_VERSION) throw new BackupError(`This backup was made by a newer HANNAH (backup format ${version}; this app reads up to ${BACKUP_VERSION}). Update HANNAH, then restore it.`, "newer-version");
  let body: { sections?: unknown; checksum?: unknown };
  const encrypted = parsed.encrypted === true;
  if (encrypted) {
    if (!passphrase) throw new BackupError("This backup is encrypted. Enter its passphrase.", "needs-passphrase");
    const kdf = parsed.kdf as { iterations?: unknown; salt?: unknown } | undefined;
    const cipher = parsed.cipher as { iv?: unknown } | undefined;
    if (typeof kdf?.salt !== "string" || typeof cipher?.iv !== "string" || typeof parsed.ciphertext !== "string") throw new BackupError("This backup's encryption header is damaged.", "corrupt");
    const iterations = Math.min(2_000_000, Math.max(100_000, Number(kdf.iterations) || PBKDF2_ITERATIONS));
    try {
      const key = await deriveKey(passphrase, fromBase64(kdf.salt), iterations);
      const plain = await subtle().decrypt({ name: "AES-GCM", iv: fromBase64(cipher.iv) as BufferSource }, key, fromBase64(parsed.ciphertext) as BufferSource);
      body = JSON.parse(decoder.decode(plain));
    } catch {
      throw new BackupError("That passphrase doesn't open this backup.", "wrong-passphrase");
    }
  } else {
    body = parsed as { sections?: unknown; checksum?: unknown };
  }
  if (!body.sections || typeof body.sections !== "object" || typeof body.checksum !== "string") throw new BackupError("This backup is incomplete.", "corrupt");
  if (await sha256(canonical(body.sections)) !== body.checksum) throw new BackupError("This backup was changed after it was made, so it can't be trusted.", "corrupt");
  const sections: BackupSections = {};
  for (const section of SECTIONS) {
    const values = (body.sections as Record<string, unknown>)[section.id];
    if (!values || typeof values !== "object" || Array.isArray(values)) continue;
    const allowed = new Set(section.keys);
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
      const ok = allowed.has(key) || (section.prefixes ?? []).some((prefix) => key.startsWith(prefix));
      if (ok && !forbidden(key)) clean[key] = value;
    }
    if (Object.keys(clean).length) sections[section.id] = clean;
  }
  return {
    manifest: {
      version,
      app: typeof parsed.app === "string" ? parsed.app : "unknown",
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
      platform: typeof parsed.platform === "string" ? parsed.platform : "unknown",
      encrypted,
      sections: SECTIONS.filter((section) => sections[section.id]).map((section) => ({ id: section.id, label: section.label, items: countItems(sections[section.id]!) })),
    },
    sections,
  };
}

type Item = Record<string, unknown>;
const idOf = (item: unknown) => (item && typeof item === "object" ? (item as Item).id ?? (item as Item).workflowId : undefined);
const stampOf = (item: unknown) => {
  if (!item || typeof item !== "object") return 0;
  const record = item as Item;
  return Math.max(0, ...[record.updatedAt, record.createdAt, record.at, record.startedAt].map((value) => (typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) || 0 : 0)));
};

/** Merge an incoming list into the local one by id: add what's missing, keep the newer of what both have. Exported for tests. */
export function mergeLists(local: unknown[], incoming: unknown[]): unknown[] {
  const byId = new Map<unknown, unknown>();
  const anonymous: unknown[] = [];
  for (const item of local) {
    const id = idOf(item);
    if (id === undefined) anonymous.push(item);
    else byId.set(id, item);
  }
  for (const item of incoming) {
    const id = idOf(item);
    if (id === undefined) {
      if (!anonymous.some((existing) => canonical(existing) === canonical(item))) anonymous.push(item);
    } else if (!byId.has(id) || stampOf(item) > stampOf(byId.get(id))) {
      byId.set(id, item);
    }
  }
  return [...byId.values(), ...anonymous];
}

export type RestoreMode = "merge" | "replace";

/**
 * Write a backup's sections to this device. "merge" keeps what's here and adds
 * the rest; "replace" makes the chosen sections match the backup. Returns the
 * sections written. Nothing in NEVER_BACKED_UP is ever written.
 */
export function restoreBackup(backup: Backup, options: { mode?: RestoreMode; sections?: SectionId[] } = {}): SectionId[] {
  const store = storage();
  if (!store) return [];
  const mode = options.mode ?? "merge";
  const written: SectionId[] = [];
  const events = new Set<string>();
  for (const section of SECTIONS) {
    const values = backup.sections[section.id];
    if (!values || (options.sections && !options.sections.includes(section.id))) continue;
    if (mode === "replace") for (const key of sectionKeys(section, store)) store.removeItem(key);
    for (const [key, value] of Object.entries(values)) {
      if (forbidden(key)) continue;
      const current = mode === "merge" ? store.getItem(key) : null;
      if (current === null) {
        store.setItem(key, decodeValue(value));
        continue;
      }
      let local: unknown;
      try {
        local = JSON.parse(current);
      } catch {
        local = undefined;
      }
      // Lists merge by id; anything else already here is kept.
      if (Array.isArray(local) && Array.isArray(value)) store.setItem(key, JSON.stringify(mergeLists(local, value)));
    }
    written.push(section.id);
    for (const event of section.event ?? []) events.add(event);
  }
  for (const event of events) {
    try {
      window.dispatchEvent(new Event(event));
    } catch {
      // No window events.
    }
  }
  return written;
}
