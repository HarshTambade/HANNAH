from __future__ import annotations

import base64
import binascii
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass
class UpdateManifest:
    version: str
    build: str
    artifact: str
    sha256: str
    size_bytes: int
    signature: str
    signer: str
    rollback_version: str | None = None

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "UpdateManifest":
        required = ["version", "build", "artifact", "sha256", "size_bytes", "signature", "signer"]
        for k in required:
            if k not in data:
                raise ValueError(f"missing manifest field: {k}")
        return UpdateManifest(
            version=str(data["version"]),
            build=str(data["build"]),
            artifact=str(data["artifact"]),
            sha256=str(data["sha256"]).lower(),
            size_bytes=int(data["size_bytes"]),
            signature=str(data["signature"]),
            signer=str(data["signer"]),
            rollback_version=str(data["rollback_version"]) if data.get("rollback_version") else None,
        )

    @staticmethod
    def load(path: str | Path) -> "UpdateManifest":
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("manifest must be JSON object")
        return UpdateManifest.from_dict(data)


def sha256_file(path: str | Path) -> str:
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def signed_bytes(manifest: UpdateManifest) -> bytes:
    """What the release signature covers: every field but the signature, canonical JSON."""
    from .package import canonical

    fields = {key: value for key, value in manifest.__dict__.items() if key != "signature" and value is not None}
    return canonical(fields).encode("utf-8")


def sign_manifest(manifest: UpdateManifest, secret: bytes) -> str:
    from . import ed25519

    return base64.b64encode(ed25519.sign(secret, signed_bytes(manifest))).decode("ascii")


def verify_manifest(manifest: UpdateManifest, artifact_path: str | Path, trusted_signers: dict[str, bytes] | None = None) -> None:
    """Size, SHA-256 and the Ed25519 release signature by a trusted signer.

    `trusted_signers` maps a signer name to its 32-byte Ed25519 public key.
    Without it nothing can be trusted, so the manifest is refused.
    """
    from . import ed25519

    p = Path(artifact_path)
    if not p.exists():
        raise FileNotFoundError(f"artifact not found: {p}")
    if not trusted_signers or manifest.signer not in trusted_signers:
        raise ValueError("untrusted signer")
    if len(manifest.sha256) != 64:
        raise ValueError("invalid sha256")
    if manifest.size_bytes != p.stat().st_size:
        raise ValueError("artifact size mismatch")
    digest = sha256_file(p)
    if digest != manifest.sha256:
        raise ValueError("artifact hash mismatch")
    if not manifest.signature or manifest.signature == "UNSIGNED":
        raise ValueError("manifest signature missing")
    try:
        signature = base64.b64decode(manifest.signature, validate=True)
    except (binascii.Error, ValueError):
        raise ValueError("manifest signature isn't base64") from None
    if not ed25519.verify(trusted_signers[manifest.signer], signed_bytes(manifest), signature):
        raise ValueError("manifest signature doesn't verify")
