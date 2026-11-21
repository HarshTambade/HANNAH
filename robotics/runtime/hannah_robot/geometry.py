"""Plane geometry the runtime needs. Metres and radians, map frame."""
from __future__ import annotations

import math
from typing import Iterable, Sequence

Point = Sequence[float]


def point_in_polygon(x: float, y: float, polygon: Sequence[Point]) -> bool:
    inside = False
    j = len(polygon) - 1
    for i in range(len(polygon)):
        xi, yi = polygon[i][0], polygon[i][1]
        xj, yj = polygon[j][0], polygon[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def distance_to_rect(x: float, y: float, rect: dict) -> float:
    """Distance from a point to an axis-aligned rectangle (0 inside it)."""
    dx = max(rect["x"] - x, 0.0, x - (rect["x"] + rect["w"]))
    dy = max(rect["y"] - y, 0.0, y - (rect["y"] + rect["h"]))
    return math.hypot(dx, dy)


def ray_rect(ox: float, oy: float, dx: float, dy: float, rect: dict) -> float | None:
    """Where a ray from (ox, oy) along the unit vector (dx, dy) first meets a rectangle, or None."""
    t_near, t_far = -math.inf, math.inf
    for origin, direction, low, high in ((ox, dx, rect["x"], rect["x"] + rect["w"]), (oy, dy, rect["y"], rect["y"] + rect["h"])):
        if abs(direction) < 1e-12:
            if origin < low or origin > high:
                return None
            continue
        t1, t2 = (low - origin) / direction, (high - origin) / direction
        if t1 > t2:
            t1, t2 = t2, t1
        t_near, t_far = max(t_near, t1), min(t_far, t2)
        if t_near > t_far:
            return None
    if t_far < 0:
        return None
    return max(t_near, 0.0)


def ray_bounds(ox: float, oy: float, dx: float, dy: float, bounds: dict) -> float:
    """Distance along a ray from inside the room to its wall."""
    best = math.inf
    if dx > 1e-12:
        best = min(best, (bounds["maxX"] - ox) / dx)
    elif dx < -1e-12:
        best = min(best, (bounds["minX"] - ox) / dx)
    if dy > 1e-12:
        best = min(best, (bounds["maxY"] - oy) / dy)
    elif dy < -1e-12:
        best = min(best, (bounds["minY"] - oy) / dy)
    return max(best, 0.0)


def wrap(angle: float) -> float:
    return math.atan2(math.sin(angle), math.cos(angle))


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def path_length(points: Iterable[Point]) -> float:
    total, previous = 0.0, None
    for point in points:
        if previous is not None:
            total += math.hypot(point[0] - previous[0], point[1] - previous[1])
        previous = point
    return total
