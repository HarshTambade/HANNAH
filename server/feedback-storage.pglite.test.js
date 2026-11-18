// Feedback, report storage and the shared rate limit on embedded Postgres (PGlite): the SQL must work on both databases.
process.env.HANNAH_TEST_DB = "pglite";
require("./feedback-storage.test.js");
