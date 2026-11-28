"""The robot's black box: a local recording of events and selected telemetry.

  format.py    the segment file format (HBX v1), standard library only
  config.py    per-topic rules: rate, sensitivity, retention, size caps
  recorder.py  writes segments, enforces retention and size, keeps the upload outbox
  hook.py      what the runtime tells it (events, mission reports, state)
  uploader.py  sends event summaries (and, if the owner allows, closed segments) to HANNAH
  rosbag2.py   optional ROS 2 bag export/import and topic recording (rosbag2_py, rclpy)
  replay.py    mission timelines, playback, fault reproduction, regression scenarios
"""
from .config import RecorderConfig, TopicRule
from .hook import RuntimeRecorder
from .recorder import Recorder
from .uploader import Uploader

__all__ = ["Recorder", "RecorderConfig", "RuntimeRecorder", "TopicRule", "Uploader"]
