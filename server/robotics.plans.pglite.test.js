// Plans again, on embedded Postgres (PGlite): migration 20 and its SQL must work on both databases.
process.env.HANNAH_TEST_DB = "pglite";
require("./robotics.plans.test.js");
