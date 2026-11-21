"""Unit and simulation tests for the camera path: frames, the detector, the simulated camera and the capture capability.

The camera here is HANNAH's built-in simulator rendering by ray casting. No
physical camera, no Gazebo, and no learned vision model is involved.
"""
import base64
import struct
import unittest
import zlib

from hannah_robot.vision import ColourRegionDetector, Frame, capture_result, encode_png, png_size, provider

from .helpers import Bench, simulator

GREY, RED, BLUE = (120, 120, 126), (205, 45, 45), (45, 85, 205)


def frame_of(width, height, paint, depth=None, pose=None):
    pixels = [[GREY for _ in range(width)] for _ in range(height)]
    for (left, top, w, h), colour in paint:
        for row in range(top, top + h):
            for col in range(left, left + w):
                pixels[row][col] = colour
    return Frame(width=width, height=height, pixels=pixels, sensor="camera", number=7, at_ms=1_800_000_000_123, fov_deg=70.0, source="test pattern", depth=depth, depth_source="test depth" if depth else "", pose=pose)


def decode_png(data):
    """Read back an 8-bit RGB PNG written by encode_png."""
    width, height = png_size(data)
    offset, raw = 8, b""
    while offset < len(data):
        (length,) = struct.unpack(">I", data[offset:offset + 4])
        kind = data[offset + 4:offset + 8]
        body = data[offset + 8:offset + 8 + length]
        (crc,) = struct.unpack(">I", data[offset + 8 + length:offset + 12 + length])
        assert crc == zlib.crc32(kind + body) & 0xFFFFFFFF
        if kind == b"IDAT":
            raw += body
        offset += 12 + length
    flat = zlib.decompress(raw)
    stride = 1 + width * 3
    return [[tuple(flat[row * stride + 1 + col * 3:row * stride + 4 + col * 3]) for col in range(width)] for row in range(height)]


class Frames(unittest.TestCase):
    def test_a_frame_becomes_a_png_that_reads_back_as_the_same_pixels(self):
        frame = frame_of(8, 6, [((1, 1, 3, 2), RED)])
        data = encode_png(frame)
        self.assertEqual(png_size(data), (8, 6))
        self.assertEqual(decode_png(data), [list(row) for row in frame.pixels])
        self.assertIsNone(png_size(b"not an image"))

    def test_a_frame_says_which_sensor_which_frame_when_and_from_where(self):
        meta = frame_of(8, 6, [], pose={"x": 1.0, "y": 2.0, "yaw": 0.0, "frame": "map"}).meta()
        self.assertEqual([meta["sensor"], meta["frame"], meta["capturedAt"], meta["width"], meta["height"], meta["source"]], ["camera", 7, 1_800_000_000_123, 8, 6, "test pattern"])
        self.assertEqual(meta["pose"]["frame"], "map")
        self.assertIsNone(meta["depth"])


class Detector(unittest.TestCase):
    def test_coloured_regions_are_found_with_their_box_and_everything_needed_to_trace_them(self):
        found = ColourRegionDetector().detect(frame_of(40, 30, [((4, 5, 10, 8), RED), ((25, 10, 6, 12), BLUE), ((0, 0, 2, 2), RED)]))
        self.assertEqual([item["label"] for item in found], ["red region", "blue region"], "a speck of four pixels is not a detection")
        red = found[0]
        self.assertEqual(red["box"], {"x": 4, "y": 5, "w": 10, "h": 8})
        self.assertEqual([red["pixels"], red["model"], red["modelVersion"], red["sensor"], red["frame"], red["capturedAt"]], [80, "hannah-colour-regions", "1", "camera", 7, 1_800_000_000_123])
        self.assertTrue(0 < red["confidence"] <= 0.95)
        # Left of centre in the image is to the robot's left: a positive bearing.
        self.assertGreater(red["bearingDeg"], 0)
        self.assertLess(found[1]["bearingDeg"], 0)

    def test_without_depth_there_is_no_distance_and_no_position(self):
        found = ColourRegionDetector().detect(frame_of(40, 30, [((4, 5, 10, 8), RED)]))
        self.assertNotIn("distanceM", found[0])
        self.assertNotIn("position", found[0])

    def test_with_depth_the_distance_and_position_say_where_they_came_from(self):
        depth = [3.0] * 15 + [2.0] * 10 + [3.0] * 15
        found = ColourRegionDetector().detect(frame_of(40, 30, [((15, 5, 10, 8), RED)], depth=depth, pose={"x": 1.0, "y": 1.0, "yaw": 0.0, "frame": "map"}))
        self.assertEqual([found[0]["distanceM"], found[0]["distanceSource"]], [2.0, "test depth"])
        self.assertEqual([found[0]["position"]["x"], found[0]["position"]["y"], found[0]["position"]["frame"]], [3.0, 1.0, "map"])
        self.assertIn("the robot's own position estimate", found[0]["position"]["source"])

    def test_grey_is_not_a_detection_and_the_detector_says_what_it_cannot_do(self):
        self.assertEqual(ColourRegionDetector().detect(frame_of(40, 30, [])), [])
        described = ColourRegionDetector().describe()
        self.assertIn("not a learned model", described["kind"])
        self.assertIn("recognise people", described["cannot"])

    def test_an_unknown_provider_is_an_error_not_a_fallback(self):
        self.assertEqual(provider().name, "hannah-colour-regions")
        with self.assertRaises(ValueError):
            provider("yolo-v99")


class SimulatedCamera(unittest.TestCase):
    def facing(self, x, y, yaw):
        sim = simulator()
        sim.x, sim.y, sim.yaw = x, y, yaw
        sim.odom_x, sim.odom_y, sim.odom_yaw = x, y, yaw
        return sim

    def test_it_is_registered_with_its_frame_resolution_and_message_type(self):
        sensors = {sensor["id"]: sensor for sensor in simulator().describe()["sensors"]}
        camera = sensors["camera"]
        self.assertEqual([camera["type"], camera["frame"], camera["resolution"], camera["messageType"]], ["rgbd-camera", "camera_link", "64x48, 70 degrees", "sensor_msgs/msg/Image, sensor_msgs/msg/CameraInfo"])
        self.assertIn("simulated", camera["calibration"])
        self.assertEqual([sensors["lidar"]["frame"], sensors["lidar"]["rateHz"], sensors["lidar"]["messageType"]], ["laser", 5.0, "sensor_msgs/msg/LaserScan"])
        self.assertIn("capture_image", simulator().describe()["capabilities"])

    def test_nothing_is_rendered_until_a_picture_is_asked_for(self):
        sim = simulator()
        sim.advance(3.0)
        reading = sim.state()["sensors"]["camera"]
        self.assertEqual([reading["ok"], reading["framesCaptured"], reading["lastCapturedAt"]], [True, 0, None])
        self.assertNotIn("pixels", reading)
        sim.capture("camera")
        self.assertEqual(sim.state()["sensors"]["camera"]["framesCaptured"], 1)

    def test_a_red_crate_is_detected_where_the_simulator_put_it(self):
        # One metre and a half west of the red crate stack (x 1.6 to 2.5, y -2.6 to -1.7), looking east.
        sim = self.facing(0.1, -2.15, 0.0)
        frame = sim.capture("camera")
        self.assertEqual([frame.width, frame.height, frame.sensor, frame.number], [64, 48, "camera", 1])
        self.assertIn("simulated camera", frame.source)
        found = ColourRegionDetector().detect(frame)
        red = [item for item in found if item["colour"] == "red"]
        self.assertEqual(len(red), 1, found)
        self.assertAlmostEqual(red[0]["distanceM"], 1.5, delta=0.05)
        self.assertAlmostEqual(red[0]["bearingDeg"], 0.0, delta=3.0)
        self.assertAlmostEqual(red[0]["position"]["x"], 1.6, delta=0.06)
        self.assertEqual(red[0]["distanceSource"], "simulated depth (ray cast)")

    def test_an_object_put_down_in_front_of_it_shows_and_a_grey_one_does_not(self):
        sim = self.facing(-4.3, -3.3, 0.0)
        # From the dock it faces a grey divider; the blue pillar is just in view, far off to the left.
        before = ColourRegionDetector().detect(sim.capture("camera"))
        self.assertEqual([item["label"] for item in before], ["blue region"])
        self.assertGreater(before[0]["distanceM"], 5.0)
        self.assertGreater(before[0]["bearingDeg"], 25.0)
        sim.place_obstacle({"name": "cone", "x": -3.3, "y": -3.5, "w": 0.4, "h": 0.4, "colour": "orange"})
        found = {item["label"]: item for item in ColourRegionDetector().detect(sim.capture("camera"))}
        self.assertEqual(sorted(found), ["blue region", "orange region"])
        self.assertAlmostEqual(found["orange region"]["distanceM"], 1.0, delta=0.05)
        sim.clear_obstacles()
        sim.place_obstacle({"name": "box", "x": -3.3, "y": -3.5, "w": 0.4, "h": 0.4})
        self.assertEqual([item["label"] for item in ColourRegionDetector().detect(sim.capture("camera"))], ["blue region"], "a grey box is not picked out")

    def test_a_camera_that_stopped_reporting_gives_no_frame(self):
        sim = simulator()
        sim.sensor_faults = {"camera"}
        with self.assertRaises(RuntimeError):
            sim.capture("camera")
        self.assertEqual(sim.state()["sensors"]["camera"], {"ok": False, "problem": "not reporting", "source": "simulated"})
        with self.assertRaises(ValueError):
            simulator().capture("thermal")


class CaptureCapability(unittest.TestCase):
    def test_a_capture_is_accepted_reported_with_the_image_once_and_logged_as_an_event(self):
        bench = Bench()
        bench.run(1.0)
        command = bench.command("capture_image", {"camera": "camera"})
        bench.exchange(command)
        bench.run(1.2)
        self.assertEqual(bench.statuses(command["missionId"]), ["accepted", "succeeded"])
        done = [report for report in bench.reports(command["missionId"]) if report["status"] == "succeeded"][0]
        self.assertEqual([done["result"]["sensor"], done["result"]["frame"], done["result"]["width"], done["result"]["height"]], ["camera", 1, 64, 48])
        self.assertEqual(done["result"]["detector"]["model"], "hannah-colour-regions")
        self.assertNotIn("data", done["result"], "the result is small; the image travels beside it")
        image = base64.b64decode(done["attachment"]["data"])
        self.assertEqual(png_size(image), (64, 48))
        self.assertEqual(done["result"]["bytes"], len(image))
        self.assertIn("camera-capture", bench.events())
        # The same command again: answered from memory, without taking or sending another picture.
        bench.exchange(command)
        bench.run(1.2)
        again = [report for report in bench.reports(command["missionId"]) if report["status"] == "succeeded"]
        self.assertEqual(len([report for report in again if "attachment" in report]), 1)
        self.assertEqual(bench.state()["sensors"]["camera"]["framesCaptured"], 1)

    def test_a_picture_moves_nothing_so_it_is_allowed_with_the_emergency_stop_engaged(self):
        bench = Bench()
        bench.sim.press_estop(True)
        bench.run(1.0)
        command = bench.command("capture_image", {"camera": "camera"})
        bench.exchange(command)
        bench.run(1.2)
        self.assertEqual(bench.statuses(command["missionId"]), ["accepted", "succeeded"])

    def test_the_robot_refuses_a_camera_it_does_not_have_or_one_that_is_not_reporting(self):
        bench = Bench()
        bench.run(1.0)
        unknown = bench.command("capture_image", {"camera": "thermal"})
        bench.exchange(unknown)
        bench.run(1.2)
        self.assertEqual(bench.statuses(unknown["missionId"]), ["rejected"])
        self.assertIn("not a camera of this robot", bench.reports(unknown["missionId"])[0]["reason"])
        bench.sim.sensor_faults = {"camera"}
        bench.run(1.0)
        dark = bench.command("capture_image", {"camera": "camera"})
        bench.exchange(dark)
        bench.run(1.2)
        self.assertEqual(bench.statuses(dark["missionId"]), ["rejected"])
        self.assertIn("the camera isn't reporting", bench.reports(dark["missionId"])[0]["reason"])

    def test_the_result_and_the_image_agree(self):
        sim = simulator()
        result, attachment = capture_result(sim.capture("camera"), ColourRegionDetector())
        self.assertEqual([attachment["kind"], attachment["encoding"], attachment["frame"], attachment["capturedAt"]], ["image", "png", result["frame"], result["capturedAt"]])
        self.assertEqual(result["depth"], "simulated depth (ray cast)")


if __name__ == "__main__":
    unittest.main()
