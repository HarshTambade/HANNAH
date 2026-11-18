#!/usr/bin/env node
"use strict";

// Check or migrate the database in DATABASE_URL (or POSTGRES_URL, from Vercel's Supabase integration).
//   npm run db:check     connect and report the provider and schema version
//   npm run db:migrate   apply pending migrations (also done automatically on first use)
require("dotenv").config();
const { databaseUrl, describeDatabaseError, openDatabase, parseDatabaseUrl, redact } = require("../db");

async function main() {
  const command = process.argv[2] || "check";
  const url = databaseUrl();
  if (!url) {
    console.error("Neither DATABASE_URL nor POSTGRES_URL is set. Add one to server/.env, for example a Supabase or Neon connection string.");
    process.exitCode = 1;
    return;
  }
  if (!["check", "migrate"].includes(command)) {
    console.error("Usage: node scripts/db.js check|migrate");
    process.exitCode = 1;
    return;
  }
  const config = parseDatabaseUrl(url);
  console.log(`Connecting to ${config.provider} (${config.kind}) at ${redact(url)}…`);
  const db = await openDatabase(url);
  const { rows } = await db.query("SELECT version, name FROM hannah_migrations ORDER BY version");
  console.log(`Connected. Schema version ${db.schemaVersion}; applied: ${rows.map((row) => `${row.version} (${row.name})`).join(", ")}.`);
  await db.close();
}

main().catch((error) => {
  console.error(`Database check failed: ${describeDatabaseError(error)}`);
  process.exitCode = 1;
});
