"use strict";

/**
 * Key storage without HANNAH_VAULT_KEY: the master key is derived from the
 * server secret that Vercel's Supabase integration adds, so connecting
 * Supabase there turns on encrypted key storage by itself.
 */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { decryptSecret, encryptSecret, vaultConfigured, vaultSource } = require("./vault");

const NAMES = ["HANNAH_VAULT_KEY", "HANNAH_VAULT_PREVIOUS_KEYS", "SUPABASE_JWT_SECRET", "SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
function withEnv(values, fn) {
  const saved = NAMES.map((name) => [name, process.env[name]]);
  for (const name of NAMES) delete process.env[name];
  Object.assign(process.env, values);
  try {
    return fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
const owner = { userId: "user-1", providerId: "groq" };
const JWT = "super-secret-jwt-token-with-at-least-32-characters-long";
const SECRET_KEY = "sb_secret_0123456789abcdefghijklmnopqrstuvwxyzABCD";

test("Supabase's JWT secret turns key storage on, and the database alone can't decrypt", () => {
  withEnv({}, () => {
    assert.equal(vaultConfigured(), false);
    assert.equal(vaultSource(), null);
  });
  const sealed = withEnv({ SUPABASE_JWT_SECRET: JWT, SUPABASE_SECRET_KEY: SECRET_KEY }, () => {
    assert.equal(vaultConfigured(), true);
    assert.equal(vaultSource(), "SUPABASE_JWT_SECRET", "the most stable secret first");
    const row = encryptSecret("gsk_live_key", owner);
    assert.doesNotMatch(JSON.stringify(row), /gsk_live_key/);
    assert.equal(decryptSecret(row, owner).secret, "gsk_live_key");
    return row;
  });
  // The same secret after a restart derives the same key.
  withEnv({ SUPABASE_JWT_SECRET: JWT }, () => assert.equal(decryptSecret(sealed, owner).secret, "gsk_live_key"));
  // Without the secret (only what's in the database), nothing decrypts.
  withEnv({}, () => assert.throws(() => decryptSecret(sealed, owner), /no longer has/));
  withEnv({ SUPABASE_JWT_SECRET: `${JWT}-rotated` }, () => assert.throws(() => decryptSecret(sealed, owner), /no longer has/));
});

test("rows stay readable when the secret they came from is still present, and an explicit key takes over", () => {
  const fromSecretKey = withEnv({ SUPABASE_SECRET_KEY: SECRET_KEY }, () => {
    assert.equal(vaultSource(), "SUPABASE_SECRET_KEY");
    return encryptSecret("sk-openai", owner);
  });
  // The JWT secret appears later and becomes the primary; rows sealed with the other still decrypt and are re-wrapped.
  withEnv({ SUPABASE_JWT_SECRET: JWT, SUPABASE_SECRET_KEY: SECRET_KEY }, () => {
    const opened = decryptSecret(fromSecretKey, owner);
    assert.equal(opened.secret, "sk-openai");
    assert.equal(opened.rewrap, true);
  });
  // The operator sets their own key: it's the primary, and derived rows still open (and get re-wrapped).
  withEnv({ HANNAH_VAULT_KEY: "a".repeat(64), SUPABASE_SECRET_KEY: SECRET_KEY }, () => {
    assert.equal(vaultSource(), "HANNAH_VAULT_KEY");
    const opened = decryptSecret(fromSecretKey, owner);
    assert.deepEqual(opened, { secret: "sk-openai", rewrap: true });
  });
});

test("a short value isn't treated as a secret, and a bad HANNAH_VAULT_KEY still turns storage off", () => {
  withEnv({ SUPABASE_JWT_SECRET: "too-short" }, () => assert.equal(vaultConfigured(), false));
  withEnv({ HANNAH_VAULT_KEY: "not-a-key", SUPABASE_JWT_SECRET: JWT }, () => assert.equal(vaultConfigured(), false, "a mistyped key isn't silently replaced"));
});
