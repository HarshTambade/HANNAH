"use strict";

/**
 * Which database HANNAH connects to, and how it secures the connection.
 *
 * - DATABASE_URL wins; without it, POSTGRES_URL (what Vercel's Supabase
 *   integration adds to the project) is used, so connecting Supabase in Vercel
 *   needs nothing copied by hand.
 * - Supabase connections are verified against Supabase's own root CA, even when
 *   the URL says sslmode=require (which the driver would otherwise check against
 *   the public roots only, and fail with "self-signed certificate in chain").
 *
 * HANNAH_LIVE_TESTS=1 also connects to a real Supabase pooler with a made-up
 * user: TLS must verify, and the pooler must then refuse the user.
 */
const assert = require("node:assert/strict");
const { X509Certificate } = require("node:crypto");
const { test } = require("node:test");
const db = require("./db");

const SAVED = ["DATABASE_URL", "POSTGRES_URL", "DATABASE_SSL", "DATABASE_CA_CERT"].map((name) => [name, process.env[name]]);
function withEnv(values, fn) {
  for (const [name] of SAVED) delete process.env[name];
  Object.assign(process.env, values);
  try {
    return fn();
  } finally {
    for (const [name, value] of SAVED) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const POOLER = "postgresql://postgres.abcdefghijklmnopqrst:secret@aws-0-ap-south-1.pooler.supabase.com:6543/postgres";

test("DATABASE_URL wins, and POSTGRES_URL from Vercel's Supabase integration is used without it", () => {
  withEnv({}, () => {
    assert.equal(db.databaseConfigured(), false);
    assert.equal(db.databaseSource(), null);
  });
  withEnv({ POSTGRES_URL: `${POOLER}?sslmode=require&supa=base-pooler.x` }, () => {
    assert.equal(db.databaseConfigured(), true);
    assert.equal(db.databaseSource(), "POSTGRES_URL");
    assert.equal(db.parseDatabaseUrl(db.databaseUrl()).provider, "supabase");
  });
  withEnv({ DATABASE_URL: "sqlite::memory:", POSTGRES_URL: POOLER }, () => {
    assert.equal(db.databaseSource(), "DATABASE_URL");
    assert.equal(db.databaseUrl(), "sqlite::memory:");
  });
  withEnv({ DATABASE_URL: "  ", POSTGRES_URL: POOLER }, () => assert.equal(db.databaseSource(), "POSTGRES_URL", "a blank DATABASE_URL doesn't count"));
});

test("Supabase is verified against Supabase's root CA, whatever sslmode the URL asks for", () => {
  withEnv({}, () => {
    for (const url of [POOLER, `${POOLER}?sslmode=require&supa=base-pooler.x`, `${POOLER}?sslmode=verify-full`]) {
      const { connectionString, ssl } = db.postgresConnection(url);
      assert.equal(ssl.rejectUnauthorized, true, url);
      const roots = ssl.ca.map((pem) => new X509Certificate(pem).subject);
      assert.ok(roots.some((subject) => subject.includes("CN=Supabase Root 2021 CA")), "Supabase's root");
      assert.ok(roots.length > 50, "and the public roots");
      assert.doesNotMatch(connectionString, /sslmode/, "the URL's sslmode would override the verified settings");
      if (url.includes("supa=")) assert.match(connectionString, /supa=base-pooler\.x/, "other parameters stay");
      assert.match(connectionString, /^postgresql:\/\/postgres\.abcdefghijklmnopqrst:secret@aws-0-ap-south-1\.pooler\.supabase\.com:6543\/postgres/);
    }
    assert.equal(db.postgresConnection(`${POOLER}?sslmode=disable`).ssl, undefined, "an explicit sslmode=disable is left to the driver");
  });
});

test("the operator's TLS settings still win, and other hosts are unchanged", () => {
  withEnv({ DATABASE_SSL: "no-verify" }, () => assert.deepEqual(db.postgresConnection(POOLER).ssl, { rejectUnauthorized: false }));
  withEnv({ DATABASE_CA_CERT: "-----BEGIN CERTIFICATE-----\\nX\\n-----END CERTIFICATE-----" }, () => assert.deepEqual(db.postgresConnection(POOLER).ssl, { rejectUnauthorized: true, ca: "-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----" }));
  withEnv({}, () => {
    const neon = "postgresql://u:p@ep-x-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require";
    assert.deepEqual(db.postgresConnection(neon), { connectionString: neon }, "sslmode in the URL is left to the driver");
    assert.deepEqual(db.postgresConnection("postgresql://u:p@db.example.com/app").ssl, { rejectUnauthorized: true });
    assert.equal(db.postgresConnection("postgresql://u:p@localhost/app").ssl, false);
  });
});

test("the bundled Supabase CA is the real one", () => {
  const cert = new X509Certificate(require("./db/supabase-ca"));
  assert.match(cert.subject, /CN=Supabase Root 2021 CA/);
  assert.equal(cert.fingerprint256, "80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA");
  assert.ok(new Date(cert.validTo) > new Date(), "not expired");
});

test("a real Supabase pooler: TLS verifies, then the made-up user is refused", { skip: process.env.HANNAH_LIVE_TESTS !== "1" && "set HANNAH_LIVE_TESTS=1 (needs network)" }, async () => {
  const url = "postgresql://postgres.hannahprobe0000000000:wrong@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?sslmode=require&supa=base-pooler.x";
  const error = await db.testDatabaseUrl(url).then(() => null, (failure) => failure);
  assert.ok(error, "a made-up user can't connect");
  assert.doesNotMatch(String(error.message), /certificate|self[- ]signed/i, `TLS failed: ${error.message}`);
  assert.match(String(error.message), /tenant|user|password|authentication/i, error.message);
});
