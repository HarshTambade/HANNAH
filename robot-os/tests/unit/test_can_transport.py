from hannah_robot_os.motors.can_codec import FrameReassembler, encode_frames
from hannah_robot_os.motors.can_transport import CANFramedTransport
from hannah_robot_os.motors.protocol import VelocityPacket
from hannah_robot_os.motors.sim import SimMotorController
from hannah_robot_os.motors.transport import SimMCUResponder


class Clock:
    def __init__(self):
        self.t = 0

    def __call__(self):
        self.t += 100
        return self.t


def test_can_frame_roundtrip():
    payload = b"hello world" * 10
    frames = encode_frames(payload)
    assert all(len(f) == 8 for f in frames)
    r = FrameReassembler()
    out = None
    for f in frames:
        out = r.feed(f)
    assert out == payload


def test_can_transport_velocity_ack():
    ctrl = SimMotorController(controller_id="can-mc")
    ctrl.connect()
    mcu = SimMCUResponder(ctrl)
    req_reassembler = FrameReassembler()
    ack_frames = []

    def send_frame(frame):
        payload = req_reassembler.feed(frame)
        if payload:
            ack = mcu.handle(payload)
            ack_frames.extend(encode_frames(ack))

    def recv_frame():
        return ack_frames.pop(0) if ack_frames else None

    tr = CANFramedTransport(send_frame=send_frame, recv_frame=recv_frame, timeout_ms=200, retries=0)
    enabled = tr.request(VelocityPacket(type="enable", controller_id="can-mc", enabled=True))
    assert enabled.ok
    ack = tr.request(VelocityPacket(type="velocity", controller_id="can-mc", linear_x_mps=0.15))
    assert ack.ok
    assert abs(ctrl.status().velocity_left_mps - 0.15) < 1e-6


def test_can_transport_timeout():
    tr = CANFramedTransport(send_frame=lambda _f: None, recv_frame=lambda: None, clock=Clock(), timeout_ms=200, retries=0)
    ack = tr.request(VelocityPacket(type="status", controller_id="can-mc"))
    assert not ack.ok
    assert ack.reason == "timeout"
