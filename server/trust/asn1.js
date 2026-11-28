"use strict";

/**
 * The little DER (ITU-T X.690) HANNAH needs to write X.509 certificates and
 * CMS signatures with node:crypto, which can parse certificates but can't make
 * them. Only encoding: everything read back is parsed by OpenSSL through
 * crypto.X509Certificate, never by this file.
 */

function length(size) {
  if (size < 0x80) return Buffer.from([size]);
  const bytes = [];
  for (let rest = size; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** One TLV. `tag` is the full identifier octet. */
const tlv = (tag, content) => {
  const body = Buffer.isBuffer(content) ? content : Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
};

const sequence = (...items) => tlv(0x30, items.flat());
/** A SET OF in DER order: elements sorted by their encodings (X.690 11.6). */
const set = (...items) => tlv(0x31, items.flat().sort(Buffer.compare));
const nullValue = () => Buffer.from([0x05, 0x00]);
const boolean = (value) => tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
const octetString = (bytes) => tlv(0x04, Buffer.from(bytes));
const utf8 = (text) => tlv(0x0c, Buffer.from(String(text), "utf8"));
const printable = (text) => tlv(0x13, Buffer.from(String(text), "ascii"));
const ia5 = (text) => tlv(0x16, Buffer.from(String(text), "ascii"));

/** A non-negative INTEGER from a Buffer (big-endian) or a safe number. */
function integer(value) {
  let bytes;
  if (Buffer.isBuffer(value)) bytes = Buffer.from(value);
  else {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("integer() takes a non-negative safe integer or a Buffer.");
    const out = [];
    for (let rest = value; rest > 0; rest = Math.floor(rest / 256)) out.unshift(rest & 0xff);
    bytes = Buffer.from(out.length ? out : [0]);
  }
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0 && bytes[start + 1] < 0x80) start += 1;
  bytes = bytes.subarray(start);
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return tlv(0x02, bytes);
}

function oid(dotted) {
  const parts = String(dotted).split(".").map(Number);
  if (parts.length < 2 || parts.some((part) => !Number.isSafeInteger(part) || part < 0)) throw new Error(`Bad object identifier ${dotted}`);
  const out = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const chunk = [];
    let rest = part;
    do { chunk.unshift(rest & 0x7f); rest = Math.floor(rest / 128); } while (rest > 0);
    for (let index = 0; index < chunk.length - 1; index += 1) chunk[index] |= 0x80;
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

/** A BIT STRING whose content is whole bytes (keys, signatures). */
const bitString = (bytes) => tlv(0x03, Buffer.concat([Buffer.from([0]), Buffer.from(bytes)]));

/** A named-bit BIT STRING (keyUsage): bit 0 is the most significant bit of the first byte; trailing zero bits are dropped (X.690 11.2.2). */
function namedBits(bits) {
  if (!bits.length) return tlv(0x03, Buffer.from([0]));
  const top = Math.max(...bits);
  const bytes = Buffer.alloc(Math.floor(top / 8) + 1);
  for (const bit of bits) bytes[Math.floor(bit / 8)] |= 0x80 >> (bit % 8);
  const unused = 7 - (top % 8);
  return tlv(0x03, Buffer.concat([Buffer.from([unused]), bytes]));
}

/** UTCTime before 2050, GeneralizedTime from then on (RFC 5280 4.1.2.5). */
function time(at) {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) throw new Error("Bad time");
  const pad = (value) => String(value).padStart(2, "0");
  const rest = `${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  const year = date.getUTCFullYear();
  if (year >= 1950 && year < 2050) return tlv(0x17, Buffer.from(`${pad(year % 100)}${rest}`, "ascii"));
  return tlv(0x18, Buffer.from(`${String(year).padStart(4, "0")}${rest}`, "ascii"));
}

/** [n] EXPLICIT: a constructed context tag around a complete encoding. */
const explicit = (number, inner) => tlv(0xa0 | number, inner);
/** [n] IMPLICIT, constructed (replaces a SEQUENCE/SET tag). */
const implicitConstructed = (number, content) => tlv(0xa0 | number, content);
/** [n] IMPLICIT, primitive (replaces a string tag). */
const implicitPrimitive = (number, bytes) => tlv(0x80 | number, Buffer.from(bytes));

/** The content octets of a TLV that starts at offset 0 (used to re-tag a SET as [0]). */
function contentOf(encoded) {
  const first = encoded[1];
  const lengthBytes = first & 0x80 ? 1 + (first & 0x7f) : 1;
  return encoded.subarray(1 + lengthBytes);
}

module.exports = { bitString, boolean, contentOf, explicit, ia5, implicitConstructed, implicitPrimitive, integer, namedBits, nullValue, octetString, oid, printable, sequence, set, time, tlv, utf8 };
