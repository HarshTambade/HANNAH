from hannah_robot_os.motors.protocol import VelocityPacket
from hannah_robot_os.motors.sim import SimMotorController
from hannah_robot_os.motors.transport import LoopbackTransport, SimMCUResponder


def test_loopback_enable_velocity_stop():
    ctrl = SimMotorController(controller_id="c1")
    ctrl.connect()
    t = LoopbackTransport(SimMCUResponder(ctrl))

    ack = t.send(VelocityPacket(type="enable", controller_id="c1", enabled=True))
    assert ack.ok and ack.status["enabled"] is True

    ack = t.send(VelocityPacket(type="velocity", controller_id="c1", linear_x_mps=0.2, angular_z_rps=0.0))
    assert ack.ok
    assert ack.status["velocity_left_mps"] == 0.2

    ack = t.send(VelocityPacket(type="stop", controller_id="c1"))
    assert ack.ok
    assert ack.status["velocity_left_mps"] == 0.0


def test_loopback_fault_on_invalid_command():
    ctrl = SimMotorController(controller_id="c1")
    ctrl.connect()
    t = LoopbackTransport(SimMCUResponder(ctrl))
    # velocity while disabled should fault
    ack = t.send(VelocityPacket(type="velocity", controller_id="c1", linear_x_mps=0.2))
    assert not ack.ok
    assert ack.type == "fault"
