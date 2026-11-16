// The account suite again, on embedded Postgres (PGlite), to check the SQL
// runs on the Postgres dialect used by Supabase, Neon and other hosts.
process.env.HANNAH_TEST_DB = "pglite";
require("./accounts.test.js");
