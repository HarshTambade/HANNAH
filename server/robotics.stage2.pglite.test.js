// Commissioning, destinations and pause/resume again, on embedded Postgres (PGlite): migration 19 and its SQL must work on both databases.
process.env.HANNAH_TEST_DB = "pglite";
require("./robotics.stage2.test.js");
