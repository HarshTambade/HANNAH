"""Fake buses and serial lines that answer like the real controllers would.

They answer from the same public protocol layouts the drivers follow, so they
prove the drivers' behaviour (ramping, clamping, stops, faults, reconnect), not
that a real controller agrees. Each fake can be broken (`fail`) or silenced.
"""
from __future__ import annotations

import struct

from hannah_robot_os.motors.drivers import dynamixel as dxl
from hannah_robot_os.motors.drivers import odrive, vesc
from hannah_robot_os.motors.drivers.base import TransportError
from hannah_robot_os.motors.drivers.buses import CanFrame


class Clock:
    """Advances a little on every read, so wait loops in drivers always end."""

    def __init__(self, t: int = 1_000_000, step: int = 10) -> None:
        self.t = t
        self.step = step

    def __call__(self) -> int:
        self.t += self.step
        return self.t


class _Breakable:
    def __init__(self) -> None:
        self.fail = False  # every send/write raises
        self.opened = False
        self.open_count = 0

    def open(self) -> None:
        if self.fail:
            raise TransportError("device unplugged")
        self.opened = True
        self.open_count += 1

    def close(self) -> None:
        self.opened = False

    def _check(self) -> None:
        if self.fail or not self.opened:
            raise TransportError("device unplugged" if self.fail else "not open")


class _CyclicBus(_Breakable):
    """recv() hands out one batch of cyclic frames per drain, like a periodic sender."""

    def __init__(self) -> None:
        super().__init__()
        self.sent: list[CanFrame] = []
        self.inbox: list[CanFrame] = []
        self.silent = False
        self._served = False

    def cyclic(self) -> list[CanFrame]:
        return []

    def send(self, frame: CanFrame) -> None:
        self._check()
        self.sent.append(frame)
        self.on_frame(frame)

    def on_frame(self, frame: CanFrame) -> None: ...

    def recv(self, timeout_s: float) -> CanFrame | None:
        self._check()
        if not self.inbox:
            if self._served or self.silent:
                self._served = False
                return None
            self.inbox.extend(self.cyclic())
            self._served = True
        return self.inbox.pop(0) if self.inbox else None


class FakeODriveBus(_CyclicBus):
    def __init__(self, nodes=(0, 1)) -> None:
        super().__init__()
        self.state = {n: odrive.AXIS_STATE_IDLE for n in nodes}
        self.error = {n: 0 for n in nodes}
        self.vel = {n: 0.0 for n in nodes}
        self.vel_limit = {n: None for n in nodes}
        self.estops = 0

    def on_frame(self, frame: CanFrame) -> None:
        node, cmd = odrive.split_id(frame.arbitration_id)
        if node not in self.state:
            return
        if cmd == odrive.SET_AXIS_STATE:
            self.state[node] = struct.unpack("<I", frame.data)[0]
        elif cmd == odrive.SET_INPUT_VEL:
            vel = struct.unpack("<ff", frame.data)[0]
            limit = self.vel_limit[node]
            self.vel[node] = vel if limit is None else max(-limit, min(limit, vel))
        elif cmd == odrive.SET_LIMITS:
            self.vel_limit[node] = struct.unpack("<ff", frame.data)[0]
        elif cmd == odrive.ESTOP:
            self.estops += 1
            self.state[node] = odrive.AXIS_STATE_IDLE
            self.vel[node] = 0.0

    def cyclic(self) -> list[CanFrame]:
        frames = []
        for n in self.state:
            frames.append(CanFrame(odrive.arbitration_id(n, odrive.HEARTBEAT), struct.pack("<IBBBx", self.error[n], self.state[n], 0, 1)))
            frames.append(CanFrame(odrive.arbitration_id(n, odrive.GET_ENCODER_ESTIMATES), struct.pack("<ff", 0.0, self.vel[n])))
        return frames

    def last_vel(self) -> tuple[float, float]:
        return self.vel[0], self.vel[1]


class FakeVescBus(_CyclicBus):
    def __init__(self, ids=(0, 1)) -> None:
        super().__init__()
        self.erpm = {i: 0 for i in ids}
        self.current = {i: None for i in ids}

    def on_frame(self, frame: CanFrame) -> None:
        packet, vid = frame.arbitration_id >> 8, frame.arbitration_id & 0xFF
        if vid not in self.erpm:
            return
        value = struct.unpack(">i", frame.data)[0]
        if packet == vesc.CAN_PACKET_SET_RPM:
            self.erpm[vid], self.current[vid] = value, None
        elif packet == vesc.CAN_PACKET_SET_CURRENT:
            self.erpm[vid], self.current[vid] = 0, value / 1000

    def cyclic(self) -> list[CanFrame]:
        return [CanFrame(vesc.can_id(i, vesc.CAN_PACKET_STATUS), struct.pack(">ihh", self.erpm[i], 0, 0), extended=True) for i in self.erpm]

    def last_vel(self) -> tuple[float, float]:
        return vesc.erpm_to_tps(self.erpm[0], 7), vesc.erpm_to_tps(self.erpm[1], 7)


class _FakeStream(_Breakable):
    def __init__(self) -> None:
        super().__init__()
        self.rx = b""
        self.silent = False
        self.written: list[bytes] = []

    def write(self, data: bytes) -> None:
        self._check()
        self.written.append(data)
        reply = self.handle(data)
        if reply and not self.silent:
            self.rx += reply

    def handle(self, data: bytes) -> bytes:
        return b""

    def read(self, size: int) -> bytes:
        self._check()
        out, self.rx = self.rx[:size], self.rx[size:]
        return out

    def read_line(self) -> bytes:
        self._check()
        if b"\n" not in self.rx:
            return b""
        line, self.rx = self.rx.split(b"\n", 1)
        return line + b"\n"


class FakeDynamixelLine(_FakeStream):
    def __init__(self, ids=(1, 2)) -> None:
        super().__init__()
        self.mem = {i: bytearray(256) for i in ids}
        self.hardware_error = {i: 0 for i in ids}

    def reg(self, dxl_id: int, address: int, size: int) -> int:
        return int.from_bytes(self.mem[dxl_id][address:address + size], "little", signed=True)

    def handle(self, data: bytes) -> bytes:
        pkt = dxl.decode_packet(data)
        if pkt.dxl_id not in self.mem:
            return b""
        mem = self.mem[pkt.dxl_id]
        alert = dxl.ERROR_ALERT if self.hardware_error[pkt.dxl_id] else 0
        if pkt.instruction == dxl.PING:
            return dxl.encode_status(pkt.dxl_id, alert, bytes([0x06, 0x04, 0x26]))
        if pkt.instruction == dxl.READ:
            address, size = struct.unpack("<HH", pkt.params)
            if address == dxl.ADDR_HARDWARE_ERROR:
                return dxl.encode_status(pkt.dxl_id, alert, bytes([self.hardware_error[pkt.dxl_id]]))
            return dxl.encode_status(pkt.dxl_id, alert, bytes(mem[address:address + size]))
        if pkt.instruction == dxl.WRITE:
            address = struct.unpack_from("<H", pkt.params)[0]
            value = pkt.params[2:]
            if address < dxl.ADDR_TORQUE_ENABLE and mem[dxl.ADDR_TORQUE_ENABLE]:
                return dxl.encode_status(pkt.dxl_id, 0x07)  # access error: EEPROM with torque on
            if address == dxl.ADDR_GOAL_VELOCITY:
                limit = self.reg(pkt.dxl_id, dxl.ADDR_VELOCITY_LIMIT, 4)
                if abs(int.from_bytes(value, "little", signed=True)) > limit:
                    return dxl.encode_status(pkt.dxl_id, 0x06)  # data limit error
                if not mem[dxl.ADDR_TORQUE_ENABLE]:
                    value = b"\x00\x00\x00\x00"
                mem[dxl.ADDR_PRESENT_VELOCITY:dxl.ADDR_PRESENT_VELOCITY + 4] = value
            if address == dxl.ADDR_TORQUE_ENABLE and value == b"\x00":
                mem[dxl.ADDR_PRESENT_VELOCITY:dxl.ADDR_PRESENT_VELOCITY + 4] = b"\x00\x00\x00\x00"
            mem[address:address + len(value)] = value
            return dxl.encode_status(pkt.dxl_id, alert)
        return dxl.encode_status(pkt.dxl_id, 0x02)

    def goal(self, dxl_id: int) -> int:
        return self.reg(dxl_id, dxl.ADDR_GOAL_VELOCITY, 4)

    def last_vel(self) -> tuple[float, float]:
        return dxl.raw_to_velocity(self.reg(1, dxl.ADDR_PRESENT_VELOCITY, 4)), dxl.raw_to_velocity(self.reg(2, dxl.ADDR_PRESENT_VELOCITY, 4))


class FakeODriveAsciiLine(_FakeStream):
    def __init__(self) -> None:
        super().__init__()
        self.vel = {0: 0.0, 1: 0.0}
        self.state = {0: odrive.AXIS_STATE_IDLE, 1: odrive.AXIS_STATE_IDLE}
        self.errors = {0: 0, 1: 0}
        self.props: dict[str, str] = {}

    def _reply(self, body: str) -> bytes:
        body = body + " "
        return f"{body}*{odrive.ascii_checksum(body)}\r\n".encode()

    def handle(self, data: bytes) -> bytes:
        text = data.decode().strip()
        body, _, cs = text.rpartition("*")
        if odrive.ascii_checksum(body) != int(cs):
            return b""  # the ODrive ignores a line with a bad checksum
        parts = body.split()
        if parts[0] == "v":
            n, vel = int(parts[1]), float(parts[2])
            self.vel[n] = vel if self.state[n] == odrive.AXIS_STATE_CLOSED_LOOP_CONTROL else 0.0
        elif parts[0] == "f":
            n = int(parts[1])
            return self._reply(f"0.000000 {self.vel[n]:.6f}")
        elif parts[0] == "r":
            prop = parts[1]
            if prop == "vbus_voltage":
                return self._reply("24.087744")
            if prop.endswith("active_errors"):
                return self._reply(str(self.errors[int(prop[4])]))
            return self._reply(self.props.get(prop, "0"))
        elif parts[0] == "w":
            prop, value = parts[1], parts[2]
            self.props[prop] = value
            if prop.endswith("requested_state"):
                n = int(prop[4])
                self.state[n] = int(value)
                if int(value) == odrive.AXIS_STATE_IDLE:
                    self.vel[n] = 0.0
        return b""

    def last_vel(self) -> tuple[float, float]:
        return self.vel[0], self.vel[1]


class FakeVescUart(_FakeStream):
    """A UART VESC (target None) forwarding to CAN VESC 1."""

    def __init__(self) -> None:
        super().__init__()
        self.erpm = {None: 0, 1: 0}
        self.current = {None: None, 1: None}
        self.fault = {None: 0, 1: 0}

    def handle(self, data: bytes) -> bytes:
        payload = vesc.unframe_packet(data)
        target = None
        if payload[0] == vesc.COMM_FORWARD_CAN:
            target, payload = payload[1], payload[2:]
        if target not in self.erpm:
            return b""
        if payload[0] == vesc.COMM_SET_RPM:
            self.erpm[target], self.current[target] = struct.unpack(">i", payload[1:5])[0], None
        elif payload[0] == vesc.COMM_SET_CURRENT:
            self.erpm[target], self.current[target] = 0, struct.unpack(">i", payload[1:5])[0] / 1000
        elif payload[0] == vesc.COMM_GET_VALUES:
            values = vesc.Values(30.0, 30.0, 0.0, 0.0, 0.0, self.erpm[target], 24.0, 0, self.fault[target])
            return vesc.frame_packet(vesc.encode_values(values))
        return b""

    def last_vel(self) -> tuple[float, float]:
        return vesc.erpm_to_tps(self.erpm[None], 7), vesc.erpm_to_tps(self.erpm[1], 7)
