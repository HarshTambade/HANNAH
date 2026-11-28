"""Sending the black box's event summaries to HANNAH.

It runs on the link thread, after a successful exchange, so it shares that
thread's signed request counter and never delays the control loop. What goes:

  - event summaries from the outbox, at most `batch` per upload; the server
    answers with the ids it stored (or already had), which leave the outbox;
  - the clock: this robot's estimate of how far its clock is from the
    server's and how sure it is, so the server can show clock uncertainty;
  - one closed segment per upload, only when the server's answer says the
    owner switched raw recording upload on, and a sensitive segment only when
    that is allowed too. Telemetry is otherwise never sent.

A failed upload changes nothing: the outbox keeps its events for the next try.
"""
from __future__ import annotations

import base64
import json
import os
import time

from .recorder import Recorder


class Uploader:
    def __init__(self, recorder: Recorder, every_s: float = 5.0, batch: int = 100, clock=time.time, log=None):
        self.recorder = recorder
        self.every_s = float(every_s)
        self.batch = int(batch)
        self.clock = clock
        self.log = log or (lambda event, **fields: None)
        self._due = 0.0
        self.policy: dict = {"acceptSegments": False, "acceptSensitive": False, "maxSegmentBytes": 0, "enabled": True}
        self._uploaded_path = os.path.join(recorder.directory, "uploaded.json")
        try:
            with open(self._uploaded_path, "r", encoding="utf-8") as handle:
                self._uploaded = set(json.load(handle))
        except (OSError, ValueError, TypeError):
            self._uploaded = set()

    def observe(self, response: dict, sent_ms: int, received_ms: int) -> None:
        server = response.get("serverTime") if isinstance(response, dict) else None
        if isinstance(server, (int, float)):
            self.recorder.observe_server_time(int(server), sent_ms, received_ms)

    def _segment(self) -> dict | None:
        if not self.policy.get("acceptSegments"):
            return None
        limit = int(self.policy.get("maxSegmentBytes") or 0)
        for meta in self.recorder.segments():
            if meta.get("open") or meta["id"] in self._uploaded:
                continue
            if meta.get("sensitivity") == "sensitive" and not self.policy.get("acceptSensitive"):
                continue
            if limit and int(meta.get("bytes") or 0) > limit:
                continue
            try:
                with open(meta["path"], "rb") as handle:
                    content = handle.read()
            except OSError:
                continue
            return {"id": meta["id"], "stream": meta["stream"], "sensitivity": meta.get("sensitivity", "normal"), "fromMs": meta.get("fromMs"), "toMs": meta.get("toMs"),
                    "records": meta.get("records"), "topics": meta.get("topics", []), "compressed": meta["path"].endswith(".gz"), "content": base64.b64encode(content).decode("ascii")}
        return None

    def body(self) -> dict | None:
        events = self.recorder.pending_events(self.batch)
        segment = self._segment()
        if not events and segment is None:
            return None
        body = {"clock": self.recorder.clock_state(), "simulated": self.recorder.simulated, "events": events, "stats": self.recorder.stats()}
        if segment is not None:
            body["segment"] = segment
        return body

    def maybe_upload(self, link, force: bool = False) -> dict | None:
        now = self.clock()
        if not force and now < self._due:
            return None
        self._due = now + self.every_s
        body = self.body()
        if body is None:
            return None
        try:
            answer = link.blackbox(body)
        except Exception as error:  # noqa: BLE001 - LinkError or anything else: try again later
            self.log("blackbox-upload-failed", reason=getattr(error, "reason", "") or str(error))
            return None
        self.apply(body, answer)
        return answer

    def apply(self, body: dict, answer: dict) -> None:
        if not isinstance(answer, dict):
            return
        stored = list(answer.get("accepted") or []) + list(answer.get("duplicates") or [])
        # Refused events are dropped too: the server said why (shown in the log) and sending them again won't change it.
        refused = [item.get("id") for item in answer.get("refused") or [] if isinstance(item, dict)]
        self.recorder.mark_uploaded(stored + refused)
        if isinstance(answer.get("policy"), dict):
            self.policy = {**self.policy, **answer["policy"]}
        segment = body.get("segment")
        if segment and answer.get("segment", {}).get("stored") in (True, "duplicate"):
            self._uploaded.add(segment["id"])
            with open(self._uploaded_path, "w", encoding="utf-8") as handle:
                json.dump(sorted(self._uploaded), handle)
        if refused:
            self.log("blackbox-events-refused", count=len(refused), reasons=sorted({str(item.get("reason")) for item in answer.get("refused") if isinstance(item, dict)}))


__all__ = ["Uploader"]
