"use strict";

/**
 * A small MQTT 3.1.1 client (OASIS, 2014): what a VDA 5050 master control
 * needs and nothing more. CONNECT with a last will, PUBLISH at QoS 0 and 1
 * (with retain), SUBSCRIBE, PINGREQ keepalive and DISCONNECT, over TCP or TLS
 * (with a client certificate for mutual TLS). QoS 2 is not implemented: a
 * QoS 2 delivery is reported as an error rather than half-handled. It is the
 * Node counterpart of hannah-os/runtime/hannah_edge/wire_mqtt.py.
 */
const net = require("node:net");
const tls = require("node:tls");
const { EventEmitter } = require("node:events");

const TYPE = { CONNECT: 1, CONNACK: 2, PUBLISH: 3, PUBACK: 4, SUBSCRIBE: 8, SUBACK: 9, PINGREQ: 12, PINGRESP: 13, DISCONNECT: 14 };
const CONNACK_REASONS = { 1: "the broker doesn't accept protocol 3.1.1", 2: "the broker refused the client id", 3: "the broker is unavailable", 4: "wrong user name or password", 5: "not authorised" };

const text = (value) => { const bytes = Buffer.from(String(value), "utf8"); if (bytes.length > 65535) throw new Error("MQTT string too long"); const out = Buffer.alloc(2 + bytes.length); out.writeUInt16BE(bytes.length); bytes.copy(out, 2); return out; };
const binary = (value) => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8"); const out = Buffer.alloc(2 + bytes.length); out.writeUInt16BE(bytes.length); bytes.copy(out, 2); return out; };
function remaining(size) {
  const out = [];
  let rest = size;
  do { let digit = rest % 128; rest = Math.floor(rest / 128); if (rest > 0) digit |= 0x80; out.push(digit); } while (rest > 0);
  if (out.length > 4) throw new Error("MQTT packet too large");
  return Buffer.from(out);
}
const packet = (first, body) => Buffer.concat([Buffer.from([first]), remaining(body.length), body]);
const u16 = (value) => { const out = Buffer.alloc(2); out.writeUInt16BE(value); return out; };

/** Does a topic match a subscription filter with + and #? */
function topicMatches(filter, topic) {
  const f = filter.split("/");
  const t = topic.split("/");
  for (let index = 0; index < f.length; index += 1) {
    if (f[index] === "#") return true;
    if (index >= t.length) return false;
    if (f[index] !== "+" && f[index] !== t[index]) return false;
  }
  return f.length === t.length;
}

/**
 * Connect. Resolves with the client once the broker accepted the connection.
 *   options  { host, port, clientId, username?, password?, keepalive = 15, clean = true,
 *              will?: { topic, payload, qos, retain }, tls?: { ca, cert, key, servername, rejectUnauthorized }, timeoutMs = 8000 }
 */
function connect(options) {
  const emitter = new EventEmitter();
  emitter.on("error", () => {}); // errors also reject what waits on them; an unheard one must not crash the server
  const { host = "127.0.0.1", port = options.tls ? 8883 : 1883, clientId, keepalive = 15, clean = true, will = null, timeoutMs = 8000 } = options;
  if (!clientId || !/^[A-Za-z0-9_.:-]{1,64}$/.test(clientId)) throw new Error("A client id is 1 to 64 letters, digits or _ . : -");
  const socket = options.tls ? tls.connect({ host, port, servername: options.tls.servername || host, ca: options.tls.ca, cert: options.tls.cert, key: options.tls.key, rejectUnauthorized: options.tls.rejectUnauthorized !== false, minVersion: "TLSv1.2" }) : net.connect({ host, port });
  let buffer = Buffer.alloc(0);
  let nextId = 1;
  const waiting = new Map();
  let connected = false;
  let closed = false;
  let pinger = null;
  const send = (bytes) => { if (!closed) socket.write(bytes); };
  const id = () => { const value = nextId; nextId = nextId === 65535 ? 1 : nextId + 1; return value; };

  function handle(first, body) {
    const kind = first >> 4;
    if (kind === TYPE.CONNACK) {
      const code = body[1];
      const pending = waiting.get("connack");
      waiting.delete("connack");
      if (code === 0) { connected = true; pending?.resolve(); } else pending?.reject(new Error(`MQTT connection refused: ${CONNACK_REASONS[code] || `code ${code}`}`));
    } else if (kind === TYPE.PUBLISH) {
      const qos = (first >> 1) & 0x03;
      const length = body.readUInt16BE(0);
      const topic = body.subarray(2, 2 + length).toString("utf8");
      let offset = 2 + length;
      if (qos === 2) { emitter.emit("error", new Error("A QoS 2 delivery arrived; this client handles QoS 0 and 1 only.")); return; }
      if (qos === 1) { const packetId = body.readUInt16BE(offset); offset += 2; send(packet(0x40, u16(packetId))); }
      emitter.emit("message", topic, body.subarray(offset), { qos, retain: Boolean(first & 0x01) });
    } else if (kind === TYPE.PUBACK || kind === TYPE.SUBACK) {
      const packetId = body.readUInt16BE(0);
      const pending = waiting.get(packetId);
      waiting.delete(packetId);
      if (kind === TYPE.SUBACK && body.subarray(2).includes(0x80)) pending?.reject(new Error("The broker refused a subscription."));
      else pending?.resolve();
    }
  }
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      let multiplier = 1;
      let size = 0;
      let index = 1;
      let byte;
      do {
        if (index >= buffer.length) return;
        byte = buffer[index];
        size += (byte & 0x7f) * multiplier;
        multiplier *= 128;
        index += 1;
      } while (byte & 0x80);
      if (buffer.length < index + size) return;
      const first = buffer[0];
      const body = buffer.subarray(index, index + size);
      buffer = buffer.subarray(index + size);
      try { handle(first, body); } catch (error) { emitter.emit("error", error); }
    }
  });
  const fail = (error) => {
    for (const pending of waiting.values()) pending.reject(error);
    waiting.clear();
  };
  socket.on("error", (error) => { fail(error); emitter.emit("error", error); });
  socket.on("close", () => { closed = true; clearInterval(pinger); fail(new Error("The MQTT connection closed.")); emitter.emit("close"); });

  // A live getter (Object.assign would copy the value it has now).
  Object.defineProperty(emitter, "connected", { get: () => connected && !closed, enumerable: true });
  const client = Object.assign(emitter, {
    publish(topic, payload, { qos = 0, retain = false } = {}) {
      if (qos === 2) return Promise.reject(new Error("QoS 2 is not supported."));
      const data = Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload), "utf8");
      if (qos === 0) { send(packet(0x30 | (retain ? 1 : 0), Buffer.concat([text(topic), data]))); return Promise.resolve(); }
      const packetId = id();
      return new Promise((resolve, reject) => {
        waiting.set(packetId, { resolve, reject });
        send(packet(0x32 | (retain ? 1 : 0), Buffer.concat([text(topic), u16(packetId), data])));
      });
    },
    subscribe(filters) {
      const list = (Array.isArray(filters) ? filters : [filters]).map((item) => (typeof item === "string" ? { topic: item, qos: 0 } : item));
      const packetId = id();
      return new Promise((resolve, reject) => {
        waiting.set(packetId, { resolve, reject });
        send(packet(0x82, Buffer.concat([u16(packetId), ...list.map((item) => Buffer.concat([text(item.topic), Buffer.from([Math.min(1, item.qos || 0)])]))])));
      });
    },
    /** Graceful: DISCONNECT, so the broker doesn't publish the last will (MQTT 3.1.1, 3.14). */
    end() {
      return new Promise((resolve) => {
        if (closed) return resolve();
        socket.once("close", resolve);
        send(Buffer.from([0xe0, 0x00]));
        socket.end();
      });
    },
    /** Drop the connection without DISCONNECT: the broker then publishes the last will. */
    destroy() { socket.destroy(); },
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("The MQTT broker didn't answer in time.")); }, timeoutMs);
    waiting.set("connack", { resolve: () => { clearTimeout(timer); resolve(client); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    socket.once(options.tls ? "secureConnect" : "connect", () => {
      const flags = (options.username ? 0x80 : 0) | (options.password ? 0x40 : 0) | (will ? 0x04 | ((will.qos || 0) << 3) | (will.retain ? 0x20 : 0) : 0) | (clean ? 0x02 : 0);
      const body = Buffer.concat([
        text("MQTT"), Buffer.from([4, flags]), u16(keepalive),
        text(clientId),
        ...(will ? [text(will.topic), binary(typeof will.payload === "string" || Buffer.isBuffer(will.payload) ? will.payload : JSON.stringify(will.payload))] : []),
        ...(options.username ? [text(options.username)] : []),
        ...(options.password ? [binary(options.password)] : []),
      ]);
      send(packet(0x10, body));
      if (keepalive > 0) { pinger = setInterval(() => send(Buffer.from([0xc0, 0x00])), keepalive * 500); pinger.unref?.(); }
    });
  });
}

module.exports = { connect, topicMatches };
