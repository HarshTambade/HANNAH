"""Ed25519 (RFC 8032) in plain Python, for checking update package signatures.

Robot OS has no third-party Python dependencies, so the verification the
update path needs is here, written from the RFC's reference algorithm. It is
not constant-time; it only ever handles public data (a public key, a
signature, a manifest). `sign` exists for tests and tools, never for keys
that matter.

Tested against the RFC 8032 test vectors and against signatures made by
Node's crypto module (tests/unit/test_update_package.py).
"""
from __future__ import annotations

import base64
import hashlib

P = 2**255 - 19
L = 2**252 + 27742317777372353535851937790883648493
D = -121665 * pow(121666, P - 2, P) % P
SQRT_M1 = pow(2, (P - 1) // 4, P)
# DER prefix of an Ed25519 SubjectPublicKeyInfo: SEQUENCE { SEQUENCE { OID 1.3.101.112 } BIT STRING (32 bytes) }
SPKI_PREFIX = bytes.fromhex("302a300506032b6570032100")


def _inv(x: int) -> int:
    return pow(x, P - 2, P)


def _recover_x(y: int, sign: int) -> int | None:
    if y >= P:
        return None
    x2 = (y * y - 1) * _inv(D * y * y + 1) % P
    if x2 == 0:
        return None if sign else 0
    x = pow(x2, (P + 3) // 8, P)
    if (x * x - x2) % P:
        x = x * SQRT_M1 % P
    if (x * x - x2) % P:
        return None
    if (x & 1) != sign:
        x = P - x
    return x


def _add(a: tuple, b: tuple) -> tuple:
    A = (a[1] - a[0]) * (b[1] - b[0]) % P
    B = (a[1] + a[0]) * (b[1] + b[0]) % P
    C = 2 * a[3] * b[3] * D % P
    Dd = 2 * a[2] * b[2] % P
    E, F, G, H = B - A, Dd - C, Dd + C, B + A
    return (E * F % P, G * H % P, F * G % P, E * H % P)


def _mul(scalar: int, point: tuple) -> tuple:
    result = (0, 1, 1, 0)
    while scalar > 0:
        if scalar & 1:
            result = _add(result, point)
        point = _add(point, point)
        scalar >>= 1
    return result


def _equal(a: tuple, b: tuple) -> bool:
    return (a[0] * b[2] - b[0] * a[2]) % P == 0 and (a[1] * b[2] - b[1] * a[2]) % P == 0


_GY = 4 * _inv(5) % P
_GX = _recover_x(_GY, 0)
BASE = (_GX, _GY, 1, _GX * _GY % P)


def _compress(point: tuple) -> bytes:
    zinv = _inv(point[2])
    x, y = point[0] * zinv % P, point[1] * zinv % P
    return int.to_bytes(y | ((x & 1) << 255), 32, "little")


def _decompress(data: bytes) -> tuple | None:
    if len(data) != 32:
        return None
    y = int.from_bytes(data, "little")
    sign = y >> 255
    y &= (1 << 255) - 1
    x = _recover_x(y, sign)
    if x is None:
        return None
    return (x, y, 1, x * y % P)


def _hash_mod_l(data: bytes) -> int:
    return int.from_bytes(hashlib.sha512(data).digest(), "little") % L


def _expand(secret: bytes) -> tuple[int, bytes]:
    if len(secret) != 32:
        raise ValueError("an Ed25519 secret key is 32 bytes")
    digest = hashlib.sha512(secret).digest()
    scalar = int.from_bytes(digest[:32], "little")
    scalar &= (1 << 254) - 8
    scalar |= 1 << 254
    return scalar, digest[32:]


def public_key(secret: bytes) -> bytes:
    scalar, _ = _expand(secret)
    return _compress(_mul(scalar, BASE))


def sign(secret: bytes, message: bytes) -> bytes:
    scalar, prefix = _expand(secret)
    public = _compress(_mul(scalar, BASE))
    r = _hash_mod_l(prefix + message)
    encoded_r = _compress(_mul(r, BASE))
    h = _hash_mod_l(encoded_r + public + message)
    return encoded_r + int.to_bytes((r + h * scalar) % L, 32, "little")


def verify(public: bytes, message: bytes, signature: bytes) -> bool:
    if len(public) != 32 or len(signature) != 64:
        return False
    point_a = _decompress(public)
    if point_a is None:
        return False
    encoded_r = signature[:32]
    point_r = _decompress(encoded_r)
    if point_r is None:
        return False
    s = int.from_bytes(signature[32:], "little")
    if s >= L:
        return False
    h = _hash_mod_l(encoded_r + public + message)
    return _equal(_mul(s, BASE), _add(point_r, _mul(h, point_a)))


def public_key_from_pem(pem: str) -> bytes:
    """The 32 raw bytes of an Ed25519 public key in SPKI PEM form."""
    lines = [line.strip() for line in str(pem).strip().splitlines()]
    if not lines or lines[0] != "-----BEGIN PUBLIC KEY-----" or lines[-1] != "-----END PUBLIC KEY-----":
        raise ValueError("not a PEM public key")
    der = base64.b64decode("".join(lines[1:-1]), validate=True)
    if len(der) != len(SPKI_PREFIX) + 32 or not der.startswith(SPKI_PREFIX):
        raise ValueError("not an Ed25519 public key")
    return der[len(SPKI_PREFIX):]


def key_id(public: bytes) -> str:
    """HANNAH's id for a key: the start of the SHA-256 of its SPKI DER (as server/robotics/packages.js keyIdOf)."""
    return hashlib.sha256(SPKI_PREFIX + public).hexdigest()[:16]
