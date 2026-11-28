"""The black box: its file format, its rules, the recorder, the runtime hook, upload, rosbag2 (fakes) and replay.

Everything runs on HANNAH's built-in simulator and a hand-moved clock. The
rosbag2 tests use stand-in modules; a run against a real ROS 2 installation is
BLOCKED_EXTERNAL_DEPENDENCY.
"""
import base64
import gzip
import json
import os
import shutil
import tempfile
import types
import unittest

from hannah_robot.blackbox import Recorder, RecorderConfig, RuntimeRecorder, Uploader
from hannah_robot.blackbox.config import sensitive_topic
from hannah_robot.blackbox.format import FormatError, SegmentWriter, read_bytes, read_segment
from hannah_robot.blackbox.replay import PlaybackAdapter, load_recording, mission_timeline, reproduce, scenario_from_recording
from hannah_robot.blackbox import rosbag2
from hannah_robot.scenarios import run_scenario_data

from .helpers import WORLD_PATH, Bench, world

PLACES = world()["places"]


class Folder(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="hbx-")
        self.now = 1_800_000_000.0

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def recorder(self, config=None, **kw):
        return Recorder(self.dir, "rb_000000000000000001", config or RecorderConfig(), simulated=True, clock=lambda: self.now, **kw)


class Format(Folder):
    def test_a_closed_segment_is_verified_and_a_changed_one_is_refused(self):
        writer = SegmentWriter(os.path.join(self.dir, "a.hbx"), {"segment": "seg_1", "robotId": "r", "stream": "nav-72h", "openedAt": 1, "simulated": True})
        for n in range(3):
            writer.append({"seq": n + 1, "t": 1000 + n, "topic": "nav/pose", "kind": "telemetry", "data": {"x": n}})
        path = writer.close(2000)
        self.assertTrue(path.endswith(".hbx.gz"))
        header, records, info = read_segment(path)
        self.assertEqual(header["format"], "hannah-blackbox")
        self.assertEqual([item["data"]["x"] for item in records], [0, 1, 2])
        self.assertTrue(info["verified"])
        raw = gzip.decompress(open(path, "rb").read()).replace(b'"x":1', b'"x":9')
        with self.assertRaises(FormatError):
            read_bytes(raw)

    def test_a_segment_cut_short_by_power_loss_is_still_read_and_marked_unverified(self):
        writer = SegmentWriter(os.path.join(self.dir, "b.hbx"), {"segment": "seg_2", "robotId": "r", "openedAt": 1})
        writer.append({"seq": 1, "t": 1, "topic": "motor/state", "kind": "telemetry", "data": {"linear": 0.2}})
        writer._file.write(b'{"seq":2,"t":2,"topic":"mot')
        writer._file.close()
        _header, records, info = read_segment(writer.path)
        self.assertEqual(len(records), 1)
        self.assertFalse(info["closed"])
        self.assertTrue(info["truncated"])
        self.assertFalse(info["verified"])
        with self.assertRaises(FormatError):
            read_bytes(b'{"format":"something-else"}\n')


class Rules(Folder):
    def test_cameras_and_microphones_are_never_recorded_blindly(self):
        self.assertTrue(sensitive_topic("sensors/camera"))
        self.assertTrue(sensitive_topic("/front_camera/image_raw"))
        self.assertTrue(sensitive_topic("audio/mic"))
        self.assertFalse(sensitive_topic("sensors/lidar"))
        config = RecorderConfig.from_dict({"rules": [{"topic": "*", "enabled": True}]})
        self.assertFalse(config.decide("sensors/camera").record, "a wildcard never switches a camera on")
        self.assertFalse(config.decide("audio/microphone").record)
        self.assertTrue(config.decide("sensors/lidar").record)
        # Named exactly: metadata only, unless the rule says raw AND raw sensitive data is allowed.
        named = RecorderConfig.from_dict({"rules": [{"topic": "sensors/camera", "raw": True}]})
        self.assertTrue(named.decide("sensors/camera").metadata_only)
        allowed = RecorderConfig.from_dict({"allowRawSensitive": True, "rules": [{"topic": "sensors/camera", "raw": True}]})
        self.assertFalse(allowed.decide("sensors/camera").metadata_only)
        # A rule can't call a camera "normal" or keep it longer than sensitive data may be kept.
        long = RecorderConfig.from_dict({"sensitiveRetentionHours": 12, "rules": [{"topic": "sensors/camera", "sensitivity": "normal", "retentionHours": 999}]})
        decision = long.decide("sensors/camera")
        self.assertTrue(decision.sensitive)
        self.assertEqual(decision.retention_hours, 12)

    def test_the_recorded_camera_record_holds_metadata_and_never_pixels(self):
        recorder = self.recorder(RecorderConfig.from_dict({"rules": [{"topic": "sensors/camera"}]}))
        self.assertTrue(recorder.record("sensors/camera", {"width": 640, "height": 480, "encoding": "rgb8", "data": "AAAA" * 100, "pixels": [1, 2, 3]}))
        recorder.flush()
        header, records, _ = read_segment(recorder.segments()[0]["path"])
        self.assertEqual(header["sensitivity"], "sensitive")
        self.assertEqual(records[0]["data"], {"width": 640, "height": 480, "encoding": "rgb8", "dataOmitted": True, "pixelsOmitted": True})

    def test_bad_rules_are_refused_with_the_reason(self):
        for bad, words in [({"rules": [{"enabled": True}]}, "needs a topic"), ({"rules": [{"topic": "a", "rateHz": -1}]}, "positive"), ({"maxSegmentBytes": 10, "maxTotalBytes": 5}, "larger"),
                           ({"rules": [{"topic": "a", "sensitivity": "secret"}]}, "sensitivity"), ({"uploadMinSeverity": "loud"}, "uploadMinSeverity")]:
            with self.assertRaises(ValueError) as caught:
                RecorderConfig.from_dict(bad)
            self.assertIn(words, str(caught.exception))

    def test_a_rule_can_name_one_device(self):
        config = RecorderConfig.from_dict({"rules": [{"topic": "motor/*", "device": "left-wheel"}, {"topic": "motor/*", "enabled": False}]})
        self.assertTrue(config.decide("motor/state", "left-wheel").record)
        self.assertFalse(config.decide("motor/state", "right-wheel").record)


class Recording(Folder):
    def test_telemetry_is_thinned_to_its_rate_and_events_never_are(self):
        recorder = self.recorder()
        kept = 0
        for _ in range(100):  # 10 s at 10 Hz on nav/* (5 Hz)
            kept += recorder.record("nav/pose", {"x": 1, "y": 2})
            recorder.event("safety", "estop-engaged", "error", "The emergency stop was engaged.")
            self.now += 0.1
        self.assertEqual(kept, 50)
        self.assertEqual(recorder.stats()["dropped"]["rate"], 50)
        self.assertEqual(len(recorder.pending_events(1000)), 100)

    def test_segments_rotate_and_expire_by_their_own_retention(self):
        recorder = self.recorder(RecorderConfig.from_dict({"maxSegmentBytes": 2000, "rules": [{"topic": "nav/*", "retentionHours": 1}, {"topic": "events/*", "retentionHours": 48}]}))
        for n in range(60):
            recorder.record("nav/pose", {"x": n, "y": 0.5, "note": "x" * 50})
            self.now += 1
        recorder.event("navigation", "nav-failed", "error", "No path to the goal.")
        recorder.flush()
        nav = [item for item in recorder.segments() if item["stream"].startswith("nav-")]
        self.assertGreater(len(nav), 1, "a segment closes at maxSegmentBytes")
        self.assertTrue(all(item["stream"] == "nav-1h" for item in nav))
        self.now += 2 * 3600
        removed = recorder.sweep()
        self.assertEqual(sorted(removed), sorted(item["id"] for item in nav))
        self.assertEqual([item["stream"] for item in recorder.segments()], ["events-48h"])
        self.assertTrue(all(not os.path.exists(item["path"]) for item in nav))

    def test_the_size_cap_deletes_old_telemetry_before_events(self):
        recorder = self.recorder(RecorderConfig.from_dict({"maxSegmentBytes": 1500, "maxTotalBytes": 6000, "compress": False}))
        recorder.event("safety", "estop-engaged", "error", "The emergency stop was engaged.")
        recorder.flush()
        for n in range(400):
            recorder.record("motor/state", {"linear": n, "pad": "y" * 40})
            self.now += 0.2
        self.assertLessEqual(recorder.total_bytes(), 6000)
        self.assertIn("events-720h", [item["stream"] for item in recorder.segments()], "the event survives while telemetry is pruned")

    def test_the_outbox_and_index_survive_a_restart(self):
        recorder = self.recorder()
        event = recorder.event("link", "link-lost", "warning", "No contact with HANNAH for 6 s.")
        recorder.record("nav/pose", {"x": 1})
        recorder.flush()
        os.remove(os.path.join(self.dir, "index.json"))
        again = self.recorder()
        self.assertEqual([item["id"] for item in again.pending_events()], [event["id"]])
        self.assertEqual(sorted(item["stream"] for item in again.segments()), ["events-720h", "nav-72h"])
        self.assertEqual(again.mark_uploaded([event["id"]]), 1)
        self.assertEqual(self.recorder().pending_events(), [])

    def test_clock_uncertainty_comes_from_the_round_trip_and_goes_stale(self):
        recorder = self.recorder()
        self.assertFalse(recorder.clock_state()["synced"])
        sent = int(self.now * 1000)
        state = recorder.observe_server_time(sent + 5_150, sent, sent + 300)
        self.assertEqual(state["offsetMs"], 5000)
        self.assertEqual(state["uncertaintyMs"], 151)
        event = recorder.event("os", "boot", "info", "Started.")
        self.assertEqual(event["clock"], {"synced": True, "offMs": 5000, "uncMs": 151})
        self.now += 11 * 60
        self.assertFalse(recorder.clock_state()["synced"], "an old comparison doesn't say how far the clock drifted since")

    def test_switched_off_means_nothing_is_written(self):
        recorder = self.recorder(RecorderConfig.from_dict({"enabled": False}))
        self.assertFalse(recorder.record("nav/pose", {"x": 1}))
        self.assertIsNone(recorder.event("safety", "estop-engaged", "error", "x"))
        self.assertEqual(recorder.segments(), [])


def recorded_bench(folder: Folder):
    bench = Bench()
    recorder = Recorder(folder.dir, "rb_000000000000000001", RecorderConfig(), simulated=True, clock=lambda: bench.now)
    bench.runtime.blackbox = RuntimeRecorder(recorder)
    return bench, recorder


class RuntimeHook(Folder):
    def test_an_emergency_stop_mid_mission_is_recorded_and_reproduced_in_the_simulator(self):
        bench, recorder = recorded_bench(self)
        goal = {"x": PLACES["shelves"]["x"], "y": PLACES["shelves"]["y"], "tolerance": 0.25}
        command = bench.command("navigate_to", goal)
        bench.exchange(command)
        bench.run(4.0)
        bench.sim.press_estop(True)
        bench.run(2.0)
        recorder.flush()
        recording = load_recording(self.dir)
        types_ = [item["data"]["type"] for item in recording["records"] if item["kind"] == "event"]
        for expected in ("mission-issued", "mission-accepted", "estop-engaged", "mission-failed", "mode-changed"):
            self.assertIn(expected, types_)
        self.assertLess(types_.index("estop-engaged"), types_.index("mission-failed"))
        topics = {item["topic"] for item in recording["records"]}
        self.assertTrue({"motor/state", "nav/pose", "nav/status", "sensors/lidar", "sensors/battery-state", "os/link"} <= topics)
        lidar = next(item for item in recording["records"] if item["topic"] == "sensors/lidar")
        self.assertNotIn("ranges", lidar["data"], "only the fields the rule keeps")
        timeline = mission_timeline(recording["records"], command["missionId"])
        self.assertEqual(timeline["outcome"]["details"]["status"], "failed")
        self.assertGreater(len(timeline["track"]), 5)
        stop = next(item for item in recording["records"] if item.get("kind") == "event" and item["data"]["type"] == "estop-engaged")
        self.assertTrue(stop["data"]["refs"], "an event points at the telemetry around it")
        # The same inputs in the built-in simulator give the same outcome.
        result = reproduce(recording["records"], command["missionId"], world_ref=WORLD_PATH, base_dir=os.path.dirname(WORLD_PATH), world=world())
        self.assertTrue(result["same"], result)
        self.assertEqual(result["recorded"], "failed")
        self.assertIn("estop", json.dumps(result["scenario"]["steps"][-1]["during"]))
        self.assertIn("not on the robot", result["note"])

    def test_a_sensor_that_stops_reporting_becomes_an_event_and_a_scenario(self):
        bench, recorder = recorded_bench(self)
        command = bench.command("navigate_to", {"x": PLACES["shelves"]["x"], "y": PLACES["shelves"]["y"], "tolerance": 0.25})
        bench.exchange(command)
        bench.run(3.0)
        bench.sim.sensor_faults = {"lidar"}
        bench.run(3.0)
        recorder.flush()
        records = load_recording(self.dir)["records"]
        lost = [item for item in records if item.get("kind") == "event" and item["data"]["type"] == "sensor-lost"]
        self.assertEqual([item["device"] for item in lost], ["lidar"])
        self.assertIn("nav-failed", [item["data"]["type"] for item in records if item.get("kind") == "event"])
        scenario = scenario_from_recording(records, command["missionId"], world_ref=WORLD_PATH, world=world(), recorded_on="simulation")
        self.assertEqual(scenario["steps"][-1]["expect"], "failed")
        self.assertEqual(scenario["steps"][-1]["during"][0]["sensorFaults"], ["lidar"])
        self.assertEqual(scenario["source"]["recordedOn"], "simulation")
        result = run_scenario_data(scenario, os.path.dirname(WORLD_PATH))
        self.assertTrue(result["passed"], result["problems"])

    def test_a_mission_without_a_drive_goal_cannot_become_a_scenario(self):
        bench, recorder = recorded_bench(self)
        command = bench.command("set_supported_device_state", {"device": "beacon", "state": "on"})
        bench.exchange(command)
        bench.run(2.0)
        recorder.flush()
        with self.assertRaises(ValueError):
            scenario_from_recording(load_recording(self.dir)["records"], command["missionId"])
        with self.assertRaises(ValueError):
            scenario_from_recording(load_recording(self.dir)["records"], "ms_unknown")

    def test_a_broken_black_box_never_stops_the_runtime(self):
        bench = Bench()
        logged = []
        bench.runtime.log = lambda event, **fields: logged.append(event)

        class Broken:
            def __getattr__(self, name):
                def fail(*_args):
                    raise OSError("disk full")
                return fail
        bench.runtime.blackbox = Broken()
        command = bench.command("navigate_to", {"x": PLACES["shelves"]["x"], "y": PLACES["shelves"]["y"], "tolerance": 0.25})
        bench.exchange(command)
        bench.run(60.0, until=lambda: bench.runtime._active is None)
        self.assertEqual(bench.statuses(command["missionId"]), ["accepted", "succeeded"])
        self.assertIn("blackbox-error", logged)


class Upload(Folder):
    class FakeLink:
        def __init__(self, answer=None, fail=False):
            self.bodies, self.answer, self.fail = [], answer, fail

        def blackbox(self, body):
            self.bodies.append(body)
            if self.fail:
                raise OSError("offline")
            return self.answer(body) if callable(self.answer) else self.answer

    def test_summaries_go_up_and_leave_the_outbox_only_when_the_server_stored_them(self):
        recorder = self.recorder()
        first = recorder.event("safety", "estop-engaged", "error", "The emergency stop was engaged.", details={"image": "bytes", "where": "aisle"})
        uploader = Uploader(recorder, clock=lambda: self.now)
        offline = self.FakeLink(fail=True)
        self.assertIsNone(uploader.maybe_upload(offline))
        self.assertEqual(len(recorder.pending_events()), 1, "a failed upload loses nothing")
        link = self.FakeLink(lambda body: {"accepted": [item["id"] for item in body["events"]], "duplicates": [], "refused": [], "policy": {"acceptSegments": False}})
        self.now += 10
        uploader.maybe_upload(link)
        sent = link.bodies[0]
        self.assertEqual(sent["events"][0]["id"], first["id"])
        self.assertEqual(sent["events"][0]["details"], {"imageOmitted": True, "where": "aisle"})
        self.assertTrue(sent["simulated"])
        self.assertNotIn("segment", sent, "telemetry is never sent unless the owner allows it")
        self.assertEqual(recorder.pending_events(), [])

    def test_a_closed_segment_goes_up_only_when_allowed_and_a_sensitive_one_only_when_that_is_allowed_too(self):
        recorder = self.recorder(RecorderConfig.from_dict({"rules": [{"topic": "sensors/camera"}, {"topic": "nav/*"}, {"topic": "events/*"}]}))
        recorder.record("nav/pose", {"x": 1})
        recorder.record("sensors/camera", {"width": 64})
        recorder.event("os", "boot", "info", "Started.")
        recorder.flush()
        uploader = Uploader(recorder, clock=lambda: self.now)
        uploader.policy = {"acceptSegments": True, "acceptSensitive": False, "maxSegmentBytes": 1_000_000}
        stored = []

        def answer(body):
            if body.get("segment"):
                stored.append(body["segment"])
            return {"accepted": [item["id"] for item in body["events"]], "segment": {"stored": True} if body.get("segment") else None}
        link = self.FakeLink(answer)
        for _ in range(4):
            uploader.maybe_upload(link, force=True)
        self.assertEqual(sorted(item["stream"] for item in stored), ["events-72h", "nav-72h"])
        header, _records, info = read_bytes(base64.b64decode(stored[0]["content"]))
        self.assertTrue(info["verified"])
        self.assertEqual(header["robotId"], "rb_000000000000000001")


def fake_ros():
    """Stand-ins for rosbag2_py, rclpy.serialization and std_msgs: the same calls, kept in memory."""
    bags = {}

    class StorageOptions:
        def __init__(self, uri, storage_id):
            self.uri, self.storage_id = uri, storage_id

    class ConverterOptions:
        def __init__(self, input_serialization_format, output_serialization_format):
            pass

    class TopicMetadata:
        def __init__(self, name, type, serialization_format, id=None):  # noqa: A002 - rosbag2_py's own names
            self.name, self.type = name, type

    class SequentialWriter:
        def open(self, storage, _converter):
            self.bag = bags.setdefault(storage.uri, {"topics": {}, "messages": []})

        def create_topic(self, meta):
            self.bag["topics"][meta.name] = meta

        def write(self, topic, data, t):
            assert topic in self.bag["topics"], "a topic is created before it is written"
            self.bag["messages"].append((topic, data, t))

    class SequentialReader:
        def open(self, storage, _converter):
            self.bag, self.at = bags[storage.uri], 0

        def get_all_topics_and_types(self):
            return list(self.bag["topics"].values())

        def has_next(self):
            return self.at < len(self.bag["messages"])

        def read_next(self):
            self.at += 1
            return self.bag["messages"][self.at - 1]

    class String:
        data = ""

    module = types.SimpleNamespace(StorageOptions=StorageOptions, ConverterOptions=ConverterOptions, TopicMetadata=TopicMetadata, SequentialWriter=SequentialWriter, SequentialReader=SequentialReader)

    def deserialize(data, kind):
        message = kind()
        message.data = data.decode("utf-8") if kind is String else json.loads(data)
        return message
    return bags, {"rosbag2_py": module, "serialize": lambda message: message.data.encode("utf-8"), "deserialize": deserialize, "String": String,
                  "get_message": lambda name: type(name.replace("/", "_"), (), {}), "message_to_ordereddict": lambda message: {"value": getattr(message, "data", None)}}


class Rosbag2(Folder):
    def test_a_recording_exports_to_a_bag_and_comes_back(self):
        recorder = self.recorder(RecorderConfig.from_dict({"rules": [{"topic": "sensors/camera"}, {"topic": "*"}]}))
        recorder.record("nav/pose", {"x": 1.5, "y": -2})
        recorder.event("safety", "estop-engaged", "error", "The emergency stop was engaged.")
        recorder.record("sensors/camera", {"width": 64})
        recorder.flush()
        bags, modules = fake_ros()
        paths = [item["path"] for item in recorder.segments()]
        result = rosbag2.export_segments(paths, "bag1", modules=modules)
        self.assertEqual(result["messages"], 2)
        self.assertEqual(len(result["skippedSensitiveSegments"]), 1, "sensitive segments stay out unless asked for")
        self.assertEqual(sorted(bags["bag1"]["topics"]), ["/hannah/events/safety", "/hannah/nav/pose"])
        self.assertTrue(all(meta.type == "std_msgs/msg/String" for meta in bags["bag1"]["topics"].values()))
        back = rosbag2.import_bag("bag1", modules=modules)
        self.assertEqual([item["topic"] for item in back], ["nav/pose", "events/safety"])
        self.assertTrue(all(item["simulated"] for item in back))

    def test_ros_topics_feed_the_recorder_through_its_rules_and_a_camera_cannot_be_renamed_out_of_them(self):
        recorder = self.recorder()
        _bags, modules = fake_ros()
        subscriptions = []
        node = types.SimpleNamespace(create_subscription=lambda kind, topic, callback, depth: subscriptions.append((topic, callback)) or callback)
        with self.assertRaises(ValueError):
            rosbag2.Rosbag2Recorder(node, recorder, {"/camera/image_raw": {"topic": "sensors/front", "type": "sensor_msgs/msg/Image"}}, modules=modules)
        rosbag2.Rosbag2Recorder(node, recorder, {"/scan": {"topic": "sensors/lidar", "type": "sensor_msgs/msg/LaserScan"}}, modules=modules)
        message = types.SimpleNamespace(data=3.5)
        subscriptions[-1][1](message)
        recorder.flush()
        _header, records, _ = read_segment(recorder.segments()[0]["path"])
        self.assertEqual(records[0]["topic"], "sensors/lidar")

    def test_without_ros_it_says_what_is_missing(self):
        with self.assertRaises(rosbag2.Rosbag2Unavailable):
            rosbag2.load_modules({"rosbag2_py": object()})
        try:
            import rosbag2_py  # noqa: F401
        except ImportError:
            with self.assertRaises(rosbag2.Rosbag2Unavailable) as caught:
                rosbag2.load_modules()
            self.assertIn("ROS 2", str(caught.exception))


class Playback(Folder):
    def test_playback_replays_recorded_state_is_always_labelled_and_never_moves(self):
        bench, recorder = recorded_bench(self)
        command = bench.command("navigate_to", {"x": PLACES["shelves"]["x"], "y": PLACES["shelves"]["y"], "tolerance": 0.25})
        bench.exchange(command)
        bench.run(5.0)
        recorder.flush()
        records = load_recording(self.dir)["records"]
        adapter = PlaybackAdapter(records, world=world())
        self.assertEqual(adapter.describe()["simulation"]["kind"], "playback")
        self.assertNotIn("navigate_to", adapter.describe()["capabilities"])
        adapter.step(0.0)
        first = adapter.state()["pose"]
        adapter.step(3.0)
        later = adapter.state()
        self.assertFalse(later["playback"]["live"])
        self.assertNotEqual(first, later["pose"], "the recorded track plays back")
        self.assertFalse(later["motorsEnabled"])
        adapter.navigate({"x": 0, "y": 0}, 0.5, 0.25)
        self.assertEqual(adapter.navigation_status().state, "failed")
        adapter.seek(adapter.end_ms)
        self.assertTrue(adapter.finished)


if __name__ == "__main__":
    unittest.main()
