"""Forward the onboard Edge Resource Manager's latest report to HANNAH.

HANNAH Robot OS measures the computer's resources (its edge-resources
service writes <data_dir>/resources/latest.json). The runtime doesn't measure
anything itself: it reads that file and sends it with its signed sync, at
most every `every_s` seconds, and only while the report is fresh. A missing,
unreadable or stale file sends nothing, so HANNAH shows "no report" rather
than old numbers as current.
"""
from __future__ import annotations

import json
import os
import time

DEFAULT_PATH = "/var/lib/hannah-robot-os/resources/latest.json"
SCHEMA = "hannah.edge-resources.v1"


class ResourceReportReader:
    def __init__(self, path: str = DEFAULT_PATH, every_s: float = 10.0, stale_after_s: float = 60.0, clock=time.time):
        self.path = path
        self.every_s = float(every_s)
        self.stale_after_s = float(stale_after_s)
        self.clock = clock
        self._last_sent = 0.0
        self._last_id = None

    def due(self) -> dict | None:
        """The report to send now, or None."""
        now = self.clock()
        if self._last_sent and now - self._last_sent < self.every_s:
            return None
        try:
            with open(self.path, "r", encoding="utf-8") as handle:
                report = json.load(handle)
        except (OSError, ValueError):
            return None
        if not isinstance(report, dict) or report.get("schema") != SCHEMA:
            return None
        measured = report.get("snapshot", {}).get("measured_at_ms")
        if not isinstance(measured, (int, float)) or now * 1000 - measured > self.stale_after_s * 1000:
            return None
        if report.get("report_id") == self._last_id:
            return None
        self._last_sent = now
        self._last_id = report.get("report_id")
        return report


def reader_from_env(path: str | None) -> ResourceReportReader | None:
    """A reader when a report file is configured or exists at the Robot OS default location."""
    target = path or (DEFAULT_PATH if os.path.exists(DEFAULT_PATH) else None)
    return ResourceReportReader(target) if target else None
