// Camera images again, on embedded Postgres (PGlite): migration 21 and its SQL must work on both databases.
process.env.HANNAH_TEST_DB = "pglite";
require("./robotics.camera.test.js");
