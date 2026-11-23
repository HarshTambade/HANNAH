from hannah_robot_os.motors.protocol import VelocityPacket


def test_velocity_packet_roundtrip():
    pkt = VelocityPacket(type="velocity", controller_id="c1", linear_x_mps=0.2, angular_z_rps=-0.1)
    raw = pkt.encode()
    decoded = VelocityPacket.decode(raw)
    assert decoded == pkt
