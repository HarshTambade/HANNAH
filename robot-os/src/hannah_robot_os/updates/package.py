"""Signed update packages, checked on the robot before anything is staged.

The manifest is the one HANNAH's server checks (server/robotics/update_packages.js,
schema "hannah-update/1"); the server's word is not taken for it. Before
staging, the robot itself checks:

- the Ed25519 signature over the canonical manifest, with a key pinned in its
  own trusted-keys file (not one the command carries), and that the publisher
  the manifest names is that key's owner;
- that the package is meant for this machine: manufacturer and model (or
  robot type), operating system, ROS distribution, runtime version, and the
  software and firmware versions when the package names them;
- that it isn't firmware (firmware is never staged through this path);
- when the artifact is on disk, its size and SHA-256.

Canonical form: keys sorted, no spaces, strings as JSON writes them, and
numbers as JavaScript prints them (the manifest only allows integers and
plain decimals, so the two languages agree).
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import json
import math
import re
from pathlib import Path
from typing import Any

from . import ed25519

SCHEMA = "hannah-update/1"
_VERSION = re.compile(r"^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]+))?$")


class PackageError(ValueError):
    pass


def canonical(value: Any) -> str:
    if isinstance(value, bool) or value is None:
        return json.dumps(value)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise PackageError("a number in the manifest isn't finite")
        if value.is_integer() and abs(value) < 2**53:
            return str(int(value))
        return repr(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(canonical(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(f"{json.dumps(key, ensure_ascii=False)}:{canonical(value[key])}" for key in sorted(value)) + "}"
    raise PackageError(f"unsupported value in the manifest: {type(value).__name__}")


def signed_bytes(manifest: dict) -> bytes:
    return canonical({key: value for key, value in manifest.items() if key != "signature"}).encode("utf-8")


def load_trusted_keys(path: str | Path) -> dict[str, dict]:
    """A JSON file: [{"owner": "Acme Robotics", "publicKey": "-----BEGIN PUBLIC KEY-----…", "revoked": false}]."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise PackageError("the trusted keys file must be a JSON list")
    keys: dict[str, dict] = {}
    for item in data:
        raw = ed25519.public_key_from_pem(item["publicKey"])
        keys[ed25519.key_id(raw)] = {"owner": str(item["owner"]), "public": raw, "revoked": bool(item.get("revoked", False))}
    return keys


def verify_signature(manifest: dict, trusted_keys: dict[str, dict]) -> dict:
    signature = manifest.get("signature") if isinstance(manifest, dict) else None
    if not isinstance(signature, dict) or signature.get("algorithm") != "ed25519":
        raise PackageError("the manifest isn't signed with Ed25519")
    key = trusted_keys.get(str(signature.get("keyId", "")))
    if key is None:
        raise PackageError("signed with a key this robot doesn't trust")
    if key["revoked"]:
        raise PackageError("signed with a revoked key")
    try:
        value = base64.b64decode(str(signature.get("value", "")), validate=True)
    except (binascii.Error, ValueError):
        raise PackageError("the signature isn't base64") from None
    if not ed25519.verify(key["public"], signed_bytes(manifest), value):
        raise PackageError("the signature doesn't match the manifest")
    if str(manifest.get("publisher", "")).strip().lower() != key["owner"].strip().lower():
        raise PackageError(f"the manifest names publisher {manifest.get('publisher')!r} but the key belongs to {key['owner']!r}")
    return key


def _parse(version: str) -> tuple | None:
    match = _VERSION.match(str(version or "").strip())
    if not match:
        return None
    pre = tuple(match.group(4).split(".")) if match.group(4) else ()
    return (int(match.group(1)), int(match.group(2)), int(match.group(3))), pre


def _compare(a: tuple, b: tuple) -> int:
    if a[0] != b[0]:
        return -1 if a[0] < b[0] else 1
    if a[1] == b[1]:
        return 0
    if not a[1]:
        return 1
    if not b[1]:
        return -1
    for x, y in zip(a[1], b[1]):
        if x == y:
            continue
        xn, yn = x.isdigit(), y.isdigit()
        if xn and yn:
            return -1 if int(x) < int(y) else 1
        if xn != yn:
            return -1 if xn else 1
        return -1 if x < y else 1
    return (len(a[1]) > len(b[1])) - (len(a[1]) < len(b[1]))


def satisfies(version: str, version_range: str) -> bool:
    """The same ranges as server/robotics/semver.js: exact, >= > <= < =, ^, ~, *, joined by spaces and ||."""
    parsed = _parse(version)
    if parsed is None:
        return False
    for alternative in str(version_range or "").split("||"):
        tokens = re.sub(r"(>=|<=|>|<|=)\s+", r"\1", alternative.strip()).split()
        if not tokens:
            return False
        if tokens in (["*"], ["x"]):
            return True
        bounds = []
        for token in tokens:
            match = re.match(r"^(>=|<=|>|<|=|\^|~)?(.+)$", token)
            op, bound = match.group(1) or "=", _parse(match.group(2))
            if bound is None:
                return False
            (major, minor, patch), _ = bound
            if op == "^":
                upper = (major + 1, 0, 0) if major else (0, minor + 1, 0) if minor else (0, 0, patch + 1)
                bounds += [(">=", bound), ("<", (upper, ()))]
            elif op == "~":
                bounds += [(">=", bound), ("<", ((major, minor + 1, 0), ()))]
            else:
                bounds.append((op, bound))
        ok = all({"=": c == 0, ">": c > 0, ">=": c >= 0, "<": c < 0, "<=": c <= 0}[op] for op, bound in bounds for c in [_compare(parsed, bound)])
        if ok and parsed[1]:
            ok = any(bound[1] and bound[0] == parsed[0] for _, bound in bounds)
        if ok:
            return True
    return False


def compatibility(manifest: dict, facts: dict) -> list[str]:
    """Problems that make this package wrong for this robot (empty: it fits)."""
    targets = manifest.get("targets") or {}
    low = lambda value: str(value or "").strip().lower()  # noqa: E731
    problems = []
    hardware = targets.get("hardware") or []
    if not any((low(item.get("manufacturer")) == low(facts.get("manufacturer")) and low(item.get("model")) == low(facts.get("model")) if item.get("manufacturer") else True) and (item.get("robotType") == facts.get("robotType") if item.get("robotType") else True) for item in hardware):
        problems.append(f"made for other hardware; this robot is {facts.get('manufacturer') or '?'} {facts.get('model') or '?'}")
    reported_os = str(facts.get("os") or "")
    def os_ok(item: dict) -> bool:
        if low(item.get("name")) not in low(reported_os):
            return False
        if item.get("versions") and not any(re.search(rf"(^|[^0-9.]){re.escape(version)}([^0-9]|$)", reported_os) for version in item["versions"]):
            return False
        if item.get("range"):
            rest = reported_os[low(reported_os).index(low(item["name"])) + len(item["name"]):]
            found = re.search(r"(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)", rest)
            if not found or not satisfies(found.group(1), item["range"]):
                return False
        return True
    if not any(os_ok(item) for item in targets.get("os") or []):
        problems.append(f"not for this operating system ({reported_os or 'unknown'})")
    ros = targets.get("ros") or []
    if ros and low(facts.get("rosDistro")) not in ros:
        problems.append(f"needs ROS 2 {', '.join(ros)}; this robot has {facts.get('rosDistro') or 'no ROS'}")
    if not satisfies(str(facts.get("runtimeVersion") or ""), str(targets.get("runtime") or "")):
        problems.append(f"needs runtime {targets.get('runtime')}; this robot runs {facts.get('runtimeVersion') or 'unknown'}")
    if targets.get("software") and not satisfies(str(facts.get("softwareVersion") or ""), targets["software"]):
        problems.append(f"needs software {targets['software']}; this robot has {facts.get('softwareVersion') or 'unknown'}")
    if targets.get("firmware") and facts.get("firmwareVersion") not in targets["firmware"]:
        problems.append(f"tested with firmware {', '.join(targets['firmware'])}; this robot has {facts.get('firmwareVersion') or 'unknown'}")
    return problems


def check_artifact(manifest: dict, folder: str | Path) -> None:
    for item in manifest.get("artifacts") or []:
        path = Path(folder) / str(item["path"])
        if ".." in Path(str(item["path"])).parts or Path(str(item["path"])).is_absolute():
            raise PackageError("an artifact path leaves the package")
        if not path.exists():
            raise PackageError(f"artifact missing: {item['path']}")
        if path.stat().st_size != int(item["size"]):
            raise PackageError(f"artifact size mismatch: {item['path']}")
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != str(item["sha256"]).lower():
            raise PackageError(f"artifact hash mismatch: {item['path']}")


def verify_package(manifest: dict, trusted_keys: dict[str, dict], facts: dict, artifact_dir: str | Path | None = None) -> dict:
    """Everything the robot checks before staging. Raises PackageError with the first reason it refuses."""
    if not isinstance(manifest, dict) or manifest.get("schema") != SCHEMA:
        raise PackageError(f"not a {SCHEMA} manifest")
    for field in ("id", "version", "kind", "publisher", "targets", "artifacts", "recovery", "healthChecks"):
        if field not in manifest:
            raise PackageError(f"the manifest has no {field}")
    if manifest["kind"] == "firmware":
        raise PackageError("firmware is never staged as an update; it goes through the separate firmware procedure")
    key = verify_signature(manifest, trusted_keys)
    problems = compatibility(manifest, facts)
    if problems:
        raise PackageError("; ".join(problems))
    if artifact_dir is not None:
        check_artifact(manifest, artifact_dir)
    return {"id": manifest["id"], "version": manifest["version"], "kind": manifest["kind"], "publisher": key["owner"], "healthChecks": [check.get("id") for check in manifest["healthChecks"]]}
