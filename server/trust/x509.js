"use strict";

/**
 * X.509 v3 certificates (RFC 5280) made with node:crypto.
 *
 * Node can verify and parse certificates (crypto.X509Certificate) but has no
 * API that makes one, so the TBSCertificate is written here in DER and signed
 * with crypto.sign. Keys are ECDSA P-256 (prime256v1) and signatures
 * ecdsa-with-SHA256: what DDS Security's PKI-DH plugin requires (DDS Security
 * 1.1, 9.3.1) and what every TLS stack accepts. Every certificate made here is
 * parsed back by OpenSSL through crypto.X509Certificate before it is returned,
 * so a malformed encoding fails at once instead of on a robot.
 */
const crypto = require("node:crypto");
const asn1 = require("./asn1");

const OID = {
  ecdsaWithSHA256: "1.2.840.10045.4.3.2",
  commonName: "2.5.4.3",
  organization: "2.5.4.10",
  organizationalUnit: "2.5.4.11",
  serialNumber: "2.5.4.5",
  subjectKeyIdentifier: "2.5.29.14",
  keyUsage: "2.5.29.15",
  subjectAltName: "2.5.29.17",
  basicConstraints: "2.5.29.19",
  authorityKeyIdentifier: "2.5.29.35",
  extKeyUsage: "2.5.29.37",
  serverAuth: "1.3.6.1.5.5.7.3.1",
  clientAuth: "1.3.6.1.5.5.7.3.2",
};
const KEY_USAGE_BITS = { digitalSignature: 0, nonRepudiation: 1, keyEncipherment: 2, dataEncipherment: 3, keyAgreement: 4, keyCertSign: 5, cRLSign: 6 };
const NAME_ATTRIBUTES = [["CN", OID.commonName], ["O", OID.organization], ["OU", OID.organizationalUnit], ["serialNumber", OID.serialNumber]];

const algorithm = () => asn1.sequence(asn1.oid(OID.ecdsaWithSHA256));

/**
 * A distinguished name from { CN, O, OU, serialNumber } in that order. Text is
 * UTF8String, serialNumber PrintableString (RFC 5280 appendix A).
 */
function name(fields = {}) {
  const parts = [];
  for (const [key, id] of NAME_ATTRIBUTES) {
    if (fields[key] === undefined || fields[key] === null || fields[key] === "") continue;
    const value = key === "serialNumber" ? asn1.printable(String(fields[key]).replace(/[^A-Za-z0-9 '()+,./:=?-]/g, "-")) : asn1.utf8(fields[key]);
    parts.push(asn1.set(asn1.sequence(asn1.oid(id), value)));
  }
  if (!parts.length) throw new Error("A certificate name needs at least one field.");
  return asn1.sequence(...parts);
}

/** The text form OpenSSL prints for a name made by name(), e.g. "CN=/hannah/robot_bridge". */
const nameText = (fields = {}) => NAME_ATTRIBUTES.filter(([key]) => fields[key]).map(([key]) => `${key}=${fields[key]}`).join("\n");

const publicKeyObject = (key) => (key instanceof crypto.KeyObject ? (key.type === "private" ? crypto.createPublicKey(key) : key) : crypto.createPublicKey(key));
const spkiOf = (key) => publicKeyObject(key).export({ type: "spki", format: "der" });
/** RFC 5280 4.2.1.2 method 1: SHA-1 of the subjectPublicKey BIT STRING's bytes. */
function keyIdentifier(key) {
  const spki = spkiOf(key);
  // For P-256 the SPKI is SEQUENCE { AlgorithmIdentifier, BIT STRING (0x00 + 65-byte point) }: the point is the last 65 bytes.
  const point = spki.subarray(spki.length - 65);
  return crypto.createHash("sha1").update(point).digest();
}

function extension(id, critical, value) {
  return asn1.sequence(asn1.oid(id), ...(critical ? [asn1.boolean(true)] : []), asn1.octetString(value));
}

/** A random positive 128-bit serial (RFC 5280 4.1.2.2 allows up to 20 octets). */
function randomSerial() {
  const bytes = crypto.randomBytes(16);
  bytes[0] &= 0x7f;
  if (bytes[0] === 0) bytes[0] = 0x01;
  return bytes;
}

/**
 * Make and sign a certificate.
 *   subject, issuer   { CN, O, OU, serialNumber }; issuer defaults to subject (self-signed)
 *   publicKey         the subject's key (KeyObject or PEM)
 *   signingKey        the issuer's private key
 *   issuerPublicKey   the issuer's public key, for the authority key identifier (defaults to the signing key's)
 *   notBefore, notAfter  epoch milliseconds
 *   ca                true: basicConstraints CA with pathLength; false: an end entity
 *   keyUsage          names from KEY_USAGE_BITS; omitted: no keyUsage extension (as sros2 does)
 *   extKeyUsage       ["clientAuth", "serverAuth"]
 *   uris, dnsNames    subjectAltName entries
 * Returns { pem, der, serialHex, certificate (crypto.X509Certificate) }.
 */
function createCertificate({ subject, issuer = null, publicKey, signingKey, issuerPublicKey = null, serial = randomSerial(), notBefore, notAfter, ca = false, pathLength = 0, keyUsage = null, extKeyUsage = null, uris = [], dnsNames = [] }) {
  if (!(notAfter > notBefore)) throw new Error("notAfter must be after notBefore.");
  const subjectKey = publicKeyObject(publicKey);
  if (subjectKey.asymmetricKeyType !== "ec" || subjectKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("Certificates here carry ECDSA P-256 keys only.");
  const authorityKey = issuerPublicKey ? publicKeyObject(issuerPublicKey) : publicKeyObject(signingKey);
  const extensions = [
    extension(OID.basicConstraints, true, ca ? asn1.sequence(asn1.boolean(true), asn1.integer(pathLength)) : asn1.sequence()),
    ...(keyUsage ? [extension(OID.keyUsage, true, asn1.namedBits(keyUsage.map((item) => { if (!(item in KEY_USAGE_BITS)) throw new Error(`Unknown key usage ${item}`); return KEY_USAGE_BITS[item]; })))] : []),
    ...(extKeyUsage?.length ? [extension(OID.extKeyUsage, false, asn1.sequence(...extKeyUsage.map((item) => asn1.oid(OID[item]))))] : []),
    ...(uris.length || dnsNames.length ? [extension(OID.subjectAltName, false, asn1.sequence(...uris.map((uri) => asn1.implicitPrimitive(6, Buffer.from(uri, "ascii"))), ...dnsNames.map((dns) => asn1.implicitPrimitive(2, Buffer.from(dns, "ascii")))))] : []),
    extension(OID.subjectKeyIdentifier, false, asn1.octetString(keyIdentifier(subjectKey))),
    extension(OID.authorityKeyIdentifier, false, asn1.sequence(asn1.implicitPrimitive(0, keyIdentifier(authorityKey)))),
  ];
  const tbs = asn1.sequence(
    asn1.explicit(0, asn1.integer(2)),
    asn1.integer(Buffer.from(serial)),
    algorithm(),
    name(issuer || subject),
    asn1.sequence(asn1.time(notBefore), asn1.time(notAfter)),
    name(subject),
    spkiOf(subjectKey),
    asn1.explicit(3, asn1.sequence(...extensions)),
  );
  const signature = crypto.sign("sha256", tbs, signingKey);
  const der = asn1.sequence(tbs, algorithm(), asn1.bitString(signature));
  const pem = toPem(der, "CERTIFICATE");
  const certificate = new crypto.X509Certificate(pem);
  // The serial as OpenSSL prints it, so a stored serial always compares equal to a parsed certificate's.
  return { pem, der, serialHex: certificate.serialNumber.toUpperCase(), certificate };
}

function toPem(der, label) {
  const body = Buffer.from(der).toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n$/, "");
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

const newKeyPair = () => crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const privatePem = (key) => key.export({ type: "pkcs8", format: "pem" });
const publicPem = (key) => publicKeyObject(key).export({ type: "spki", format: "pem" });

/** The uniform resource identifiers in a parsed certificate's subjectAltName. */
const sanUris = (certificate) => String(certificate.subjectAltName || "").split(/,\s*/).filter((item) => item.startsWith("URI:")).map((item) => item.slice(4));

/** "sha256:AB:CD…" of the DER, the form people compare. */
const fingerprint = (certificate) => certificate.fingerprint256;

module.exports = { KEY_USAGE_BITS, OID, createCertificate, fingerprint, keyIdentifier, name, nameText, newKeyPair, privatePem, publicPem, randomSerial, sanUris, spkiOf, toPem };
