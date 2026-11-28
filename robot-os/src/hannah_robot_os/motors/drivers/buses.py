"""Links the drivers talk over: a CAN bus and a serial byte stream.

Real links use only what is installed: Linux SocketCAN through the standard
library's socket.AF_CAN, python-can if present, and serial ports through the
standard-library POSIX stream (motors/posix_serial.py) or pyserial if present.
Nothing here is imported at package import time, so the package and its tests
work with none of them installed. Tests pass fakes with the same methods.
"""
from __future__ import annotations

import socket
import struct
from dataclasses import dataclass
from typing import Protocol

from .base import TransportError

CAN_EFF_FLAG = 0x80000000
CAN_RTR_FLAG = 0x40000000
CAN_EFF_MASK = 0x1FFFFFFF
CAN_SFF_MASK = 0x7FF
_CAN_FRAME = struct.Struct("=IB3x8s")  # struct can_frame, linux/can.h


@dataclass
class CanFrame:
    arbitration_id: int
    data: bytes = b""
    extended: bool = False
    rtr: bool = False


class CanBus(Protocol):
    def open(self) -> None: ...
    def close(self) -> None: ...
    def send(self, frame: CanFrame) -> None: ...
    def recv(self, timeout_s: float) -> CanFrame | None: ...


class ByteStream(Protocol):
    def open(self) -> None: ...
    def close(self) -> None: ...
    def write(self, data: bytes) -> None: ...
    def read(self, size: int) -> bytes: ...  # up to size bytes; b"" on timeout
    def read_line(self) -> bytes: ...  # one line ending in \n; b"" on timeout


class SocketCanBus:
    """Raw SocketCAN socket bound to one interface (Linux only)."""

    def __init__(self, interface: str) -> None:
        self.interface = interface
        self._sock: socket.socket | None = None

    def open(self) -> None:
        if self._sock is not None:
            return
        family = getattr(socket, "AF_CAN", None)
        if family is None:
            raise TransportError("SocketCAN is not available on this system (Linux only)")
        try:
            sock = socket.socket(family, socket.SOCK_RAW, socket.CAN_RAW)
            sock.bind((self.interface,))
        except OSError as error:
            raise TransportError(f"cannot open CAN interface {self.interface}: {error}") from error
        self._sock = sock

    def close(self) -> None:
        if self._sock is not None:
            self._sock.close()
            self._sock = None

    def send(self, frame: CanFrame) -> None:
        if self._sock is None:
            raise TransportError("CAN bus not open")
        can_id = frame.arbitration_id & (CAN_EFF_MASK if frame.extended else CAN_SFF_MASK)
        if frame.extended:
            can_id |= CAN_EFF_FLAG
        if frame.rtr:
            can_id |= CAN_RTR_FLAG
        try:
            self._sock.send(_CAN_FRAME.pack(can_id, len(frame.data), frame.data.ljust(8, b"\x00")))
        except OSError as error:
            raise TransportError(f"CAN send failed: {error}") from error

    def recv(self, timeout_s: float) -> CanFrame | None:
        if self._sock is None:
            raise TransportError("CAN bus not open")
        self._sock.settimeout(max(0.0, timeout_s))
        try:
            raw = self._sock.recv(_CAN_FRAME.size)
        except socket.timeout:
            return None
        except OSError as error:
            raise TransportError(f"CAN receive failed: {error}") from error
        can_id, length, data = _CAN_FRAME.unpack(raw)
        extended = bool(can_id & CAN_EFF_FLAG)
        return CanFrame(
            arbitration_id=can_id & (CAN_EFF_MASK if extended else CAN_SFF_MASK),
            data=data[:length],
            extended=extended,
            rtr=bool(can_id & CAN_RTR_FLAG),
        )


class PythonCanBus:
    """python-can bus (optional dependency), for adapters SocketCAN can't reach."""

    def __init__(self, interface: str, channel: str, bitrate: int | None = None) -> None:
        self.interface, self.channel, self.bitrate = interface, channel, bitrate
        self._bus = None

    def open(self) -> None:
        if self._bus is not None:
            return
        try:
            import can  # type: ignore[import-not-found]
        except ImportError as error:
            raise TransportError("python-can is not installed") from error
        kwargs = {"interface": self.interface, "channel": self.channel}
        if self.bitrate:
            kwargs["bitrate"] = self.bitrate
        try:
            self._bus = can.Bus(**kwargs)
        except Exception as error:
            raise TransportError(f"cannot open CAN bus: {error}") from error

    def close(self) -> None:
        if self._bus is not None:
            self._bus.shutdown()
            self._bus = None

    def send(self, frame: CanFrame) -> None:
        import can  # type: ignore[import-not-found]

        if self._bus is None:
            raise TransportError("CAN bus not open")
        try:
            self._bus.send(can.Message(arbitration_id=frame.arbitration_id, data=frame.data, is_extended_id=frame.extended, is_remote_frame=frame.rtr))
        except Exception as error:
            raise TransportError(f"CAN send failed: {error}") from error

    def recv(self, timeout_s: float) -> CanFrame | None:
        if self._bus is None:
            raise TransportError("CAN bus not open")
        try:
            msg = self._bus.recv(timeout=timeout_s)
        except Exception as error:
            raise TransportError(f"CAN receive failed: {error}") from error
        if msg is None:
            return None
        return CanFrame(msg.arbitration_id, bytes(msg.data), bool(msg.is_extended_id), bool(msg.is_remote_frame))


class PosixByteStream:
    """Serial port through the standard-library POSIX stream."""

    def __init__(self, path: str, baudrate: int = 115200, timeout_ms: int = 100) -> None:
        from ..posix_serial import PosixSerialStream

        self._stream = PosixSerialStream(path=path, baudrate=baudrate, timeout_ms=timeout_ms)

    def open(self) -> None:
        try:
            self._stream.open()
        except OSError as error:
            raise TransportError(f"cannot open {self._stream.path}: {error}") from error

    def close(self) -> None:
        self._stream.close()

    def write(self, data: bytes) -> None:
        try:
            self._stream.write(data)
        except (OSError, RuntimeError) as error:
            raise TransportError(f"serial write failed: {error}") from error

    def read(self, size: int) -> bytes:
        try:
            return self._stream.read(size)
        except (OSError, RuntimeError) as error:
            raise TransportError(f"serial read failed: {error}") from error

    def read_line(self) -> bytes:
        try:
            return self._stream.read_line()
        except (OSError, RuntimeError) as error:
            raise TransportError(f"serial read failed: {error}") from error


class PySerialStream:
    """Serial port through pyserial (optional dependency)."""

    def __init__(self, path: str, baudrate: int = 115200, timeout_ms: int = 100) -> None:
        self.path, self.baudrate, self.timeout_ms = path, baudrate, timeout_ms
        self._port = None

    def open(self) -> None:
        if self._port is not None:
            return
        try:
            import serial  # type: ignore[import-not-found]
        except ImportError as error:
            raise TransportError("pyserial is not installed") from error
        try:
            self._port = serial.Serial(self.path, self.baudrate, timeout=self.timeout_ms / 1000.0)
        except Exception as error:
            raise TransportError(f"cannot open {self.path}: {error}") from error

    def close(self) -> None:
        if self._port is not None:
            self._port.close()
            self._port = None

    def _require(self):
        if self._port is None:
            raise TransportError("serial port not open")
        return self._port

    def write(self, data: bytes) -> None:
        try:
            self._require().write(data)
        except TransportError:
            raise
        except Exception as error:
            raise TransportError(f"serial write failed: {error}") from error

    def read(self, size: int) -> bytes:
        try:
            return bytes(self._require().read(size))
        except TransportError:
            raise
        except Exception as error:
            raise TransportError(f"serial read failed: {error}") from error

    def read_line(self) -> bytes:
        try:
            line = bytes(self._require().readline())
        except TransportError:
            raise
        except Exception as error:
            raise TransportError(f"serial read failed: {error}") from error
        return line if line.endswith(b"\n") else b""


def make_can_bus(transport: dict) -> CanBus:
    backend = transport.get("backend", "socketcan")
    if backend == "socketcan":
        return SocketCanBus(transport["interface"])
    if backend == "python-can":
        return PythonCanBus(transport.get("python_can_interface", "socketcan"), transport["interface"], transport.get("bitrate"))
    raise ValueError(f"unknown CAN backend: {backend}")


def make_byte_stream(transport: dict) -> ByteStream:
    backend = transport.get("backend", "posix")
    path, baud = transport["path"], int(transport.get("baudrate", 115200))
    timeout = int(transport.get("timeout_ms", 100))
    if backend == "posix":
        return PosixByteStream(path, baud, timeout)
    if backend == "pyserial":
        return PySerialStream(path, baud, timeout)
    raise ValueError(f"unknown serial backend: {backend}")
