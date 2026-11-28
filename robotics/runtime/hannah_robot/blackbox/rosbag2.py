"""rosbag2: export a recording to a ROS 2 bag, import a bag, and record ROS 2 topics.

Everything here imports ROS lazily, so the runtime and the black box work on a
computer without ROS 2. Each function takes `modules`, a dict with the pieces
it needs ("rosbag2_py", "serialize", "deserialize", "String", optionally
"get_message" and "message_to_ordereddict"); left out, they are imported from
a sourced ROS 2 installation, and Rosbag2Unavailable says what is missing.

  export_segments(paths, uri)   HBX segments -> a bag. Each topic becomes
                                /hannah/<topic> of type std_msgs/msg/String
                                carrying the record as JSON, so `ros2 bag play`
                                replays it and `ros2 bag info` lists it.
  import_bag(uri)               a bag -> black box records: HANNAH's own topics
                                back as they were; other topics converted with
                                rosidl_runtime_py when it is available.
  Rosbag2Recorder               subscribes to ROS 2 topics on an rclpy node and
                                feeds a Recorder, through the same per-topic
                                rules (rate, sensitivity, retention).

Tested here against fakes only. Running it against a real ROS 2 installation
has not been done: BLOCKED_EXTERNAL_DEPENDENCY (no ROS 2 on the development
machine).
"""
from __future__ import annotations

import json

from .config import sensitive_topic
from .format import read_segment

PREFIX = "/hannah/"
STRING_TYPE = "std_msgs/msg/String"


class Rosbag2Unavailable(RuntimeError):
    pass


def load_modules(modules: dict | None = None) -> dict:
    if modules is not None:
        missing = [name for name in ("rosbag2_py", "serialize", "deserialize", "String") if name not in modules]
        if missing:
            raise Rosbag2Unavailable(f"missing ROS 2 pieces: {', '.join(missing)}")
        return modules
    try:
        import rosbag2_py  # type: ignore
        from rclpy.serialization import deserialize_message, serialize_message  # type: ignore
        from std_msgs.msg import String  # type: ignore
    except ImportError as error:
        raise Rosbag2Unavailable(f"rosbag2 needs a sourced ROS 2 installation ({error.name or 'rosbag2_py'} isn't available). Source it first, for example: source /opt/ros/jazzy/setup.bash") from None
    found = {"rosbag2_py": rosbag2_py, "serialize": serialize_message, "deserialize": deserialize_message, "String": String}
    try:
        from rosidl_runtime_py.convert import message_to_ordereddict  # type: ignore
        from rosidl_runtime_py.utilities import get_message  # type: ignore
        found.update({"get_message": get_message, "message_to_ordereddict": message_to_ordereddict})
    except ImportError:
        pass
    return found


def _options(rosbag2_py, uri: str, storage_id: str):
    return rosbag2_py.StorageOptions(uri=uri, storage_id=storage_id), rosbag2_py.ConverterOptions(input_serialization_format="cdr", output_serialization_format="cdr")


def _topic_metadata(rosbag2_py, name: str, type_: str, index: int):
    try:
        return rosbag2_py.TopicMetadata(name=name, type=type_, serialization_format="cdr")
    except TypeError:
        # Jazzy and later also want an id.
        return rosbag2_py.TopicMetadata(id=index, name=name, type=type_, serialization_format="cdr")


class Rosbag2Writer:
    def __init__(self, uri: str, storage_id: str = "mcap", modules: dict | None = None):
        self.m = load_modules(modules)
        self._writer = self.m["rosbag2_py"].SequentialWriter()
        self._writer.open(*_options(self.m["rosbag2_py"], uri, storage_id))
        self._topics: set[str] = set()
        self.count = 0

    def write(self, topic: str, record: dict, t_ns: int) -> None:
        name = PREFIX + topic.strip("/")
        if name not in self._topics:
            self._writer.create_topic(_topic_metadata(self.m["rosbag2_py"], name, STRING_TYPE, len(self._topics)))
            self._topics.add(name)
        message = self.m["String"]()
        message.data = json.dumps(record, separators=(",", ":"), sort_keys=True)
        self._writer.write(name, self.m["serialize"](message), int(t_ns))
        self.count += 1

    def close(self) -> None:
        closer = getattr(self._writer, "close", None)
        if callable(closer):
            closer()
        self._writer = None


def export_segments(paths, uri: str, storage_id: str = "mcap", modules: dict | None = None, include_sensitive: bool = False) -> dict:
    """Write HBX segments to a bag. Sensitive segments are left out unless asked for."""
    writer = Rosbag2Writer(uri, storage_id, modules)
    skipped = []
    try:
        records = []
        for path in paths:
            header, items, _info = read_segment(path)
            if header.get("sensitivity") == "sensitive" and not include_sensitive:
                skipped.append(header.get("segment"))
                continue
            for item in items:
                records.append({**item, "simulated": bool(header.get("simulated")), "robotId": header.get("robotId")})
        for item in sorted(records, key=lambda value: (int(value.get("t") or 0), int(value.get("seq") or 0))):
            writer.write(str(item.get("topic") or "misc"), item, int(item.get("t") or 0) * 1_000_000)
    finally:
        count = writer.count
        writer.close()
    return {"uri": uri, "messages": count, "skippedSensitiveSegments": skipped}


def import_bag(uri: str, storage_id: str = "mcap", modules: dict | None = None, topics=None) -> list[dict]:
    """Read a bag into black box records, oldest first."""
    m = load_modules(modules)
    reader = m["rosbag2_py"].SequentialReader()
    reader.open(*_options(m["rosbag2_py"], uri, storage_id))
    types = {meta.name: meta.type for meta in reader.get_all_topics_and_types()}
    wanted = set(topics) if topics else None
    out = []
    while reader.has_next():
        name, data, t_ns = reader.read_next()
        if wanted is not None and name not in wanted:
            continue
        type_ = types.get(name, "")
        if name.startswith(PREFIX) and type_ == STRING_TYPE:
            message = m["deserialize"](data, m["String"])
            try:
                record = json.loads(message.data)
            except ValueError:
                continue
            out.append(record)
            continue
        if "get_message" not in m or "message_to_ordereddict" not in m:
            continue
        message = m["deserialize"](data, m["get_message"](type_))
        out.append({"t": int(t_ns // 1_000_000), "topic": name.strip("/"), "kind": "telemetry", "rosType": type_, "data": json.loads(json.dumps(m["message_to_ordereddict"](message), default=str)),
                    **({"sensitive": True} if sensitive_topic(name) else {})})
    return out


class Rosbag2Recorder:
    """Feed a Recorder from ROS 2 topics. `topics` maps a ROS topic to {"topic": black box name, "type": "pkg/msg/Type"}.

    A ROS topic that looks like a camera or microphone stream must map to a black box name that does too
    (sensors/camera...), so the recorder's sensitivity rules can't be sidestepped by renaming it.
    """

    def __init__(self, node, recorder, topics: dict, modules: dict | None = None, qos_depth: int = 10):
        self.node = node
        self.recorder = recorder
        self.m = modules if modules is not None else load_modules(None)
        if "get_message" not in self.m or "message_to_ordereddict" not in self.m:
            raise Rosbag2Unavailable("recording ROS 2 topics needs rosidl_runtime_py")
        self.subscriptions = []
        for ros_topic, spec in topics.items():
            target = str(spec.get("topic") or "")
            if not target:
                raise ValueError(f"{ros_topic} needs a black box topic name")
            if sensitive_topic(ros_topic) and not sensitive_topic(target):
                raise ValueError(f"{ros_topic} is a camera or microphone stream; record it under a camera or microphone name (for example sensors/camera), not {target}")
            message_type = self.m["get_message"](spec["type"])
            self.subscriptions.append(node.create_subscription(message_type, ros_topic, self._callback(target, spec.get("device")), qos_depth))

    def _callback(self, target: str, device):
        def receive(message) -> None:
            data = json.loads(json.dumps(self.m["message_to_ordereddict"](message), default=str))
            self.recorder.record(target, data, device=device)
        return receive


__all__ = ["PREFIX", "Rosbag2Recorder", "Rosbag2Unavailable", "Rosbag2Writer", "STRING_TYPE", "export_segments", "import_bag", "load_modules"]
