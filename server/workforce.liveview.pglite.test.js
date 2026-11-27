// The live view suite again, on embedded Postgres (PGlite).
process.env.HANNAH_TEST_DB = "pglite";
require("./workforce.liveview.test.js");
