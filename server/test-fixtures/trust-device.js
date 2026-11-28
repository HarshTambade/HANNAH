"use strict";

/** A device's side of zero-trust enrollment: its own key pair and the signatures it makes. */
const crypto = require("node:crypto");
const { credentialMessage, enrollMessage, rotateMessage } = require("../trust/service");

function createDevice(deviceId, { hardwareId = null } = {}) {
  let pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicPem = () => pair.publicKey.export({ type: "spki", format: "pem" });
  const sign = (message, key = pair.privateKey) => crypto.sign("sha256", Buffer.from(message, "utf8"), key).toString("base64");
  return {
    deviceId,
    hardwareId,
    get privateKey() { return pair.privateKey; },
    publicPem,
    enrollment(code) {
      const publicKey = publicPem();
      return { deviceId, code, publicKey, hardwareId, signature: sign(enrollMessage({ deviceId, code, publicKey })) };
    },
    credentialRequest({ time = Date.now(), nonce = crypto.randomBytes(12).toString("hex"), scope = "device" } = {}) {
      return { deviceId, time, nonce, scope, hardwareId, signature: sign(credentialMessage({ deviceId, time: String(time), nonce, scope })) };
    },
    rotation({ time = Date.now(), nonce = crypto.randomBytes(12).toString("hex") } = {}) {
      const next = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const publicKey = next.publicKey.export({ type: "spki", format: "pem" });
      const message = rotateMessage({ deviceId, time: String(time), nonce, publicKey });
      const request = { deviceId, time, nonce, publicKey, signature: sign(message), newKeySignature: sign(message, next.privateKey) };
      return { request, commit: () => { pair = next; } };
    },
  };
}

module.exports = { createDevice };
