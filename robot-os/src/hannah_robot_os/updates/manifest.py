from __future__ import annotations

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


def verify_manifest(manifest: UpdateManifest, artifact_path: str | Path, trusted_signers: set[str] | None = None) -> None:
    p = Path(artifact_path)
    if not p.exists():
        raise FileNotFoundError(f"artifact not found: {p}")
    if trusted_signers is not None and manifest.signer not in trusted_signers:
        raise ValueError("untrusted signer")
    if len(manifest.sha256) != 64:
        raise ValueError("invalid sha256")
    if manifest.size_bytes != p.stat().st_size:
        raise ValueError("artifact size mismatch")
    digest = sha256_file(p)
    if digest != manifest.sha256:
        raise ValueError("artifact hash mismatch")
    # Signature verification is placeholder until production signing keys/HSM are integrated.
    if not manifest.signature or manifest.signature == "UNSIGNED":
        raise ValueError("manifest signature missing")
