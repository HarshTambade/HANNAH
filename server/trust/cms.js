"use strict";

/**
 * Detached CMS SignedData (RFC 5652) in S/MIME form (RFC 8551), the format of
 * a DDS Security governance.p7s and permissions.p7s.
 *
 * It reproduces what sros2 produces with OpenSSL's PKCS7_sign(DETACHED | TEXT):
 * the signed content is the MIME entity "Content-Type: text/plain" + blank
 * line + the document with CRLF line ends, the signer is the permissions CA,
 * and the signed attributes are contentType, signingTime and messageDigest.
 * A DDS implementation reads it with SMIME_read_PKCS7 and PKCS7_verify(TEXT).
 */
const crypto = require("node:crypto");
const asn1 = require("./asn1");

const OID = {
  data: "1.2.840.113549.1.7.1",
  signedData: "1.2.840.113549.1.7.2",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingTime: "1.2.840.113549.1.9.5",
  sha256: "2.16.840.1.101.3.4.2.1",
  ecdsaWithSHA256: "1.2.840.10045.4.3.2",
};

/** CRLF line ends, as S/MIME canonicalizes text before signing. */
const canonical = (text) => Buffer.from(String(text).replace(/\r?\n/g, "\r\n"), "utf8");
/** The entity PKCS7_TEXT signs: a text/plain header, a blank line, the content. */
const textEntity = (content) => Buffer.concat([Buffer.from("Content-Type: text/plain\r\n\r\n", "ascii"), canonical(Buffer.isBuffer(content) ? content.toString("utf8") : content)]);

/** The issuer Name and serial INTEGER inside a certificate's DER, by walking its first levels. */
function issuerAndSerial(certificateDer) {
  const read = (buffer, offset) => {
    const first = buffer[offset + 1];
    const lengthBytes = first & 0x80 ? first & 0x7f : 0;
    const size = lengthBytes ? buffer.subarray(offset + 2, offset + 2 + lengthBytes).reduce((sum, byte) => sum * 256 + byte, 0) : first;
    const header = 2 + lengthBytes;
    return { start: offset, contentStart: offset + header, end: offset + header + size };
  };
  const cert = read(certificateDer, 0);
  const tbs = read(certificateDer, cert.contentStart);
  let at = tbs.contentStart;
  const items = [];
  while (at < tbs.end && items.length < 4) { const item = read(certificateDer, at); items.push(certificateDer.subarray(item.start, item.end)); at = item.end; }
  // version [0], serial, signature algorithm, issuer
  const [, serial, , issuer] = items[0][0] === 0xa0 ? items : [null, ...items];
  return asn1.sequence(issuer, serial);
}

/**
 * Sign `content` (string or Buffer) with the certificate's private key.
 * Returns the S/MIME text (multipart/signed) to write to a .p7s file.
 */
function signSmime(content, { certificatePem, privateKey, at = Date.now() }) {
  const certificateDer = new crypto.X509Certificate(certificatePem).raw;
  const signed = textEntity(content);
  const attributes = [
    asn1.sequence(asn1.oid(OID.contentType), asn1.set(asn1.oid(OID.data))),
    asn1.sequence(asn1.oid(OID.signingTime), asn1.set(asn1.time(at))),
    asn1.sequence(asn1.oid(OID.messageDigest), asn1.set(asn1.octetString(crypto.createHash("sha256").update(signed).digest()))),
  ];
  const attributeSet = asn1.set(...attributes);
  const signature = crypto.sign("sha256", attributeSet, privateKey);
  const signerInfo = asn1.sequence(
    asn1.integer(1),
    issuerAndSerial(certificateDer),
    asn1.sequence(asn1.oid(OID.sha256)),
    asn1.implicitConstructed(0, asn1.contentOf(attributeSet)),
    asn1.sequence(asn1.oid(OID.ecdsaWithSHA256)),
    asn1.octetString(signature),
  );
  const signedData = asn1.sequence(
    asn1.integer(1),
    asn1.set(asn1.sequence(asn1.oid(OID.sha256))),
    asn1.sequence(asn1.oid(OID.data)),
    asn1.implicitConstructed(0, certificateDer),
    asn1.set(signerInfo),
  );
  const der = asn1.sequence(asn1.oid(OID.signedData), asn1.explicit(0, signedData));
  const boundary = `----${crypto.randomBytes(16).toString("hex").toUpperCase()}`;
  const base64 = der.toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n$/, "");
  // The part's content is everything between its blank line and the line break before the next boundary: the document exactly.
  const body = String(Buffer.isBuffer(content) ? content.toString("utf8") : content).replace(/\r?\n/g, "\n");
  return [
    "MIME-Version: 1.0",
    `Content-Type: multipart/signed; protocol="application/x-pkcs7-signature"; micalg="sha-256"; boundary="${boundary}"`,
    "",
    "This is an S/MIME signed message",
    "",
    `--${boundary}`,
    "Content-Type: text/plain",
    "",
    body,
    `--${boundary}`,
    'Content-Type: application/x-pkcs7-signature; name="smime.p7s"',
    "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="smime.p7s"',
    "",
    base64,
    "",
    `--${boundary}--`,
    "",
  ].join("\n");
}

module.exports = { OID, canonical, signSmime, textEntity };
