"""Least privilege for installed hardware packages, enforced on the robot.

The server installs a package with exactly the permissions and hardware
interfaces its signed manifest declares (server/marketplace/hardware-packages.js)
and hands the robot that grant. Before a package's driver opens a device or
uses a permission, it asks this policy. Anything not declared is denied and
recorded in the audit log: an untrusted driver can't silently reach hardware.

A grant looks like:
    {"packageId": "org.example.lidar-driver", "version": "1.0.0", "status": "active",
     "permissions": ["read-sensors", "hardware-access"],
     "interfaces": [{"type": "serial", "match": "/dev/ttyUSB*"}]}
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from ..common import AuditLog

INTERFACE_TYPES = {"serial", "can", "usb", "gpio", "i2c", "spi", "camera", "audio", "network"}


def _matches(pattern: str, value: str) -> bool:
    regex = "^" + re.escape(str(pattern)).replace(r"\*", "[^/]*") + "$"
    return re.match(regex, str(value)) is not None


@dataclass
class PackagePolicy:
    audit: AuditLog
    grants: dict[str, dict[str, Any]] = field(default_factory=dict)

    def load(self, grants: list[dict[str, Any]]) -> None:
        """Replace the grants with what the server sent. Malformed entries are dropped, never widened."""
        self.grants = {}
        for grant in grants or []:
            if not isinstance(grant, dict) or not grant.get("packageId"):
                continue
            interfaces = [item for item in grant.get("interfaces") or [] if isinstance(item, dict) and item.get("type") in INTERFACE_TYPES and isinstance(item.get("match"), str) and ".." not in item["match"]]
            self.grants[str(grant["packageId"])] = {
                "status": str(grant.get("status", "")),
                "permissions": {str(item) for item in grant.get("permissions") or []},
                "interfaces": interfaces,
            }

    def _deny(self, package_id: str, reason: str, **data: Any) -> tuple[bool, str]:
        self.audit.emit("package-policy", "access_denied", severity="warning", package=package_id, reason=reason, **data)
        return False, reason

    def check_permission(self, package_id: str, permission: str) -> tuple[bool, str]:
        grant = self.grants.get(package_id)
        if grant is None:
            return self._deny(package_id, "package not installed", permission=permission)
        if grant["status"] != "active":
            return self._deny(package_id, f"install is {grant['status'] or 'unknown'}", permission=permission)
        if permission not in grant["permissions"]:
            return self._deny(package_id, f"permission {permission} not declared", permission=permission)
        return True, "ok"

    def check_interface(self, package_id: str, kind: str, path: str) -> tuple[bool, str]:
        if kind != "network":
            ok, reason = self.check_permission(package_id, "hardware-access")
            if not ok:
                return False, reason
        grant = self.grants.get(package_id)
        if grant is None or grant["status"] != "active":
            return self._deny(package_id, "package not installed", interface=kind, path=path)
        if not any(item["type"] == kind and _matches(item["match"], path) for item in grant["interfaces"]):
            return self._deny(package_id, f"{kind} {path} not declared", interface=kind, path=path)
        return True, "ok"
