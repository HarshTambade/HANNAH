// The robot registry, missions and device protocol again, on embedded Postgres (PGlite): the SQL must work on both databases.
process.env.HANNAH_TEST_DB = "pglite";
require("./robotics.test.js");
