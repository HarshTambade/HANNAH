"use strict";

// The robot-link zero-trust tests again on embedded Postgres (PGlite).
process.env.HANNAH_TEST_DB = "pglite";
require("./robotics.trust.test.js");
