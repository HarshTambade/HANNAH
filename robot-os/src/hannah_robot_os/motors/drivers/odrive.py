"""ODrive over CAN (CAN Simple protocol) and over USB/UART (ASCII protocol).

Sources (ODrive documentation, "latest", firmware 0.6):
- CAN Simple: https://docs.odriverobotics.com/v/latest/manual/can-protocol.html
  sections "Overview", "Cyclic Messages", "Watchdog" and "Messages".
- ASCII: https://docs.odriverobotics.com/v/latest/manual/ascii-protocol.html
  sections "Command Format", "Command Reference" and "System Commands".
- Enum values: "ODrive API Reference" (AxisState, Controller.ControlMode,
  Controller.InputMode).

The CAN docs give message layouts but no example frames, so the test vectors
are built from those layouts by hand. Tested against fake buses only, never on a
real ODrive.
"""
from __future__ import annotations

import struct
from dataclasses import dataclass
from typing import Callable

from ...common import now_ms
from ...config import SafetyLimits
from .base import ControllerFault, DriveGeometry, Feedback, TransportError, WheelPairDriver
from .buses import ByteStream, CanBus, CanFrame

# "Messages": cmd_id values.
HEARTBEAT = 0x001
ESTOP = 0x002
GET_ERROR = 0x003
SET_AXIS_STATE = 0x007
GET_ENCODER_ESTIMATES = 0x009
SET_CONTROLLER_MODE = 0x00B
SET_INPUT_VEL = 0x00D
SET_LIMITS = 0x00F
GET_BUS_VOLTAGE_CURRENT = 0x017
CLEAR_ERRORS = 0x018
MAX_NODE_ID = 0x3E  # 0x3F is broadcast ("Broadcast")

# API reference enums.
AXIS_STATE_IDLE = 1
AXIS_STATE_CLOSED_LOOP_CONTROL = 8
CONTROL_MODE_VELOCITY = 2
INPUT_MODE_PASSTHROUGH = 1


def arbitration_id(node_id: int, cmd_id: int) -> int:
    """"Overview": 11-bit ID = node_id (upper 6 bits) << 5 | cmd_id (lower 5 bits)."""
    if not 0 <= node_id <= 0x3F or not 0 <= cmd_id <= 0x1F:
        raise ValueError("node_id or cmd_id out of range")
    return (node_id << 5) | cmd_id


def split_id(arb_id: int) -> tuple[int, int]:
    return arb_id >> 5, arb_id & 0x1F


# Payloads are little-endian; floats are IEEE 754 float32 ("Overview").
def encode_set_axis_state(node_id: int, state: int) -> CanFrame:
    return CanFrame(arbitration_id(node_id, SET_AXIS_STATE), struct.pack("<I", state))


def encode_set_controller_mode(node_id: int, control_mode: int, input_mode: int) -> CanFrame:
    return CanFrame(arbitration_id(node_id, SET_CONTROLLER_MODE), struct.pack("<II", control_mode, input_mode))


def encode_set_input_vel(node_id: int, vel_rev_s: float, torque_ff_nm: float = 0.0) -> CanFrame:
    return CanFrame(arbitration_id(node_id, SET_INPUT_VEL), struct.pack("<ff", vel_rev_s, torque_ff_nm))


def encode_set_limits(node_id: int, vel_limit_rev_s: float, current_limit_a: float) -> CanFrame:
    return CanFrame(arbitration_id(node_id, SET_LIMITS), struct.pack("<ff", vel_limit_rev_s, current_limit_a))


def encode_estop(node_id: int) -> CanFrame:
    return CanFrame(arbitration_id(node_id, ESTOP), b"")


def encode_clear_errors(node_id: int, identify: int = 0) -> CanFrame:
    return CanFrame(arbitration_id(node_id, CLEAR_ERRORS), bytes([identify]))


def encode_request(node_id: int, cmd_id: int) -> CanFrame:
    """"RTR": a Get_ message is requested with an RTR frame of the same ID."""
    return CanFrame(arbitration_id(node_id, cmd_id), b"", rtr=True)


@dataclass
class Heartbeat:
    axis_error: int
    axis_state: int
    procedure_result: int
    trajectory_done: bool


def decode_heartbeat(data: bytes) -> Heartbeat:
    """Heartbeat: Axis_Error uint32, Axis_State uint8, Procedure_Result uint8, Trajectory_Done uint8."""
    if len(data) < 7:
        raise ValueError("heartbeat too short")
    error, state, result, done = struct.unpack_from("<IBBB", data)
    return Heartbeat(error, state, result, bool(done))


def decode_encoder_estimates(data: bytes) -> tuple[float, float]:
    """Get_Encoder_Estimates: Pos_Estimate float32 (rev), Vel_Estimate float32 (rev/s)."""
    if len(data) < 8:
        raise ValueError("encoder estimates too short")
    return struct.unpack_from("<ff", data)


def decode_get_error(data: bytes) -> tuple[int, int]:
    """Get_Error: Active_Errors uint32, Disarm_Reason uint32."""
    if len(data) < 8:
        raise ValueError("get_error too short")
    return struct.unpack_from("<II", data)


@dataclass
class _Axis:
    node_id: int
    heartbeat: Heartbeat | None = None
    heartbeat_ms: int | None = None
    pos: float | None = None
    vel: float | None = None


class ODriveCanDriver(WheelPairDriver):
    """One ODrive axis per wheel, each its own CAN node."""

    driver_name = "odrive_can"

    def __init__(
        self,
        controller_id: str,
        bus: CanBus,
        limits: SafetyLimits,
        geometry: DriveGeometry,
        left_node_id: int = 0,
        right_node_id: int = 1,
        current_limit_a: float = 10.0,
        heartbeat_timeout_ms: int = 500,
        clock: Callable[[], int] = now_ms,
    ) -> None:
        super().__init__(controller_id, limits, geometry, clock)
        self.bus = bus
        self.left = _Axis(left_node_id)
        self.right = _Axis(right_node_id)
        self.current_limit_a = current_limit_a
        self.heartbeat_timeout_ms = heartbeat_timeout_ms

    @property
    def axes(self) -> tuple[_Axis, _Axis]:
        return self.left, self.right

    def _open(self) -> None:
        self.bus.open()
        for axis in self.axes:
            axis.heartbeat = None
            axis.heartbeat_ms = None

    def _close(self) -> None:
        self.bus.close()

    def _drain(self, max_frames: int = 64) -> None:
        for _ in range(max_frames):
            frame = self.bus.recv(0.0)
            if frame is None:
                return
            self._handle(frame)

    def _handle(self, frame: CanFrame) -> None:
        if frame.extended or frame.rtr:
            return
        node_id, cmd_id = split_id(frame.arbitration_id)
        for axis in self.axes:
            if axis.node_id != node_id:
                continue
            if cmd_id == HEARTBEAT:
                axis.heartbeat = decode_heartbeat(frame.data)
                axis.heartbeat_ms = self.clock()
            elif cmd_id == GET_ENCODER_ESTIMATES:
                axis.pos, axis.vel = decode_encoder_estimates(frame.data)

    def _wait_for_heartbeats(self) -> None:
        deadline = self.clock() + self.heartbeat_timeout_ms
        while any(a.heartbeat is None for a in self.axes):
            if self.clock() > deadline:
                missing = [a.node_id for a in self.axes if a.heartbeat is None]
                raise TransportError(f"no heartbeat from ODrive node(s) {missing}")
            frame = self.bus.recv(0.05)
            if frame is not None:
                self._handle(frame)

    def _configure(self) -> None:
        # The heartbeat (default every 100 ms, "Cyclic Messages") shows each node is there.
        self._wait_for_heartbeats()
        # Errors are never cleared here: an axis that reports one stays faulted
        # until a person clears it (Clear_Errors, e.g. from odrivetool).
        for axis in self.axes:
            if axis.heartbeat and axis.heartbeat.axis_error:
                raise ControllerFault(f"ODrive node {axis.node_id} axis error 0x{axis.heartbeat.axis_error:08x}")
        vel_limit = self.max_motor_tps()
        for axis in self.axes:
            self.bus.send(encode_set_axis_state(axis.node_id, AXIS_STATE_IDLE))
            self.bus.send(encode_set_controller_mode(axis.node_id, CONTROL_MODE_VELOCITY, INPUT_MODE_PASSTHROUGH))
            self.bus.send(encode_set_limits(axis.node_id, vel_limit, self.current_limit_a))

    def _engage(self) -> None:
        for axis in self.axes:
            self.bus.send(encode_set_axis_state(axis.node_id, AXIS_STATE_CLOSED_LOOP_CONTROL))

    def _disengage(self) -> None:
        for axis in self.axes:
            self.bus.send(encode_set_axis_state(axis.node_id, AXIS_STATE_IDLE))

    def _command(self, left_tps: float, right_tps: float) -> None:
        self.bus.send(encode_set_input_vel(self.left.node_id, left_tps))
        self.bus.send(encode_set_input_vel(self.right.node_id, right_tps))

    def _emergency(self) -> None:
        # "Estop": disarms the axis with ESTOP_REQUESTED.
        for axis in self.axes:
            self.bus.send(encode_estop(axis.node_id))

    def _read_feedback(self) -> Feedback:
        self._drain()
        now = self.clock()
        for axis in self.axes:
            if axis.heartbeat_ms is None or now - axis.heartbeat_ms > self.heartbeat_timeout_ms:
                raise TransportError(f"heartbeat lost from ODrive node {axis.node_id}")
            hb = axis.heartbeat
            if hb and hb.axis_error:
                raise ControllerFault(f"ODrive node {axis.node_id} axis error 0x{hb.axis_error:08x}")
            if hb and self._enabled and hb.axis_state != AXIS_STATE_CLOSED_LOOP_CONTROL:
                raise ControllerFault(f"ODrive node {axis.node_id} left closed loop (state {hb.axis_state})")
        return Feedback(
            left_tps=self.left.vel, right_tps=self.right.vel, left_turns=self.left.pos, right_turns=self.right.pos,
            details={"axis_states": [a.heartbeat.axis_state if a.heartbeat else None for a in self.axes]},
        )


# ---- ASCII protocol --------------------------------------------------------

def ascii_checksum(line: str) -> int:
    """"Command Format": GCode-style checksum, XOR of every character before '*'."""
    value = 0
    for byte in line.encode("ascii"):
        value ^= byte
    return value


def encode_ascii(command: str, checksum: bool = True) -> bytes:
    """One command line ending in a single '\\n' (CR/LF can give spurious errors)."""
    command = command.strip()
    if checksum:
        command = f"{command} *{ascii_checksum(command + ' ')}"
    return (command + "\n").encode("ascii")


def decode_ascii_reply(raw: bytes, checksum: bool = True) -> str:
    """Strip CR/LF and, if present, check and remove the '*cs' checksum."""
    text = raw.decode("ascii", errors="replace").strip()
    if "*" in text:
        body, _, cs = text.rpartition("*")
        try:
            given = int(cs.strip())
        except ValueError as error:
            raise TransportError(f"bad checksum field in reply: {text!r}") from error
        if ascii_checksum(body) != given:
            raise TransportError(f"reply checksum mismatch: {text!r}")
        return body.strip()
    if checksum:
        raise TransportError(f"reply without checksum: {text!r}")
    return text


def encode_velocity(motor: int, vel_rev_s: float, torque_ff: float = 0.0, checksum: bool = True) -> bytes:
    """"Motor Velocity": v motor velocity torque_ff (also feeds the watchdog)."""
    return encode_ascii(f"v {motor} {vel_rev_s:.6f} {torque_ff:.6f}", checksum)


def encode_feedback_request(motor: int, checksum: bool = True) -> bytes:
    """"Request Feedback": f motor, answered with 'pos vel'."""
    return encode_ascii(f"f {motor}", checksum)


def encode_write(prop: str, value: object, checksum: bool = True) -> bytes:
    return encode_ascii(f"w {prop} {value}", checksum)


def encode_read(prop: str, checksum: bool = True) -> bytes:
    return encode_ascii(f"r {prop}", checksum)


class ODriveAsciiDriver(WheelPairDriver):
    """One ODrive with two axes (axis0/axis1) over its USB or UART ASCII port."""

    driver_name = "odrive_ascii"

    def __init__(
        self,
        controller_id: str,
        stream: ByteStream,
        limits: SafetyLimits,
        geometry: DriveGeometry,
        left_axis: int = 0,
        right_axis: int = 1,
        checksum: bool = True,
        error_property: str = "active_errors",
        clock: Callable[[], int] = now_ms,
    ) -> None:
        super().__init__(controller_id, limits, geometry, clock)
        self.stream = stream
        self.left_axis, self.right_axis = left_axis, right_axis
        self.checksum = checksum
        self.error_property = error_property

    @property
    def axes(self) -> tuple[int, int]:
        return self.left_axis, self.right_axis

    def _send(self, raw: bytes) -> None:
        self.stream.write(raw)

    def _query(self, raw: bytes) -> str:
        self.stream.write(raw)
        line = self.stream.read_line()
        if not line:
            raise TransportError("no reply from ODrive (timeout)")
        reply = decode_ascii_reply(line, self.checksum)
        if reply.startswith("unknown command") or reply.startswith("invalid"):
            raise ControllerFault(f"ODrive rejected command: {reply}")
        return reply

    def _open(self) -> None:
        self.stream.open()

    def _close(self) -> None:
        self.stream.close()

    def _configure(self) -> None:
        voltage = self._query(encode_read("vbus_voltage", self.checksum))
        try:
            float(voltage)
        except ValueError as error:
            raise TransportError(f"unexpected reply to r vbus_voltage: {voltage!r}") from error
        # Errors are not cleared ("sc"): a person clears them; status() reports them.
        for n in self.axes:
            err = self._query(encode_read(f"axis{n}.{self.error_property}", self.checksum))
            if err.strip() not in ("0", ""):
                raise ControllerFault(f"ODrive axis{n} {self.error_property} = {err}")
        vel_limit = self.max_motor_tps()
        for n in self.axes:
            self._send(encode_write(f"axis{n}.requested_state", AXIS_STATE_IDLE, self.checksum))
            self._send(encode_write(f"axis{n}.controller.config.control_mode", CONTROL_MODE_VELOCITY, self.checksum))
            self._send(encode_write(f"axis{n}.controller.config.input_mode", INPUT_MODE_PASSTHROUGH, self.checksum))
            self._send(encode_write(f"axis{n}.controller.config.vel_limit", f"{vel_limit:.6f}", self.checksum))

    def _engage(self) -> None:
        for n in self.axes:
            self._send(encode_write(f"axis{n}.requested_state", AXIS_STATE_CLOSED_LOOP_CONTROL, self.checksum))

    def _disengage(self) -> None:
        for n in self.axes:
            self._send(encode_write(f"axis{n}.requested_state", AXIS_STATE_IDLE, self.checksum))

    def _command(self, left_tps: float, right_tps: float) -> None:
        self._send(encode_velocity(self.left_axis, left_tps, checksum=self.checksum))
        self._send(encode_velocity(self.right_axis, right_tps, checksum=self.checksum))

    def _read_feedback(self) -> Feedback:
        values = []
        for n in self.axes:
            reply = self._query(encode_feedback_request(n, self.checksum)).split()
            try:
                pos, vel = float(reply[0]), float(reply[1])
            except (IndexError, ValueError) as error:
                raise TransportError(f"unexpected feedback reply: {reply!r}") from error
            err = self._query(encode_read(f"axis{n}.{self.error_property}", self.checksum))
            if err.strip() not in ("0", ""):
                raise ControllerFault(f"ODrive axis{n} {self.error_property} = {err}")
            values.append((pos, vel))
        (lp, lv), (rp, rv) = values
        return Feedback(left_tps=lv, right_tps=rv, left_turns=lp, right_turns=rp)
