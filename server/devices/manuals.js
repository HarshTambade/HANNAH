"use strict";

/**
 * Manual intelligence: what a device's manual says about connecting to it.
 *
 * A person gives HANNAH a manual or a datasheet (PDF, Word, text). This reads
 * it and returns FACTS, each with the page it is on and the exact line it came
 * from, so a person can check it in seconds:
 *
 *   { field: "modbus.unit", value: 1, page: 12, quote: "Default slave address: 1", confidence, state: "unverified" }
 *
 * and, when there is enough to go on, a PROPOSED device profile built only
 * from those facts.
 *
 * The rules:
 *   - Nothing is a fact without a quote found on the cited page. That holds
 *     for this file's own patterns and for anything a language model
 *     suggests: accept() drops every suggestion whose quote isn't in the
 *     document or whose value isn't in its quote.
 *   - Nothing is filled in. A writable register with no stated range is
 *     proposed read-only, and says why. A register whose table isn't stated
 *     isn't given one.
 *   - Voltage, current and wiring are reported for a qualified person to
 *     check against the device itself. They are never used.
 *   - A manual is data. Whatever it says, it cannot allow a write, grant a
 *     permission or skip the check and switch-on a person does.
 *   - A proposal is "experimental" until it has been checked against the
 *     device. A manual cannot produce a verified driver.
 */
const { readFile } = require("../documents/read");
const profiles = require("./profiles");
const crypto = require("node:crypto");

const MAX_PAGES = 400;
const MAX_FACTS = 300;
const MAX_REGISTERS = 64;
const fail = (status, message, reason) => Object.assign(new Error(message), { status, reason });
const squash = (text) => String(text).replace(/\s+/g, " ").trim();
const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^([^a-z])/, "p_$1").slice(0, 40);

const PROTOCOLS = [
  { id: "modbus-tcp", pattern: /\bmodbus[\s\-/]*tcp\b/i, label: "Modbus TCP" },
  { id: "modbus-rtu", pattern: /\bmodbus[\s\-/]*rtu\b|\brs[\s-]?485\b/i, label: "Modbus RTU / RS-485" },
  { id: "mqtt", pattern: /\bmqtt\b/i, label: "MQTT" },
  { id: "opcua", pattern: /\bopc[\s-]?ua\b/i, label: "OPC UA" },
  { id: "matter", pattern: /\bmatter\b(?=.{0,40}\b(device|certified|commission|compatible|protocol|over)\b)/i, label: "Matter" },
  { id: "zigbee", pattern: /\bzigbee\b/i, label: "Zigbee" },
  { id: "zwave", pattern: /\bz[\s-]?wave\b/i, label: "Z-Wave" },
  { id: "ble", pattern: /\bbluetooth\b|\bble\b/i, label: "Bluetooth" },
  { id: "http", pattern: /\b(rest(ful)?\s+api|http\s+api|http:\/\/)/i, label: "HTTP API" },
  { id: "coap", pattern: /\bcoap\b/i, label: "CoAP" },
  { id: "can", pattern: /\bcan[\s-]?(bus|open|fd)\b/i, label: "CAN" },
];
const UNITS = ["°C", "°F", "%RH", "%", "kWh", "Wh", "kW", "W", "VA", "V", "mA", "A", "Hz", "ppm", "lx", "lux", "Pa", "kPa", "bar", "rpm", "l/min", "m3/h", "s", "ms", "psi", "mBar", "mT", "G", "km", "km/h", "kHz", "MHz", "GHz", "dB", "°K", "°R"];
const TYPE = /^(u?int(?:16|32)|float(?:32)?|real|bool(?:ean)?|bit|word|dword)$/i;
const ACCESS = /^(r|ro|rw|r\/w|w|wo|read(?:-|\s)?only|read\/write)$/i;
const TABLE_HINT = [["holding", /\bholding\b|\b(fc|function(\s+code)?)\s*0?3\b|\b0x03\b/i], ["input", /\binput\s+register|\b(fc|function(\s+code)?)\s*0?4\b|\b0x04\b/i], ["coil", /\bcoils?\b|\b(fc|function(\s+code)?)\s*0?[15]\b/i], ["discrete", /\bdiscrete\b|\b(fc|function(\s+code)?)\s*0?2\b/i], ["bit", /\b(?:bit|coil|discrete)\b/i], ["float32", /\b(?:float|single)\b/i]];
TABLE_HINT.push(["semicolon", /;\s*\d+/i], ["colon", /\d+\s*:\s*\d+/i]);

/** What kind of image a buffer holds, so a photo of a label can be kept as source evidence. */
function imageType(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}


/** A document's text as pages: [{ page, lines }]. A PDF keeps its page numbers; anything else is one page per form feed. */
function pagesOf(read) {
  const text = String(read.text || "");
  const parts = read.kind === "pdf" ? text.split(/^## Page (\d+)$/m) : null;
  const pages = [];
  if (parts && parts.length > 1) for (let index = 1; index < parts.length; index += 2) pages.push({ page: Number(parts[index]), text: parts[index + 1] || "" });
  else text.split("\f").forEach((chunk, index) => pages.push({ page: index + 1, text: chunk }));
  return pages.slice(0, MAX_PAGES).map(({ page, text: body }) => ({ page, lines: body.split(/\r?\n/).map(squash).filter((line) => line && !/^\[No text on this page/.test(line)) }));
}

/** Is this fact really in the document? The quote must be a line (or part of one) on the cited page, and the value must be in the quote. */
function supported(pages, fact) {
  const page = pages.find((item) => item.page === fact?.page);
  const quote = squash(fact?.quote || "");
  if (!page || quote.length < 3 || quote.length > 400) return false;
  if (!page.lines.some((line) => line.includes(quote))) return false;
  // `found` is the text a pattern matched when the value itself is an id or was put together (a protocol's id, "8N1").
  const value = fact.found ?? fact.value;
  if (value === null || value === undefined || value === "") return false;
  if (typeof value === "number") return (quote.match(/0x[0-9a-f]+|-?\d+(?:[.,]\d+)?/gi) || []).some((token) => Number(/^0x/i.test(token) ? parseInt(token, 16) : token.replace(",", ".")) === value);
  return quote.toLowerCase().includes(String(value).toLowerCase());
}

/** Keep only the suggested facts the document supports. For anything not produced by this file's own patterns, a language model above all. */
function accept(pages, suggested) {
  const accepted = [];
  const rejected = [];
  for (const item of Array.isArray(suggested) ? suggested.slice(0, MAX_FACTS) : []) {
    const fact = { field: squash(item?.field || "").slice(0, 60), label: squash(item?.label || item?.field || "").slice(0, 80), value: typeof item?.value === "number" ? item.value : squash(item?.value ?? "").slice(0, 200), page: Number(item?.page), quote: squash(item?.quote || "").slice(0, 400) };
    if (fact.field && supported(pages, fact)) accepted.push({ ...fact, confidence: "low", method: "model", state: "unverified" });
    else rejected.push({ field: fact.field, value: fact.value, reason: "Not found in the document as quoted." });
  }
  return { accepted, rejected };
}

function extract(pages) {
  const facts = [];
  const seen = new Set();
  const add = (fact) => {
    const key = `${fact.field}|${fact.value}`;
    if (seen.has(key) || facts.length >= MAX_FACTS) return;
    seen.add(key);
    facts.push({ id: `f${facts.length + 1}`, method: "pattern", state: "unverified", ...fact });
  };
  const registers = [];
  for (const { page, lines } of pages) {
    let table = null;
    const pageText = lines.join(" ");
    const registerPage = /\bregisters?\b|\bmodbus\b/i.test(pageText);
    for (const line of lines) {
      const at = { page, quote: line.slice(0, 400) };
      let match;
      // Who and what.
      if ((match = /^(?:model(?:\s*(?:no\.?|number|name))?|type|part\s*(?:no\.?|number))\s*[:：]\s*([A-Za-z0-9][A-Za-z0-9 ._\-/]{1,40})$/i.exec(line))) add({ field: "identity.model", label: "Model", value: squash(match[1]), confidence: "high", ...at });
      if ((match = /^(?:manufacturer|manufactured by|made by|brand)\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9 .,&-]{1,60})$/i.exec(line))) add({ field: "identity.manufacturer", label: "Manufacturer", value: squash(match[1]), confidence: "high", ...at });
      if ((match = /\b(?:hardware\s+)?(?:revision|rev\.?)\s*[:：]?\s*([A-Z0-9][A-Za-z0-9.]{0,10})\b/.exec(line)) && /hardware|revision/i.test(line)) add({ field: "identity.revision", label: "Hardware revision", value: match[1], confidence: "medium", ...at });
      if ((match = /\bfirmware(?:\s+version)?\s*[:：]?\s*v?(\d+(?:\.\d+){1,3})/i.exec(line))) add({ field: "identity.firmware", label: "Firmware named in the manual", value: match[1], confidence: "medium", ...at });
      // How it talks.
      for (const protocol of PROTOCOLS) { const hit = protocol.pattern.exec(line); if (hit) add({ field: "protocol", label: "Protocol", value: protocol.id, shown: protocol.label, found: hit[0], confidence: "medium", ...at }); }
      if ((match = /\b(?:baud\s*rate|baudrate|baud)\b[^0-9]{0,20}(\d{4,6})\b/i.exec(line) || /\b(\d{4,6})\s*(?:bps|baud)\b/i.exec(line))) add({ field: "serial.baud", label: "Baud rate", value: Number(match[1]), confidence: "high", ...at });
      if ((match = /\b([78])\s*[-,]?\s*([NEO])\s*[-,]?\s*([12])\b/.exec(line)) && /serial|rs-?485|rs-?232|uart|format|parity|baud/i.test(line)) add({ field: "serial.format", label: "Serial format (data bits, parity, stop bits)", value: `${match[1]}${match[2]}${match[3]}`, found: match[0], confidence: "medium", ...at });
      if ((match = /\b(?:slave|unit|device|modbus)\s*(?:id|address|addr\.?)\b[^0-9]{0,24}(\d{1,3})\b/i.exec(line)) && Number(match[1]) <= 247) add({ field: "modbus.unit", label: "Modbus unit number", value: Number(match[1]), confidence: /default/i.test(line) ? "high" : "medium", ...at });
      if ((match = /\b(?:tcp\s*)?port\b[^0-9]{0,16}(\d{2,5})\b/i.exec(line)) && Number(match[1]) <= 65535) add({ field: "network.port", label: "Network port", value: Number(match[1]), confidence: "medium", ...at });
      if ((match = /\b(?:default\s+)?ip(?:\s*address)?\b[^0-9]{0,20}((?:\d{1,3}\.){3}\d{1,3})\b/i.exec(line))) add({ field: "network.address", label: "Network address", value: match[1], confidence: /default/i.test(line) ? "high" : "medium", ...at });
      if (/\btopics?\b/i.test(line)) for (const topic of line.match(/[A-Za-z0-9_$%<>{}-]+(?:\/[A-Za-z0-9_+#%<>{}-]+){1,8}/g) || []) if (!/^https?:?$/i.test(topic.split("/")[0])) add({ field: "mqtt.topic", label: "MQTT topic", value: topic, confidence: "medium", ...at });
      // Additional electrical value patterns (added 2026-11-23)
      // These extract more electrical constraints from manuals.

      // Power consumption
      if ((match = /\b(?:power\s+)?consumption\b[^0-9]{0,30}(\d+(?:\.\d+)?)\s*(W|kW|mW)\b/i.exec(line))) add({ field: "electrical.power", label: "Power consumption", value: `${match[1]} ${match[2]}`, found: match[0], confidence: "medium", ...at });

      // Voltage range
      if ((match = /\b(?:operating|input|output)\s+voltage\s+range\b[^0-9]{0,30}(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*(V|kV|mV)\b/i.exec(line))) add({ field: "electrical.voltage.range", label: "Voltage range", value: `${match[1]} to ${match[2]} ${match[3]}`, found: match[0], confidence: "medium", ...at });

      // Current range
      if ((match = /\b(?:operating|output|load)\s+current\s+range\b[^0-9]{0,30}(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*(mA|A)\b/i.exec(line))) add({ field: "electrical.current.range", label: "Current range", value: `${match[1]} to ${match[2]} ${match[3]}`, found: match[0], confidence: "medium", ...at });

      // What it must not exceed. Reported, never used.
      if ((match = /\b(?:supply|power\s+supply|input|rated|operating)\s+voltage\b[^0-9]{0,24}(\d+(?:\.\d+)?(?:\s*(?:-|–|to|~)\s*\d+(?:\.\d+)?)?)\s*(V\s?(?:AC|DC)?|VAC|VDC)\b/i.exec(line))) add({ field: "electrical.voltage", label: "Supply voltage", value: `${squash(match[1])} ${squash(match[2])}`, found: match[1], confidence: "medium", hazardous: true, ...at });
      if ((match = /\b(?:max(?:imum)?|rated)\s+(?:load\s+)?current\b[^0-9]{0,24}(\d+(?:\.\d+)?)\s*(mA|A)\b/i.exec(line))) add({ field: "electrical.current", label: "Rated current", value: `${match[1]} ${match[2]}`, found: match[1], confidence: "medium", hazardous: true, ...at });
      if ((match = /\boperating\s+temperature\b[^0-9\-+]{0,24}([-+]?\d+(?:\.\d+)?)\s*(?:°?\s*[CF])?\s*(?:to|-|–|~|\.\.\.)\s*\+?([-+]?\d+(?:\.\d+)?)\s*°?\s*([CF])\b/i.exec(line))) add({ field: "limits.operatingTemperature", label: "Operating temperature", value: `${match[1]} to ${match[2]} °${match[3].toUpperCase()}`, found: match[1], confidence: "medium", ...at });
      // Additional electrical value patterns (added 2026-11-23)
      // Power factor
      if ((match = /\b(?:power\s+)?factor\b[^0-9]{0,20}([0-9](?:\.[0-9]+)?)\b/i.exec(line))) add({ field: "electrical.power_factor", label: "Power factor", value: match[1], confidence: "medium", found: match[0], ...at });
      // Efficiency
      if ((match = /\b(?:efficiency|eta)\b[^0-9]{0,20}(\d+(?:\.\d+)?)\s*%\b/i.exec(line))) add({ field: "electrical.efficiency", label: "Efficiency", value: `${match[1]}%`, found: match[0], confidence: "medium", ...at });
      // Inrush current
      if ((match = /\b(?:inrush|peak)\s+current\b[^0-9]{0,30}(\d+(?:\.\d+)?)\s*(mA|A)\b/i.exec(line))) add({ field: "electrical.inrush_current", label: "Inrush current", value: `${match[1]} ${match[2]}`, found: match[0], confidence: "medium", hazardous: true, ...at });
      if (/^(?:⚠\s*)?(?:warning|caution|danger)\b/i.test(line) && line.length > 12) add({ field: "safety", label: "Safety instruction", value: line.slice(0, 300), confidence: "high", ...at });
      // Register maps.
      for (const [name, hint] of TABLE_HINT) if (hint.test(line) && !/^\s*(?:0x[0-9a-f]+|\d+)\s/i.test(line)) table = name;
      if (!registerPage || registers.length >= MAX_REGISTERS) continue;
      const cells = line.split(/\s*\|\s*|\t+|\s{2,}|\s+/).filter(Boolean);
      const first = cells[0] || "";
      let address = null;
      let rowTable = table;
      if (/^0x[0-9a-f]{1,4}$/i.test(first)) address = parseInt(first, 16);
      else if (/^[34]\d{4}$/.test(first)) { address = Number(first.slice(1)) - 1; rowTable = first[0] === "4" ? "holding" : "input"; }
      else if (/^\d{1,5}$/.test(first) && Number(first) <= 65535) address = Number(first);
      if (address === null || address < 0 || cells.length < 3) continue;
      const rest = cells.slice(1);
      const type = rest.find((cell) => TYPE.test(cell));
      const access = rest.find((cell) => ACCESS.test(cell));
      if (!type && !access) continue; // a number followed by words is not a register row
      const unit = rest.find((cell) => UNITS.includes(cell));
      const scaleCell = rest.find((cell) => /^(?:[x×*]\s*)?0?\.\d+$|^(?:\/|÷)\s*\d+$|^[x×*]\s*\d+$/.test(cell));
      const scale = scaleCell ? (/^(?:\/|÷)/.test(scaleCell) ? 1 / Number(scaleCell.replace(/[^0-9.]/g, "")) : Number(scaleCell.replace(/[^0-9.]/g, ""))) : null;
      const name = rest.filter((cell) => cell !== type && cell !== access && cell !== unit && cell !== scaleCell && !/^\d+$/.test(cell)).join(" ").replace(/[^\w\s%°/().-]/g, "").trim().slice(0, 60);
      if (!name || !/[A-Za-z]{3}/.test(name)) continue;
      const kind = type ? ({ real: "float32", float: "float32", word: "uint16", dword: "uint32", bit: "bool", boolean: "bool" }[type.toLowerCase()] || type.toLowerCase()) : null;
      registers.push({ address, table: rowTable, type: kind, access: access && /w/i.test(access) ? "read-write" : "read", unit: unit || null, scale, name, page, quote: line.slice(0, 400), written: first });
      add({ field: `register.${rowTable || "unknown"}.${address}`, label: `Register ${first}${rowTable ? ` (${rowTable})` : ""}: ${name}`, value: address, found: first, confidence: rowTable && kind ? "medium" : "low", page, quote: line.slice(0, 400) });
    }
  }
  return { facts, registers };
}

/** A profile built only from what was found. Returns { profile, notes } or { profile: null, missing }. */
function propose(facts, registers, name) {
  const value = (field) => facts.find((fact) => fact.field === field)?.value;
  const found = [...new Set(facts.filter((fact) => fact.field === "protocol").map((fact) => fact.value))];
  const usable = found.filter((id) => Object.hasOwn(profiles.ADAPTERS, id));
  const notes = [];
  const model = value("identity.model") || squash(String(name || "").replace(/\.[^.]+$/, "")).slice(0, 60) || "Unknown model";
  const manufacturer = value("identity.manufacturer") || "Unknown maker";
  if (!value("identity.model")) notes.push("The model wasn't stated in a form HANNAH recognises; the file name is used.");
  const constraints = facts.filter((fact) => fact.field === "safety").slice(0, 8).map((fact) => String(fact.value).slice(0, 300));
  const base = {
    format: 1, id: `user.manual.${slug(`${manufacturer}_${model}`).replace(/_/g, "-") || "device"}`, version: "0.1.0", name: `${model} (from its manual)`, author: "Proposed by HANNAH from a document", manufacturer, model,
    revisions: value("identity.revision") ? [String(value("identity.revision"))] : [], category: "other", domain: "iot", permissions: ["network-local"], dependencies: [], constraints,
    tests: { level: "unit", passed: 0, total: 0, evidence: "" }, documentation: "Proposed from a document. Every value needs checking against the device before it is trusted.",
  };
  const adapter = usable.includes("modbus-tcp") && registers.length ? "modbus-tcp" : usable.includes("mqtt") ? "mqtt" : usable[0] || null;
  if (adapter === "modbus-tcp") {
    const used = new Set();
    const points = [];
    for (const register of registers) {
      if (!register.table) { notes.push(`Register ${register.written} (${register.name}): the manual doesn't say which table it is in (holding, input, coil), so it is left out.`); continue; }
      const bits = ["coil", "discrete"].includes(register.table);
      let id = slug(register.name) || `register_${register.address}`;
      while (used.has(id)) id = `${id.slice(0, 34)}_${register.address}`;
      used.add(id);
      const point = { id, name: register.name, kind: "sensor", type: bits ? "boolean" : "number", access: "read", ...(register.unit && !bits ? { unit: register.unit } : {}), binding: { register: { table: register.table, address: register.address, ...(bits ? {} : { type: register.type && register.type !== "bool" ? register.type : "uint16" }), ...(register.scale && !bits ? { scale: register.scale } : {}) } } };
      if (!register.type && !bits) notes.push(`${register.name}: the manual gives no data type; a 16-bit unsigned number is assumed. Check it.`);
      if (register.access === "read-write") notes.push(`${register.name}: the manual marks it writable. It is proposed read-only: ${bits ? "allow changing it yourself in the Hardware Studio once you have checked what it switches" : "give its allowed range in the Hardware Studio to let HANNAH change it"}.`);
      points.push(point);
    }
    if (points.length) {
      return { profile: { ...base, domain: "industrial", category: "industrial-sensor", constraints: constraints.length ? constraints : ["Modbus has no sign-in or encryption: anything on the same network can write to this device."], protocol: { adapter, version: "1.1b3" },
        connection: { instructions: ["Connect the device to the same network as the hub.", "Enter its address. The port and unit number below come from the manual: check them."], fields: [
          { id: "host", label: "Device address", type: "text", required: true, ...(value("network.address") ? { default: value("network.address") } : {}) },
          { id: "port", label: "Port", type: "number", default: value("network.port") || 502, min: 1, max: 65535 },
          { id: "unit", label: "Unit number", type: "number", default: value("modbus.unit") ?? 1, min: 0, max: 255 },
        ] }, points }, notes };
    }
  }
  if (adapter === "mqtt") {
    const topics = facts.filter((fact) => fact.field === "mqtt.topic" && !/[+#<>{}%]/.test(fact.value)).slice(0, 24);
    const used = new Set();
    const points = topics.map((fact) => { let id = slug(fact.value.split("/").slice(-2).join("_")) || "topic"; while (used.has(id)) id = `${id.slice(0, 36)}_${used.size}`; used.add(id); return { id, name: fact.value, kind: "sensor", type: "text", access: "read", binding: { state: { topic: fact.value } } }; });
    if (points.length) {
      notes.push("Each topic is proposed as plain text, read-only. In the Hardware Studio, say which are numbers or switches, and which field of the message to use.");
      return { profile: { ...base, protocol: { adapter, version: "3.1.1" }, connection: { instructions: ["Connect the device to your MQTT broker as its manual describes.", "Enter the broker's address."], fields: [
        { id: "host", label: "Broker address", type: "text", required: true }, { id: "port", label: "Port", type: "number", default: value("network.port") || 1883, min: 1, max: 65535 },
        { id: "username", label: "User name", type: "text" }, { id: "password", label: "Password", type: "secret" }, { id: "tls", label: "Encrypted (TLS)", type: "toggle", default: false },
      ] }, points }, notes };
    }
  }
  const notBuilt = found.filter((id) => Object.hasOwn(profiles.NOT_BUILT, id));
  const missing = [];
  if (!found.length) missing.push("The document doesn't name a protocol HANNAH recognises.");
  for (const id of notBuilt) missing.push(profiles.NOT_BUILT[id]);
  if (usable.includes("modbus-tcp") && !registers.length) missing.push("It mentions Modbus TCP, and no register table could be read from it.");
  if (usable.includes("mqtt") && adapter === "mqtt") missing.push("It mentions MQTT, and no exact topic could be read from it.");
  if (usable.includes("http") && adapter === "http") missing.push("It mentions an HTTP API. Describe its paths in the Hardware Studio; they can't be worked out from prose.");
  return { profile: null, notes, missing, request: { manufacturer, model, protocolsFound: found, needs: missing } };
}

/** Read a manual and say what it supports. Nothing is stored. */
async function analyze({ name, buffer, suggest = null }) {
  const mediaType = imageType(buffer);
  if (mediaType) {
    const source = { id: crypto.createHash("sha256").update(buffer).digest("hex"), name: String(name || "image").slice(0, 120), mediaType, bytes: buffer.length };
    return {
      document: { name: source.name, kind: "image", pages: 1, pagesWithText: 0, source, notes: ["Image received as source evidence. HANNAH has no image or diagram reader configured, so it did not extract text, wiring, pin assignments or ratings."] },
      facts: [], proposal: null,
      missing: ["No vision reader is configured for this image. Check the label or diagram yourself, then enter the verified connection details in the Hardware Studio."],
      request: null,
      reminder: "This image has not been interpreted. No electrical, wiring or device value was inferred from it.",
    };
  }
  const read = await readFile(buffer, name, { maxText: 2_000_000 });
  const pages = pagesOf(read);
  const { facts, registers } = extract(pages);
  // Each fact is checked against the document the same way a suggestion would be: a pattern that misquotes is a bug, and is dropped rather than shown.
  const kept = facts.filter((fact) => supported(pages, fact));
  // Optional model assistance: a model may suggest facts, but only those the evidence gate accepts are kept. The model never bypasses the gate.
  if (typeof suggest === "function") {
    try {
      const suggested = await suggest(pages.map((page) => `## Page ${page.page}\n${page.lines.join("\n")}`).join("\n\n"));
      const { accepted } = accept(pages, Array.isArray(suggested) ? suggested : suggested?.facts || []);
      for (const fact of accepted) { if (!kept.some((item) => item.field === fact.field && item.value === fact.value && item.page === fact.page)) kept.push(fact); }
    } catch (_error) { /* model assistance is optional; the pattern-based reading still stands */ }
  }
  const quoted = new Set(kept.filter((fact) => fact.field.startsWith("register.")).map((fact) => `${fact.page}|${fact.quote}`));
  const proposal = propose(kept, registers.filter((register) => quoted.has(`${register.page}|${register.quote}`)), name);
  const problems = proposal.profile ? profiles.validateProfile(proposal.profile) : [];
  const profile = proposal.profile && !problems.length ? proposal.profile : null;
  return {
    document: { name: String(name || "document").slice(0, 120), kind: read.kind, pages: read.kind === "pdf" ? read.coverage?.total ?? pages.length : pages.length, pagesWithText: pages.filter((page) => page.lines.length).length, notes: read.coverage?.notes || [] },
    facts: kept.map(({ shown, found: _found, ...fact }) => ({ ...fact, ...(shown ? { shown } : {}), ...(fact.hazardous ? { note: "For a qualified person to check against the device's own rating plate before any wiring. HANNAH does not use this value." } : {}) })),
    proposal: profile ? { profile, public: profiles.publicProfile(profile), compatibility: profiles.compatibility(profile, { source: "manual" }), notes: proposal.notes } : null,
    missing: profile ? [] : [...(proposal.missing || []), ...problems],
    request: profile ? null : proposal.request || null,
    reminder: "Everything here was read from the document and is unverified. Check each value you rely on. The device still has to be reached by your hub and switched on by you.",
  };
}

/** The evidence kept beside a saved profile: where each value came from. */
const evidenceOf = (analysis, confirmed = []) => ({
  document: analysis.document,
  facts: analysis.facts.map(({ id, field, label, value, page, quote, confidence, method, hazardous, ...rest }) => {
    const base = { field, label, value, page, quote, confidence, ...(hazardous ? { hazardous: true } : {}), state: confirmed.includes(id) ? "confirmed by you" : "unverified" };
    // Preserve the source method (pattern or model) for transparency
    if (method) { base.method = method; }
    // Add a note if the fact came from a model and is still unverified
    if (method === "model" && base.state === "unverified") {
      base.note = "Model suggestion: verify this value against the device before relying on it. The evidence gate ensures the quote appears on the cited page, but the device has not been reached or switched on.";
    }
    return { ...base, ...rest };
  }),
});

function decode(body) {
  const name = String(body?.name || "").slice(0, 200);
  const data = typeof body?.data === "string" ? body.data : "";
  if (!name || !data) throw fail(400, "Send the document's name and its contents.", "bad-request");
  if (data.length > 28_000_000) throw fail(413, "Documents up to 20 MB can be read.", "too-large");
  return { name, buffer: Buffer.from(data, "base64") };
}

/** Routes, added to the device router: POST /devices/manuals (read one) and POST /devices/manuals/save (keep a proposal with its evidence). */
function manualRoutes({ devices, suggest = null }) {
  return (router, { person }) => {
    const big = require("express").json({ limit: "30mb" });
    router.post("/devices/manuals", big, person(async (req, res) => res.json(await analyze({ ...decode(req.body), suggest }))));
    router.post("/devices/manuals/save", big, person(async (req, res, db, account) => {
      // The document is read again here, so the evidence kept is what the server found, not what a client says it found.
      const analysis = await analyze(decode(req.body));
      const profile = req.body?.profile && typeof req.body.profile === "object" ? req.body.profile : analysis.proposal?.profile;
      if (!profile) throw fail(400, "There is no device description to keep. Build one in the Hardware Studio.", "no-proposal");
      const saved = await devices.saveProfile(db, account.id, { ...profile, permissions: ["network-local"] }, { source: "manual", evidence: evidenceOf(analysis, Array.isArray(req.body?.confirmed) ? req.body.confirmed.map(String) : []) });
      res.status(201).json({ profile: saved });
    }));
  };
}

module.exports = { accept, analyze, evidenceOf, extract, manualRoutes, pagesOf, propose, supported };
