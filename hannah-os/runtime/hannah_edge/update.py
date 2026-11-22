"""Updating the hub's own software, with a way back.

Versions live side by side and a link names the one in use:

    <root>/versions/0.1.0/hannah_edge/…
    <root>/versions/0.2.0/hannah_edge/…
    <root>/current -> versions/0.2.0
    <root>/update.json

An update goes through four gates, and stops at the first that fails:

  1. the bundle is exactly the one that was announced (size and SHA-256);
  2. it unpacks to ordinary files inside its own folder, and is the version
     it says it is;
  3. the new version passes a health check before anything is switched;
  4. after the switch it is on probation: if it restarts three times without
     confirming that it reached the server, the previous version is put back.

Who may announce an update is not decided here: the announcement (version,
size, hash) must come in a command signed by the server, checked by
protocol.CommandGuard like any other. That command is not wired up yet, so
today this module is used only by its tests.

It replaces HANNAH's own files only. It never touches the operating system,
a device's firmware or anything outside <root>.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import re
import shutil
import tarfile
import time

VERSION = re.compile(r"^\d+\.\d+\.\d+$")
MAX_BUNDLE = 20 * 1024 * 1024
MAX_FILES = 500
MAX_STARTS = 3


class UpdateError(Exception):
    def __init__(self, message: str, reason: str):
        super().__init__(message)
        self.reason = reason


def _key(version: str) -> tuple:
    return tuple(int(part) for part in version.split("."))


class Updater:
    def __init__(self, root: str, health=None, clock=time.time):
        self.root = root
        self._health = health or (lambda _folder, _version: (True, ""))
        self._clock = clock
        os.makedirs(os.path.join(root, "versions"), exist_ok=True)

    # ---------- state ----------
    def _state_path(self) -> str:
        return os.path.join(self.root, "update.json")

    def status(self) -> dict:
        try:
            with open(self._state_path(), "r", encoding="utf-8") as handle:
                state = json.load(handle)
        except (OSError, ValueError):
            state = {}
        return {"current": state.get("current"), "previous": state.get("previous"), "pending": state.get("pending"), "last": state.get("last")}

    def _save(self, state: dict) -> None:
        temporary = self._state_path() + ".tmp"
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump(state, handle)
        os.replace(temporary, self._state_path())

    def _folder(self, version: str) -> str:
        return os.path.join(self.root, "versions", version)

    def _point(self, version: str) -> None:
        link = os.path.join(self.root, "current")
        temporary = link + ".new"
        if os.path.lexists(temporary):
            os.remove(temporary)
        os.symlink(os.path.join("versions", version), temporary)
        os.replace(temporary, link)  # one step: there is never a moment with no current version

    def installed(self) -> list:
        return sorted((name for name in os.listdir(os.path.join(self.root, "versions")) if VERSION.match(name)), key=_key)

    # ---------- gate 1 and 2 ----------
    def stage(self, bundle: bytes, announced: dict, allow_downgrade: bool = False) -> str:
        version = str(announced.get("version", ""))
        if not VERSION.match(version):
            raise UpdateError("The update doesn't say which version it is.", "bad-version")
        current = self.status()["current"]
        if current and not allow_downgrade and _key(version) <= _key(current):
            raise UpdateError(f"Version {version} is not newer than {current}, which is running.", "not-newer")
        if len(bundle) != announced.get("size") or len(bundle) > MAX_BUNDLE:
            raise UpdateError("The update isn't the size that was announced.", "wrong-size")
        if hashlib.sha256(bundle).hexdigest() != announced.get("sha256"):
            raise UpdateError("The update isn't the one that was announced: its SHA-256 differs.", "wrong-hash")
        staging = self._folder(version) + ".staging"
        shutil.rmtree(staging, ignore_errors=True)
        try:
            with tarfile.open(fileobj=io.BytesIO(bundle), mode="r:gz") as archive:
                members = archive.getmembers()
                if len(members) > MAX_FILES:
                    raise UpdateError("The update has too many files.", "too-large")
                total = 0
                for member in members:
                    parts = member.name.split("/")
                    if member.name.startswith("/") or ".." in parts or not (member.isfile() or member.isdir()):
                        raise UpdateError(f"The update contains something that isn't an ordinary file in its own folder: {member.name[:80]}", "unsafe-archive")
                    total += member.size
                    if total > MAX_BUNDLE * 4:
                        raise UpdateError("The update unpacks to more than is allowed.", "too-large")
                os.makedirs(staging)
                for member in members:
                    target = os.path.join(staging, *member.name.split("/"))
                    if member.isdir():
                        os.makedirs(target, exist_ok=True)
                        continue
                    os.makedirs(os.path.dirname(target), exist_ok=True)
                    source = archive.extractfile(member)
                    with open(target, "wb") as out:
                        shutil.copyfileobj(source, out)
        except (tarfile.TarError, OSError, EOFError):
            shutil.rmtree(staging, ignore_errors=True)
            raise UpdateError("The update couldn't be unpacked.", "unreadable") from None
        except UpdateError:
            shutil.rmtree(staging, ignore_errors=True)
            raise
        try:
            with open(os.path.join(staging, "hannah_edge", "__init__.py"), "r", encoding="utf-8") as handle:
                said = re.search(r'^__version__\s*=\s*"([^"]+)"', handle.read(), re.M)
        except OSError:
            said = None
        if not said or said.group(1) != version:
            shutil.rmtree(staging, ignore_errors=True)
            raise UpdateError(f"The update was announced as {version} and its files say {said.group(1) if said else 'nothing'}.", "version-mismatch")
        shutil.rmtree(self._folder(version), ignore_errors=True)
        os.replace(staging, self._folder(version))
        return version

    # ---------- gate 3 ----------
    def activate(self, version: str) -> None:
        if version not in self.installed():
            raise UpdateError(f"Version {version} isn't here.", "not-staged")
        ok, detail = self._health(self._folder(version), version)
        state = self.status()
        if not ok:
            shutil.rmtree(self._folder(version), ignore_errors=True)
            self._save({**state, "last": {"result": "refused", "version": version, "reason": f"It failed its check before being switched on. {detail}".strip(), "at": int(self._clock() * 1000)}})
            raise UpdateError(f"Version {version} failed its check and was not switched on. {detail}".strip(), "unhealthy")
        previous = state["current"]
        self._point(version)
        self._save({"current": version, "previous": previous, "pending": {"version": version, "since": int(self._clock() * 1000), "starts": 0} if previous else None, "last": {"result": "switched", "version": version, "from": previous, "at": int(self._clock() * 1000)}})

    # ---------- gate 4 ----------
    def on_start(self) -> dict:
        """Call once each time the hub starts. Puts the previous version back when a new one keeps restarting without confirming."""
        state = self.status()
        pending = state["pending"]
        if not pending:
            return state
        pending["starts"] += 1
        if pending["starts"] > MAX_STARTS:
            return self.rollback(f"It restarted {MAX_STARTS} times without reaching the server.")
        self._save(state)
        return state

    def confirm(self) -> None:
        """Call when the running version has exchanged with the server. Ends its probation."""
        state = self.status()
        if state["pending"]:
            self._save({**state, "pending": None, "last": {"result": "confirmed", "version": state["current"], "at": int(self._clock() * 1000)}})

    def rollback(self, reason: str) -> dict:
        state = self.status()
        if not state["previous"] or state["previous"] not in self.installed():
            raise UpdateError("There is no previous version to go back to.", "no-previous")
        bad = state["current"]
        self._point(state["previous"])
        new = {"current": state["previous"], "previous": None, "pending": None, "last": {"result": "rolled-back", "version": bad, "to": state["previous"], "reason": reason, "at": int(self._clock() * 1000)}}
        self._save(new)
        shutil.rmtree(self._folder(bad), ignore_errors=True)
        return new

    def prune(self) -> list:
        """Keep the version in use and the one before it; remove the rest."""
        state = self.status()
        keep = {state["current"], state["previous"]}
        removed = [version for version in self.installed() if version not in keep]
        for version in removed:
            shutil.rmtree(self._folder(version), ignore_errors=True)
        return removed
