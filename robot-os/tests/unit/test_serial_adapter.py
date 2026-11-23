from hannah_robot_os.motors.framed import FramedTransport
from hannah_robot_os.motors.protocol import VelocityPacket
from hannah_robot_os.motors.serial_adapter import SerialControllerAdapter
from hannah_robot_os.motors.sim import SimMotorController
from hannah_robot_os.motors.transport import SimMCUResponder


class FakeLine:
    def __init__(self, responder):
        self.responder = responder
        self.inbox = []
        self.outbox = []

    def write(self, raw):
        self.inbox.append(self.responder.handle(raw))

    def read_line(self):
        return self.inbox.pop(0) if self.inbox else b""


class Clock:
    def __init__(self):
        self.t = 0

    def __call__(self):
        self.t += 100
        return self.t


def make_adapter():
    ctrl = SimMotorController(controller_id="mc1")
    ctrl.connect()
    line = FakeLine(SimMCUResponder(ctrl))
    tr = FramedTransport(write=line.write, read_line=line.read_line, clock=Clock(), timeout_ms=500, retries=1)
    adapter = SerialControllerAdapter(controller_id="mc1", transport=tr)
    adapter.connect()
    return adapter, ctrl, line


def test_serial_adapter_enable_velocity_status_stop():
    adapter, ctrl, line = make_adapter()
    adapter.enable(True)
    adapter.send_velocity(0.2, 0.0)
    st = adapter.status()
    assert st.connected and st.enabled
    assert abs(st.velocity_left_mps - 0.2) < 1e-6
    adapter.stop()
    assert ctrl.status().velocity_left_mps == 0.0


def test_framed_transport_timeout_returns_fault():
    line = FakeLine(SimMCUResponder(SimMotorController(controller_id="mc1")))
    tr = FramedTransport(write=line.write, read_line=lambda: b"", clock=Clock(), timeout_ms=300, retries=0)
    ack = tr.request(VelocityPacket(type="status", controller_id="mc1"))
    assert not ack.ok
    assert ack.reason == "timeout"
