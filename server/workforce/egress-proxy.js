"use strict";

/**
 * The workforce browser's way out to the network.
 *
 * Every request the browser makes, a page load, a script's fetch, an image, a
 * frame and each hop of a redirect, goes through this proxy. It resolves the
 * host itself and connects to the address it checked, so a name can't resolve
 * to a public address for the check and an internal one for the connection
 * (DNS rebinding), and a redirect can't reach what a direct request couldn't.
 *
 * It listens on 127.0.0.1 only, one proxy per browser, and only ever refuses:
 * anything it lets through, the server could reach directly anyway.
 */
const dns = require("node:dns/promises");
const http = require("node:http");
const net = require("node:net");

const HOP_BY_HOP = new Set(["proxy-connection", "proxy-authorization", "proxy-authenticate", "connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade"]);

/**
 * `check(hostname, address)` returns a reason to refuse, or "" to allow. It is
 * asked for every address the host resolves to; any refusal refuses the host.
 */
async function resolveChecked(hostname, check) {
  const host = String(hostname || "").replace(/^\[|\]$/g, "");
  const answers = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true, verbatim: true });
  if (!answers.length) throw Object.assign(new Error(`${host} doesn't resolve`), { refused: true });
  for (const answer of answers) {
    const reason = await check(host, answer.address);
    if (reason) throw Object.assign(new Error(reason), { refused: true });
  }
  return answers;
}

/**
 * A lookup that answers only with addresses already checked, so the connection
 * can try each of them (IPv6 then IPv4, say) without resolving the name again.
 */
function fixedLookup(answers) {
  return (_host, options, callback) => {
    const done = typeof options === "function" ? options : callback;
    const all = typeof options === "object" && options?.all;
    if (all) return done(null, answers.map(({ address, family }) => ({ address, family })));
    return done(null, answers[0].address, answers[0].family);
  };
}

function createEgressProxy({ check }) {
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    // A plain http request, sent to the proxy with the full URL.
    let url;
    try {
      url = new URL(req.url);
      if (url.protocol !== "http:") throw new Error("only http here");
    } catch {
      res.writeHead(400).end();
      return;
    }
    let target;
    try {
      target = await resolveChecked(url.hostname, check);
    } catch (error) {
      res.writeHead(error.refused ? 403 : 502, { "Content-Type": "text/plain" }).end(error.refused ? "Blocked by HANNAH's network policy." : "The host couldn't be reached.");
      return;
    }
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(name.toLowerCase())) headers[name] = value;
    const upstream = http.request({
      host: url.hostname.replace(/^\[|\]$/g, ""), lookup: fixedLookup(target), autoSelectFamily: true, port: url.port || 80, method: req.method, path: `${url.pathname}${url.search}`,
      headers: { ...headers, host: url.host },
    }, (response) => {
      const back = {};
      for (const [name, value] of Object.entries(response.headers)) if (!HOP_BY_HOP.has(name.toLowerCase())) back[name] = value;
      res.writeHead(response.statusCode || 502, back);
      response.pipe(res);
    });
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502).end(); else res.destroy(); });
    req.pipe(upstream);
  });

  // https (and WebSockets): a tunnel to the checked address.
  server.on("connect", async (req, client, head) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    const match = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(String(req.url || ""));
    if (!match) {
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    let target;
    try {
      target = await resolveChecked(match[1], check);
    } catch (error) {
      client.end(`HTTP/1.1 ${error.refused ? "403 Forbidden" : "502 Bad Gateway"}\r\n\r\n`);
      return;
    }
    const upstream = net.connect({ host: match[1], lookup: fixedLookup(target), autoSelectFamily: true, port: Number(match[2]) }, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    upstream.on("error", () => client.destroy());
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}

module.exports = { createEgressProxy, resolveChecked };
