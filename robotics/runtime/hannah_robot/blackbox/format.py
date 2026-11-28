"""The black box's own file format (HBX, version 1). Needs nothing but Python.

A recording is a set of segment files. A segment is UTF-8 JSON Lines:

  line 1   header  {"format": "hannah-blackbox", "version": 1, "segment": id,
                    "robotId": ..., "stream": ..., "openedAt": ms, "simulated": bool,
                    "sensitivity": "normal" | "sensitive", "clock": {...}}
  lines    records {"seq": n, "t": ms, "topic": ..., "kind": "event" | "telemetry",
                    "data": {...}, optional "sev", "mission", "device", "id", "clk"}
  last     footer  {"footer": true, "records": n, "closedAt": ms, "sha256": hex}

The footer's sha256 covers every byte before the footer line, so a segment
that was changed after it was closed is detected. A segment without a footer
was not closed (the robot lost power); it is still read, its last line may be
cut short and is skipped, and it is reported as unverified. Closed segments
are gzip-compressed (".hbx.gz"). The server reads the same format
(server/robotics/blackbox_format.js) and so does HANNAH Robot OS
(robot-os/src/hannah_robot_os/blackbox/format.py).
"""
from __future__ import annotations

import gzip
import hashlib
import json
import os

MAGIC = "hannah-blackbox"
VERSION = 1
SUFFIX = ".hbx"


class FormatError(ValueError):
    pass


def _line(value: dict) -> bytes:
    return (json.dumps(value, separators=(",", ":"), sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8")


class SegmentWriter:
    """Appends records to one open segment. Not thread-safe; the recorder holds a lock."""

    def __init__(self, path: str, header: dict):
        self.path = path
        self.header = {"format": MAGIC, "version": VERSION, **header}
        self._hash = hashlib.sha256()
        self.records = 0
        self.bytes = 0
        self.first_t: int | None = None
        self.last_t: int | None = None
        self.topics: set[str] = set()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self._file = open(path, "xb")
        self._write(_line(self.header))

    def _write(self, data: bytes) -> None:
        self._file.write(data)
        self._hash.update(data)
        self.bytes += len(data)

    def append(self, record: dict) -> int:
        data = _line(record)
        self._write(data)
        self._file.flush()
        self.records += 1
        t = int(record.get("t") or 0)
        self.first_t = t if self.first_t is None else min(self.first_t, t)
        self.last_t = t if self.last_t is None else max(self.last_t, t)
        self.topics.add(str(record.get("topic", "")))
        return len(data)

    def close(self, closed_at: int, compress: bool = True) -> str:
        """Write the footer and close. Returns the final path (compressed when asked)."""
        footer = {"footer": True, "records": self.records, "closedAt": int(closed_at), "sha256": self._hash.hexdigest()}
        self._file.write(_line(footer))
        self._file.flush()
        os.fsync(self._file.fileno())
        self._file.close()
        if not compress:
            return self.path
        target = self.path + ".gz"
        with open(self.path, "rb") as source, gzip.open(target, "wb") as out:
            out.write(source.read())
        os.remove(self.path)
        return target


def read_bytes(raw: bytes) -> tuple[dict, list[dict], dict]:
    """Parse a segment's bytes (gzip or plain). Returns (header, records, info)."""
    if raw[:2] == b"\x1f\x8b":
        try:
            raw = gzip.decompress(raw)
        except (OSError, EOFError) as error:
            raise FormatError(f"the compressed segment is damaged ({error})") from None
    lines = raw.split(b"\n")
    if not lines or not lines[0]:
        raise FormatError("the segment is empty")
    try:
        header = json.loads(lines[0])
    except ValueError:
        raise FormatError("the segment has no readable header") from None
    if not isinstance(header, dict) or header.get("format") != MAGIC:
        raise FormatError("not a HANNAH black box segment")
    if header.get("version") != VERSION:
        raise FormatError(f"segment version {header.get('version')} isn't supported (this reader knows {VERSION})")
    digest = hashlib.sha256(lines[0] + b"\n")
    records: list[dict] = []
    footer = None
    truncated = False
    body = lines[1:]
    for index, line in enumerate(body):
        if not line:
            continue
        try:
            value = json.loads(line)
        except ValueError:
            # Only the very last line may be cut short (power lost while writing).
            if index >= len(body) - 2:
                truncated = True
                break
            raise FormatError(f"line {index + 2} is not JSON") from None
        if isinstance(value, dict) and value.get("footer") is True:
            footer = value
            break
        digest.update(line + b"\n")
        if isinstance(value, dict):
            records.append(value)
    info = {"closed": footer is not None, "truncated": truncated, "verified": False, "records": len(records)}
    if footer is not None:
        info["verified"] = footer.get("sha256") == digest.hexdigest() and footer.get("records") == len(records)
        if not info["verified"]:
            raise FormatError("the segment's checksum doesn't match: it was changed or damaged after it was closed")
        info["closedAt"] = footer.get("closedAt")
    return header, records, info


def read_segment(path: str) -> tuple[dict, list[dict], dict]:
    with open(path, "rb") as handle:
        return read_bytes(handle.read())


def is_segment(name: str) -> bool:
    return name.endswith(SUFFIX) or name.endswith(SUFFIX + ".gz")


__all__ = ["FormatError", "MAGIC", "SUFFIX", "SegmentWriter", "VERSION", "is_segment", "read_bytes", "read_segment"]
