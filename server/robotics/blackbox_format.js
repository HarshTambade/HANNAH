"use strict";

/**
 * Reads a robot's black box segment (HBX version 1), the format written by
 * robotics/runtime/hannah_robot/blackbox/format.py and by HANNAH Robot OS:
 * JSON Lines with a header, records and a footer whose sha256 covers every
 * byte before it. A closed segment whose checksum doesn't match is refused; an
 * unclosed one (the robot lost power) is read and marked unverified.
 */
const crypto = require("node:crypto");
const zlib = require("node:zlib");

const MAGIC = "hannah-blackbox";
const VERSION = 1;
const MAX_INFLATED = 64 * 1024 * 1024;

const fail = (message) => Object.assign(new Error(message), { status: 400, reason: "bad-segment" });

function readSegment(buffer) {
  let raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || "");
  if (raw[0] === 0x1f && raw[1] === 0x8b) {
    try { raw = zlib.gunzipSync(raw, { maxOutputLength: MAX_INFLATED }); } catch { throw fail("The compressed segment is damaged or too large."); }
  }
  const lines = [];
  let start = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] === 0x0a) { lines.push(raw.subarray(start, index)); start = index + 1; }
  }
  if (start < raw.length) lines.push(raw.subarray(start));
  if (!lines.length || !lines[0].length) throw fail("The segment is empty.");
  let header;
  try { header = JSON.parse(lines[0].toString("utf8")); } catch { throw fail("The segment has no readable header."); }
  if (!header || header.format !== MAGIC) throw fail("Not a HANNAH black box segment.");
  if (header.version !== VERSION) throw fail(`Segment version ${header.version} isn't supported.`);
  const digest = crypto.createHash("sha256").update(lines[0]).update("\n");
  const records = [];
  let footer = null;
  let truncated = false;
  const body = lines.slice(1);
  for (let index = 0; index < body.length; index += 1) {
    const line = body[index];
    if (!line.length) continue;
    let value;
    try { value = JSON.parse(line.toString("utf8")); } catch {
      // Only the last line may be cut short (power lost while writing).
      if (index >= body.length - 2) { truncated = true; break; }
      throw fail(`Line ${index + 2} of the segment is not JSON.`);
    }
    if (value && value.footer === true) { footer = value; break; }
    digest.update(line).update("\n");
    if (value && typeof value === "object") records.push(value);
  }
  const info = { closed: Boolean(footer), truncated, verified: false, records: records.length };
  if (footer) {
    info.verified = footer.sha256 === digest.digest("hex") && footer.records === records.length;
    if (!info.verified) throw fail("The segment's checksum doesn't match: it was changed or damaged after it was closed.");
    info.closedAt = Number(footer.closedAt) || null;
  }
  return { header, records, info, bytes: raw.length };
}

module.exports = { MAGIC, VERSION, readSegment };
