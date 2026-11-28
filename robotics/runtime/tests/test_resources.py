"""The runtime forwards the Robot OS Edge Resource Manager's report; it never measures or invents one."""
from __future__ import annotations

import json
import os
import tempfile
import unittest

from hannah_robot.resources import ResourceReportReader

from .helpers import Bench


def report(measured_ms: int, report_id: str = "res_1") -> dict:
    return {"schema": "hannah.edge-resources.v1", "report_id": report_id, "snapshot": {"schema": "hannah.edge-resources.v1", "measured_at_ms": measured_ms, "memory": {"total_mb": {"available": False, "reason": "not measurable on this device: test"}}}, "evaluation": {"status": "ok", "warnings": [], "unmeasured": []}, "actions": []}


class ResourceForwardingTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.dir.name, "latest.json")
        self.bench = Bench()
        self.reader = ResourceReportReader(self.path, every_s=10, stale_after_s=60, clock=lambda: self.bench.now)
        self.bench.runtime.resources = self.reader

    def tearDown(self):
        self.dir.cleanup()

    def write(self, data: dict) -> None:
        with open(self.path, "w", encoding="utf-8") as handle:
            json.dump(data, handle)

    def test_nothing_is_sent_without_a_report(self):
        self.assertNotIn("resources", self.bench.runtime.outbox())

    def test_a_fresh_report_is_sent_once_and_at_most_every_interval(self):
        now_ms = int(self.bench.now * 1000)
        self.write(report(now_ms - 1000))
        self.assertEqual(self.bench.runtime.outbox()["resources"]["report_id"], "res_1")
        self.assertNotIn("resources", self.bench.runtime.outbox())
        self.bench.now += 11
        self.assertNotIn("resources", self.bench.runtime.outbox(), "the same report isn't sent twice")
        self.write(report(int(self.bench.now * 1000), "res_2"))
        self.assertEqual(self.bench.runtime.outbox()["resources"]["report_id"], "res_2")

    def test_a_stale_or_foreign_file_is_not_forwarded(self):
        self.write(report(int(self.bench.now * 1000) - 120_000))
        self.assertNotIn("resources", self.bench.runtime.outbox())
        self.write({"schema": "something-else", "snapshot": {"measured_at_ms": int(self.bench.now * 1000)}})
        self.assertNotIn("resources", self.bench.runtime.outbox())
        with open(self.path, "w", encoding="utf-8") as handle:
            handle.write("{not json")
        self.assertNotIn("resources", self.bench.runtime.outbox())


if __name__ == "__main__":
    unittest.main()
