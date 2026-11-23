from __future__ import annotations

import os
import select
import termios
import time
from dataclasses import dataclass


@dataclass
class PosixSerialStream:
    """Read/write byte stream over a POSIX serial device using only stdlib.

    Requires Linux/macOS. The device path is opened read-only with no controlling
    terminal; no writes happen until the caller explicitly calls write().
    """

    path: str
    baudrate: int = 115200
    timeout_ms: int = 500
    fd: int | None = None
    _buffer: bytes = b""

    def open(self) -> None:
        if self.fd is not None:
            return
        fd = os.open(self.path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        attrs = termios.tcgetattr(fd)
        attrs[0] = 0  # no input processing
        attrs[1] = 0  # no output processing
        attrs[2] = (attrs[2] & ~(termios.CSIZE | termios.PARENB)) | termios.CS8
        attrs[3] = 0  # no echo/canonical/control
        speed = getattr(termios, f"B{self.baudrate}", termios.B9600)
        attrs[4] = speed
        attrs[5] = speed
        termios.tcsetattr(fd, termios.TCSANOW, attrs)
        self.fd = fd
        self._buffer = b""

    def close(self) -> None:
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def write(self, data: bytes) -> None:
        if self.fd is None:
            raise RuntimeError("serial stream not open")
        os.write(self.fd, data)

    def read_line(self) -> bytes:
        """Return one newline-terminated frame, or b'' on timeout."""
        if self.fd is None:
            raise RuntimeError("serial stream not open")
        deadline = time.monotonic() + self.timeout_ms / 1000.0
        while b"\n" not in self._buffer:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return b""
            ready, _, _ = select.select([self.fd], [], [], remaining)
            if not ready:
                return b""
            chunk = os.read(self.fd, 4096)
            if not chunk:
                return b""
            self._buffer += chunk
        line, self._buffer = self._buffer.split(b"\n", 1)
        return line + b"\n"
