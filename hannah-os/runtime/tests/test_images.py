"""UNIT tests: the description of the HANNAH OS images is consistent, and a manifest is the same every time.

No image is built or booted here, or anywhere yet.
"""
import copy
import importlib.util
import json
import os
import unittest

TOOLS = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "tools")
spec = importlib.util.spec_from_file_location("image_manifest", os.path.join(TOOLS, "image_manifest.py"))
images = importlib.util.module_from_spec(spec)
spec.loader.exec_module(images)


class Images(unittest.TestCase):
    def setUp(self):
        self.description = images.load()

    def test_the_description_is_consistent_and_claims_no_board(self):
        self.assertEqual(images.problems(self.description), [])
        self.assertEqual(self.description["validatedHardware"], [])
        self.assertIn("NOT BUILT", self.description["status"])
        self.assertEqual([profile["id"] for profile in self.description["profiles"]], ["edge", "robotics", "iot-gateway", "industrial-edge", "developer"])

    def test_every_profile_carries_the_same_core(self):
        hubs = set()
        for profile in self.description["profiles"]:
            made = images.manifest(self.description, profile["id"])
            self.assertFalse(made["built"])
            self.assertIn("hannah-os/images/systemd/hannah-edge.service", made["services"])
            hub = next(component for component in made["components"] if component["id"] == "hannah-edge")
            hubs.add(json.dumps(hub, sort_keys=True))
            self.assertTrue(any(item["path"].endswith("hannah_edge/hub.py") for item in hub["files"]))
            self.assertFalse(any("__pycache__" in item["path"] or "/tests/" in item["path"] for item in hub["files"]))
        self.assertEqual(len(hubs), 1, "every image has byte-for-byte the same hub")
        robotics = images.manifest(self.description, "robotics")
        self.assertIn("robotics/deploy/hannah-robot.service", robotics["services"])
        self.assertIn("ros-jazzy-navigation2", robotics["packages"])
        self.assertNotIn("ros-jazzy-navigation2", images.manifest(self.description, "iot-gateway")["packages"])

    def test_a_manifest_is_the_same_every_time(self):
        first = json.dumps(images.manifest(self.description, "developer"), sort_keys=True)
        second = json.dumps(images.manifest(images.load(), "developer"), sort_keys=True)
        self.assertEqual(first, second)

    def test_rules_catch_a_claim_without_evidence_and_a_missing_piece(self):
        claimed = copy.deepcopy(self.description)
        claimed["validatedHardware"] = [{"board": "Raspberry Pi 5", "evidence": "hannah-os/evidence/does-not-exist.md"}]
        self.assertTrue(any("without a boot record" in issue for issue in images.problems(claimed)))
        broken = copy.deepcopy(self.description)
        broken["profiles"][2].pop("snap")
        broken["profiles"][0]["architectures"] = ["riscv64"]
        broken["profiles"][1]["services"] = ["robotics/deploy/missing.service"]
        del broken["profiles"][4]
        issues = " ".join(images.problems(broken))
        for expected in ("made of snaps", "architectures must be from", "service file that doesn't exist", "developer profile is missing"):
            self.assertIn(expected, issues)

    def test_no_image_file_carries_a_secret_or_opens_a_port(self):
        root = os.path.join(os.path.dirname(TOOLS), "images")
        for folder, _names, files in os.walk(root):
            for name in files:
                with open(os.path.join(folder, name), encoding="utf-8") as handle:
                    text = handle.read()
                self.assertNotRegex(text, r"(?i)(password|passwd|secret|token)\s*[:=]\s*[\"']?[A-Za-z0-9+/]{8,}", name)
                self.assertNotRegex(text, r"ufw, allow, (?!outgoing)|ListenStream|allow incoming", name)
        with open(os.path.join(root, "systemd", "hannah-edge.service"), encoding="utf-8") as handle:
            unit = handle.read()
        for line in ("NoNewPrivileges=true", "ProtectSystem=strict", "User=hannah-edge", "ExecStartPre=/usr/bin/python3 -m hannah_edge doctor"):
            self.assertIn(line, unit)


if __name__ == "__main__":
    unittest.main()
