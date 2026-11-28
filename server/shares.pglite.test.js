// The share-link suite again, on embedded Postgres (PGlite).
process.env.HANNAH_TEST_DB = "pglite";
require("./shares.test.js");
