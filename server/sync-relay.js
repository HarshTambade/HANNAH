const http = require("http");

const PORT = Number(process.env.SYNC_RELAY_PORT || 8787);
const store = new Map();

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/sync") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const id = Math.random().toString(36).slice(2);
      store.set(id, body); // opaque encrypted payload only
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id, stored: true }));
    });
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/sync/")) {
    const id = req.url.split("/").pop();
    const payload = store.get(id);
    if (!payload) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(payload);
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`Sync relay listening on ${PORT}; stores opaque encrypted payloads only.`);
});