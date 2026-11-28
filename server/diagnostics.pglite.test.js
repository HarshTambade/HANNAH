// Self-diagnostics again, on embedded Postgres (PGlite): the SQL must work on both databases.
process.env.HANNAH_TEST_DB = "pglite";
require("./diagnostics.test.js");
