"""Discovery worker process boundaries: short-lived, bounded, read-only jobs."""
import os
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from hannah_edge.discovery import DiscoveryError, run_isolated
from hannah_edge.hub import Hub
from tests.support import HUB, SECRET


class DiscoveryWorker(unittest.TestCase):
    def test_usb_listing_runs_in_a_separate_process_and_returns_only_metadata(self):
        answer = run_isolated({"kind": "usb"}, timeout=5)
        worker_pid = answer.pop("_workerPid")
        self.assertNotEqual(worker_pid, os.getpid())
        self.assertEqual(answer["kind"], "usb")
        self.assertIn("devices", answer)
        self.assertEqual(answer["note"], "Listed only. Nothing was opened or written to.")

    def test_bad_requests_fail_closed_in_the_worker(self):
        with self.assertRaises(DiscoveryError) as raised:
            run_isolated({"kind": "scan-network"}, timeout=5)
        self.assertEqual(raised.exception.reason, "unknown-kind")

    def test_worker_timeout_is_reported_without_stopping_the_hub_tick(self):
        with tempfile.TemporaryDirectory() as state:
            hub = Hub(HUB, SECRET, state)
            try:
                with patch("hannah_edge.hub.discovery.run_isolated", side_effect=subprocess.TimeoutExpired("worker", 5)):
                    hub._run_discover({"id": "cmd-timeout", "type": "discover", "kind": "usb"})
                self.assertEqual(hub._outbox[-1]["status"], "failed")
                self.assertEqual(hub._outbox[-1]["reason"], "worker-timeout")
                hub.tick()
            finally:
                hub.close()


if __name__ == "__main__":
    unittest.main()
