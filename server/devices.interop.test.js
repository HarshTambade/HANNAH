"use strict";

// INTEROPERABILITY tests: HANNAH Edge's own MQTT 3.1.1 client and its MQTT
// device adapter (hannah-os/runtime, Python) against aedes, an MQTT broker
// HANNAH did not write. This is what says the client speaks MQTT, and not
// merely the dialect of HANNAH's own test broker.
//
// Still not a test of any device: the "fan" here is a few lines of this file.
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const net = require("node:net");
const path = require("node:path");
const test = require("node:test");
const { after, before } = test;

const RUNTIME = path.join(__dirname, "..", "hannah-os", "runtime");
const python = (() => {
  const found = spawnSync("python3", ["-c", "import sys; print(sys.version_info >= (3, 9))"], { encoding: "utf8" });
  return found.status === 0 && found.stdout.trim() === "True";
})();
const skip = python ? false : "python3 (3.9 or newer) isn't installed, so the hub's client can't run here";
let broker;
let server;
let port;
const heard = [];

/** Run a Python snippet in the hub's runtime; it prints one JSON value. */
async function py(code) {
  const child = spawn("python3", ["-c", code], { cwd: RUNTIME, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { err += chunk; });
  const [status] = await once(child, "exit");
  assert.equal(status, 0, err || out);
  return JSON.parse(out.trim().split("\n").pop());
}
const publish = (topic, payload, extra = {}) => new Promise((resolve, reject) => broker.publish({ cmd: "publish", topic, payload: Buffer.from(payload), qos: 0, retain: false, dup: false, ...extra }, (error) => (error ? reject(error) : resolve())));

before(async () => {
  if (skip) return;
  const { Aedes } = await import("aedes");
  broker = await Aedes.createBroker({
    authenticate(_client, username, password, done) {
      if (username === "asha" && String(password || "") === "open sesame") return done(null, true);
      return done(Object.assign(new Error("bad credentials"), { returnCode: 4 }), false);
    },
  });
  server = net.createServer(broker.handle);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = server.address().port;
  await new Promise((resolve) => broker.subscribe("interop/py/#", (packet, done) => { heard.push({ topic: packet.topic, payload: packet.payload.toString(), qos: packet.qos, retain: packet.retain }); done(); }, resolve));
  // A stand-in fan on the broker: it reports its state, and obeys ON and OFF.
  await publish("sim/fan/status", "online", { retain: true });
  await publish("sim/fan/state", "OFF", { retain: true });
  await new Promise((resolve) => broker.subscribe("sim/fan/set", (packet, done) => { const text = packet.payload.toString(); if (text === "ON" || text === "OFF") broker.publish({ cmd: "publish", topic: "sim/fan/state", payload: Buffer.from(text), qos: 0, retain: true, dup: false }, () => done()); else done(); }, resolve));
});

after(async () => {
  if (skip) return;
  await new Promise((resolve) => broker.close(resolve));
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

test("HANNAH's MQTT client talks to a broker it didn't write: sign-in, subscribe, retained, QoS 1 both ways, keep-alive", { skip }, async () => {
  await publish("interop/room/state", "21.5", { retain: true });
  const result = await py(`
import json, threading, time
from hannah_edge.mqtt import MqttClient
got, done = [], threading.Event()
def on_message(topic, payload, retained):
    got.append([topic, payload.decode(), retained])
    if len(got) >= 2: done.set()
client = MqttClient("127.0.0.1", ${port}, client_id="hannah-interop", username="asha", password="open sesame", keepalive=1, timeout=4.0, on_message=on_message)
client.connect()
client.subscribe(["interop/+/state"], qos=1)
client.publish("interop/py/out", "hello from the hub", qos=1)
client.publish("interop/py/kept", "kept", qos=1, retain=True)
client.publish("interop/lamp/state", "ON", qos=1)
done.wait(4.0)
time.sleep(2.2)  # more than two keep-alive periods with nothing to say
alive = client.connected
client.publish("interop/py/late", "still here", qos=1)
client.close()
print(json.dumps({"got": got, "alive": alive}))
`);
  assert.deepEqual(result.got[0], ["interop/room/state", "21.5", true], "the retained message arrives first, marked as retained");
  assert.deepEqual(result.got[1], ["interop/lamp/state", "ON", false]);
  assert.equal(result.alive, true, "the connection outlives two quiet keep-alive periods");
  const byTopic = Object.fromEntries(heard.map((item) => [item.topic, item]));
  assert.equal(byTopic["interop/py/out"].payload, "hello from the hub");
  assert.equal(byTopic["interop/py/out"].qos, 1);
  assert.equal(byTopic["interop/py/kept"].retain, true);
  assert.equal(byTopic["interop/py/late"].payload, "still here");
});

test("a refused sign-in is reported as that, by an independent broker's own answer", { skip }, async () => {
  const result = await py(`
import json
from hannah_edge.mqtt import MqttClient, MqttError
out = {}
for name, password in (("wrong", "nope"), ("none", None)):
    try:
        MqttClient("127.0.0.1", ${port}, client_id="hannah-" + name, username="asha" if password else None, password=password, timeout=3.0).connect()
        out[name] = "connected"
    except MqttError as error:
        out[name] = [error.reason, str(error)]
print(json.dumps(out))
`);
  assert.equal(result.wrong[0], "auth");
  assert.match(result.wrong[1], /wrong user name or password/);
  assert.equal(result.none[0], "auth");
});

test("the MQTT device adapter reads, writes and reads back through that broker", { skip }, async () => {
  const result = await py(`
import json, os, time
from hannah_edge.adapters.mqtt_device import MqttDevice
from hannah_edge.adapters.base import AdapterError
with open(os.path.join("..", "profiles", "org.hannah.sim.fan.json"), encoding="utf-8") as handle:
    profile = json.load(handle)
fan = MqttDevice({"id": "dev_fan", "profile": profile, "settings": {"host": "127.0.0.1", "port": ${port}, "username": "asha", "password": "open sesame"}, "writable": ["power"]}, client_id="hannah-interop-fan")
fan.start()
def wait(check):
    end = time.time() + 4.0
    while time.time() < end and not check():
        time.sleep(0.05)
    return check()
out = {"online": wait(lambda: fan.connection()["state"] == "online" and fan.reading("power") is not None), "before": (fan.reading("power") or {}).get("value")}
fan.write("power", True)
out["after"] = wait(lambda: fan.reading("power")["value"] is True)
try:
    fan.write("power", "ON")
    out["bad"] = "accepted"
except AdapterError as error:
    out["bad"] = error.reason
fan.stop()
print(json.dumps(out))
`);
  assert.deepEqual(result, { online: true, before: false, after: true, bad: "bad-value" });
});
