// The Safety and Autonomy Manager and teleoperation again, on embedded Postgres (PGlite): the SQL must work on both databases.
process.env.HANNAH_TEST_DB = "pglite";
require("./robotics.autonomy.http.test.js");
