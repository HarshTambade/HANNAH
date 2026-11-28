"use strict";

// The zero-trust identity tests again on embedded Postgres (PGlite): the SQL must work on both databases.
process.env.HANNAH_TEST_DB = "pglite";
require("./trust.test.js");
