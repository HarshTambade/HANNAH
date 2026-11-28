"""Packet encoders/decoders against known byte vectors.

Dynamixel vectors are copied from the Robotis e-Manual, Protocol 2.0, section 5
("Example"). The ODrive ASCII checksum vector is the docs' own example. ODrive
CAN and VESC docs/sources give no example frames: those vectors are built by
hand from the documented field layouts (noted per test).
"""
import struct

import pytest

from hannah_robot_os.motors.drivers import dynamixel as dxl
from hannah_robot_os.motors.drivers import odrive, vesc
from hannah_robot_os.motors.drivers.crc import crc16_dynamixel, crc16_xmodem

h = bytes.fromhex


# ---- CRC -------------------------------------------------------------------

def test_crc16_dynamixel_matches_emanual_ping():
    # 5.1 Ping: FF FF FD 00 01 03 00 01 | CRC 19 4E (low byte first)
    assert crc16_dynamixel(h("FFFFFD0001030001")) == 0x4E19


def test_crc16_xmodem_check_value():
    # Standard CRC-16/XMODEM check value for "123456789".
    assert crc16_xmodem(b"123456789") == 0x31C3


# ---- Dynamixel Protocol 2.0 (e-Manual section 5) -----------------------------

def test_dxl_ping_instruction():
    assert dxl.ping(1) == h("FFFFFD0001030001194E")


def test_dxl_ping_status_decode():
    pkt = dxl.decode_packet(h("FFFFFD000107005500060426655D"))
    assert (pkt.dxl_id, pkt.instruction, pkt.error) == (1, dxl.STATUS, 0)
    assert pkt.params == h("060426")  # model 1030 (0x0406), firmware 0x26


def test_dxl_read_instruction_and_status():
    assert dxl.read(1, 132, 4) == h("FFFFFD0001070002840004001D15")
    pkt = dxl.decode_packet(h("FFFFFD000108005500A60000008CC0"))
    assert int.from_bytes(pkt.params, "little") == 0xA6


def test_dxl_write_instruction_and_status():
    assert dxl.write(1, 116, struct.pack("<I", 512)) == h("FFFFFD0001090003740000020000CA89")
    pkt = dxl.decode_packet(h("FFFFFD000104005500A10C"))
    assert pkt.error == 0 and pkt.params == b""


def test_dxl_sync_write():
    packet = dxl.sync_write(116, 4, {1: struct.pack("<I", 150), 2: struct.pack("<I", 170)})
    assert packet == h("FFFFFD00FE11008374000400019600000002AA0000008287")


def test_dxl_sync_read_and_its_status_packets():
    assert dxl.sync_read(132, 4, [1, 2]) == h("FFFFFD00FE090082840004000102CEFA")
    pkt = dxl.decode_packet(h("FFFFFD0002080055001F080000BABE"))
    assert pkt.dxl_id == 2 and int.from_bytes(pkt.params, "little") == 0x081F


def test_dxl_status_encoder_matches_emanual():
    assert dxl.encode_status(1, 0, h("060426")) == h("FFFFFD000107005500060426655D")


def test_dxl_crc_mismatch_rejected():
    with pytest.raises(ValueError, match="CRC"):
        dxl.decode_packet(h("FFFFFD000107005500060426655E"))


def test_dxl_byte_stuffing_roundtrip():
    # "Packet Process": FF FF FD inside the packet gets an extra FD.
    params = h("0000FFFFFD00")
    packet = dxl.encode_instruction(1, dxl.WRITE, params)
    assert h("FFFFFDFD") in packet[7:]
    length = struct.unpack_from("<H", packet, 5)[0]
    assert length == 1 + len(params) + 1 + 2  # one stuffed byte counted
    assert dxl.decode_packet(packet).params == params


def test_dxl_error_byte_description():
    assert dxl.describe_error(0x04) == "data range error"
    assert "hardware alert" in dxl.describe_error(0x80)
    assert dxl.describe_hardware_error(0x24) == "overload, overheating"


def test_dxl_velocity_units_round_toward_zero():
    # Goal Velocity unit is 0.229 rpm (X-series control table).
    assert dxl.velocity_to_raw(1.0) == 262  # 60 rpm / 0.229 = 262.0087
    assert dxl.velocity_to_raw(-1.0) == -262
    assert abs(dxl.raw_to_velocity(262) - 0.99997) < 1e-4


# ---- ODrive CAN Simple (layouts from "Messages"; vectors built by hand) -------

def test_odrive_arbitration_id():
    assert odrive.arbitration_id(0, odrive.HEARTBEAT) == 0x001
    assert odrive.arbitration_id(1, odrive.SET_INPUT_VEL) == 0x02D
    assert odrive.arbitration_id(0x3F, odrive.ESTOP) == 0x7E2
    assert odrive.split_id(0x02D) == (1, 0x0D)
    with pytest.raises(ValueError):
        odrive.arbitration_id(0x40, 1)


def test_odrive_set_input_vel_frame():
    frame = odrive.encode_set_input_vel(1, 2.0, 0.0)
    assert frame.arbitration_id == 0x02D and not frame.extended
    assert frame.data == h("0000004000000000")  # float32 LE 2.0, 0.0


def test_odrive_set_axis_state_and_mode_and_limits():
    assert odrive.encode_set_axis_state(0, 8).data == h("08000000")
    assert odrive.encode_set_axis_state(0, 8).arbitration_id == 0x007
    mode = odrive.encode_set_controller_mode(2, 2, 1)
    assert mode.arbitration_id == (2 << 5) | 0x0B and mode.data == h("0200000001000000")
    limits = odrive.encode_set_limits(0, 1.5, 10.0)
    assert limits.arbitration_id == 0x00F and limits.data == h("0000C03F00002041")


def test_odrive_estop_and_clear_errors():
    assert odrive.encode_estop(3).arbitration_id == (3 << 5) | 0x02 and odrive.encode_estop(3).data == b""
    assert odrive.encode_clear_errors(0).data == b"\x00"
    assert odrive.encode_request(1, odrive.GET_ENCODER_ESTIMATES).rtr


def test_odrive_heartbeat_and_encoder_decode():
    hb = odrive.decode_heartbeat(h("0100000008000100"))
    assert (hb.axis_error, hb.axis_state, hb.procedure_result, hb.trajectory_done) == (1, 8, 0, True)
    pos, vel = odrive.decode_encoder_estimates(h("0000803F000000C0"))
    assert (pos, vel) == (1.0, -2.0)
    assert odrive.decode_get_error(h("0200000004000000")) == (2, 4)
    with pytest.raises(ValueError):
        odrive.decode_heartbeat(b"\x00")


# ---- ODrive ASCII ("Command Format") ----------------------------------------

def test_odrive_ascii_checksum_matches_docs_example():
    # Docs: "r vbus_voltage *93"
    assert odrive.encode_read("vbus_voltage") == b"r vbus_voltage *93\n"


def test_odrive_ascii_commands():
    assert odrive.encode_velocity(0, 1.0, checksum=False) == b"v 0 1.000000 0.000000\n"
    assert odrive.encode_feedback_request(1, checksum=False) == b"f 1\n"
    assert odrive.encode_write("axis0.requested_state", 8, checksum=False) == b"w axis0.requested_state 8\n"


def test_odrive_ascii_reply_checksum():
    body = "24.087744 "
    good = f"{body}*{odrive.ascii_checksum(body)}\r\n".encode()
    assert odrive.decode_ascii_reply(good) == "24.087744"
    with pytest.raises(Exception, match="checksum"):
        odrive.decode_ascii_reply(b"24.087744 *1\r\n")
    with pytest.raises(Exception, match="without checksum"):
        odrive.decode_ascii_reply(b"24.087744\r\n")
    assert odrive.decode_ascii_reply(b"24.087744\r\n", checksum=False) == "24.087744"


# ---- VESC (datatypes.h / packet.c / comm_can.c; vectors built by hand) --------

def test_vesc_set_rpm_packet():
    payload = vesc.set_rpm_payload(1000)
    assert payload == h("08000003E8")
    framed = vesc.frame_packet(payload)
    assert framed[:2] == h("0205") and framed[-1] == 3
    assert framed[7:9] == struct.pack(">H", crc16_xmodem(payload))
    assert vesc.unframe_packet(framed) == payload


def test_vesc_set_current_and_forward():
    assert vesc.set_current_payload(-2.5) == h("06FFFFF63C")
    assert vesc.forward(7, vesc.set_rpm_payload(-1)) == h("220708FFFFFFFF")
    assert vesc.forward(None, b"\x04") == b"\x04"


def test_vesc_bad_crc_rejected():
    framed = bytearray(vesc.frame_packet(b"\x04"))
    framed[3] ^= 0xFF
    with pytest.raises(ValueError, match="CRC"):
        vesc.unframe_packet(bytes(framed))


def test_vesc_get_values_roundtrip():
    v = vesc.Values(31.5, 40.2, 3.25, 1.5, 0.25, -4200, 24.6, 1234, 0)
    decoded = vesc.decode_values(vesc.encode_values(v))
    assert decoded.erpm == -4200 and decoded.fault_code == 0
    assert abs(decoded.input_voltage_v - 24.6) < 1e-9 and abs(decoded.duty - 0.25) < 1e-9


def test_vesc_can_frames():
    frame = vesc.can_set_rpm(5, 1000)
    assert frame.extended and frame.arbitration_id == 0x305 and frame.data == h("000003E8")
    cur = vesc.can_set_current(5, 0.0)
    assert cur.arbitration_id == 0x105 and cur.data == h("00000000")
    erpm, current, duty = vesc.can_decode_status(h("FFFFF060003200FA"))
    assert (erpm, current, duty) == (-4000, 5.0, 0.25)


def test_vesc_erpm_conversion_truncates():
    assert vesc.tps_to_erpm(1.0, 7) == 420
    assert vesc.tps_to_erpm(-0.9999, 7) == -419
