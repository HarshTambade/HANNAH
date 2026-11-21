"""The implementation tracker can't say more than was done."""
import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, "..", "..", "tools", "progress.py")
spec = importlib.util.spec_from_file_location("hannah_progress", TOOL)
progress = importlib.util.module_from_spec(spec)
spec.loader.exec_module(progress)


class TrackerTest(unittest.TestCase):
    def test_the_record_keeps_its_own_rules_and_the_page_is_current(self):
        record = progress.load()
        self.assertEqual(progress.problems(record), [])
        with open(progress.PAGE, encoding="utf-8") as handle:
            self.assertEqual(handle.read(), progress.render(record), "Run: python3 robotics/tools/progress.py")

    def test_nothing_is_marked_as_run_in_gazebo_or_on_hardware_without_an_evidence_file(self):
        for item in progress.load()["items"]:
            claimed = set(item.get("where", [])) & progress.NEEDS_EVIDENCE
            self.assertTrue(not claimed or item.get("evidence"), item["id"])

    def test_the_rules_catch_a_claim_without_a_test_a_missing_file_and_an_unnamed_blocker(self):
        base = {"blockers": [{"id": "B1"}], "items": []}

        def found(item):
            return " ".join(progress.problems({**base, "items": [{"id": "x", "stage": "1", "feature": "f", **item}]}))
        self.assertIn("VERIFIED without a test", found({"status": "VERIFIED", "where": ["sim"]}))
        self.assertIn("without saying where", found({"status": "VERIFIED", "tests": ["robotics/runtime/tests/test_progress.py"]}))
        self.assertIn("doesn't exist", found({"status": "VERIFIED", "where": ["sim"], "tests": ["no/such/test.py"]}))
        self.assertIn("without an evidence file", found({"status": "VERIFIED", "where": ["physical"], "tests": ["robotics/runtime/tests/test_progress.py"]}))
        self.assertIn("blocked without naming", found({"status": "BLOCKED_EXTERNAL_DEPENDENCY"}))
        self.assertIn("unknown status", found({"status": "DONE"}))
        self.assertEqual(found({"status": "VERIFIED", "where": ["sim"], "tests": ["robotics/runtime/tests/test_progress.py"]}), "")


if __name__ == "__main__":
    unittest.main()
