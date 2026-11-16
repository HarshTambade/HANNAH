"use strict";

/**
 * Test-only adapter: real Postgres (PGlite, compiled to WebAssembly) in
 * process, so the Postgres SQL dialect is exercised without a server.
 */
async function createPgliteAdapter() {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = await PGlite.create();
  const run = (target) => async (sql, params = []) => {
    const result = await target.query(sql, params);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };
  return {
    kind: "postgres",
    provider: "pglite",
    query: run(pg),
    transaction: (fn) => pg.transaction((tx) => fn(run(tx), { lock: (key) => tx.query("SELECT pg_advisory_xact_lock($1)", [key]) })),
    close: () => pg.close(),
  };
}

module.exports = { createPgliteAdapter };
