// Robot operations again, on embedded Postgres (PGlite): the SQL of migration 35 must work on both databases.
process.env.HANNAH_TEST_DB = "pglite";
require("./robotops.test.js");
