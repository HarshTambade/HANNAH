"""VESC motor controllers over UART and over CAN.

VESC has no separate protocol document; the firmware source is the reference
(https://github.com/vedderb/bldc):
- datatypes.h: COMM_PACKET_ID (COMM_GET_VALUES = 4, COMM_SET_CURRENT = 6,
  COMM_SET_RPM = 8, COMM_FORWARD_CAN = 34), CAN_PACKET_ID (SET_CURRENT = 1,
  SET_RPM = 3, STATUS = 9) and mc_fault_code.
- comm/packet.c, packet_send_packet(): start byte 2, one length byte, payload,
  CRC-16 of the payload high byte first, end byte 3 (3 and 4 start longer
  packets).
- comm/commands.c, COMM_GET_VALUES: the reply's field order.
- comm/comm_can.c: extended IDs are controller_id | packet_id << 8; values are
  big-endian int32 (current x 1000, RPM x 1); CAN_PACKET_STATUS carries ERPM
  int32, current int16 x 10, duty int16 x 1000.

RPM here is electrical RPM (ERPM = mechanical RPM x motor pole pairs).
Tested against hand-built vectors and fake transports only, never on a real VESC.
"""
from __future__ import annotations

import struct
from dataclasses import dataclass
from typing import Callable

from ...common import now_ms
from ...config import SafetyLimits
from .base import ControllerFault, DriveGeometry, Feedback, TransportError, WheelPairDriver
from .buses import ByteStream, CanBus, CanFrame
from .crc import crc16_xmodem

COMM_GET_VALUES = 4
COMM_SET_CURRENT = 6
COMM_SET_RPM = 8
COMM_ALIVE = 30
COMM_FORWARD_CAN = 34
CAN_PACKET_SET_CURRENT = 1
CAN_PACKET_SET_RPM = 3
CAN_PACKET_STATUS = 9
FAULT_CODES = {
    0: "none", 1: "over voltage", 2: "under voltage", 3: "DRV", 4: "absolute over current",
    5: "FET over temperature", 6: "motor over temperature", 7: "gate driver over voltage",
    8: "gate driver under voltage", 9: "MCU under voltage", 10: "booting from watchdog reset",
}


def frame_packet(payload: bytes) -> bytes:
    """packet_send_packet(): short packets only (payload up to 255 bytes)."""
    if not 0 < len(payload) <= 255:
        raise ValueError("VESC short packet payload must be 1..255 bytes")
    return bytes([2, len(payload)]) + payload + struct.pack(">H", crc16_xmodem(payload)) + b"\x03"


def unframe_packet(raw: bytes) -> bytes:
    if len(raw) < 5 or raw[0] != 2 or raw[-1] != 3:
        raise ValueError("not a VESC short packet")
    length = raw[1]
    if len(raw) != length + 5:
        raise ValueError("bad VESC packet length")
    payload = raw[2:2 + length]
    if struct.unpack(">H", raw[2 + length:4 + length])[0] != crc16_xmodem(payload):
        raise ValueError("VESC CRC mismatch")
    return payload


def read_packet(stream: ByteStream, max_empty_reads: int = 2) -> bytes:
    buffer = b""
    empty = 0

    def fill(count: int) -> None:
        nonlocal buffer, empty
        while len(buffer) < count:
            chunk = stream.read(count - len(buffer))
            if not chunk:
                empty += 1
                if empty >= max_empty_reads:
                    raise TransportError("no reply from VESC (timeout)")
                continue
            buffer += chunk

    while True:
        fill(2)
        if buffer[0] != 2:
            buffer = buffer[1:]
            continue
        fill(buffer[1] + 5)
        return buffer[: buffer[1] + 5]


def forward(can_id: int | None, payload: bytes) -> bytes:
    """COMM_FORWARD_CAN: the UART-connected VESC passes the command to can_id."""
    if can_id is None:
        return payload
    return bytes([COMM_FORWARD_CAN, can_id & 0xFF]) + payload


def set_rpm_payload(erpm: int) -> bytes:
    return bytes([COMM_SET_RPM]) + struct.pack(">i", erpm)


def set_current_payload(current_a: float) -> bytes:
    return bytes([COMM_SET_CURRENT]) + struct.pack(">i", int(current_a * 1000))


def get_values_payload() -> bytes:
    return bytes([COMM_GET_VALUES])


@dataclass
class Values:
    temp_fet_c: float
    temp_motor_c: float
    motor_current_a: float
    input_current_a: float
    duty: float
    erpm: int
    input_voltage_v: float
    tachometer: int
    fault_code: int


_VALUES = struct.Struct(">hhiiiihihiiiiiiB")


def decode_values(payload: bytes) -> Values:
    """COMM_GET_VALUES reply, fields up to fault_code (commands.c)."""
    if not payload or payload[0] != COMM_GET_VALUES or len(payload) < 1 + _VALUES.size:
        raise ValueError("not a COMM_GET_VALUES reply")
    (t_fet, t_motor, i_motor, i_in, _id, _iq, duty, rpm, v_in, _ah, _ahc, _wh, _whc, tacho, _tacho_abs, fault) = _VALUES.unpack_from(payload, 1)
    return Values(t_fet / 10, t_motor / 10, i_motor / 100, i_in / 100, duty / 1000, rpm, v_in / 10, tacho, fault)


def encode_values(v: Values) -> bytes:
    """Inverse of decode_values, for test fakes."""
    return bytes([COMM_GET_VALUES]) + _VALUES.pack(
        int(v.temp_fet_c * 10), int(v.temp_motor_c * 10), int(v.motor_current_a * 100), int(v.input_current_a * 100),
        0, 0, int(v.duty * 1000), v.erpm, int(v.input_voltage_v * 10), 0, 0, 0, 0, v.tachometer, abs(v.tachometer), v.fault_code)


def can_id(controller_id: int, packet_id: int) -> int:
    return (packet_id << 8) | (controller_id & 0xFF)


def can_set_rpm(controller_id: int, erpm: int) -> CanFrame:
    return CanFrame(can_id(controller_id, CAN_PACKET_SET_RPM), struct.pack(">i", erpm), extended=True)


def can_set_current(controller_id: int, current_a: float) -> CanFrame:
    return CanFrame(can_id(controller_id, CAN_PACKET_SET_CURRENT), struct.pack(">i", int(current_a * 1000)), extended=True)


def can_decode_status(data: bytes) -> tuple[int, float, float]:
    """CAN_PACKET_STATUS: (ERPM, current A, duty)."""
    if len(data) < 8:
        raise ValueError("status frame too short")
    erpm, current, duty = struct.unpack(">ihh", data[:8])
    return erpm, current / 10, duty / 1000


def tps_to_erpm(motor_tps: float, pole_pairs: int) -> int:
    """Truncates toward zero, so the VESC never gets more than asked."""
    return int(motor_tps * 60 * pole_pairs)


def erpm_to_tps(erpm: float, pole_pairs: int) -> float:
    return erpm / 60 / pole_pairs


class _VescBase(WheelPairDriver):
    def __init__(self, controller_id: str, limits: SafetyLimits, geometry: DriveGeometry, pole_pairs: int, clock: Callable[[], int]) -> None:
        super().__init__(controller_id, limits, geometry, clock)
        if pole_pairs <= 0:
            raise ValueError("pole_pairs must be positive")
        self.pole_pairs = pole_pairs

    def _erpm(self, tps: float) -> int:
        cap = tps_to_erpm(self.max_motor_tps(), self.pole_pairs)
        return max(-cap, min(cap, tps_to_erpm(tps, self.pole_pairs)))

    # VESC has no enable: "engaged" means it accepts speed commands. Disengage
    # and estop command zero current, which leaves the motor unpowered.
    def _engage(self) -> None:
        pass


class VescUartDriver(_VescBase):
    """One UART-connected VESC. Each wheel is that VESC (can_id None) or one
    reached through it with COMM_FORWARD_CAN."""

    driver_name = "vesc_uart"

    def __init__(
        self,
        controller_id: str,
        stream: ByteStream,
        limits: SafetyLimits,
        geometry: DriveGeometry,
        pole_pairs: int = 7,
        left_can_id: int | None = None,
        right_can_id: int | None = 1,
        clock: Callable[[], int] = now_ms,
    ) -> None:
        super().__init__(controller_id, limits, geometry, pole_pairs, clock)
        self.stream = stream
        self.left_can_id, self.right_can_id = left_can_id, right_can_id

    def _send(self, payload: bytes) -> None:
        self.stream.write(frame_packet(payload))

    def _values(self, target: int | None) -> Values:
        self._send(forward(target, get_values_payload()))
        while True:
            try:
                payload = unframe_packet(read_packet(self.stream))
            except ValueError as error:
                raise TransportError(f"bad VESC reply: {error}") from error
            if payload and payload[0] == COMM_GET_VALUES:
                return decode_values(payload)

    def _open(self) -> None:
        self.stream.open()

    def _close(self) -> None:
        self.stream.close()

    def _configure(self) -> None:
        for target in (self.left_can_id, self.right_can_id):
            self._check(self._values(target), target)
            self._send(forward(target, set_current_payload(0.0)))

    def _check(self, values: Values, target: int | None) -> None:
        if values.fault_code:
            name = FAULT_CODES.get(values.fault_code, f"code {values.fault_code}")
            raise ControllerFault(f"VESC {'local' if target is None else target} fault: {name}")

    def _disengage(self) -> None:
        for target in (self.left_can_id, self.right_can_id):
            self._send(forward(target, set_current_payload(0.0)))

    def _command(self, left_tps: float, right_tps: float) -> None:
        self._send(forward(self.left_can_id, set_rpm_payload(self._erpm(left_tps))))
        self._send(forward(self.right_can_id, set_rpm_payload(self._erpm(right_tps))))

    def _read_feedback(self) -> Feedback:
        left = self._values(self.left_can_id)
        self._check(left, self.left_can_id)
        right = self._values(self.right_can_id)
        self._check(right, self.right_can_id)
        return Feedback(
            left_tps=erpm_to_tps(left.erpm, self.pole_pairs),
            right_tps=erpm_to_tps(right.erpm, self.pole_pairs),
            details={"input_voltage_v": left.input_voltage_v, "temp_fet_c": [left.temp_fet_c, right.temp_fet_c]},
        )


class VescCanDriver(_VescBase):
    """Two VESCs on a CAN bus. Needs CAN status messages (STATUS 1) enabled in
    each VESC's app configuration; a silent VESC is a fault."""

    driver_name = "vesc_can"

    def __init__(
        self,
        controller_id: str,
        bus: CanBus,
        limits: SafetyLimits,
        geometry: DriveGeometry,
        pole_pairs: int = 7,
        left_can_id: int = 0,
        right_can_id: int = 1,
        status_timeout_ms: int = 500,
        clock: Callable[[], int] = now_ms,
    ) -> None:
        super().__init__(controller_id, limits, geometry, pole_pairs, clock)
        self.bus = bus
        self.left_can_id, self.right_can_id = left_can_id, right_can_id
        self.status_timeout_ms = status_timeout_ms
        self._status: dict[int, tuple[int, float, float]] = {}
        self._status_ms: dict[int, int] = {}

    @property
    def ids(self) -> tuple[int, int]:
        return self.left_can_id, self.right_can_id

    def _open(self) -> None:
        self.bus.open()
        self._status.clear()
        self._status_ms.clear()

    def _close(self) -> None:
        self.bus.close()

    def _handle(self, frame: CanFrame) -> None:
        if not frame.extended:
            return
        packet_id, vesc_id = frame.arbitration_id >> 8, frame.arbitration_id & 0xFF
        if packet_id == CAN_PACKET_STATUS and vesc_id in self.ids:
            self._status[vesc_id] = can_decode_status(frame.data)
            self._status_ms[vesc_id] = self.clock()

    def _configure(self) -> None:
        deadline = self.clock() + self.status_timeout_ms
        while any(i not in self._status for i in self.ids):
            if self.clock() > deadline:
                missing = [i for i in self.ids if i not in self._status]
                raise TransportError(f"no CAN status from VESC {missing}")
            frame = self.bus.recv(0.05)
            if frame is not None:
                self._handle(frame)
        self._disengage()

    def _disengage(self) -> None:
        for i in self.ids:
            self.bus.send(can_set_current(i, 0.0))

    def _command(self, left_tps: float, right_tps: float) -> None:
        self.bus.send(can_set_rpm(self.left_can_id, self._erpm(left_tps)))
        self.bus.send(can_set_rpm(self.right_can_id, self._erpm(right_tps)))

    def _read_feedback(self) -> Feedback:
        for _ in range(64):
            frame = self.bus.recv(0.0)
            if frame is None:
                break
            self._handle(frame)
        now = self.clock()
        for i in self.ids:
            if i not in self._status_ms or now - self._status_ms[i] > self.status_timeout_ms:
                raise TransportError(f"CAN status lost from VESC {i}")
        (l_erpm, l_cur, _), (r_erpm, r_cur, _) = self._status[self.left_can_id], self._status[self.right_can_id]
        return Feedback(
            left_tps=erpm_to_tps(l_erpm, self.pole_pairs),
            right_tps=erpm_to_tps(r_erpm, self.pole_pairs),
            details={"motor_current_a": [l_cur, r_cur]},
        )
