"""What the black box records, for how long, and how much disk it may use.

A topic is a slash name such as "motor/state", "sensors/lidar", "nav/pose",
"events/safety". Rules are matched in order; the first rule whose topic (an
exact name, or a prefix ending in "/*", or "*") and device (when the rule
names one) match decides. Each rule says:

  enabled         record this topic at all
  rateHz          at most this many telemetry records a second (events are never thinned)
  retentionHours  how long its segments are kept
  sensitivity     "normal" or "sensitive"
  fields          for telemetry, the only keys kept (omit for all scalar keys)
  raw             for a sensitive topic: keep the payload, not just metadata

Cameras and microphones are never recorded blindly:

  - a topic that looks like a camera, image, depth image, microphone or audio
    stream is sensitive whatever its rule says;
  - a wildcard rule ("*", "sensors/*") never switches one on: only a rule that
    names the topic exactly does;
  - even then only metadata is kept (size, encoding, frame, time), never the
    pixels or samples, unless that rule says raw AND the configuration's
    allowRawSensitive is true.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

SENSITIVE = re.compile(r"(^|[/_.-])(camera|image|images|depth|rgb|video|mic|microphone|audio|sound|voice)([/_.-]|$)", re.IGNORECASE)
RAW_KEYS = {"data", "pixels", "image", "frame_data", "png", "jpeg", "audio", "samples", "pcm", "bytes", "raw"}
SEVERITIES = ("debug", "info", "warning", "error", "critical")
SENSITIVITIES = ("normal", "sensitive")


def sensitive_topic(topic: str) -> bool:
    return bool(SENSITIVE.search(topic or ""))


@dataclass
class TopicRule:
    topic: str
    enabled: bool = True
    rate_hz: float | None = None
    retention_hours: float | None = None
    sensitivity: str = "normal"
    fields: list[str] | None = None
    raw: bool = False
    device: str | None = None

    @staticmethod
    def from_dict(data: dict) -> "TopicRule":
        if not isinstance(data, dict) or not isinstance(data.get("topic"), str) or not data["topic"].strip():
            raise ValueError("every topic rule needs a topic")
        sensitivity = str(data.get("sensitivity", "normal"))
        if sensitivity not in SENSITIVITIES:
            raise ValueError(f"sensitivity must be one of {', '.join(SENSITIVITIES)}")
        rate = data.get("rateHz")
        retention = data.get("retentionHours")
        if rate is not None and (not isinstance(rate, (int, float)) or rate <= 0):
            raise ValueError(f"rateHz for {data['topic']} must be a positive number")
        if retention is not None and (not isinstance(retention, (int, float)) or retention <= 0):
            raise ValueError(f"retentionHours for {data['topic']} must be a positive number")
        fields = data.get("fields")
        if fields is not None and (not isinstance(fields, list) or not all(isinstance(item, str) for item in fields)):
            raise ValueError(f"fields for {data['topic']} must be a list of names")
        return TopicRule(topic=data["topic"].strip(), enabled=bool(data.get("enabled", True)), rate_hz=None if rate is None else float(rate),
                         retention_hours=None if retention is None else float(retention), sensitivity=sensitivity, fields=fields,
                         raw=bool(data.get("raw", False)), device=str(data["device"]) if data.get("device") else None)

    def matches(self, topic: str, device: str | None) -> bool:
        if self.device and self.device != device:
            return False
        if self.topic == "*" or self.topic == topic:
            return True
        return self.topic.endswith("/*") and topic.startswith(self.topic[:-1])

    @property
    def exact(self) -> bool:
        return "*" not in self.topic


DEFAULT_RULES = [
    {"topic": "events/*", "retentionHours": 720},
    {"topic": "motor/*", "rateHz": 10},
    {"topic": "sensors/lidar", "rateHz": 2, "fields": ["ok", "problem", "minRange", "minBearingDeg", "measuredAt", "source"]},
    {"topic": "sensors/camera", "enabled": True, "sensitivity": "sensitive"},
    {"topic": "sensors/*", "rateHz": 1},
    {"topic": "nav/*", "rateHz": 5},
    {"topic": "os/*", "rateHz": 0.2},
    {"topic": "*", "enabled": False},
]


@dataclass
class Decision:
    record: bool
    reason: str = ""
    rule: TopicRule | None = None
    sensitive: bool = False
    metadata_only: bool = False
    retention_hours: float = 72.0


@dataclass
class RecorderConfig:
    enabled: bool = True
    rules: list[TopicRule] = field(default_factory=lambda: [TopicRule.from_dict(item) for item in DEFAULT_RULES])
    retention_hours: float = 72.0
    sensitive_retention_hours: float = 24.0
    max_segment_bytes: int = 4 * 1024 * 1024
    max_segment_seconds: float = 600.0
    max_total_bytes: int = 512 * 1024 * 1024
    max_record_bytes: int = 64 * 1024
    allow_raw_sensitive: bool = False
    compress: bool = True
    upload_events: bool = True
    upload_min_severity: str = "info"
    outbox_max: int = 5000

    @staticmethod
    def from_dict(data: dict) -> "RecorderConfig":
        if not isinstance(data, dict):
            raise ValueError("the black box configuration must be a JSON object")
        config = RecorderConfig()
        if "rules" in data:
            if not isinstance(data["rules"], list):
                raise ValueError("rules must be a list")
            config.rules = [TopicRule.from_dict(item) for item in data["rules"]]
        numbers = {"retentionHours": "retention_hours", "sensitiveRetentionHours": "sensitive_retention_hours", "maxSegmentBytes": "max_segment_bytes",
                   "maxSegmentSeconds": "max_segment_seconds", "maxTotalBytes": "max_total_bytes", "maxRecordBytes": "max_record_bytes", "outboxMax": "outbox_max"}
        for key, name in numbers.items():
            if key in data:
                value = data[key]
                if not isinstance(value, (int, float)) or isinstance(value, bool) or value <= 0:
                    raise ValueError(f"{key} must be a positive number")
                setattr(config, name, type(getattr(config, name))(value))
        for key, name in {"enabled": "enabled", "allowRawSensitive": "allow_raw_sensitive", "compress": "compress", "uploadEvents": "upload_events"}.items():
            if key in data:
                setattr(config, name, bool(data[key]))
        if "uploadMinSeverity" in data:
            if data["uploadMinSeverity"] not in SEVERITIES:
                raise ValueError(f"uploadMinSeverity must be one of {', '.join(SEVERITIES)}")
            config.upload_min_severity = data["uploadMinSeverity"]
        if config.max_segment_bytes > config.max_total_bytes:
            raise ValueError("maxSegmentBytes can't be larger than maxTotalBytes")
        return config

    @staticmethod
    def load(path: str) -> "RecorderConfig":
        with open(path, "r", encoding="utf-8") as handle:
            return RecorderConfig.from_dict(json.load(handle))

    def decide(self, topic: str, device: str | None = None, kind: str = "telemetry") -> Decision:
        if not self.enabled:
            return Decision(False, "recording is switched off")
        sensitive_name = sensitive_topic(topic)
        for rule in self.rules:
            if not rule.matches(topic, device):
                continue
            sensitive = sensitive_name or rule.sensitivity == "sensitive"
            if not rule.enabled:
                return Decision(False, f"rule {rule.topic} switches it off", rule, sensitive)
            # Events are summaries the robot writes itself, never sensor payloads; a camera stream needs a rule naming it.
            if sensitive and not rule.exact and kind != "event":
                return Decision(False, f"{topic} is a camera or microphone stream: only a rule naming it exactly can record it", rule, True)
            metadata_only = sensitive and not (rule.raw and self.allow_raw_sensitive)
            retention = rule.retention_hours or self.retention_hours
            if sensitive:
                # Sensitive data is never kept longer than sensitiveRetentionHours, whatever a rule says.
                retention = min(retention, self.sensitive_retention_hours)
            return Decision(True, "", rule, sensitive, metadata_only, float(retention))
        return Decision(False, "no rule matches")

    def to_dict(self) -> dict:
        return {
            "enabled": self.enabled, "retentionHours": self.retention_hours, "sensitiveRetentionHours": self.sensitive_retention_hours,
            "maxSegmentBytes": self.max_segment_bytes, "maxSegmentSeconds": self.max_segment_seconds, "maxTotalBytes": self.max_total_bytes,
            "maxRecordBytes": self.max_record_bytes, "allowRawSensitive": self.allow_raw_sensitive, "compress": self.compress,
            "uploadEvents": self.upload_events, "uploadMinSeverity": self.upload_min_severity, "outboxMax": self.outbox_max,
            "rules": [{k: v for k, v in {"topic": r.topic, "enabled": r.enabled, "rateHz": r.rate_hz, "retentionHours": r.retention_hours, "sensitivity": r.sensitivity, "fields": r.fields, "raw": r.raw or None, "device": r.device}.items() if v is not None} for r in self.rules],
        }


def strip_payload(data, depth: int = 0):
    """Metadata only: scalars and short strings, never pixel or sample arrays."""
    if depth > 3:
        return None
    if isinstance(data, dict):
        out = {}
        for key, value in data.items():
            if str(key).lower() in RAW_KEYS:
                out[f"{key}Omitted"] = True
                continue
            kept = strip_payload(value, depth + 1)
            if kept is not None:
                out[str(key)] = kept
        return out
    if isinstance(data, (list, tuple)):
        return None if len(data) > 16 or any(isinstance(item, (list, dict)) for item in data) else [item for item in data if isinstance(item, (int, float, str, bool))]
    if isinstance(data, str):
        return data[:200]
    if isinstance(data, (int, float, bool)) or data is None:
        return data
    return None


def select_fields(data: dict, fields: list[str] | None) -> dict:
    if fields is None or not isinstance(data, dict):
        return data
    return {key: data[key] for key in fields if key in data}


__all__ = ["DEFAULT_RULES", "Decision", "RecorderConfig", "SEVERITIES", "TopicRule", "select_fields", "sensitive_topic", "strip_payload"]
