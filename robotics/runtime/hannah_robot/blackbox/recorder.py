"""The robot's black box: events and selected telemetry, kept on the robot's own disk.

    recorder = Recorder(directory, robot_id, RecorderConfig(), simulated=True)
    recorder.record("nav/pose", {"x": 1.0, "y": 2.0})              # telemetry, thinned to the topic's rate
    recorder.event("safety", "estop-engaged", "error", "The emergency stop was engaged.")

Records go into segments (format.py), one open segment per stream. A stream is
the topic's first part, its retention and its sensitivity ("nav-72h",
"sensors-24h-sensitive"), so each segment can be deleted whole when it expires.
A segment is closed when it reaches maxSegmentBytes or maxSegmentSeconds, and
the oldest closed segments are deleted when the recording passes
maxTotalBytes: telemetry first, events last.

Events are also put in an outbox for upload to HANNAH as summaries (no
telemetry, no sensor payloads); the outbox survives a restart.

Recording never stops the robot: every error here is counted and logged, never
raised into the control loop.
"""
from __future__ import annotations

import json
import os
import threading
import time
import uuid

from .config import SEVERITIES, RecorderConfig, select_fields, strip_payload
from .format import SUFFIX, SegmentWriter, is_segment, read_segment

SOURCES = ("motor", "sensor", "navigation", "ai", "os", "safety", "link", "mission")
CLOCK_FRESH_MS = 10 * 60_000


def _stream_of(topic: str, retention_hours: float, sensitive: bool) -> str:
    head = (topic.split("/", 1)[0] or "misc").replace(".", "_")[:24]
    return f"{head}-{int(round(retention_hours))}h{'-sensitive' if sensitive else ''}"


class Recorder:
    def __init__(self, directory: str, robot_id: str, config: RecorderConfig | None = None, *, simulated: bool, clock=time.time, log=None):
        self.directory = os.path.abspath(directory)
        self.robot_id = str(robot_id)
        self.config = config or RecorderConfig()
        self.simulated = bool(simulated)
        self.clock = clock
        self.log = log or (lambda event, **fields: None)
        self._lock = threading.RLock()
        self._open: dict[str, SegmentWriter] = {}
        self._opened_at: dict[str, int] = {}
        self._segment_meta: dict[str, dict] = {}
        self._last: dict[tuple, int] = {}
        self._seq = 0
        self._clock_state = {"source": "system", "synced": False, "offsetMs": None, "uncertaintyMs": None, "observedAt": None}
        self.dropped = {"rate": 0, "too-large": 0, "refused": 0, "errors": 0}
        os.makedirs(self._segments_dir, mode=0o700, exist_ok=True)
        self._index = self._load_index()
        self._outbox = self._load_outbox()

    # ---------------- paths and persisted state ----------------
    @property
    def _segments_dir(self) -> str:
        return os.path.join(self.directory, "segments")

    def _now_ms(self) -> int:
        return int(self.clock() * 1000)

    def _load_index(self) -> dict:
        path = os.path.join(self.directory, "index.json")
        try:
            with open(path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
            if isinstance(data, dict):
                return {key: value for key, value in data.items() if isinstance(value, dict) and os.path.exists(value.get("path", ""))}
        except (OSError, ValueError):
            pass
        return self._rebuild_index()

    def _rebuild_index(self) -> dict:
        """The index was lost: read every closed segment's header and footer again. A segment left open by a crash is kept as unclosed."""
        index = {}
        for root, _dirs, files in os.walk(self._segments_dir):
            for name in files:
                if not is_segment(name):
                    continue
                path = os.path.join(root, name)
                try:
                    header, records, info = read_segment(path)
                except (OSError, ValueError):
                    continue
                times = [int(item.get("t") or 0) for item in records]
                index[header["segment"]] = {"id": header["segment"], "path": path, "stream": header.get("stream", ""), "sensitivity": header.get("sensitivity", "normal"),
                                            "retentionHours": header.get("retentionHours", self.config.retention_hours), "fromMs": min(times) if times else header.get("openedAt"),
                                            "toMs": max(times) if times else header.get("openedAt"), "closedAt": info.get("closedAt") or header.get("openedAt"), "records": len(records),
                                            "bytes": os.path.getsize(path), "topics": sorted({str(item.get("topic")) for item in records}), "verified": info["verified"], "simulated": bool(header.get("simulated"))}
        return index

    def _save_index(self) -> None:
        path = os.path.join(self.directory, "index.json")
        temporary = path + ".tmp"
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump(self._index, handle)
        os.replace(temporary, path)

    def _load_outbox(self) -> list[dict]:
        out = []
        try:
            with open(os.path.join(self.directory, "outbox.jsonl"), "r", encoding="utf-8") as handle:
                for line in handle:
                    try:
                        item = json.loads(line)
                    except ValueError:
                        continue
                    if isinstance(item, dict) and item.get("id"):
                        out.append(item)
        except OSError:
            pass
        return out[-self.config.outbox_max:]

    def _save_outbox(self) -> None:
        path = os.path.join(self.directory, "outbox.jsonl")
        temporary = path + ".tmp"
        with open(temporary, "w", encoding="utf-8") as handle:
            for item in self._outbox:
                handle.write(json.dumps(item, separators=(",", ":")) + "\n")
        os.replace(temporary, path)

    # ---------------- clock ----------------
    def observe_server_time(self, server_ms: int, sent_ms: int, received_ms: int) -> dict:
        """One exchange's times: how far this clock is from the server's, and how sure that is (half the round trip)."""
        with self._lock:
            if not all(isinstance(value, (int, float)) for value in (server_ms, sent_ms, received_ms)) or received_ms < sent_ms:
                return dict(self._clock_state)
            midpoint = (sent_ms + received_ms) / 2.0
            self._clock_state = {"source": "server-exchange", "synced": True, "offsetMs": int(round(server_ms - midpoint)),
                                 "uncertaintyMs": int((received_ms - sent_ms) / 2) + 1, "observedAt": int(received_ms)}
            return dict(self._clock_state)

    def clock_state(self) -> dict:
        with self._lock:
            state = dict(self._clock_state)
            if state["synced"] and self._now_ms() - int(state["observedAt"] or 0) > CLOCK_FRESH_MS:
                # An old comparison says little about now: drift since then is unknown.
                state.update({"synced": False, "stale": True})
            return state

    # ---------------- recording ----------------
    def _writer(self, stream: str, sensitive: bool, retention: float, at: int) -> SegmentWriter:
        writer = self._open.get(stream)
        if writer is not None and (writer.bytes >= self.config.max_segment_bytes or at - self._opened_at[stream] >= self.config.max_segment_seconds * 1000):
            self._close(stream, at)
            writer = None
        if writer is None:
            segment = f"seg_{uuid.uuid4().hex[:16]}"
            path = os.path.join(self._segments_dir, stream, f"{at}-{segment}{SUFFIX}")
            writer = SegmentWriter(path, {"segment": segment, "robotId": self.robot_id, "stream": stream, "openedAt": at, "simulated": self.simulated,
                                          "sensitivity": "sensitive" if sensitive else "normal", "retentionHours": retention, "clock": self.clock_state()})
            self._open[stream] = writer
            self._opened_at[stream] = at
            self._segment_meta[stream] = {"id": segment, "retentionHours": retention, "sensitivity": "sensitive" if sensitive else "normal"}
        return writer

    def _close(self, stream: str, at: int) -> None:
        writer = self._open.pop(stream, None)
        if writer is None:
            return
        meta = self._segment_meta.pop(stream)
        self._opened_at.pop(stream, None)
        path = writer.close(at, compress=self.config.compress)
        self._index[meta["id"]] = {"id": meta["id"], "path": path, "stream": stream, "sensitivity": meta["sensitivity"], "retentionHours": meta["retentionHours"],
                                   "fromMs": writer.first_t, "toMs": writer.last_t, "closedAt": at, "records": writer.records, "bytes": os.path.getsize(path),
                                   "topics": sorted(writer.topics), "verified": True, "simulated": self.simulated}
        self._save_index()

    def _append(self, record: dict, decision, at: int) -> bool:
        data = json.dumps(record, separators=(",", ":"), default=str)
        if len(data) > self.config.max_record_bytes:
            self.dropped["too-large"] += 1
            return False
        stream = _stream_of(record["topic"], decision.retention_hours, decision.sensitive)
        writer = self._writer(stream, decision.sensitive, decision.retention_hours, at)
        self._seq += 1
        record["seq"] = self._seq
        writer.append(record)
        self._enforce_size(at)
        return True

    def record(self, topic: str, data: dict, *, at: int | None = None, device: str | None = None, mission: str | None = None) -> bool:
        """One telemetry record. Returns whether it was kept (it may be thinned to the topic's rate, or refused by its rule)."""
        try:
            with self._lock:
                at = self._now_ms() if at is None else int(at)
                decision = self.config.decide(topic, device, "telemetry")
                if not decision.record:
                    self.dropped["refused"] += 1
                    return False
                key = (topic, device)
                rate = decision.rule.rate_hz if decision.rule else None
                if rate and at - self._last.get(key, -10**15) < 1000.0 / rate:
                    self.dropped["rate"] += 1
                    return False
                payload = select_fields(data, decision.rule.fields if decision.rule else None)
                if decision.metadata_only:
                    payload = strip_payload(payload)
                record = {"t": at, "topic": topic, "kind": "telemetry", "data": payload}
                if device:
                    record["device"] = device
                if mission:
                    record["mission"] = mission
                kept = self._append(record, decision, at)
                if kept:
                    self._last[key] = at
                return kept
        except Exception as error:  # noqa: BLE001 - the black box must never stop the robot
            self.dropped["errors"] += 1
            self.log("blackbox-error", error=f"{type(error).__name__}: {error}")
            return False

    def event(self, source: str, type_: str, severity: str, summary: str, *, at: int | None = None, mission: str | None = None, device: str | None = None, details: dict | None = None) -> dict | None:
        """An event: always kept when its topic is enabled (never thinned), and queued for upload as a summary."""
        try:
            with self._lock:
                at = self._now_ms() if at is None else int(at)
                source = source if source in SOURCES else "os"
                severity = severity if severity in SEVERITIES else "info"
                topic = f"events/{source}"
                decision = self.config.decide(topic, device, "event")
                if not decision.record:
                    self.dropped["refused"] += 1
                    return None
                event_id = f"bbe_{uuid.uuid4().hex[:20]}"
                clock = self.clock_state()
                refs = [{"segment": meta["id"], "stream": stream, "fromMs": at - 60_000, "toMs": at + 10_000}
                        for stream, meta in sorted(self._segment_meta.items()) if not stream.startswith("events-") and not stream.endswith("-sensitive")]
                details = strip_payload(details or {}) or {}
                record = {"t": at, "topic": topic, "kind": "event", "id": event_id, "sev": severity,
                          "data": {"type": str(type_)[:60], "summary": str(summary)[:400], "details": details, "refs": refs},
                          "clk": {"synced": clock["synced"], "offMs": clock["offsetMs"], "uncMs": clock["uncertaintyMs"]}}
                if mission:
                    record["mission"] = str(mission)
                if device:
                    record["device"] = str(device)
                if not self._append(record, decision, at):
                    return None
                summary_item = {"id": event_id, "at": at, "source": source, "type": record["data"]["type"], "severity": severity, "summary": record["data"]["summary"],
                                "mission": mission, "device": device, "details": details, "refs": refs, "sensitivity": "sensitive" if decision.sensitive else "normal", "clock": record["clk"]}
                if self.config.upload_events and SEVERITIES.index(severity) >= SEVERITIES.index(self.config.upload_min_severity):
                    self._outbox.append(summary_item)
                    if len(self._outbox) > self.config.outbox_max:
                        self._outbox = self._outbox[-self.config.outbox_max:]
                    self._save_outbox()
                return summary_item
        except Exception as error:  # noqa: BLE001
            self.dropped["errors"] += 1
            self.log("blackbox-error", error=f"{type(error).__name__}: {error}")
            return None

    # ---------------- upload queue ----------------
    def pending_events(self, limit: int = 100) -> list[dict]:
        with self._lock:
            return [dict(item) for item in self._outbox[:limit]]

    def mark_uploaded(self, ids) -> int:
        with self._lock:
            done = set(ids)
            before = len(self._outbox)
            self._outbox = [item for item in self._outbox if item["id"] not in done]
            if len(self._outbox) != before:
                self._save_outbox()
            return before - len(self._outbox)

    # ---------------- housekeeping ----------------
    def flush(self) -> None:
        """Close every open segment (on shutdown, or before export)."""
        with self._lock:
            at = self._now_ms()
            for stream in list(self._open):
                self._close(stream, at)

    close = flush

    def _delete(self, segment_id: str) -> None:
        meta = self._index.pop(segment_id, None)
        if meta:
            try:
                os.remove(meta["path"])
            except OSError:
                pass

    def sweep(self, now_ms: int | None = None) -> list[str]:
        """Delete closed segments past their retention. Returns their ids."""
        with self._lock:
            now_ms = self._now_ms() if now_ms is None else int(now_ms)
            for stream, opened in list(self._opened_at.items()):
                if now_ms - opened >= self.config.max_segment_seconds * 1000:
                    self._close(stream, now_ms)
            expired = [key for key, meta in self._index.items() if int(meta.get("toMs") or meta.get("closedAt") or 0) + float(meta.get("retentionHours") or 0) * 3_600_000 <= now_ms]
            for key in expired:
                self._delete(key)
            if expired:
                self._save_index()
            return expired

    def _enforce_size(self, now_ms: int) -> None:
        total = self.total_bytes()
        if total <= self.config.max_total_bytes:
            return
        # Oldest first; telemetry before events, so the record of what happened outlives the samples around it.
        order = sorted(self._index.values(), key=lambda meta: (meta["stream"].startswith("events-"), int(meta.get("closedAt") or 0)))
        removed = False
        for meta in order:
            if total <= self.config.max_total_bytes:
                break
            total -= int(meta.get("bytes") or 0)
            self._delete(meta["id"])
            removed = True
        if removed:
            self._save_index()

    def total_bytes(self) -> int:
        return sum(int(meta.get("bytes") or 0) for meta in self._index.values()) + sum(writer.bytes for writer in self._open.values())

    def segments(self) -> list[dict]:
        with self._lock:
            closed = sorted(self._index.values(), key=lambda meta: int(meta.get("fromMs") or 0))
            open_ = [{"id": self._segment_meta[stream]["id"], "path": writer.path, "stream": stream, "sensitivity": self._segment_meta[stream]["sensitivity"],
                      "fromMs": writer.first_t, "toMs": writer.last_t, "records": writer.records, "bytes": writer.bytes, "open": True, "simulated": self.simulated}
                     for stream, writer in self._open.items()]
            return [dict(meta) for meta in closed] + open_

    def stats(self) -> dict:
        with self._lock:
            return {"segments": len(self._index), "open": len(self._open), "bytes": self.total_bytes(), "outbox": len(self._outbox), "dropped": dict(self.dropped), "clock": self.clock_state(), "simulated": self.simulated}


__all__ = ["Recorder", "SOURCES"]
