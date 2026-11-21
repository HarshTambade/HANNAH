"""Camera frames and what is detected in them.

A frame is pixels with the facts that make a detection checkable later: which
sensor, which frame number, when, and from where. A detection keeps all of
them, plus the name and version of what produced it and a confidence.

The detector here is deliberately modest. It finds regions of saturated
colour and says "a red region", with its box, its size and how solid it is.
It does not classify objects, recognise people or read anything, and it says
so in its own description. A distance is given only when the frame carries
depth, and is labelled with where that depth came from.

A provider is anything with `name`, `version`, `describe()` and
`detect(frame)`. Others (an ONNX model, for example) can be added to
PROVIDERS; none is included, because none could be run and tested here.

Standard library only.
"""
from __future__ import annotations

import base64
import colorsys
import math
import struct
import zlib
from dataclasses import dataclass, field

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
# Hue ranges in degrees for the colours the detector names. Anything else that is saturated is "coloured".
HUES = (("red", 345, 15), ("orange", 15, 45), ("yellow", 45, 70), ("green", 70, 170), ("blue", 170, 265), ("purple", 265, 345))
MIN_SATURATION = 0.45
MIN_VALUE = 0.22
MIN_PIXELS = 12


@dataclass
class Frame:
    """One image. `pixels[row][col]` is (r, g, b), each 0..255. `depth[col]` is metres or None."""
    width: int
    height: int
    pixels: list
    sensor: str
    number: int
    at_ms: int
    fov_deg: float
    source: str
    pose: dict | None = None
    depth: list | None = None
    depth_source: str = ""
    extra: dict = field(default_factory=dict)

    def meta(self) -> dict:
        return {
            "sensor": self.sensor, "frame": self.number, "capturedAt": self.at_ms, "width": self.width, "height": self.height,
            "fovDeg": self.fov_deg, "encoding": "png", "source": self.source, "pose": self.pose, "depth": self.depth_source or None,
        }


def encode_png(frame: Frame) -> bytes:
    """An 8-bit RGB PNG, from the standard library alone."""
    raw = bytearray()
    for row in frame.pixels:
        raw.append(0)  # filter: none
        for r, g, b in row:
            raw += bytes((r, g, b))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", frame.width, frame.height, 8, 2, 0, 0, 0)
    return PNG_MAGIC + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")


def png_size(data: bytes) -> tuple[int, int] | None:
    """Width and height of a PNG, or None when it isn't one."""
    if len(data) < 24 or data[:8] != PNG_MAGIC or data[12:16] != b"IHDR":
        return None
    return struct.unpack(">II", data[16:24])


def colour_of(r: int, g: int, b: int) -> str | None:
    hue, saturation, value = colorsys.rgb_to_hsv(r / 255.0, g / 255.0, b / 255.0)
    if saturation < MIN_SATURATION or value < MIN_VALUE:
        return None
    degrees = hue * 360.0
    for name, low, high in HUES:
        if (low <= degrees < high) if low < high else (degrees >= low or degrees < high):
            return name
    return "coloured"


class ColourRegionDetector:
    """Connected regions of one saturated colour."""

    name = "hannah-colour-regions"
    version = "1"

    def describe(self) -> dict:
        return {
            "model": self.name, "version": self.version, "kind": "colour segmentation (not a learned model)",
            "detects": "regions of saturated colour: red, orange, yellow, green, blue, purple",
            "cannot": "say what an object is, recognise people or faces, or read text",
        }

    def detect(self, frame: Frame) -> list[dict]:
        labels = [[colour_of(*pixel) for pixel in row] for row in frame.pixels]
        seen = [[False] * frame.width for _ in range(frame.height)]
        found = []
        for row in range(frame.height):
            for col in range(frame.width):
                colour = labels[row][col]
                if colour is None or seen[row][col]:
                    continue
                stack = [(row, col)]
                seen[row][col] = True
                cells = []
                while stack:
                    r, c = stack.pop()
                    cells.append((r, c))
                    for nr, nc in ((r + 1, c), (r - 1, c), (r, c + 1), (r, c - 1)):
                        if 0 <= nr < frame.height and 0 <= nc < frame.width and not seen[nr][nc] and labels[nr][nc] == colour:
                            seen[nr][nc] = True
                            stack.append((nr, nc))
                if len(cells) < MIN_PIXELS:
                    continue
                rows = [cell[0] for cell in cells]
                cols = [cell[1] for cell in cells]
                top, bottom, left, right = min(rows), max(rows), min(cols), max(cols)
                box_area = (bottom - top + 1) * (right - left + 1)
                fill = len(cells) / box_area
                # Confidence is how solid and how large the region is. It is not a probability of being any particular object.
                confidence = round(min(0.95, 0.35 + 0.4 * fill + 0.2 * min(1.0, len(cells) / 200.0)), 2)
                detection = {
                    "label": f"{colour} region", "colour": colour, "box": {"x": left, "y": top, "w": right - left + 1, "h": bottom - top + 1},
                    "pixels": len(cells), "shareOfImage": round(len(cells) / (frame.width * frame.height), 4), "confidence": confidence,
                    "model": self.name, "modelVersion": self.version, "sensor": frame.sensor, "frame": frame.number, "capturedAt": frame.at_ms,
                    "bearingDeg": round((0.5 - (left + right + 1) / 2.0 / frame.width) * frame.fov_deg, 1) + 0.0,
                }
                if frame.depth:
                    depths = sorted(value for value in frame.depth[left:right + 1] if value is not None)
                    if depths:
                        distance = depths[len(depths) // 2]
                        detection["distanceM"] = round(distance, 2)
                        detection["distanceSource"] = frame.depth_source
                        if frame.pose:
                            angle = frame.pose["yaw"] + math.radians(detection["bearingDeg"])
                            detection["position"] = {"x": round(frame.pose["x"] + distance * math.cos(angle), 2), "y": round(frame.pose["y"] + distance * math.sin(angle), 2), "frame": frame.pose.get("frame", "map"), "source": f"{frame.depth_source}, from the robot's own position estimate"}
                found.append(detection)
        found.sort(key=lambda item: -item["pixels"])
        return found[:12]


PROVIDERS = {ColourRegionDetector.name: ColourRegionDetector}


def provider(name: str | None = None):
    """The detector a profile asks for. An unknown name is an error, not a silent fallback."""
    wanted = name or ColourRegionDetector.name
    if wanted not in PROVIDERS:
        raise ValueError(f"There is no vision provider called {wanted!r}. Available: {', '.join(sorted(PROVIDERS))}.")
    return PROVIDERS[wanted]()


def capture_result(frame: Frame, detector) -> tuple[dict, dict]:
    """What a capture reports: the result (small, no pixels) and the image itself as a separate attachment."""
    detections = detector.detect(frame)
    png = encode_png(frame)
    result = {**frame.meta(), "bytes": len(png), "detections": detections, "detector": detector.describe()}
    attachment = {"kind": "image", "encoding": "png", "data": base64.b64encode(png).decode("ascii"), **frame.meta()}
    return result, attachment
