"""Robotis Dynamixel Protocol 2.0 over a serial (TTL/RS-485) line.

Source: Robotis e-Manual, "DYNAMIXEL Protocol 2.0"
(https://emanual.robotis.com/docs/en/dxl/protocol2/), and the X-series
control table for velocity mode (XM430-W350 page, "Control Table").
Section numbers below are the e-Manual's.

Tested against the e-Manual's example packets (section 5) and a fake bus only.
Not run on a real servo.
"""
from __future__ import annotations

import struct
from dataclasses import dataclass
from typing import Callable

from ...common import now_ms
from ...config import SafetyLimits
from .base import ControllerFault, DriveGeometry, Feedback, TransportError, WheelPairDriver
from .buses import ByteStream
from .crc import crc16_dynamixel

# 2.1 Header, 2.2 Reserved
HEADER = b"\xFF\xFF\xFD"
RESERVED = 0x00
# 2.3 Packet ID
BROADCAST_ID = 0xFE
MAX_ID = 252
# 2.5 Instruction
PING, READ, WRITE, REG_WRITE, ACTION, FACTORY_RESET, REBOOT, CLEAR = 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x08, 0x10
STATUS, SYNC_READ, SYNC_WRITE, BULK_READ, BULK_WRITE = 0x55, 0x82, 0x83, 0x92, 0x93
# 3.2 Error
ERROR_ALERT = 0x80
ERRORS = {
    0x01: "result fail",
    0x02: "instruction error",
    0x03: "CRC error",
    0x04: "data range error",
    0x05: "data length error",
    0x06: "data limit error",
    0x07: "access error",
}

# X-series control table (XM430-W350 e-Manual, "Control Table").
ADDR_OPERATING_MODE = 11  # 1 byte, EEPROM
ADDR_VELOCITY_LIMIT = 44  # 4 bytes, EEPROM, 0.229 rpm
ADDR_TORQUE_ENABLE = 64  # 1 byte
ADDR_HARDWARE_ERROR = 70  # 1 byte, read only
ADDR_BUS_WATCHDOG = 98  # 1 byte, 20 ms per unit, 0 = off, -1 = tripped
ADDR_GOAL_VELOCITY = 104  # 4 bytes, 0.229 rpm
ADDR_PRESENT_VELOCITY = 128  # 4 bytes, 0.229 rpm
ADDR_PRESENT_POSITION = 132  # 4 bytes, pulses
OPERATING_MODE_VELOCITY = 1
VELOCITY_UNIT_RPM = 0.229
BUS_WATCHDOG_UNIT_MS = 20
HARDWARE_ERRORS = {0x20: "overload", 0x10: "electrical shock", 0x08: "motor encoder", 0x04: "overheating", 0x01: "input voltage"}


def stuff(data: bytes) -> bytes:
    """Byte stuffing ("Packet Process"): after FF FF FD inside the packet, add FD."""
    out = bytearray()
    for byte in data:
        out.append(byte)
        if len(out) >= 3 and out[-3:] == HEADER:
            out.append(0xFD)
    return bytes(out)


def unstuff(data: bytes) -> bytes:
    """Remove the FD added after FF FF FD by stuff()."""
    out = bytearray()
    i = 0
    while i < len(data):
        out.append(data[i])
        if len(out) >= 3 and out[-3:] == HEADER and i + 1 < len(data) and data[i + 1] == 0xFD:
            i += 1
        i += 1
    return bytes(out)


def encode_instruction(dxl_id: int, instruction: int, params: bytes = b"") -> bytes:
    """2. Instruction Packet: header, reserved, ID, length (2.4: parameters + 3,
    counted after stuffing), instruction, parameters, CRC low then high (2.7)."""
    if not 0 <= dxl_id <= MAX_ID and dxl_id != BROADCAST_ID:
        raise ValueError(f"invalid Dynamixel ID: {dxl_id}")
    body = stuff(bytes([instruction]) + bytes(params))
    head = HEADER + bytes([RESERVED, dxl_id]) + struct.pack("<H", len(body) + 2)
    packet = head + body
    return packet + struct.pack("<H", crc16_dynamixel(packet))


@dataclass
class Packet:
    dxl_id: int
    instruction: int
    params: bytes
    error: int = 0  # status packets only (3.2)


def decode_packet(raw: bytes) -> Packet:
    """Decode one instruction or status packet; checks length and CRC."""
    if len(raw) < 10 or raw[:3] != HEADER or raw[3] != RESERVED:
        raise ValueError("not a Dynamixel 2.0 packet")
    length = struct.unpack_from("<H", raw, 5)[0]
    if len(raw) != 7 + length or length < 3:
        raise ValueError("bad packet length")
    expected = struct.unpack_from("<H", raw, len(raw) - 2)[0]
    if crc16_dynamixel(raw[:-2]) != expected:
        raise ValueError("CRC mismatch")
    body = unstuff(raw[7:-2])
    instruction = body[0]
    if instruction == STATUS:
        if len(body) < 2:
            raise ValueError("status packet without error byte")
        return Packet(raw[4], instruction, body[2:], error=body[1])
    return Packet(raw[4], instruction, body[1:])


def encode_status(dxl_id: int, error: int = 0, params: bytes = b"") -> bytes:
    """3. Status Packet (used by test fakes): instruction 0x55, then the error byte."""
    body = stuff(bytes([STATUS, error]) + bytes(params))
    head = HEADER + bytes([RESERVED, dxl_id]) + struct.pack("<H", len(body) + 2)
    return head + body + struct.pack("<H", crc16_dynamixel(head + body))


def ping(dxl_id: int) -> bytes:
    return encode_instruction(dxl_id, PING)


def read(dxl_id: int, address: int, size: int) -> bytes:
    return encode_instruction(dxl_id, READ, struct.pack("<HH", address, size))


def write(dxl_id: int, address: int, data: bytes) -> bytes:
    return encode_instruction(dxl_id, WRITE, struct.pack("<H", address) + data)


def sync_write(address: int, size: int, values: dict[int, bytes]) -> bytes:
    params = struct.pack("<HH", address, size)
    for dxl_id, data in values.items():
        if len(data) != size:
            raise ValueError("sync write data has the wrong size")
        params += bytes([dxl_id]) + data
    return encode_instruction(BROADCAST_ID, SYNC_WRITE, params)


def sync_read(address: int, size: int, ids: list[int]) -> bytes:
    return encode_instruction(BROADCAST_ID, SYNC_READ, struct.pack("<HH", address, size) + bytes(ids))


def describe_error(error: int) -> str:
    parts = []
    if error & 0x7F:
        parts.append(ERRORS.get(error & 0x7F, f"error 0x{error & 0x7F:02x}"))
    if error & ERROR_ALERT:
        parts.append("hardware alert")
    return ", ".join(parts) or "no error"


def describe_hardware_error(bits: int) -> str:
    return ", ".join(name for bit, name in HARDWARE_ERRORS.items() if bits & bit) or "none"


def read_packet(stream: ByteStream, max_empty_reads: int = 2) -> bytes:
    """Read one packet from the stream: find the header, then the declared length."""
    buffer = b""
    empty = 0

    def fill(count: int) -> None:
        nonlocal buffer, empty
        while len(buffer) < count:
            chunk = stream.read(count - len(buffer))
            if not chunk:
                empty += 1
                if empty >= max_empty_reads:
                    raise TransportError("no reply from Dynamixel (timeout)")
                continue
            buffer += chunk

    while True:
        fill(7)
        start = buffer.find(HEADER)
        if start < 0:
            buffer = buffer[-2:]
            continue
        buffer = buffer[start:]
        fill(7)
        if buffer[3] != RESERVED:
            buffer = buffer[1:]
            continue
        length = struct.unpack_from("<H", buffer, 5)[0]
        fill(7 + length)
        return buffer[: 7 + length]


def velocity_to_raw(motor_tps: float) -> int:
    """Turns per second to Goal Velocity units (0.229 rpm), rounded toward zero
    so the servo never gets more than was asked."""
    return int(motor_tps * 60.0 / VELOCITY_UNIT_RPM)


def raw_to_velocity(raw: int) -> float:
    return raw * VELOCITY_UNIT_RPM / 60.0


class DynamixelDriver(WheelPairDriver):
    """Two Dynamixel X-series servos in velocity mode, one per wheel."""

    driver_name = "dynamixel_p2"

    def __init__(
        self,
        controller_id: str,
        stream: ByteStream,
        limits: SafetyLimits,
        geometry: DriveGeometry,
        left_id: int = 1,
        right_id: int = 2,
        bus_watchdog_ms: int = 0,
        pulses_per_turn: int = 4096,
        model_velocity_limit_raw: int = 1023,
        clock: Callable[[], int] = now_ms,
    ) -> None:
        super().__init__(controller_id, limits, geometry, clock)
        self.stream = stream
        self.left_id, self.right_id = left_id, right_id
        self.bus_watchdog_ms = bus_watchdog_ms
        self.pulses_per_turn = pulses_per_turn
        self.model_velocity_limit_raw = model_velocity_limit_raw

    @property
    def ids(self) -> tuple[int, int]:
        return self.left_id, self.right_id

    def _transact(self, packet: bytes, expect_id: int) -> Packet:
        self.stream.write(packet)
        while True:
            raw = read_packet(self.stream)
            try:
                reply = decode_packet(raw)
            except ValueError as error:
                raise TransportError(f"bad reply: {error}") from error
            if reply.instruction != STATUS:
                continue  # an echo of our own packet on a half-duplex line
            if reply.dxl_id != expect_id:
                raise TransportError(f"reply from ID {reply.dxl_id}, expected {expect_id}")
            if reply.error & ERROR_ALERT:
                bits = self._hardware_error(expect_id)
                raise ControllerFault(f"Dynamixel {expect_id} hardware error: {describe_hardware_error(bits)}")
            if reply.error & 0x7F:
                raise ControllerFault(f"Dynamixel {expect_id}: {describe_error(reply.error)}")
            return reply

    def _hardware_error(self, dxl_id: int) -> int:
        self.stream.write(read(dxl_id, ADDR_HARDWARE_ERROR, 1))
        try:
            reply = decode_packet(read_packet(self.stream))
        except (ValueError, TransportError):
            return 0
        return reply.params[0] if reply.params else 0

    def _write(self, dxl_id: int, address: int, data: bytes) -> None:
        self._transact(write(dxl_id, address, data), dxl_id)

    def _read_int(self, dxl_id: int, address: int, size: int) -> int:
        reply = self._transact(read(dxl_id, address, size), dxl_id)
        if len(reply.params) != size:
            raise TransportError("short read reply")
        return int.from_bytes(reply.params, "little", signed=True)

    def max_raw_velocity(self) -> int:
        return min(self.model_velocity_limit_raw, velocity_to_raw(self.max_motor_tps()))

    def _open(self) -> None:
        self.stream.open()

    def _close(self) -> None:
        self.stream.close()

    def _configure(self) -> None:
        for dxl_id in self.ids:
            self._transact(ping(dxl_id), dxl_id)
            self._write(dxl_id, ADDR_TORQUE_ENABLE, b"\x00")  # EEPROM writes need torque off
            self._write(dxl_id, ADDR_OPERATING_MODE, bytes([OPERATING_MODE_VELOCITY]))
            self._write(dxl_id, ADDR_VELOCITY_LIMIT, struct.pack("<i", self.max_raw_velocity()))
            self._write(dxl_id, ADDR_BUS_WATCHDOG, b"\x00")  # clears a tripped watchdog
            if self.bus_watchdog_ms:
                units = max(1, min(127, self.bus_watchdog_ms // BUS_WATCHDOG_UNIT_MS))
                self._write(dxl_id, ADDR_BUS_WATCHDOG, bytes([units]))

    def _engage(self) -> None:
        for dxl_id in self.ids:
            self._write(dxl_id, ADDR_TORQUE_ENABLE, b"\x01")

    def _disengage(self) -> None:
        for dxl_id in self.ids:
            self._write(dxl_id, ADDR_TORQUE_ENABLE, b"\x00")

    def _command(self, left_tps: float, right_tps: float) -> None:
        cap = self.max_raw_velocity()
        for dxl_id, tps in ((self.left_id, left_tps), (self.right_id, right_tps)):
            raw = max(-cap, min(cap, velocity_to_raw(tps)))
            self._write(dxl_id, ADDR_GOAL_VELOCITY, struct.pack("<i", raw))

    def _emergency(self) -> None:
        # Torque off first: it stops the servo even if a goal write would fail.
        errors = []
        for dxl_id in self.ids:
            try:
                self._write(dxl_id, ADDR_TORQUE_ENABLE, b"\x00")
            except Exception as error:
                errors.append(error)
        if errors:
            raise errors[0]

    def _read_feedback(self) -> Feedback:
        left_v = raw_to_velocity(self._read_int(self.left_id, ADDR_PRESENT_VELOCITY, 4))
        right_v = raw_to_velocity(self._read_int(self.right_id, ADDR_PRESENT_VELOCITY, 4))
        left_p = self._read_int(self.left_id, ADDR_PRESENT_POSITION, 4) / self.pulses_per_turn
        right_p = self._read_int(self.right_id, ADDR_PRESENT_POSITION, 4) / self.pulses_per_turn
        return Feedback(left_tps=left_v, right_tps=right_v, left_turns=left_p, right_turns=right_p)
