"use strict";

// The hardware package and interop route tests again on embedded Postgres (PGlite).
process.env.HANNAH_TEST_DB = "pglite";
require("./marketplace.hardware.test.js");
