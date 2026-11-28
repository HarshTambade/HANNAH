"use strict";

// The interoperability tests again on embedded Postgres (PGlite).
process.env.HANNAH_TEST_DB = "pglite";
require("./interop.test.js");
