const assert = require("node:assert/strict");
const { once } = require("node:events");
const { test, before, after } = require("node:test");

// Like production: CLIENT_ORIGIN lists only the website.
process.env.NODE_ENV = "production";
process.env.CLIENT_ORIGIN = "https://hannah.example";
process.env.DATABASE_URL = "";
delete process.env.HANNAH_API_TOKEN;

let server;
let base;

before(async () => {
  const app = require("./index");
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

const preflight = (origin) => fetch(`${base}/api/models?provider=groq`, {
  method: "OPTIONS",
  headers: { Origin: origin, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "x-groq-api-key" },
});

test("the apps can call the server even when CLIENT_ORIGIN lists only the website", async () => {
  for (const origin of ["https://hannah.example", "capacitor://localhost", "https://localhost", "capacitor-electron://localhost"]) {
    const response = await preflight(origin);
    assert.equal(response.headers.get("access-control-allow-origin"), origin, origin);
    assert.match(response.headers.get("access-control-allow-headers") || "", /x-groq-api-key/i, origin);
  }
});

test("other origins are still refused", async () => {
  const response = await preflight("https://evil.example");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});
