"""Hardware abstraction layer: one interface, an adapter per kind of robot."""
from .base import RobotAdapter, NavigationStatus

__all__ = ["RobotAdapter", "NavigationStatus"]
