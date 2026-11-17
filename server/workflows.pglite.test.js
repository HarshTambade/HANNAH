// The workflow suite again, on embedded Postgres (PGlite): the SQL must work on both databases.
process.env.HANNAH_TEST_DB = "pglite";
require("./workflows.test.js");
