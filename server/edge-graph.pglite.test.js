// Edge resources and the Device Intelligence Graph again, on embedded Postgres (PGlite): the SQL must work on both databases.
process.env.HANNAH_TEST_DB = "pglite";
require("./edge-graph.test.js");
