"""UNIT tests: the hub's self-update, with real archives in a temporary folder.

The update is not wired to the server yet, and has never replaced an installed hub.
"""
import hashlib
import io
import os
import tarfile
import tempfile
import unittest

from hannah_edge.update import UpdateError, Updater


def bundle(version, extra=None, said=None, members=None):
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode="w:gz") as archive:
        files = {"hannah_edge/__init__.py": f'__version__ = "{said or version}"\n', "hannah_edge/hub.py": f"# {version}\n", **(extra or {})}
        for name, text in files.items():
            raw = text.encode()
            info = tarfile.TarInfo(name)
            info.size = len(raw)
            archive.addfile(info, io.BytesIO(raw))
        for member in members or []:
            archive.addfile(member)
    raw = data.getvalue()
    return raw, {"version": version, "size": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}


class Update(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.root = self.folder.name
        self.healthy = {}
        self.updater = Updater(self.root, health=lambda _folder, version: self.healthy.get(version, (True, "")))
        self.updater.activate(self.updater.stage(*bundle("0.1.0")))

    def tearDown(self):
        self.folder.cleanup()

    def current(self):
        with open(os.path.join(self.root, "current", "hannah_edge", "hub.py"), encoding="utf-8") as handle:
            return handle.read().strip("# \n")

    def refused(self, raw, announced, reason, **options):
        with self.assertRaises(UpdateError) as raised:
            self.updater.stage(raw, announced, **options)
        self.assertEqual(raised.exception.reason, reason)
        self.assertEqual(self.updater.installed(), ["0.1.0"])
        self.assertEqual(self.current(), "0.1.0")
        self.assertFalse([name for name in os.listdir(os.path.join(self.root, "versions")) if name.endswith(".staging")])

    def test_a_good_update_is_switched_in_one_step_and_confirmed(self):
        self.assertEqual(self.updater.status()["pending"], None, "the first install has nothing to go back to, so no probation")
        self.updater.activate(self.updater.stage(*bundle("0.2.0")))
        self.assertEqual(self.current(), "0.2.0")
        self.assertEqual(os.readlink(os.path.join(self.root, "current")), os.path.join("versions", "0.2.0"))
        status = self.updater.status()
        self.assertEqual((status["current"], status["previous"], status["pending"]["starts"]), ("0.2.0", "0.1.0", 0))
        self.updater.on_start()
        self.updater.confirm()
        status = self.updater.status()
        self.assertEqual((status["pending"], status["last"]["result"]), (None, "confirmed"))
        self.updater.on_start()
        self.assertEqual(self.current(), "0.2.0")

    def test_a_bundle_that_is_not_the_one_announced_is_refused(self):
        raw, announced = bundle("0.2.0")
        self.refused(raw + b"x", announced, "wrong-size")
        self.refused(raw, {**announced, "sha256": "0" * 64}, "wrong-hash")
        tampered = bytearray(raw)
        tampered[-9] ^= 1
        self.refused(bytes(tampered), announced, "wrong-hash")
        self.refused(raw, {**announced, "version": "latest"}, "bad-version")
        self.refused(*bundle("0.2.0", said="9.9.9"), "version-mismatch")
        self.refused(b"not an archive", {"version": "0.2.0", "size": 14, "sha256": hashlib.sha256(b"not an archive").hexdigest()}, "unreadable")

    def test_an_archive_that_reaches_outside_its_folder_is_refused(self):
        link = tarfile.TarInfo("hannah_edge/key")
        link.type = tarfile.SYMTYPE
        link.linkname = "/etc/passwd"
        device = tarfile.TarInfo("hannah_edge/dev")
        device.type = tarfile.CHRTYPE
        for extra, members in (({"../outside.py": "x"}, None), ({"/etc/cron.d/hannah": "x"}, None), ({"hannah_edge/../../up.py": "x"}, None), (None, [link]), (None, [device])):
            self.refused(*bundle("0.2.0", extra=extra, members=members), "unsafe-archive")
        self.assertFalse(os.path.exists(os.path.join(os.path.dirname(self.root), "outside.py")))

    def test_an_older_or_equal_version_is_refused_unless_asked_for(self):
        self.updater.activate(self.updater.stage(*bundle("0.3.0")))
        self.updater.confirm()
        for version in ("0.3.0", "0.2.9"):
            with self.assertRaises(UpdateError) as raised:
                self.updater.stage(*bundle(version))
            self.assertEqual(raised.exception.reason, "not-newer")
        self.assertEqual(self.updater.stage(*bundle("0.2.9"), allow_downgrade=True), "0.2.9")

    def test_a_version_that_fails_its_check_is_never_switched_on(self):
        self.healthy["0.2.0"] = (False, "doctor: FAIL clock")
        version = self.updater.stage(*bundle("0.2.0"))
        with self.assertRaises(UpdateError) as raised:
            self.updater.activate(version)
        self.assertEqual(raised.exception.reason, "unhealthy")
        self.assertIn("doctor: FAIL clock", str(raised.exception))
        self.assertEqual(self.current(), "0.1.0")
        self.assertEqual(self.updater.installed(), ["0.1.0"])
        self.assertEqual(self.updater.status()["last"]["result"], "refused")

    def test_a_version_that_keeps_restarting_without_confirming_is_rolled_back(self):
        self.updater.activate(self.updater.stage(*bundle("0.2.0")))
        for _start in range(3):
            self.updater.on_start()
            self.assertEqual(self.current(), "0.2.0")
        self.updater.on_start()  # the fourth start without a confirmation
        self.assertEqual(self.current(), "0.1.0")
        status = self.updater.status()
        self.assertEqual((status["current"], status["pending"], status["last"]["result"], status["last"]["version"]), ("0.1.0", None, "rolled-back", "0.2.0"))
        self.assertIn("restarted 3 times without reaching the server", status["last"]["reason"])
        self.assertEqual(self.updater.installed(), ["0.1.0"], "the version that failed is removed")
        self.updater.on_start()
        self.assertEqual(self.current(), "0.1.0")
        with self.assertRaises(UpdateError) as raised:
            self.updater.rollback("again")
        self.assertEqual(raised.exception.reason, "no-previous")

    def test_only_the_version_in_use_and_the_one_before_are_kept(self):
        for version in ("0.2.0", "0.3.0", "0.4.0"):
            self.updater.activate(self.updater.stage(*bundle(version)))
            self.updater.confirm()
        self.assertEqual(self.updater.prune(), ["0.1.0", "0.2.0"])
        self.assertEqual(self.updater.installed(), ["0.3.0", "0.4.0"])
        self.assertEqual(self.current(), "0.4.0")


if __name__ == "__main__":
    unittest.main()
