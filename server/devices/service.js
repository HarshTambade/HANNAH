"use strict";

/**
 * The device registry: hubs, the devices behind them, the commands sent to
 * them and the rules they run. One per server.
 *
 * A HUB is a computer on the person's own network running HANNAH Edge. It
 * enrolls once with a one-time code and receives a secret, sealed here in the
 * vault. After that it opens every connection itself: a signed request every
 * couple of seconds that reports what it sees and collects what it should do.
 * The server never connects to a hub or to a device.
 *
 * A DEVICE is one thing reached through a hub, described by a profile. Its
 * life: added → verified (the hub connected and heard it) → active (a person
 * switched it on and chose what HANNAH may change) → disabled. Only an active
 * device is given to the hub to run. Changing its settings sends it back to
 * the start.
 *
 * A COMMAND is one signed request to a hub: write this value to this point of
 * this device, check this draft device, look at this broker. It names the hub,
 * carries a sequence number that only goes up, and expires in seconds; one
 * that isn't taken in time never runs later. Its states are what was observed:
 *   queued → sent → done        the device reported the new value
 *                 → unverified  written, and the device didn't confirm it
 *                 → refused     the hub's own checks refused it
 *                 → failed
 *   expired     never taken     ·   no-answer   taken, and no result came back
 *
 * A RULE is a comparison and a few writes that the hub evaluates by itself,
 * with no model anywhere. It is created through the Action Engine (so a
 * person approves exactly what it will do) and can only write where a person
 * allowed writes.
 */
const crypto = require("node:crypto");
const { decryptSecret, encryptSecret, vaultConfigured } = require("../vault");
const profiles = require("./profiles");
const safety = require("./safety");

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_TTL_MS = 15 * 60_000;
const SKEW_MS = 60_000;
const COMMAND_TTL_MS = 20_000;
const PROBE_S = 8;
const ANSWER_GRACE_MS = 30_000;
const SYNC_INTERVAL_MS = 2000;
const MAX_HUBS = 10;
const MAX_DEVICES = 100;
const MAX_RULES = 50;
const MAX_PROFILES = 60;
const HISTORY_EVERY_MS = 60_000;
const HISTORY_KEEP_MS = 24 * 60 * 60_000;
const EVENTS_KEEP_MS = 30 * 24 * 60 * 60_000;
const COMMANDS_KEEP_MS = 30 * 24 * 60 * 60_000;
const UPDATE_BUNDLE_MAX = 20 * 1024 * 1024;
const ROLLOUT_CONFIRM_MS = 5 * 60_000;
const AUTH_LABEL = "hannah-hub-auth-v1";
const COMMAND_LABEL = "hannah-hub-command-v1";
const CONFIG_LABEL = "hannah-hub-config-v1";
const FINAL = new Set(["done", "unverified", "refused", "failed", "expired", "no-answer"]);
const ALERTS = new Set(["device-offline", "device-error", "rule-failed", "rule-limited", "rule-waiting", "write-unconfirmed", "hub-revoked"]);

const fail = (status, message, reason, extra = {}) => Object.assign(new Error(message), { status, reason, ...extra });
const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const parse = (text, fallback = null) => { if (text === null || text === undefined || text === "") return fallback; try { return JSON.parse(text) ?? fallback; } catch { return fallback; } };
const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
const deriveKey = (secret, label) => crypto.createHmac("sha256", Buffer.from(String(secret), "base64url")).update(label).digest();
const hmac = (key, text) => crypto.createHmac("sha256", key).update(text).digest("hex");
const signRequest = (secret, { hubId, time, counter, method, path, body }) => hmac(deriveKey(secret, AUTH_LABEL), `${hubId}\n${time}\n${counter}\n${String(method).toUpperCase()}\n${path}\n${sha256(body || "")}`);
const signCommand = (secret, payload) => hmac(deriveKey(secret, COMMAND_LABEL), payload);
const signConfig = (secret, payload) => hmac(deriveKey(secret, CONFIG_LABEL), payload);
const fingerprintOf = (secret) => sha256(`hannah-hub-fingerprint-v1:${secret}`).slice(0, 16).toUpperCase().replace(/(.{4})(?=.)/g, "$1 ");
const codeHash = (code) => sha256(`hannah-hub-enroll:${String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "")}`);
function sameHex(a, b) {
  const left = Buffer.from(String(a), "utf8");
  const right = Buffer.from(String(b), "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function newCode() {
  const bytes = crypto.randomBytes(8);
  const text = [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
  return `${text.slice(0, 4)}-${text.slice(4)}`;
}
const scalar = (value) => (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) || typeof value === "string" ? value : null);

function createDeviceService({ now = () => Date.now(), ackWaitMs = Number(process.env.HANNAH_DEVICE_ACK_WAIT_MS) || 9000, pollMs = 150, emit = null } = {}) {
  const announce = (userId, event, data) => { if (emit) Promise.resolve().then(() => emit(userId, event, data)).catch(() => {}); };
  const lastSample = new Map();
  let housekeeping = 0;

  // ---------- views ----------
  function hubView(row, at = now()) {
    if (!row) return null;
    const descriptor = parse(row.descriptor, {});
    const lastSeenAt = row.last_seen_at ? Number(row.last_seen_at) : null;
    const online = row.status === "enrolled" && lastSeenAt !== null && at - lastSeenAt <= safety.ONLINE_MS;
    return {
      id: row.id, name: row.name, status: row.status, online, lastSeenAt,
      connection: row.status === "pending" ? "awaiting-enrollment" : row.status === "revoked" ? "revoked" : online ? "online" : lastSeenAt ? "offline" : "never-connected",
      software: descriptor.software || null, system: [descriptor.system, descriptor.machine].filter(Boolean).join(" ") || null, adapters: (descriptor.adapters || []).map((item) => item.name), adapterDetails: descriptor.adapters || [],
      fingerprint: descriptor.fingerprint || null, rulesSuspended: Boolean(Number(row.rules_suspended)), configVersion: Number(row.config_version), upToDate: Number(row.reported_config) === Number(row.config_version),
      discovered: parse(row.discovered), updateStatus: parse(row.update_status), createdAt: Number(row.created_at), enrolledAt: row.enrolled_at ? Number(row.enrolled_at) : null,
      enrollmentExpiresAt: row.enroll_hash && row.enroll_expires_at ? Number(row.enroll_expires_at) : null,
    };
  }
  function deviceView(row, hub, at = now()) {
    if (!row) return null;
    const profile = parse(row.profile, {});
    const state = parse(row.state, {});
    const hubOnline = Boolean(hub?.online);
    const fresh = hubOnline && state.receivedAt && at - state.receivedAt <= safety.ONLINE_MS;
    const points = {};
    for (const point of profile.points || []) {
      const reading = state.points?.[point.id];
      if (!reading) continue;
      const ageS = Math.max(0, Math.round((at - reading.at) / 1000));
      // A value is "live" only while its hub is reporting it. Otherwise it is the last value known, and says so.
      points[point.id] = { value: reading.value, at: reading.at, ageS, live: Boolean(fresh && state.connection?.state === "online"), unit: point.unit || null };
    }
    const reported = state.connection?.state || null;
    const connection = row.status !== "active" ? "not-running" : !hubOnline ? "hub-offline" : !fresh ? "waiting" : reported === "online" ? "online" : reported === "offline" ? "offline" : reported === "no-data" ? "no-data" : reported === "error" ? "error" : "waiting";
    return {
      id: row.id, name: row.name, location: row.location || "", status: row.status,
      hub: hub ? { id: hub.id, name: hub.name, online: hubOnline } : { id: row.hub_id, name: "(removed hub)", online: false },
      profile: { ...profiles.publicProfile(profile), fullPoints: undefined }, profileSource: row.profile_source,
      compatibility: profiles.compatibility(profile, { source: row.profile_source, hubAdapters: hub?.adapters?.length ? hub.adapters : null }),
      settings: parse(row.settings, {}), hasSecrets: Boolean(row.ciphertext), writable: parse(row.writable, []), alwaysAsk: parse(row.always_ask, []),
      verification: parse(row.verification), connection, connectionDetail: connection === "hub-offline" ? "its hub isn't connected" : state.connection?.message || state.connection?.reason || "",
      points, rejected: state.rejected || 0, lastSeenAt: row.last_seen_at ? Number(row.last_seen_at) : null, createdAt: Number(row.created_at),
    };
  }
  /** The view the Safety Gateway works with: the public view plus the full profile (bindings are never returned to a caller). */
  const internal = (row, hub, at = now()) => ({ ...deviceView(row, hub, at), profile: { ...parse(row.profile, {}), categoryLabel: profiles.CATEGORIES[parse(row.profile, {}).category] } });

  const hubRow = async (db, userId, id) => (await db.query("SELECT * FROM hannah_hubs WHERE user_id = $1 AND id = $2", [userId, String(id || "")])).rows[0] || null;
  const hubRows = async (db, userId) => (await db.query("SELECT * FROM hannah_hubs WHERE user_id = $1 ORDER BY created_at", [userId])).rows;
  const deviceRow = async (db, userId, id) => (await db.query("SELECT * FROM hannah_devices WHERE user_id = $1 AND id = $2", [userId, String(id || "")])).rows[0] || null;
  const deviceRows = async (db, userId) => (await db.query("SELECT * FROM hannah_devices WHERE user_id = $1 ORDER BY created_at", [userId])).rows;
  const bump = (db, hubId) => db.query("UPDATE hannah_hubs SET config_version = config_version + 1, updated_at = $1 WHERE id = $2", [now(), hubId]);

  async function addEvent(db, userId, { id = crypto.randomUUID(), hubId = null, deviceId = null, ruleId = null, type, severity = "info", message, source = "server", at = now() }) {
    const kind = clean(type, 40) || "event";
    const inserted = await db.query("INSERT INTO hannah_device_events (user_id, id, hub_id, device_id, rule_id, at, type, severity, message, source) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (user_id, id) DO NOTHING",
      [userId, id, hubId, deviceId, ruleId, at, kind, ["info", "warning", "error"].includes(severity) ? severity : "info", clean(message, 400), source]).catch(() => ({ rowCount: 0 }));
    if (inserted.rowCount && ALERTS.has(kind)) announce(userId, "device.alert", { type: kind, severity, message: clean(message, 400), hubId, deviceId, ruleId, at });
    return Boolean(inserted.rowCount);
  }

  // ---------- hubs ----------
  async function listHubs(db, userId) { return (await hubRows(db, userId)).map((row) => hubView(row)); }
  async function getHub(db, userId, id) {
    const row = await hubRow(db, userId, id);
    if (!row) throw fail(404, "That hub isn't in your account.", "not-found");
    return hubView(row);
  }
  async function resolveHub(db, userId, reference) {
    const hubs = await listHubs(db, userId);
    const wanted = clean(reference, 80);
    if (!wanted) {
      const usable = hubs.filter((hub) => hub.status === "enrolled");
      if (usable.length === 1) return usable[0];
      throw fail(400, usable.length ? `Which hub? You have: ${usable.map((hub) => hub.name).join(", ")}.` : "You have no hub yet. Add one under Devices.", usable.length ? "ambiguous-hub" : "no-hub");
    }
    const found = hubs.find((hub) => hub.id === wanted) || hubs.filter((hub) => hub.name.toLowerCase() === wanted.toLowerCase())[0];
    if (!found) throw fail(404, `You have no hub called “${wanted}”.`, "not-found");
    return found;
  }
  async function createHub(db, userId, { name } = {}) {
    const label = clean(name, 60);
    if (!label) throw fail(400, "Give the hub a name.", "bad-request");
    if (!vaultConfigured()) throw fail(503, "This server can't enroll hubs yet: it has no key vault to store a hub's secret in.", "vault-unconfigured");
    const existing = await listHubs(db, userId);
    if (existing.length >= MAX_HUBS) throw fail(400, `You have ${MAX_HUBS} hubs. Remove one first.`, "too-many");
    if (existing.some((hub) => hub.name.toLowerCase() === label.toLowerCase())) throw fail(409, `You already have a hub called “${label}”.`, "duplicate-name");
    const id = `hub_${crypto.randomBytes(9).toString("hex")}`;
    const code = newCode();
    const at = now();
    await db.query("INSERT INTO hannah_hubs (user_id, id, name, status, descriptor, enroll_hash, enroll_expires_at, created_at, updated_at) VALUES ($1, $2, $3, 'pending', '{}', $4, $5, $6, $6)", [userId, id, label, codeHash(code), at + CODE_TTL_MS, at]);
    await addEvent(db, userId, { hubId: id, type: "hub-created", message: `Hub “${label}” created. Waiting for it to enroll.` });
    return { hub: await getHub(db, userId, id), enrollment: { code, expiresAt: at + CODE_TTL_MS } };
  }
  async function issueHubCode(db, userId, id) {
    const row = await hubRow(db, userId, id);
    if (!row) throw fail(404, "That hub isn't in your account.", "not-found");
    if (!vaultConfigured()) throw fail(503, "This server has no key vault to store a hub's secret in.", "vault-unconfigured");
    const code = newCode();
    const at = now();
    await db.query("UPDATE hannah_hubs SET enroll_hash = $1, enroll_expires_at = $2, updated_at = $3 WHERE user_id = $4 AND id = $5", [codeHash(code), at + CODE_TTL_MS, at, userId, row.id]);
    return { hub: await getHub(db, userId, row.id), enrollment: { code, expiresAt: at + CODE_TTL_MS } };
  }
  async function enrollHub(db, { code, descriptor } = {}) {
    const hash = codeHash(code);
    const row = (await db.query("SELECT * FROM hannah_hubs WHERE enroll_hash = $1", [hash])).rows[0];
    const at = now();
    if (!row || !row.enroll_expires_at || Number(row.enroll_expires_at) <= at) throw fail(403, "That enrollment code isn't valid or has expired. Create a new one under Devices.", "bad-code");
    if (!vaultConfigured()) throw fail(503, "This server has no key vault to store a hub's secret in.", "vault-unconfigured");
    const input = descriptor && typeof descriptor === "object" ? descriptor : {};
    if (input.protocol !== "hannah-hub/1") throw fail(400, "This hub's software speaks a protocol this server doesn't. Update one of them.", "protocol-mismatch");
    const secret = crypto.randomBytes(32).toString("base64url");
    const described = {
      protocol: input.protocol, software: clean(input.software, 20), python: clean(input.python, 20), system: clean(input.system, 30), machine: clean(input.machine, 30), fingerprint: fingerprintOf(secret),
      adapters: (Array.isArray(input.adapters) ? input.adapters : []).slice(0, 12).filter((item) => Object.hasOwn(profiles.ADAPTERS, item?.name)).map((item) => Object.fromEntries(Object.entries(item).filter(([, value]) => typeof value === "string").map(([key, value]) => [clean(key, 30), clean(value, 400)]))),
    };
    const sealed = encryptSecret(secret, { userId: row.user_id, providerId: `hub:${row.id}` });
    const won = await db.query(
      "UPDATE hannah_hubs SET status = 'enrolled', descriptor = $1, key_id = $2, wrapped_key = $3, ciphertext = $4, enroll_hash = NULL, enroll_expires_at = NULL, counter = 0, reported_config = 0, enrolled_at = $5, updated_at = $5, revoked_at = NULL, last_seen_at = NULL WHERE id = $6 AND enroll_hash = $7",
      [JSON.stringify(described), sealed.keyId, sealed.wrappedKey, sealed.ciphertext, at, row.id, hash]);
    if (!won.rowCount) throw fail(403, "That enrollment code was just used.", "bad-code");
    await addEvent(db, row.user_id, { hubId: row.id, type: "hub-enrolled", message: `Hub “${row.name}” enrolled (${described.system || "unknown system"}, software ${described.software || "?"}, adapters: ${described.adapters.map((item) => item.name).join(", ") || "none"}).` });
    return { hubId: row.id, name: row.name, secret, fingerprint: described.fingerprint, serverTime: at, intervalMs: SYNC_INTERVAL_MS };
  }
  async function authenticate(db, { hubId, time, counter, signature, method, path, body }) {
    const refused = (reason) => fail(401, "The hub's request wasn't accepted.", reason);
    const id = String(hubId || "");
    if (!/^hub_[0-9a-f]{18}$/.test(id) || !/^[0-9a-f]{64}$/.test(String(signature || ""))) throw refused("bad-signature");
    const row = (await db.query("SELECT * FROM hannah_hubs WHERE id = $1", [id])).rows[0];
    if (!row || row.status !== "enrolled" || !row.ciphertext) throw refused(row?.status === "revoked" ? "revoked" : "bad-signature");
    let secret;
    try { secret = decryptSecret(row, { userId: row.user_id, providerId: `hub:${row.id}` }).secret; } catch { throw fail(503, "The server can't read this hub's key.", "vault-key-missing"); }
    if (!sameHex(signRequest(secret, { hubId: id, time: String(time), counter: String(counter), method, path, body }), signature)) throw refused("bad-signature");
    const stamp = Number(time);
    const count = Number(counter);
    if (!Number.isFinite(stamp) || Math.abs(now() - stamp) > SKEW_MS) throw fail(401, "The hub's clock is more than a minute away from the server's. Set the hub's clock.", "clock-skew");
    if (!Number.isSafeInteger(count) || count <= 0) throw refused("replayed");
    const advanced = await db.query("UPDATE hannah_hubs SET counter = $1 WHERE id = $2 AND counter < $1 AND status = 'enrolled'", [count, id]);
    if (!advanced.rowCount) throw refused("replayed");
    return { row, secret };
  }
  async function revokeHub(db, userId, id) {
    const row = await hubRow(db, userId, id);
    if (!row) throw fail(404, "That hub isn't in your account.", "not-found");
    const at = now();
    await db.query("UPDATE hannah_hubs SET status = 'revoked', key_id = NULL, wrapped_key = NULL, ciphertext = NULL, enroll_hash = NULL, revoked_at = $1, updated_at = $1 WHERE user_id = $2 AND id = $3", [at, userId, row.id]);
    await db.query("UPDATE hannah_device_commands SET status = 'expired', finished_at = $1, error = 'The hub was revoked.' WHERE user_id = $2 AND hub_id = $3 AND status IN ('queued', 'sent')", [at, userId, row.id]);
    await addEvent(db, userId, { hubId: row.id, type: "hub-revoked", severity: "warning", message: `Hub “${row.name}” was revoked. HANNAH accepts nothing from it and sends it nothing. Rules already on it keep running until it is switched off.` });
    return getHub(db, userId, row.id);
  }
  async function removeHub(db, userId, id) {
    const row = await hubRow(db, userId, id);
    if (!row) return false;
    for (const table of ["hannah_device_commands", "hannah_device_rules", "hannah_device_events"]) await db.query(`DELETE FROM ${table} WHERE user_id = $1 AND hub_id = $2`, [userId, row.id]);
    const devices = (await db.query("SELECT id FROM hannah_devices WHERE user_id = $1 AND hub_id = $2", [userId, row.id])).rows;
    for (const device of devices) await db.query("DELETE FROM hannah_device_readings WHERE user_id = $1 AND device_id = $2", [userId, device.id]);
    await db.query("DELETE FROM hannah_devices WHERE user_id = $1 AND hub_id = $2", [userId, row.id]);
    await db.query("DELETE FROM hannah_hubs WHERE user_id = $1 AND id = $2", [userId, row.id]);
    return true;
  }

  // ---------- profiles ----------
  const ownProfiles = async (db, userId) => (await db.query("SELECT * FROM hannah_device_profiles WHERE user_id = $1 ORDER BY created_at", [userId])).rows.map((row) => ({ profile: parse(row.profile, {}), source: row.source, evidence: parse(row.evidence), createdAt: Number(row.created_at) }));
  async function findProfile(db, userId, id) {
    const shipped = profiles.builtin().find((profile) => profile.id === id);
    if (shipped) return { profile: shipped, source: "builtin", evidence: null };
    const own = (await ownProfiles(db, userId)).find((entry) => entry.profile.id === id);
    if (!own) throw fail(404, "There is no device profile with that id.", "no-profile");
    return own;
  }
  async function listProfiles(db, userId, { hub = null } = {}) {
    const hubAdapters = hub?.adapters?.length ? hub.adapters : null;
    const entry = (profile, source, evidence = null) => ({ ...profiles.publicProfile(profile), source, compatibility: profiles.compatibility(profile, { source, hubAdapters }), ...(evidence ? { evidence } : {}) });
    return [...profiles.builtin().map((profile) => entry(profile, "builtin")), ...(await ownProfiles(db, userId)).map((own) => entry(own.profile, own.source, own.evidence))];
  }
  /** Keep a profile a person built (source "studio") or one proposed from a document ("manual"). Validated; never trusted beyond that. */
  async function saveProfile(db, userId, profile, { source = "studio", evidence = null } = {}) {
    if (!["studio", "manual"].includes(source)) throw fail(400, "A profile can be saved from the Hardware Studio or from a document.", "bad-request");
    const problems = profiles.validateProfile(profile);
    if (problems.length) throw fail(400, `This device description isn't complete: ${problems.slice(0, 6).join(" ")}`, "bad-profile", { problems });
    if (profiles.builtin().some((item) => item.id === profile.id)) throw fail(409, "That id belongs to a profile that ships with HANNAH.", "duplicate");
    if (!profile.id.startsWith("user.")) throw fail(400, "Your own profiles have ids that start with “user.”.", "bad-profile");
    // A person's own description can't claim hardware tests or a simulation it doesn't have.
    const stored = { ...profile, simulated: false, tests: { level: "unit", passed: 0, total: 0, evidence: "" }, signature: undefined };
    const existing = await ownProfiles(db, userId);
    if (!existing.some((entry) => entry.profile.id === profile.id) && existing.length >= MAX_PROFILES) throw fail(400, `You have ${MAX_PROFILES} device profiles. Remove one first.`, "too-many");
    const at = now();
    await db.query(
      `INSERT INTO hannah_device_profiles (user_id, id, source, profile, evidence, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT (user_id, id) DO UPDATE SET source = EXCLUDED.source, profile = EXCLUDED.profile, evidence = EXCLUDED.evidence, updated_at = EXCLUDED.updated_at`,
      [userId, profile.id, source, JSON.stringify(stored), evidence ? JSON.stringify(evidence) : null, at]);
    return { ...profiles.publicProfile(stored), source, compatibility: profiles.compatibility(stored, { source }) };
  }
  async function deleteProfile(db, userId, id) {
    const used = (await deviceRows(db, userId)).some((row) => parse(row.profile, {}).id === id);
    if (used) throw fail(409, "A device uses this profile. Remove the device first.", "in-use");
    return { removed: (await db.query("DELETE FROM hannah_device_profiles WHERE user_id = $1 AND id = $2", [userId, String(id)])).rowCount > 0 };
  }
  // ---------- publisher keys and signed profiles ----------
  async function listPublisherKeys(db, userId) {
    const { rows } = await db.query("SELECT key_id, owner, public_key, revoked_at, created_at FROM hannah_publisher_keys WHERE user_id = $1 ORDER BY created_at", [userId]);
    return rows.map((row) => ({ keyId: row.key_id, owner: row.owner, publicKey: row.public_key, revokedAt: row.revoked_at ? Number(row.revoked_at) : null, createdAt: Number(row.created_at) }));
  }
  async function addPublisherKey(db, userId, { keyId, owner, publicKey }) {
    const cleanKeyId = clean(keyId, 80);
    const cleanOwner = clean(owner, 80) || cleanKeyId;
    if (!cleanKeyId || !publicKey || typeof publicKey !== "string") throw fail(400, "A publisher key needs an id and a public key.", "bad-request");
    const at = now();
    await db.query("INSERT INTO hannah_publisher_keys (user_id, key_id, owner, public_key, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (user_id, key_id) DO UPDATE SET owner = EXCLUDED.owner, public_key = EXCLUDED.public_key", [userId, cleanKeyId, cleanOwner, publicKey, at]);
    return { keyId: cleanKeyId, owner: cleanOwner };
  }
  async function revokePublisherKey(db, userId, keyId) {
    await db.query("UPDATE hannah_publisher_keys SET revoked_at = $1 WHERE user_id = $2 AND key_id = $3", [now(), userId, String(keyId)]);
    return { revoked: true };
  }
  async function installSignedProfile(db, userId, profile) {
    const keys = await listPublisherKeys(db, userId);
    const trustedKeys = keys.map((key) => ({ keyId: key.keyId, owner: key.owner, publicKey: key.publicKey, revokedAt: key.revokedAt }));
    const verdict = profiles.verifyProfile(profile, { trustedKeys });
    if (!verdict.ok) throw fail(400, `This signed profile can't be installed: ${verdict.problems.join(" ")}`, "bad-profile", { problems: verdict.problems });
    // Save it as a normal own profile, keeping the signature and review.
    const saved = await saveProfile(db, userId, profile, { source: "studio" });
    return { profile: saved, signedBy: verdict.signedBy, review: verdict.review };
  }

  const protocols = () => ({
    available: Object.entries(profiles.ADAPTERS).map(([id, item]) => ({ id, label: item.label })),
    notBuilt: Object.entries(profiles.NOT_BUILT).map(([id, reason]) => ({ id, reason })),
  });

  // ---------- devices ----------
  async function views(db, userId) {
    const hubs = new Map((await hubRows(db, userId)).map((row) => [row.id, hubView(row)]));
    return { hubs, rows: await deviceRows(db, userId) };
  }
  async function listDevices(db, userId) {
    const { hubs, rows } = await views(db, userId);
    return rows.map((row) => deviceView(row, hubs.get(row.hub_id)));
  }
  async function getDevice(db, userId, id) {
    const row = await deviceRow(db, userId, id);
    if (!row) throw fail(404, "That device isn't in your account.", "not-found");
    return deviceView(row, hubView(await hubRow(db, userId, row.hub_id)));
  }
  /** Find a device by id or by name (exact, any case). Returns the internal view. */
  async function resolveDevice(db, userId, reference) {
    const { hubs, rows } = await views(db, userId);
    const wanted = clean(reference, 80);
    const names = rows.map((row) => row.name);
    if (!wanted) throw fail(400, rows.length ? `Which device? You have: ${names.join(", ")}.` : "You have no devices yet. Add one under Devices.", rows.length ? "ambiguous-device" : "no-device", { candidates: rows.map((row) => ({ id: row.id, name: row.name })) });
    const named = rows.filter((row) => row.id === wanted || row.name.toLowerCase() === wanted.toLowerCase());
    if (named.length !== 1) throw fail(named.length ? 400 : 404, named.length ? `More than one device is called “${wanted}”. Use its id.` : `You have no device called “${wanted}”${names.length ? ` (you have: ${names.join(", ")})` : ""}.`, named.length ? "ambiguous-device" : "not-found", { candidates: rows.map((row) => ({ id: row.id, name: row.name })) });
    return internal(named[0], hubs.get(named[0].hub_id));
  }
  const seal = (userId, deviceId, secret) => (Object.keys(secret).length ? encryptSecret(JSON.stringify(secret), { userId, providerId: `device:${deviceId}` }) : { keyId: null, wrappedKey: null, ciphertext: null });
  const unseal = (row) => { if (!row.ciphertext) return {}; try { return parse(decryptSecret(row, { userId: row.user_id, providerId: `device:${row.id}` }).secret, {}); } catch { return {}; } };

  async function addDevice(db, userId, { hub, profileId, name, location, settings } = {}) {
    const label = clean(name, 60);
    if (!label) throw fail(400, "Give the device a name.", "bad-request");
    const target = await resolveHub(db, userId, hub);
    if (target.status !== "enrolled") throw fail(409, `The hub “${target.name}” hasn't enrolled yet.`, "hub-not-enrolled");
    const { profile, source } = await findProfile(db, userId, clean(profileId, 120));
    const level = profiles.compatibility(profile, { source, hubAdapters: target.adapters.length ? target.adapters : null });
    if (["developer-required", "unsupported"].includes(level.level)) throw fail(409, `This device can't be added yet. ${level.reasons.join(" ")}`, level.level);
    const checked = profiles.checkSettings(profile, settings || {});
    if (checked.problems.length) throw fail(400, checked.problems.map((item) => item.message).join(" "), "bad-settings", { fields: checked.problems });
    const existing = await deviceRows(db, userId);
    if (existing.length >= MAX_DEVICES) throw fail(400, `You have ${MAX_DEVICES} devices. Remove one first.`, "too-many");
    if (existing.some((row) => row.name.toLowerCase() === label.toLowerCase())) throw fail(409, `You already have a device called “${label}”.`, "duplicate-name");
    const id = `dev_${crypto.randomBytes(9).toString("hex")}`;
    const sealed = seal(userId, id, checked.secret);
    const at = now();
    await db.query(
      `INSERT INTO hannah_devices (user_id, id, hub_id, name, location, status, profile_source, profile, settings, key_id, wrapped_key, ciphertext, writable, always_ask, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'added', $6, $7, $8, $9, $10, $11, '[]', '[]', $12, $12)`,
      [userId, id, target.id, label, clean(location, 60), source, JSON.stringify(profile), JSON.stringify(checked.plain), sealed.keyId, sealed.wrappedKey, sealed.ciphertext, at]);
    await addEvent(db, userId, { hubId: target.id, deviceId: id, type: "device-added", message: `“${label}” added (${profile.manufacturer} ${profile.model}, ${level.label}). Not checked yet.` });
    return getDevice(db, userId, id);
  }
  async function updateDevice(db, userId, id, change = {}) {
    const row = await deviceRow(db, userId, id);
    if (!row) throw fail(404, "That device isn't in your account.", "not-found");
    const profile = parse(row.profile, {});
    const fields = {};
    if (change.name !== undefined) {
      const label = clean(change.name, 60);
      if (!label) throw fail(400, "Give the device a name.", "bad-request");
      if ((await deviceRows(db, userId)).some((other) => other.id !== row.id && other.name.toLowerCase() === label.toLowerCase())) throw fail(409, `You already have a device called “${label}”.`, "duplicate-name");
      fields.name = label;
    }
    if (change.location !== undefined) fields.location = clean(change.location, 60);
    if (change.settings !== undefined) {
      // New settings are a different connection: what was verified no longer applies.
      const checked = profiles.checkSettings(profile, { ...parse(row.settings, {}), ...unseal(row), ...change.settings });
      if (checked.problems.length) throw fail(400, checked.problems.map((item) => item.message).join(" "), "bad-settings", { fields: checked.problems });
      const sealed = seal(userId, row.id, checked.secret);
      Object.assign(fields, { settings: JSON.stringify(checked.plain), key_id: sealed.keyId, wrapped_key: sealed.wrappedKey, ciphertext: sealed.ciphertext, status: "added", verification: null, writable: "[]" });
    }
    const writablePoints = profile.points.filter((point) => point.access === "read-write").map((point) => point.id);
    if (change.writable !== undefined && fields.status === undefined) {
      if (row.status !== "active") throw fail(409, "Choose what HANNAH may change when you switch the device on.", "not-active");
      fields.writable = JSON.stringify([...new Set((Array.isArray(change.writable) ? change.writable : []).map(String))].filter((point) => writablePoints.includes(point)));
    }
    if (change.alwaysAsk !== undefined) fields.always_ask = JSON.stringify([...new Set((Array.isArray(change.alwaysAsk) ? change.alwaysAsk : []).map(String))].filter((point) => writablePoints.includes(point)));
    if (change.disabled !== undefined && fields.status === undefined) {
      if (change.disabled === true && row.status === "active") fields.status = "disabled";
      else if (change.disabled === false && row.status === "disabled") fields.status = "active";
    }
    const names = Object.keys(fields);
    if (names.length) {
      await db.query(`UPDATE hannah_devices SET ${names.map((name, index) => `${name} = $${index + 1}`).join(", ")}, updated_at = $${names.length + 1} WHERE user_id = $${names.length + 2} AND id = $${names.length + 3}`, [...names.map((name) => fields[name]), now(), userId, row.id]);
      await bump(db, row.hub_id);
      if (fields.status) await addEvent(db, userId, { hubId: row.hub_id, deviceId: row.id, type: `device-${fields.status}`, message: fields.status === "added" ? `“${fields.name || row.name}”: settings changed. It has to be checked again before it runs.` : `“${fields.name || row.name}” ${fields.status === "disabled" ? "switched off in HANNAH" : "switched back on"}.` });
    }
    return getDevice(db, userId, row.id);
  }
  async function removeDevice(db, userId, id) {
    const row = await deviceRow(db, userId, id);
    if (!row) return false;
    const rules = (await db.query("SELECT id, name, spec FROM hannah_device_rules WHERE user_id = $1 AND hub_id = $2", [userId, row.hub_id])).rows.filter((rule) => JSON.stringify(parse(rule.spec, {})).includes(`"${row.id}"`));
    if (rules.length) throw fail(409, `${row.name} is used by ${rules.length === 1 ? "an automation" : "automations"}: ${rules.map((rule) => rule.name).join(", ")}. Remove ${rules.length === 1 ? "it" : "them"} first.`, "in-use");
    await db.query("DELETE FROM hannah_device_readings WHERE user_id = $1 AND device_id = $2", [userId, row.id]);
    await db.query("DELETE FROM hannah_devices WHERE user_id = $1 AND id = $2", [userId, row.id]);
    await bump(db, row.hub_id);
    return true;
  }

  // ---------- commands ----------
  function effectiveStatus(row, at) {
    if (row.status === "queued" && Number(row.expires_at) <= at) return "expired";
    if (row.status === "sent" && Number(row.expires_at) + ANSWER_GRACE_MS <= at) return "no-answer";
    return row.status;
  }
  function commandView(row, at = now()) {
    if (!row) return null;
    const status = effectiveStatus(row, at);
    const payload = parse(row.payload, {});
    return {
      id: row.id, hubId: row.hub_id, deviceId: row.device_id || null, type: row.type, point: payload.point ?? null, value: payload.value ?? null, status, final: FINAL.has(status), actionId: row.action_id || null, requestedBy: row.requested_by || "",
      createdAt: Number(row.created_at), expiresAt: Number(row.expires_at), sentAt: row.sent_at ? Number(row.sent_at) : null, finishedAt: row.finished_at ? Number(row.finished_at) : null, result: parse(row.result),
      error: row.error || (status === "expired" ? "The hub didn't take the command before it expired. Nothing was done." : status === "no-answer" ? "The hub took the command and never reported what happened. The outcome is unknown." : null),
    };
  }
  async function issue(db, userId, hubId, { type, deviceId = null, payload, ttlMs = COMMAND_TTL_MS, actionId = null, requestedBy = "" }) {
    // Claim the next number with a compare-and-swap. An increment followed by a
    // separate read let two commands sent together get the same number, and
    // the hub refused the second as a replay.
    let seq = null;
    for (let attempt = 0; attempt < 20 && seq === null; attempt += 1) {
      const current = (await db.query("SELECT seq FROM hannah_hubs WHERE user_id = $1 AND id = $2 AND status = 'enrolled'", [userId, hubId])).rows[0];
      if (!current) throw fail(409, "That hub isn't enrolled.", "hub-not-enrolled");
      const next = Number(current.seq) + 1;
      const claimed = await db.query("UPDATE hannah_hubs SET seq = $1 WHERE user_id = $2 AND id = $3 AND status = 'enrolled' AND seq = $4", [next, userId, hubId, Number(current.seq)]);
      if (claimed.rowCount) seq = next;
    }
    if (seq === null) throw fail(503, "The hub is busy. Try again.", "hub-busy");
    const id = `cmd_${crypto.randomBytes(9).toString("hex")}`;
    const at = now();
    await db.query("INSERT INTO hannah_device_commands (user_id, id, hub_id, device_id, type, payload, status, seq, action_id, requested_by, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $8, $9, $10, $11)",
      [userId, id, hubId, deviceId, type, JSON.stringify(payload), seq, actionId, clean(requestedBy, 80), at, at + ttlMs]);
    return id;
  }
  async function getCommand(db, userId, id) {
    const row = (await db.query("SELECT * FROM hannah_device_commands WHERE user_id = $1 AND id = $2", [userId, String(id || "")])).rows[0];
    if (!row) throw fail(404, "There is no such command in your account.", "not-found");
    return commandView(row);
  }
  async function waitForCommand(db, userId, id, { ms = ackWaitMs } = {}) {
    const end = Date.now() + ms;
    for (;;) {
      const command = await getCommand(db, userId, id);
      if (command.final || Date.now() >= end) return command;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
  async function assessWrite(db, userId, reference, pointId, value) {
    const device = await resolveDevice(db, userId, reference);
    return { device, ...safety.assessWrite(device, clean(pointId, 40), value, { at: now() }) };
  }
  /** Queue a write that has already passed assessWrite. */
  async function write(db, userId, { device, point, value, actionId = null, requestedBy = "" }) {
    return issue(db, userId, device.hub.id, { type: "write", deviceId: device.id, payload: { deviceId: device.id, point, value }, actionId, requestedBy });
  }
  async function issueUpdate(db, userId, hubId, { version, size, sha256, url, requestedBy = "" }) {
    const bundle = validateUpdateBundle({ version, size, sha256, url });
    return issue(db, userId, hubId, { type: "update", payload: bundle, requestedBy });
  }

  function validateUpdateBundle({ version, size, sha256: digest, url }) {
    const release = clean(version, 24);
    const bytes = Number(size);
    const hash = String(digest || "").toLowerCase();
    let address;
    try { address = new URL(String(url || "")); } catch { throw fail(400, "Enter a valid update bundle URL.", "bad-update-url"); }
    const loopback = address.hostname === "localhost" || address.hostname === "[::1]" || /^127\./.test(address.hostname);
    if (!/^\d+\.\d+\.\d+$/.test(release)) throw fail(400, "Use a version such as 1.2.3.", "bad-update-version");
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > UPDATE_BUNDLE_MAX) throw fail(400, "The bundle size must be between 1 byte and 20 MiB.", "bad-update-size");
    if (!/^[a-f0-9]{64}$/.test(hash)) throw fail(400, "Enter the bundle's 64 character SHA-256 hash.", "bad-update-hash");
    if (!address.hostname || address.username || address.password || !(address.protocol === "https:" || (address.protocol === "http:" && loopback))) throw fail(400, "Update bundles need HTTPS. HTTP is allowed only from this computer for development.", "insecure-update-url");
    return { version: release, size: bytes, sha256: hash, url: address.toString() };
  }

  const rolloutLockId = (userId) => crypto.createHash("sha256").update(`hannah-update-rollout:${userId}`).digest().readInt32BE(0);
  async function inRolloutTransaction(db, userId, work) {
    return db.transaction(async (query, { lock }) => { await lock(rolloutLockId(userId)); return work({ query }); });
  }
  function rolloutCompatible(row, version, at = now()) {
    if (!row || row.status !== "enrolled") return "Hub isn't enrolled.";
    if (!hubView(row, at).online) return "Hub isn't online.";
    const descriptor = parse(row.descriptor, {});
    if (descriptor.protocol !== "hannah-hub/1") return "Hub reports an unsupported HANNAH hub protocol.";
    const update = parse(row.update_status, {});
    const current = update.current || descriptor.software;
    if (!/^\d+\.\d+\.\d+$/.test(String(current || ""))) return "Hub hasn't reported a compatible software version yet.";
    if (current === version) return "Hub already runs this version.";
    if (update.pending) return "Hub already has an update on probation.";
    return "";
  }
  async function rolloutRow(db, userId, id) {
    return (await db.query("SELECT * FROM hannah_update_rollouts WHERE user_id = $1 AND id = $2", [userId, String(id || "")])).rows[0] || null;
  }
  async function rolloutView(db, row) {
    const targets = (await db.query("SELECT hub_id AS \"hubId\", hub_name AS \"hubName\", ordinal, status, command_id AS \"commandId\", detail, updated_at AS \"updatedAt\" FROM hannah_update_rollout_targets WHERE user_id = $1 AND rollout_id = $2 ORDER BY ordinal", [row.user_id, row.id])).rows;
    return {
      id: row.id, version: row.version, cohortSize: Number(row.cohort_size), kind: row.kind, rollbackTo: row.rollback_to || null,
      status: row.status, detail: row.detail || null, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), targets: targets.map((target) => ({ ...target, ordinal: Number(target.ordinal), updatedAt: Number(target.updatedAt) })),
    };
  }
  async function stageRolloutCohort(db, row) {
    const pending = (await db.query("SELECT * FROM hannah_update_rollout_targets WHERE user_id = $1 AND rollout_id = $2 AND status = 'pending' ORDER BY ordinal LIMIT $3", [row.user_id, row.id, Number(row.cohort_size)])).rows;
    for (const target of pending) {
      const commandId = row.kind === "rollback"
        ? await issue(db, row.user_id, target.hub_id, { type: "update", payload: { rollback: true }, requestedBy: "a signed-in person" })
        : await issue(db, row.user_id, target.hub_id, { type: "update", payload: { version: row.version, size: Number(row.size), sha256: row.sha256, url: row.url }, requestedBy: "a signed-in person" });
      await db.query("UPDATE hannah_update_rollout_targets SET status = 'queued', command_id = $1, detail = NULL, updated_at = $2 WHERE user_id = $3 AND rollout_id = $4 AND hub_id = $5 AND status = 'pending'", [commandId, now(), row.user_id, row.id, target.hub_id]);
    }
    return pending.length;
  }
  async function reconcileRollout(db, row) {
    if (row.status !== "running") return;
    const targets = (await db.query("SELECT * FROM hannah_update_rollout_targets WHERE user_id = $1 AND rollout_id = $2 ORDER BY ordinal", [row.user_id, row.id])).rows;
    const failure = targets.find((target) => target.status === "failed");
    if (failure) {
      await db.query("UPDATE hannah_update_rollouts SET status = 'paused-failure', detail = $1, updated_at = $2 WHERE user_id = $3 AND id = $4 AND status = 'running'", [`${failure.hub_name}: ${failure.detail || "update failed"}`, now(), row.user_id, row.id]);
      return;
    }
    if (targets.some((target) => target.status === "queued")) return;
    const dispatched = await stageRolloutCohort(db, row);
    if (dispatched) return;
    const remaining = (await db.query("SELECT COUNT(*) AS count FROM hannah_update_rollout_targets WHERE user_id = $1 AND rollout_id = $2 AND status = 'pending'", [row.user_id, row.id])).rows[0];
    if (Number(remaining?.count || 0)) return;
    const hasFailures = targets.some((target) => target.status === "failed" || target.status === "skipped");
    await db.query("UPDATE hannah_update_rollouts SET status = $1, updated_at = $2 WHERE user_id = $3 AND id = $4 AND status = 'running'", [hasFailures ? "completed-with-errors" : "completed", now(), row.user_id, row.id]);
  }
  async function observeRollouts(db, userId, hubId, update) {
    await inRolloutTransaction(db, userId, async (tx) => {
      const targets = (await tx.query("SELECT t.*, r.version, r.kind, r.rollback_to FROM hannah_update_rollout_targets t JOIN hannah_update_rollouts r ON r.user_id = t.user_id AND r.id = t.rollout_id WHERE t.user_id = $1 AND t.hub_id = $2 AND t.status = 'queued'", [userId, hubId])).rows;
      for (const target of targets) {
        let status = "";
        let detail = "";
        const command = target.command_id ? (await tx.query("SELECT * FROM hannah_device_commands WHERE user_id = $1 AND id = $2", [userId, target.command_id])).rows[0] : null;
        const commandStatus = command ? effectiveStatus(command, now()) : "";
        if (commandStatus && FINAL.has(commandStatus) && commandStatus !== "done") {
          status = "failed";
          detail = command?.error || command?.message || `Hub command ended as ${commandStatus}.`;
        } else if (target.kind === "rollback") {
          if (update?.current === target.rollback_to && update?.last?.result === "rolled-back") status = "rolled-back";
          else if (["refused", "failed"].includes(update?.last?.result) && update?.current !== target.rollback_to) { status = "failed"; detail = update.last.reason || update.last.message || "Hub refused the rollback."; }
        } else if (update?.current === target.version && update?.last?.result === "confirmed") status = "confirmed";
        else if (["refused", "rolled-back"].includes(update?.last?.result) && update?.current !== target.version) { status = "failed"; detail = update.last.reason || update.last.message || `Hub reported ${update.last.result}.`; }
        if (!status && now() - Number(target.updated_at) > ROLLOUT_CONFIRM_MS) { status = "failed"; detail = "The hub did not confirm the update within five minutes."; }
        if (status) await tx.query("UPDATE hannah_update_rollout_targets SET status = $1, detail = $2, updated_at = $3 WHERE user_id = $4 AND rollout_id = $5 AND hub_id = $6 AND status = 'queued'", [status, detail || null, now(), userId, target.rollout_id, hubId]);
      }
      const rows = (await tx.query("SELECT r.* FROM hannah_update_rollouts r JOIN hannah_update_rollout_targets t ON t.user_id = r.user_id AND t.rollout_id = r.id WHERE r.user_id = $1 AND t.hub_id = $2 AND r.status IN ('running', 'paused', 'paused-failure') GROUP BY r.user_id, r.id", [userId, hubId])).rows;
      for (const row of rows) await reconcileRollout(tx, row);
    });
  }
  async function createRollout(db, userId, input = {}) {
    const bundle = validateUpdateBundle(input);
    const cohortSize = Number(input.cohortSize ?? 1);
    if (!Number.isInteger(cohortSize) || cohortSize < 1 || cohortSize > MAX_HUBS) throw fail(400, `Choose a cohort size from 1 to ${MAX_HUBS}.`, "bad-cohort-size");
    return inRolloutTransaction(db, userId, async (tx) => {
      const hubs = await hubRows(tx, userId);
      const wanted = Array.isArray(input.hubIds) && input.hubIds.length ? [...new Set(input.hubIds.map((id) => clean(id, 80)))] : null;
      if (wanted?.some((id) => !id)) throw fail(400, "Hub ids must be valid.", "bad-hub-selection");
      const selected = wanted ? hubs.filter((hub) => wanted.includes(hub.id)) : hubs;
      if (wanted && selected.length !== wanted.length) throw fail(404, "One or more selected hubs aren't in this account.", "not-found");
      const excluded = [];
      const eligible = [];
      for (const hub of selected) {
        const reason = rolloutCompatible(hub, bundle.version);
        if (reason) {
          if (wanted) throw fail(409, `${hub.name}: ${reason}`, "incompatible-hub");
          excluded.push({ hubId: hub.id, hubName: hub.name, reason });
        } else eligible.push(hub);
      }
      if (!eligible.length) throw fail(409, "No online, enrolled, compatible hubs are available for this rollout.", "no-compatible-hubs", { excluded });
      const id = `roll_${crypto.randomBytes(10).toString("hex")}`;
      const at = now();
      await tx.query("INSERT INTO hannah_update_rollouts (user_id, id, version, size, sha256, url, cohort_size, kind, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 'update', 'running', $8, $8)", [userId, id, bundle.version, bundle.size, bundle.sha256, bundle.url, cohortSize, at]);
      for (const [ordinal, hub] of eligible.entries()) await tx.query("INSERT INTO hannah_update_rollout_targets (user_id, rollout_id, hub_id, hub_name, ordinal, status, updated_at) VALUES ($1, $2, $3, $4, $5, 'pending', $6)", [userId, id, hub.id, hub.name, ordinal, at]);
      const row = await rolloutRow(tx, userId, id);
      await stageRolloutCohort(tx, row);
      return { rollout: await rolloutView(tx, row), excluded };
    });
  }
  async function listRollouts(db, userId) {
    return Promise.all((await db.query("SELECT * FROM hannah_update_rollouts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30", [userId])).rows.map((row) => rolloutView(db, row)));
  }
  async function setRolloutPaused(db, userId, id, paused) {
    return inRolloutTransaction(db, userId, async (tx) => {
      const row = await rolloutRow(tx, userId, id);
      if (!row) throw fail(404, "There is no such rollout in your account.", "not-found");
      if (paused) {
        if (row.status !== "running") throw fail(409, "Only a running rollout can be paused.", "rollout-not-running");
        await tx.query("UPDATE hannah_update_rollouts SET status = 'paused', detail = 'Paused by the account owner.', updated_at = $1 WHERE user_id = $2 AND id = $3", [now(), userId, id]);
      } else {
        if (!["paused", "paused-failure"].includes(row.status)) throw fail(409, "This rollout isn't paused.", "rollout-not-paused");
        await tx.query("UPDATE hannah_update_rollout_targets SET status = 'skipped', updated_at = $1 WHERE user_id = $2 AND rollout_id = $3 AND status = 'failed'", [now(), userId, id]);
        await tx.query("UPDATE hannah_update_rollouts SET status = 'running', detail = NULL, updated_at = $1 WHERE user_id = $2 AND id = $3", [now(), userId, id]);
        await reconcileRollout(tx, { ...row, status: "running" });
      }
      return rolloutView(tx, await rolloutRow(tx, userId, id));
    });
  }
  async function rollbackRollout(db, userId, id) {
    return inRolloutTransaction(db, userId, async (tx) => {
      const original = await rolloutRow(tx, userId, id);
      if (!original || original.kind !== "update") throw fail(404, "There is no software update rollout to roll back.", "not-found");
      const targets = (await tx.query("SELECT t.*, h.status AS hub_status, h.descriptor, h.update_status FROM hannah_update_rollout_targets t JOIN hannah_hubs h ON h.user_id = t.user_id AND h.id = t.hub_id WHERE t.user_id = $1 AND t.rollout_id = $2 ORDER BY t.ordinal", [userId, id])).rows;
      const eligible = targets.filter((target) => {
        const state = parse(target.update_status, {});
        const descriptor = parse(target.descriptor, {});
        return target.status === "confirmed" && target.hub_status === "enrolled" && hubView({ id: target.hub_id, name: target.hub_name, status: target.hub_status, descriptor: target.descriptor, update_status: target.update_status, last_seen_at: now() }).online && descriptor.protocol === "hannah-hub/1" && state.current === original.version && Boolean(state.previous) && !state.pending;
      });
      if (!eligible.length) throw fail(409, "No online hub from this rollout has a confirmed version with a previous version available.", "no-rollback-targets");
      const rollbackTo = parse(eligible[0].update_status, {}).previous;
      const sameRollback = eligible.filter((target) => parse(target.update_status, {}).previous === rollbackTo);
      const id2 = `roll_${crypto.randomBytes(10).toString("hex")}`;
      const at = now();
      await tx.query("INSERT INTO hannah_update_rollouts (user_id, id, version, size, sha256, url, cohort_size, kind, rollback_to, status, created_at, updated_at) VALUES ($1, $2, $3, 0, '', '', $4, 'rollback', $5, 'running', $6, $6)", [userId, id2, original.version, Number(original.cohort_size), rollbackTo, at]);
      for (const [ordinal, target] of sameRollback.entries()) await tx.query("INSERT INTO hannah_update_rollout_targets (user_id, rollout_id, hub_id, hub_name, ordinal, status, updated_at) VALUES ($1, $2, $3, $4, $5, 'pending', $6)", [userId, id2, target.hub_id, target.hub_name, ordinal, at]);
      const row = await rolloutRow(tx, userId, id2);
      await stageRolloutCohort(tx, row);
      return rolloutView(tx, row);
    });
  }

  // ---------- checking a device before it runs ----------
  function verificationFrom(profile, settings, command) {
    const probe = command.result?.probe;
    const checks = [];
    const add = (id, label, result, detail = "") => checks.push({ id, label, result, detail });
    if (!probe) {
      add("hub", "The hub ran the check", "fail", command.error || command.result?.message || "The hub didn't answer.");
      return { at: now(), level: "failed", passed: false, checks, commandId: command.id };
    }
    add("hub", "The hub ran the check", "pass", `Listened for up to ${probe.seconds} seconds.`);
    const state = probe.connection?.state;
    const reached = ["online", "no-data", "offline"].includes(state);
    add("connection", "Connection", reached ? "pass" : "fail", reached ? "" : probe.connection?.message || "No connection.");
    if (probe.connection?.reason === "auth") add("sign-in", "Sign-in", "fail", probe.connection.message);
    const encrypted = settings.tls === true || String(settings.url || "").startsWith("https://");
    add("encryption", "Encryption", encrypted ? "pass" : "note", encrypted ? "" : profile.protocol.adapter === "modbus-tcp" ? "Modbus has none. Anything on the device's network can read and write it." : "Not encrypted. Acceptable only because it stays on your own network.");
    add("identity", "Maker and model", "not-checked", "This protocol gives no way to confirm what the device is. HANNAH can't tell it from another device that answers the same way.");
    if (state === "offline") add("availability", "The device's own status", "fail", "The device says it is offline.");
    let heard = 0;
    let expected = 0;
    for (const point of profile.points) {
      const seen = probe.points?.[point.id];
      if (!seen?.expected) { add(`data:${point.id}`, point.name, "not-checked", "This point reports nothing back."); continue; }
      expected += 1;
      if (seen.heard) heard += 1;
      add(`data:${point.id}`, point.name, seen.heard ? "pass" : "fail", seen.heard ? `Heard: ${typeof seen.value === "boolean" ? (seen.value ? "on" : "off") : seen.value}${point.unit ? ` ${point.unit}` : ""}` : `Nothing heard in ${probe.seconds} seconds.`);
    }
    add("values", "Values fit the description", probe.rejected ? "warn" : "pass", probe.rejected ? `${probe.rejected} message${probe.rejected === 1 ? "" : "s"} didn't fit the expected type or range and ${probe.rejected === 1 ? "was" : "were"} dropped.` : "");
    add("commands", "Changing things", "not-checked", "Nothing was written during the check. The first change you approve is read back from the device to confirm it.");
    const passed = reached && state !== "offline" && expected === heard;
    const level = passed ? "verified" : reached && heard > 0 ? "partial" : reached && expected === 0 ? "partial" : "failed";
    return { at: now(), level, passed, heard, expected, checks, commandId: command.id, simulated: Boolean(profile.simulated) };
  }
  async function recordVerification(db, userId, command) {
    const row = await deviceRow(db, userId, command.deviceId);
    if (!row || !["added", "verified", "failed"].includes(row.status)) return;
    const profile = parse(row.profile, {});
    const verification = verificationFrom(profile, parse(row.settings, {}), command);
    const status = verification.level === "failed" ? "failed" : "verified";
    await db.query("UPDATE hannah_devices SET verification = $1, status = $2, updated_at = $3 WHERE user_id = $4 AND id = $5", [JSON.stringify(verification), status, now(), userId, row.id]);
    await addEvent(db, userId, { hubId: row.hub_id, deviceId: row.id, type: "device-checked", severity: verification.level === "failed" ? "warning" : "info", message: `“${row.name}” checked: ${verification.level === "verified" ? "connected, and every reading was heard" : verification.level === "partial" ? `connected; ${verification.heard} of ${verification.expected} readings heard` : "it could not be reached or nothing was heard"}.` });
  }
  async function testDevice(db, userId, id, { requestedBy = "" } = {}) {
    const row = await deviceRow(db, userId, id);
    if (!row) throw fail(404, "That device isn't in your account.", "not-found");
    if (!["added", "verified", "failed"].includes(row.status)) throw fail(409, "This device is already running. Switch it off to check it again.", "already-active");
    const hub = hubView(await hubRow(db, userId, row.hub_id));
    if (!hub?.online) throw fail(409, `The hub “${hub?.name || ""}” isn't connected, so it can't check the device.`, "hub-offline");
    const profile = parse(row.profile, {});
    const commandId = await issue(db, userId, row.hub_id, { type: "probe", deviceId: row.id, ttlMs: COMMAND_TTL_MS, requestedBy, payload: { seconds: PROBE_S, device: { id: row.id, name: row.name, profile: profiles.hubProfile(profile), settings: { ...parse(row.settings, {}), ...unseal(row) }, writable: [] } } });
    const command = await waitForCommand(db, userId, commandId, { ms: ackWaitMs + PROBE_S * 1000 });
    if (command.final && !command.result?.probe) await recordVerification(db, userId, command);
    return { device: await getDevice(db, userId, row.id), pending: !command.final, commandId };
  }
  async function activateDevice(db, userId, id, { writable = [], acceptPartial = false } = {}) {
    const row = await deviceRow(db, userId, id);
    if (!row) throw fail(404, "That device isn't in your account.", "not-found");
    const verification = parse(row.verification);
    if (row.status !== "verified" || !verification) throw fail(409, row.status === "active" ? "This device is already on." : "Check the device first: HANNAH switches on only a device its hub has reached.", "not-verified");
    if (verification.level === "partial" && acceptPartial !== true) throw fail(409, `Only ${verification.heard} of ${verification.expected} readings were heard. Check again, or confirm that you want to switch it on anyway.`, "partial");
    const profile = parse(row.profile, {});
    const allowed = profile.points.filter((point) => point.access === "read-write").map((point) => point.id);
    const chosen = [...new Set((Array.isArray(writable) ? writable : []).map(String))];
    const unknown = chosen.filter((point) => !allowed.includes(point));
    if (unknown.length) throw fail(400, `${unknown.join(", ")} can't be changed on this device.`, "bad-request");
    await db.query("UPDATE hannah_devices SET status = 'active', writable = $1, verification = $2, updated_at = $3 WHERE user_id = $4 AND id = $5", [JSON.stringify(chosen), JSON.stringify({ ...verification, activatedAt: now(), acceptedPartial: verification.level === "partial" }), now(), userId, row.id]);
    await bump(db, row.hub_id);
    await addEvent(db, userId, { hubId: row.hub_id, deviceId: row.id, type: "device-active", message: `“${row.name}” switched on. HANNAH may read it${chosen.length ? ` and change: ${chosen.join(", ")}` : " and change nothing"}.` });
    return getDevice(db, userId, row.id);
  }
  async function discover(db, userId, hubReference, { kind, settings = {} } = {}, { requestedBy = "" } = {}) {
    const hub = await resolveHub(db, userId, hubReference);
    if (!hub.online) throw fail(409, `The hub “${hub.name}” isn't connected.`, "hub-offline");
    if (!["mqtt", "serial", "mdns", "usb"].includes(kind)) throw fail(400, "A hub can look at an MQTT broker's topics, list serial ports, list USB devices, or browse for one mDNS service type.", "bad-request");
    const cleaned = kind === "mqtt" ? { host: clean(settings.host, 120), port: Number(settings.port) || undefined, username: clean(settings.username, 120) || undefined, password: typeof settings.password === "string" ? settings.password.slice(0, 200) : undefined, tls: settings.tls === true } : kind === "mdns" ? { service: clean(settings.service, 120) || "_http._tcp.local", seconds: Math.max(1, Math.min(15, Number(settings.seconds) || 5)) } : kind === "usb" ? {} : {};
    if (kind === "mqtt" && !/^[A-Za-z0-9.\-:]{1,120}$/.test(cleaned.host)) throw fail(400, "Give the broker's address.", "bad-request");
    if (kind === "mdns" && !/^_[A-Za-z0-9-]{1,15}\._(?:tcp|udp)\.local\.?$/i.test(cleaned.service)) throw fail(400, "Use one local service type, for example _http._tcp.local.", "bad-request");
    const commandId = await issue(db, userId, hub.id, { type: "discover", requestedBy, payload: { kind, settings: cleaned, seconds: 5 } });
    const command = await waitForCommand(db, userId, commandId, { ms: ackWaitMs + 6000 });
    if (command.final && command.status !== "done") throw fail(409, command.result?.message || command.error || "The hub couldn't look.", command.result?.reason || command.status);
    return { pending: !command.final, commandId, discovered: command.result?.discovered || null };
  }

  // ---------- rules ----------
  function ruleView(row, deviceNames = new Map()) {
    const spec = parse(row.spec, {});
    const status = parse(row.status, {});
    const named = (item) => ({ ...item, deviceName: deviceNames.get(item.device) || item.device });
    const conditions = spec.when?.all || (spec.when ? [spec.when] : []);
    return {
      id: row.id, hubId: row.hub_id, name: row.name, enabled: Boolean(Number(row.enabled)), when: conditions.map(named), then: (spec.then || []).map(named), otherwise: (spec.otherwise || []).map(named),
      forS: spec.forS || 0, staleAfterS: spec.staleAfterS, maxPerHour: spec.maxPerHour, status: status.status || (Number(row.enabled) ? "not-reported" : "off"), detail: status.detail || "", fires: status.fires || 0, lastFiredAt: status.lastFiredAt || null, lastError: status.lastError || null,
      reportedAt: status.reportedAt || null, createdAt: Number(row.created_at),
    };
  }
  async function listRules(db, userId) {
    const names = new Map((await deviceRows(db, userId)).map((row) => [row.id, row.name]));
    return (await db.query("SELECT * FROM hannah_device_rules WHERE user_id = $1 ORDER BY created_at", [userId])).rows.map((row) => ruleView(row, names));
  }
  async function assessRule(db, userId, input) {
    const { hubs, rows } = await views(db, userId);
    return safety.assessRule(input, rows.map((row) => internal(row, hubs.get(row.hub_id))));
  }
  async function createRule(db, userId, input, { actionId = null } = {}) {
    const verdict = await assessRule(db, userId, input);
    if (!verdict.ok) throw fail(400, verdict.problems.join(" "), "bad-rule", { problems: verdict.problems });
    const count = Number((await db.query("SELECT COUNT(*) AS n FROM hannah_device_rules WHERE user_id = $1", [userId])).rows[0].n);
    if (count >= MAX_RULES) throw fail(400, `You have ${MAX_RULES} automations. Remove one first.`, "too-many");
    const id = `rule_${crypto.randomBytes(9).toString("hex")}`;
    const at = now();
    await db.query("INSERT INTO hannah_device_rules (user_id, id, hub_id, name, spec, enabled, action_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $7)", [userId, id, verdict.hubId, verdict.rule.name, JSON.stringify(verdict.rule), actionId, at]);
    await bump(db, verdict.hubId);
    await addEvent(db, userId, { hubId: verdict.hubId, ruleId: id, type: "rule-created", message: `Automation “${verdict.rule.name}” created.` });
    return (await listRules(db, userId)).find((rule) => rule.id === id);
  }
  async function resolveRule(db, userId, reference) {
    const rules = await listRules(db, userId);
    const wanted = clean(reference, 80);
    const found = rules.filter((rule) => rule.id === wanted || rule.name.toLowerCase() === wanted.toLowerCase());
    if (found.length !== 1) throw fail(found.length ? 400 : 404, found.length ? `More than one automation is called “${wanted}”. Use its id.` : `You have no automation called “${wanted}”${rules.length ? ` (you have: ${rules.map((rule) => rule.name).join(", ")})` : ""}.`, found.length ? "ambiguous-rule" : "not-found");
    return found[0];
  }
  async function setRule(db, userId, reference, { enabled }) {
    const rule = await resolveRule(db, userId, reference);
    await db.query("UPDATE hannah_device_rules SET enabled = $1, status = NULL, updated_at = $2 WHERE user_id = $3 AND id = $4", [enabled ? 1 : 0, now(), userId, rule.id]);
    await bump(db, rule.hubId);
    await addEvent(db, userId, { hubId: rule.hubId, ruleId: rule.id, type: enabled ? "rule-enabled" : "rule-disabled", message: `Automation “${rule.name}” switched ${enabled ? "on" : "off"}.` });
    return (await listRules(db, userId)).find((item) => item.id === rule.id);
  }
  async function deleteRule(db, userId, reference) {
    const rule = await resolveRule(db, userId, reference);
    await db.query("DELETE FROM hannah_device_rules WHERE user_id = $1 AND id = $2", [userId, rule.id]);
    await bump(db, rule.hubId);
    await addEvent(db, userId, { hubId: rule.hubId, ruleId: rule.id, type: "rule-removed", message: `Automation “${rule.name}” removed.` });
    return { removed: true, name: rule.name };
  }
  /** Pause or resume every automation of the account. Pausing changes no device: each stays as it is. */
  async function suspendRules(db, userId, on) {
    const changed = await db.query("UPDATE hannah_hubs SET rules_suspended = $1, config_version = config_version + 1, updated_at = $2 WHERE user_id = $3 AND rules_suspended <> $1", [on ? 1 : 0, now(), userId]);
    if (changed.rowCount) await addEvent(db, userId, { type: on ? "rules-suspended" : "rules-resumed", severity: on ? "warning" : "info", message: on ? "Every automation was paused. Devices stay as they are." : "Automations were resumed." });
    return changed.rowCount;
  }

  // ---------- reading ----------
  async function events(db, userId, { deviceId = null, hubId = null, limit = 60 } = {}) {
    const conditions = ["user_id = $1"];
    const params = [userId];
    if (deviceId) { params.push(deviceId); conditions.push(`device_id = $${params.length}`); }
    if (hubId) { params.push(hubId); conditions.push(`hub_id = $${params.length}`); }
    params.push(Math.max(1, Math.min(300, Number(limit) || 60)));
    return (await db.query(`SELECT * FROM hannah_device_events WHERE ${conditions.join(" AND ")} ORDER BY at DESC LIMIT $${params.length}`, params)).rows.map((row) => ({ id: row.id, hubId: row.hub_id, deviceId: row.device_id, ruleId: row.rule_id, at: Number(row.at), type: row.type, severity: row.severity, message: row.message, source: row.source }));
  }
  async function history(db, userId, deviceId, point, { minutes = 180 } = {}) {
    const since = now() - Math.max(1, Math.min(24 * 60, Number(minutes) || 180)) * 60_000;
    return (await db.query("SELECT at, value FROM hannah_device_readings WHERE user_id = $1 AND device_id = $2 AND point = $3 AND at >= $4 ORDER BY at", [userId, deviceId, String(point), since])).rows.map((row) => ({ at: Number(row.at), value: parse(row.value) }));
  }
  async function commands(db, userId, { deviceId = null, limit = 30 } = {}) {
    const rows = (await db.query(`SELECT * FROM hannah_device_commands WHERE user_id = $1 AND type = 'write' ${deviceId ? "AND device_id = $3" : ""} ORDER BY created_at DESC LIMIT $2`, [userId, Math.max(1, Math.min(100, Number(limit) || 30)), ...(deviceId ? [deviceId] : [])])).rows;
    return rows.map((row) => commandView(row));
  }
  /** One picture of everything: hubs, devices with the age of what is known, automations. */
  async function overview(db, userId) {
    const [hubs, devices, rules] = [await listHubs(db, userId), await listDevices(db, userId), await listRules(db, userId)];
    return {
      hubs, devices, rules,
      counts: { hubs: hubs.length, hubsOnline: hubs.filter((hub) => hub.online).length, devices: devices.length, active: devices.filter((device) => device.status === "active").length, reporting: devices.filter((device) => device.connection === "online").length, rules: rules.length, rulesOn: rules.filter((rule) => rule.enabled).length },
      rulesSuspended: hubs.some((hub) => hub.rulesSuspended),
    };
  }

  // ---------- the hub's exchange ----------
  async function configFor(db, row, secret) {
    const devices = (await db.query("SELECT * FROM hannah_devices WHERE user_id = $1 AND hub_id = $2 AND status = 'active' ORDER BY created_at", [row.user_id, row.id])).rows;
    const active = new Set(devices.map((device) => device.id));
    const rules = (await db.query("SELECT * FROM hannah_device_rules WHERE user_id = $1 AND hub_id = $2 AND enabled = 1 ORDER BY created_at", [row.user_id, row.id])).rows
      .map((rule) => ({ id: rule.id, enabled: true, ...parse(rule.spec, {}) }))
      // A rule that names a device that isn't running is left out: it could only wait.
      .filter((rule) => [...(rule.when.all || [rule.when]), ...rule.then, ...(rule.otherwise || [])].every((item) => active.has(item.device)));
    const payload = JSON.stringify({
      v: 1, hubId: row.id, version: Number(row.config_version), rulesSuspended: Boolean(Number(row.rules_suspended)),
      devices: devices.map((device) => ({ id: device.id, name: device.name, profile: profiles.hubProfile(parse(device.profile, {})), settings: { ...parse(device.settings, {}), ...unseal(device) }, writable: parse(device.writable, []) })),
      rules,
    });
    return { payload, signature: signConfig(secret, payload) };
  }
  async function sync(db, { row, secret }, body = {}) {
    const at = now();
    const userId = row.user_id;
    const reported = Number.isInteger(body.configVersion) ? body.configVersion : 0;
    const software = typeof body.software === "string" ? body.software.slice(0, 40) : "";
    if (/^\d+\.\d+\.\d+$/.test(software)) {
      const descriptor = parse(row.descriptor, {});
      if (descriptor.software !== software) {
        descriptor.software = software;
        await db.query("UPDATE hannah_hubs SET descriptor = $1 WHERE id = $2", [JSON.stringify(descriptor), row.id]);
      }
    }
    await db.query("UPDATE hannah_hubs SET last_seen_at = $1, reported_config = $2 WHERE id = $3", [at, reported, row.id]);
    // What the hub sees of its devices.
    const mine = new Map((await db.query("SELECT * FROM hannah_devices WHERE user_id = $1 AND hub_id = $2", [userId, row.id])).rows.map((device) => [device.id, device]));
    for (const item of (Array.isArray(body.devices) ? body.devices : []).slice(0, MAX_DEVICES)) {
      const device = mine.get(String(item?.id || ""));
      if (!device || device.status !== "active") continue;
      const profile = parse(device.profile, {});
      const before = parse(device.state, {});
      const points = {};
      for (const point of profile.points || []) {
        const reading = item.points?.[point.id];
        const value = scalar(reading?.value);
        // The hub already typed and range-checked the value; the type is checked again because this is another trust boundary.
        if (value === null || !Number.isFinite(Number(reading?.at)) || (point.type === "number" ? typeof value !== "number" : point.type === "boolean" ? typeof value !== "boolean" : typeof value !== "string")) continue;
        points[point.id] = { value: typeof value === "string" ? value.slice(0, 200) : value, at: Math.min(Number(reading.at), at + SKEW_MS) };
        if (point.type !== "text") {
          const key = `${device.id}:${point.id}`;
          const last = lastSample.get(key);
          if (!last || last.value !== value || at - last.at >= HISTORY_EVERY_MS) {
            lastSample.set(key, { value, at });
            await db.query("INSERT INTO hannah_device_readings (user_id, device_id, point, at, value) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING", [userId, device.id, point.id, points[point.id].at, JSON.stringify(value)]).catch(() => {});
          }
        }
      }
      const connection = { state: ["online", "offline", "no-data", "error", "connecting", "starting", "stopped"].includes(item.connection?.state) ? item.connection.state : "error", reason: clean(item.connection?.reason, 40), message: clean(item.connection?.message, 300) };
      const state = { connection, points, rejected: Math.max(0, Math.min(1e9, Number(item.rejected) || 0)), receivedAt: at };
      await db.query("UPDATE hannah_devices SET state = $1, last_seen_at = CASE WHEN $2 = 1 THEN $3 ELSE last_seen_at END WHERE user_id = $4 AND id = $5", [JSON.stringify(state), connection.state === "online" ? 1 : 0, at, userId, device.id]);
      const was = before.connection?.state;
      if (was !== connection.state && ["online", "offline", "error", "no-data"].includes(connection.state) && (was || connection.state !== "online")) {
        const bad = connection.state !== "online";
        await addEvent(db, userId, { hubId: row.id, deviceId: device.id, at, source: "hub", type: connection.state === "online" ? "device-online" : connection.state === "error" ? "device-error" : connection.state === "offline" ? "device-offline" : "device-quiet", severity: bad ? "warning" : "info", message: bad ? `“${device.name}” ${connection.state === "offline" ? "says it is offline" : connection.state === "no-data" ? "is connected and has sent nothing yet" : `can't be reached: ${connection.message || connection.reason}`}.` : `“${device.name}” is reporting again.` });
      }
    }
    // What the hub's rules are doing.
    for (const item of (Array.isArray(body.rules) ? body.rules : []).slice(0, MAX_RULES)) {
      if (typeof item?.id !== "string") continue;
      const status = { status: clean(item.status, 20), detail: clean(item.detail, 200), fires: Math.max(0, Number(item.fires) || 0), lastFiredAt: Number(item.lastFiredAt) || null, lastError: item.lastError ? clean(item.lastError, 300) : null, reportedAt: at };
      await db.query("UPDATE hannah_device_rules SET status = $1 WHERE user_id = $2 AND hub_id = $3 AND id = $4 AND enabled = 1", [JSON.stringify(status), userId, row.id, item.id]);
    }
    if (body.update) await db.query("UPDATE hannah_hubs SET update_status = $1 WHERE id = $2", [JSON.stringify(body.update).slice(0, 60_000), row.id]).catch(() => {});
    // Results and events the hub has been holding until the server has them.
    const received = [];
    for (const item of (Array.isArray(body.outbox) ? body.outbox : []).slice(0, 40)) {
      const key = clean(item?.key, 60);
      if (!key) continue;
      received.push(key);
      if (item.kind === "result") {
        const status = ["done", "unverified", "refused", "failed"].includes(item.status) ? item.status : "failed";
        const { key: _key, kind: _kind, commandId: _id, status: _status, ...rest } = item;
        const result = JSON.stringify(rest).length <= 60_000 ? rest : { message: "The hub's answer was too large to keep." };
        const updated = await db.query("UPDATE hannah_device_commands SET status = $1, finished_at = $2, result = $3, error = $4 WHERE user_id = $5 AND hub_id = $6 AND id = $7 AND status IN ('queued', 'sent')",
          [status, at, JSON.stringify(result), status === "done" ? null : clean(item.message, 300) || null, userId, row.id, String(item.commandId || "")]);
        if (!updated.rowCount) continue;
        const command = commandView((await db.query("SELECT * FROM hannah_device_commands WHERE user_id = $1 AND id = $2", [userId, String(item.commandId)])).rows[0], at);
        if (command.type === "probe") await recordVerification(db, userId, command);
        if (command.type === "discover" && item.discovered) await db.query("UPDATE hannah_hubs SET discovered = $1 WHERE id = $2", [JSON.stringify({ ...item.discovered, at }).slice(0, 60_000), row.id]);
        if (item.update) await db.query("UPDATE hannah_hubs SET update_status = $1 WHERE id = $2", [JSON.stringify(item.update).slice(0, 60_000), row.id]).catch(() => {});
      } else if (item.kind === "event") {
        const ruleId = typeof item.ruleId === "string" ? item.ruleId.slice(0, 40) : null;
        const deviceId = typeof item.deviceId === "string" && mine.has(item.deviceId) ? item.deviceId : null;
        const fresh = await addEvent(db, userId, { id: `${row.id}:${key}`, hubId: row.id, deviceId, ruleId, at, source: "hub", type: item.type, severity: item.severity, message: item.message });
        if (fresh && item.type === "rule-fired") announce(userId, "device.rule.fired", { ruleId, hubId: row.id, branch: item.branch === "otherwise" ? "otherwise" : "then", message: clean(item.message, 400), at });
      }
    }
    if (body.update) await observeRollouts(db, userId, row.id, body.update);
    // What the hub should have and do.
    const current = (await db.query("SELECT * FROM hannah_hubs WHERE id = $1", [row.id])).rows[0];
    const answer = { serverTime: at, intervalMs: SYNC_INTERVAL_MS, received, commands: [] };
    if (reported !== Number(current.config_version)) answer.config = await configFor(db, current, secret);
    const queued = (await db.query("SELECT * FROM hannah_device_commands WHERE user_id = $1 AND hub_id = $2 AND status = 'queued' AND expires_at > $3 ORDER BY seq LIMIT 8", [userId, row.id, at])).rows;
    for (const command of queued) {
      const payload = JSON.stringify({ v: 1, hubId: row.id, id: command.id, type: command.type, seq: Number(command.seq), issuedAt: Number(command.created_at), expiresAt: Number(command.expires_at), ...parse(command.payload, {}) });
      const taken = await db.query("UPDATE hannah_device_commands SET status = 'sent', sent_at = $1 WHERE user_id = $2 AND id = $3 AND status = 'queued'", [at, userId, command.id]);
      if (taken.rowCount) answer.commands.push({ payload, signature: signCommand(secret, payload) });
    }
    if (at - housekeeping > 10 * 60_000) {
      housekeeping = at;
      await db.query("DELETE FROM hannah_device_readings WHERE at < $1", [at - HISTORY_KEEP_MS]).catch(() => {});
      await db.query("DELETE FROM hannah_device_events WHERE at < $1", [at - EVENTS_KEEP_MS]).catch(() => {});
      await db.query("DELETE FROM hannah_device_commands WHERE created_at < $1", [at - COMMANDS_KEEP_MS]).catch(() => {});
    }
    return answer;
  }

  return {
    activateDevice, addDevice, assessRule, assessWrite, authenticate, commands, createHub, createRule, deleteProfile, deleteRule, discover, enrollHub, events, getCommand, getDevice, getHub, history,
    createRollout, issueHubCode, issueUpdate, listDevices, listHubs, listProfiles, listRollouts, listRules, overview, protocols, removeDevice, removeHub, resolveDevice, resolveHub, resolveRule, revokeHub, rollbackRollout, saveProfile, setRolloutPaused, setRule, suspendRules, sync, testDevice,
    updateDevice, waitForCommand, write,
    listPublisherKeys, addPublisherKey, revokePublisherKey, installSignedProfile,
  };
}

module.exports = { FINAL, createDeviceService, signCommand, signConfig, signRequest };
