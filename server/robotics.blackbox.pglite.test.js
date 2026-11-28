// The black box again, on embedded Postgres (PGlite): its SQL must work on both databases.
process.env.HANNAH_TEST_DB = "pglite";
require("./robotics.blackbox.test.js");
