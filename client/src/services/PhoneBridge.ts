/**
 * HANNAH Phone Bridge, in the app.
 *
 * On a computer (web or desktop app):
 * - Pair a phone with a one-time code.
 * - Send it a call, an SMS or a contact lookup.
 * - Follow what the phone reports.
 *
 * On the phone (the Android or iOS app, signed in to the same account):
 * - Pair with that code and a device key: a P-256 key made here whose private
 *   half can't be exported, kept in IndexedDB.
 * - While HANNAH is open, with "Use this phone from my computer" on, fetch
 *   requests with signed calls, check each one again here, and hand it to the
 *   phone's own dialer, messaging app or contacts through the native
 *   HannahPhone plugin.
 * - Report what happened, signed.
 *
 * Nothing calls or texts silently: the dialer waits for Call and the composer
 * for Send. A request is never kept for later: it's for this minute or not at all.
 */
import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { accountRequest, AccountError } from "./Account";
import { apiFetch, apiUrl, getAccountHint, usesBearerSession } from "./api";

export type PhoneCapability = "call" | "sms" | "contacts";
export type PairedPhone = { id: string; name: string; platform: "android" | "ios"; fingerprint: string; capabilities: PhoneCapability[]; isDefault: boolean; pairedBy: string | null; createdAt: number; lastSeenAt: number | null; online: boolean };
export type PhoneCommandStatus = "pending" | "delivered" | "dialer-opened" | "composer-opened" | "sent" | "cancelled" | "declined" | "failed" | "resolved" | "expired" | "no-report";
export type ContactMatch = { name: string; numbers: Array<{ label: string | null; number: string }> };
export type PhoneCommand = {
  id: string; phoneId: string; action: "call" | "sms" | "lookup"; status: PhoneCommandStatus; requestedBy: string | null;
  payload: { number?: string; name?: string | null; body?: string; query?: string };
  createdAt: number; expiresAt: number; deliveredAt: number | null; finishedAt: number | null;
  result: { detail: string | null; matches?: ContactMatch[]; by?: string } | null;
};

const post = <T>(path: string, body: unknown = {}) => accountRequest<T>(path, { method: "POST", body: JSON.stringify(body) });

// ---------- the computer ----------

export const PhoneBridgeApi = {
  createPairingCode: (deviceName: string) => post<{ code: string; expiresAt: number }>("/api/phone/pairing", { deviceName }),
  pairingStatus: (code: string) => post<{ paired: boolean; expired?: boolean; phone?: PairedPhone | null }>("/api/phone/pairing/status", { code }),
  phones: () => accountRequest<{ phones: PairedPhone[] }>("/api/phone/devices"),
  makeDefault: (id: string) => accountRequest<{ phone: PairedPhone }>(`/api/phone/devices/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ isDefault: true }) }),
  revoke: (id: string) => accountRequest<{ revoked: true }>(`/api/phone/devices/${encodeURIComponent(id)}`, { method: "DELETE" }),
  send: (request: { action: "call" | "sms" | "lookup"; phoneId?: string; number?: string; name?: string; body?: string; query?: string; deviceName?: string }) => post<{ command: PhoneCommand; phone: PairedPhone }>("/api/phone/commands", request),
  command: (id: string) => accountRequest<{ command: PhoneCommand }>(`/api/phone/commands/${encodeURIComponent(id)}`),
  history: (limit = 30) => accountRequest<{ commands: PhoneCommand[] }>(`/api/phone/commands?limit=${limit}`),
  cancel: (id: string) => post<{ status: string }>(`/api/phone/commands/${encodeURIComponent(id)}/cancel`),
};

const FINAL: PhoneCommandStatus[] = ["dialer-opened", "sent", "cancelled", "declined", "failed", "resolved", "expired", "no-report"];

/**
 * Wait for a request's outcome. Stops at a final state, or at "composer-opened"
 * on Android, which can't tell apps whether the person then sent the message.
 */
export async function waitForPhone(id: string, { timeoutMs = 45_000, intervalMs = 1500, platform, sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)) }: { timeoutMs?: number; intervalMs?: number; platform?: string; sleep?: (ms: number) => Promise<unknown> } = {}): Promise<PhoneCommand> {
  const deadline = Date.now() + timeoutMs;
  let last: PhoneCommand | null = null;
  while (Date.now() < deadline) {
    last = (await PhoneBridgeApi.command(id)).command;
    if (FINAL.includes(last.status) || (last.status === "composer-opened" && platform === "android")) return last;
    await sleep(intervalMs);
  }
  return last ?? (await PhoneBridgeApi.command(id)).command;
}

/** What a request's state means, in words the person can trust. Only verified states are claimed. */
export function describeOutcome(command: PhoneCommand, phoneName: string): string {
  const who = command.payload.name ? `${command.payload.name} (${command.payload.number})` : command.payload.number;
  switch (command.status) {
    case "pending": return `Sent to ${phoneName}; it hasn't picked it up yet.`;
    case "delivered": return `${phoneName} received the request and hasn't reported back yet.`;
    case "dialer-opened": return `The dialer opened on ${phoneName} with ${who}. Tap Call on the phone to place it. HANNAH can't see whether the call connects.`;
    case "composer-opened": return `The message to ${who} is open in ${phoneName}'s messaging app. Tap Send there; the phone doesn't tell HANNAH whether you did.`;
    case "sent": return `You sent the message to ${who} from ${phoneName}. (Sent from the phone; delivery isn't reported.)`;
    case "cancelled": return command.result?.by === "computer" ? "Cancelled before the phone received it." : `You cancelled it on ${phoneName}.`;
    case "declined": return `${phoneName} declined it: ${command.result?.detail || "not allowed on the phone."}`;
    case "failed": return `${phoneName} couldn't do it: ${command.result?.detail || "unknown error."}`;
    case "resolved": return `${phoneName} found ${command.result?.matches?.length ?? 0} matching contact(s).`;
    case "expired": return `${phoneName} didn't pick it up within a minute, so it was dropped. Nothing will happen later.`;
    case "no-report": return `${phoneName} received it but never reported back.`;
    default: return command.status;
  }
}

// ---------- shared checks (the phone runs these again on its own) ----------

const EMERGENCY = new Set(["000", "08", "100", "101", "102", "103", "108", "110", "112", "113", "115", "118", "119", "122", "15", "17", "18", "911", "999", "1122", "1091", "1098", "181"]);

/** The number to dial, or why it's refused. */
export function checkNumber(input: string): { number: string } | { refused: string } {
  const raw = String(input ?? "").trim();
  if (/[*#]/.test(raw)) return { refused: "Codes with * or # aren't dialled by HANNAH." };
  if (!/^\+?[\d\s().-]{3,25}$/.test(raw)) return { refused: "That isn't a phone number." };
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 3 || digits.length > 17) return { refused: "That isn't a phone number." };
  if (EMERGENCY.has(digits) || (digits.length <= 5 && [...EMERGENCY].some((number) => number.length >= 3 && digits.endsWith(number)))) return { refused: "HANNAH doesn't call or text emergency numbers. Dial it yourself." };
  return { number: `${raw.startsWith("+") ? "+" : ""}${digits}` };
}

// ---------- the phone ----------

type NativeResult = { result: "opened" | "sent" | "cancelled" | "failed" };
export interface HannahPhonePlugin {
  capabilities(): Promise<{ platform: string; canDial: boolean; canSms: boolean; contactsPermission: "granted" | "denied" | "prompt" | string }>;
  dial(options: { number: string }): Promise<NativeResult>;
  composeSms(options: { number: string; body: string }): Promise<NativeResult>;
  findContacts(options: { query: string }): Promise<{ matches: ContactMatch[] }>;
  addListener(event: "smsComposerPresented", listener: () => void): Promise<PluginListenerHandle>;
}

let nativePlugin: HannahPhonePlugin | undefined;
export const hannahPhone = () => (nativePlugin ??= registerPlugin<HannahPhonePlugin>("HannahPhone"));

/** True in the Android and iOS apps, which can act as the paired phone. */
export function isPhoneApp() {
  const platform = Capacitor.getPlatform();
  return Capacitor.isNativePlatform() && (platform === "android" || platform === "ios");
}

const SETTINGS_KEY = "hannah.phoneBridge.v1";
const NONCES_KEY = "hannah.phoneBridge.nonces";
export type PhoneSettings = { enabled: boolean; capabilities: PhoneCapability[]; phoneId: string | null; fingerprint: string | null };
const DEFAULT_SETTINGS: PhoneSettings = { enabled: true, capabilities: ["call", "sms"], phoneId: null, fingerprint: null };

export function phoneSettings(): PhoneSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    return saved ? { ...DEFAULT_SETTINGS, ...saved } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
function saveSettings(settings: PhoneSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable: the pairing lasts for this session.
  }
  window.dispatchEvent(new CustomEvent("hannah:phone-bridge"));
}

// The key pair lives in IndexedDB as non-extractable CryptoKeys: scripts can sign with it, nothing can read it out.
const DB_NAME = "hannah-phone-bridge";
function keyStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore("keys");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const transaction = open.result.transaction("keys", mode);
      const request = run(transaction.objectStore("keys"));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => open.result.close();
    };
  });
}
const loadKeys = () => keyStore<CryptoKeyPair | undefined>("readonly", (store) => store.get("device"));
const saveKeys = (keys: CryptoKeyPair) => keyStore("readwrite", (store) => store.put(keys, "device"));
const clearKeys = () => keyStore("readwrite", (store) => store.delete("device"));

const base64url = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The exact string the server checks: id, time, method, path and the body's hash. */
export async function signedMessage(phoneId: string, time: number, method: string, path: string, body: string) {
  return `${phoneId}\n${time}\n${method.toUpperCase()}\n${path}\n${await sha256Hex(body)}`;
}

let clockOffset = 0;
async function phoneRequest<T>(method: "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
  const settings = phoneSettings();
  const keys = await loadKeys();
  if (!settings.phoneId || !keys) throw new AccountError("This phone isn't paired.", 401, "not-paired");
  const text = body === undefined ? "" : JSON.stringify(body);
  const time = Date.now() + clockOffset;
  const url = new URL(apiUrl(path), window.location.href);
  const message = await signedMessage(settings.phoneId, time, method, url.pathname, text);
  const signature = base64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, new TextEncoder().encode(message)));
  const response = await apiFetch(apiUrl(path), {
    method,
    credentials: usesBearerSession() ? "omit" : "same-origin",
    headers: { Accept: "application/json", "Content-Type": "application/json", "X-Hannah-Phone": settings.phoneId, "X-Hannah-Time": String(time), "X-Hannah-Signature": signature, ...(usesBearerSession() ? { "X-HANNAH-Session": "bearer" } : {}) },
    ...(body === undefined ? {} : { body: text }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json().catch(() => ({})) as { error?: string; reason?: string; serverTime?: number };
  if (!response.ok) throw new AccountError(data.error || `HTTP ${response.status}`, response.status, data.reason);
  if (typeof data.serverTime === "number") clockOffset = data.serverTime - Date.now();
  return data as T;
}

/** Pair this phone with the code a computer shows. */
export async function pairThisPhone(code: string, { name, capabilities }: { name: string; capabilities: PhoneCapability[] }) {
  if (!isPhoneApp()) throw new Error("Pair from the HANNAH app on your Android phone or iPhone.");
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const { phone } = await post<{ phone: PairedPhone }>("/api/phone/pair", { code, platform: Capacitor.getPlatform(), name, publicKey: { kty: publicKey.kty, crv: publicKey.crv, x: publicKey.x, y: publicKey.y }, capabilities });
  await saveKeys(keys);
  saveSettings({ ...phoneSettings(), phoneId: phone.id, fingerprint: phone.fingerprint, capabilities, enabled: true });
  return phone;
}

export async function updateThisPhone(next: Partial<Pick<PhoneSettings, "enabled" | "capabilities">>) {
  const settings = { ...phoneSettings(), ...next };
  saveSettings(settings);
  if (settings.phoneId) await phoneRequest("POST", "/api/phone/me/heartbeat", { capabilities: settings.enabled ? settings.capabilities : [] }).catch(() => {});
}

export async function unpairThisPhone() {
  await phoneRequest("DELETE", "/api/phone/me").catch(() => {});
  await clearKeys().catch(() => {});
  saveSettings({ ...DEFAULT_SETTINGS });
}

type DeliveredCommand = { id: string; action: "call" | "sms" | "lookup"; payload: { number?: string; name?: string | null; body?: string; query?: string }; nonce: string; expiresAt: number; requestedBy: string | null };
export type PhoneEvent = { at: number; action: string; who: string; status: string; requestedBy: string | null };
const recent: PhoneEvent[] = [];
export const recentPhoneEvents = () => [...recent];

function rememberNonce(nonce: string) {
  let seen: string[] = [];
  try {
    seen = JSON.parse(localStorage.getItem(NONCES_KEY) || "[]");
  } catch {
    seen = [];
  }
  if (seen.includes(nonce)) return false;
  try {
    localStorage.setItem(NONCES_KEY, JSON.stringify([nonce, ...seen].slice(0, 200)));
  } catch {
    // Without storage, the server's single delivery still stops repeats.
  }
  return true;
}

/** Check a request on the phone, independently of the server, then hand it to the native app. Exported for tests. */
export async function handleCommand(command: DeliveredCommand, { plugin = hannahPhone(), settings = phoneSettings(), now = () => Date.now() + clockOffset, report }: { plugin?: HannahPhonePlugin; settings?: PhoneSettings; now?: () => number; report: (status: string, extra?: Record<string, unknown>) => Promise<unknown> }) {
  const need: Record<DeliveredCommand["action"], PhoneCapability> = { call: "call", sms: "sms", lookup: "contacts" };
  if (!settings.enabled) return report("declined", { detail: "Using this phone from a computer is turned off on the phone." });
  if (!need[command.action] || !settings.capabilities.includes(need[command.action])) return report("declined", { detail: `${command.action === "lookup" ? "Contact lookups" : command.action === "sms" ? "Preparing SMS" : "Calls"} aren't allowed on this phone.` });
  if (command.expiresAt <= now()) return report("declined", { detail: "The request was too old." });
  if (!rememberNonce(command.nonce)) return report("declined", { detail: "This request was already handled." });

  if (command.action === "lookup") {
    try {
      const { matches } = await plugin.findContacts({ query: String(command.payload.query || "") });
      return report("resolved", { matches });
    } catch (error) {
      const code = (error as { code?: string }).code;
      return report(code === "PERMISSION_DENIED" ? "declined" : "failed", { detail: error instanceof Error ? error.message : String(error) });
    }
  }
  const checked = checkNumber(String(command.payload.number || ""));
  if ("refused" in checked) return report("declined", { detail: checked.refused });

  if (command.action === "call") {
    try {
      await plugin.dial({ number: checked.number });
      return report("dialer-opened");
    } catch (error) {
      return report("failed", { detail: error instanceof Error ? error.message : String(error) });
    }
  }

  // SMS: report "composer-opened" when it's on screen, then what the person did (iOS says; Android doesn't).
  let opened = false;
  const listener = await plugin.addListener("smsComposerPresented", () => { opened = true; void report("composer-opened"); }).catch(() => null);
  try {
    const { result } = await plugin.composeSms({ number: checked.number, body: String(command.payload.body || "") });
    if (result === "opened") return opened ? undefined : report("composer-opened");
    if (!opened) await report("composer-opened");
    return report(result === "sent" ? "sent" : result === "cancelled" ? "cancelled" : "failed", result === "failed" ? { detail: "The messaging app reported a failure." } : {});
  } catch (error) {
    return report("failed", { detail: error instanceof Error ? error.message : String(error) });
  } finally {
    await listener?.remove();
  }
}

/** While HANNAH is open on a paired phone, take requests from the person's computer. Returns a stop function. */
export function startPhoneBridge(): () => void {
  if (!isPhoneApp()) return () => {};
  let stopped = false;
  let busy = false;
  const tick = async () => {
    const settings = phoneSettings();
    if (stopped || busy || !settings.phoneId || !settings.enabled || !getAccountHint() || document.visibilityState !== "visible") return;
    busy = true;
    try {
      const { commands } = await phoneRequest<{ commands: DeliveredCommand[] }>("POST", "/api/phone/me/commands", {});
      for (const command of commands) {
        await handleCommand(command, {
          report: async (status, extra = {}) => {
            recent.unshift({ at: Date.now(), action: command.action, who: command.payload.name || command.payload.number || command.payload.query || "", status, requestedBy: command.requestedBy });
            recent.splice(20);
            window.dispatchEvent(new CustomEvent("hannah:phone-bridge"));
            return phoneRequest("POST", `/api/phone/me/commands/${encodeURIComponent(command.id)}/result`, { nonce: command.nonce, status, ...extra }).catch(() => {});
          },
        });
      }
    } catch (error) {
      // A removed pairing ends here; anything else is retried on the next tick.
      if (error instanceof AccountError && error.reason === "revoked") {
        await clearKeys().catch(() => {});
        saveSettings({ ...DEFAULT_SETTINGS });
      }
    } finally {
      busy = false;
    }
  };
  void updateThisPhone({});
  const timer = window.setInterval(() => void tick(), 3000);
  const onVisible = () => { if (document.visibilityState === "visible") { void updateThisPhone({}); void tick(); } };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    stopped = true;
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
