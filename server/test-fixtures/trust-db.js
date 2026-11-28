"use strict";

/**
 * A migrated database for service-level tests: SQLite in memory, or embedded
 * Postgres (PGlite) when HANNAH_TEST_DB=pglite, with users already created.
 */
process.env.HANNAH_VAULT_KEY = process.env.HANNAH_VAULT_KEY || "e".repeat(64);
const { migrate, openDatabase } = require("../db");

async function testDatabase(users = ["u_asha", "u_bo"]) {
  let db;
  if (process.env.HANNAH_TEST_DB === "pglite") {
    db = await require("../db/pglite-adapter").createPgliteAdapter();
    await migrate(db);
  } else {
    db = await openDatabase("sqlite::memory:");
  }
  for (const id of users) {
    await db.query("INSERT INTO hannah_users (id, email, password_hash, display_name, created_at, updated_at) VALUES ($1, $2, 'x', $1, 1, 1)", [id, `${id}@example.test`]);
  }
  return db;
}

module.exports = { testDatabase };
