import os
import pty
import threading

from hannah_robot_os.motors.framed import FramedTransport
from hannah_robot_os.motors.posix_serial import PosixSerialStream
from hannah_robot_os.motors.serial_adapter import SerialControllerAdapter
from hannah_robot_os.motors.sim import SimMotorController
from hannah_robot_os.motors.transport import SimMCUResponder


def test_serial_adapter_over_pty():
    master, slave = pty.openpty()
    stream = PosixSerialStream(os.ttyname(slave), timeout_ms=1000)
    stream.open()
    ctrl = SimMotorController(controller_id="pty-mc")
    ctrl.connect()
    responder = SimMCUResponder(ctrl)

    def mcu():
        raw = os.read(master, 4096)
        os.write(master, responder.handle(raw))

    tr = FramedTransport(write=stream.write, read_line=stream.read_line, timeout_ms=1000, retries=0)
    adapter = SerialControllerAdapter(controller_id="pty-mc", transport=tr)
    adapter.connect()

    t = threading.Thread(target=mcu, daemon=True)
    t.start()
    adapter.enable(True)
    t.join(timeout=3)

    t2 = threading.Thread(target=mcu, daemon=True)
    t2.start()
    adapter.send_velocity(0.1, 0.0)
    t2.join(timeout=3)
    assert abs(ctrl.status().velocity_left_mps - 0.1) < 1e-6

    stream.close()
    os.close(master)
    os.close(slave)
