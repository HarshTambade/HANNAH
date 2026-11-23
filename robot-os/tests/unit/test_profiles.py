from hannah_robot_os.profiles.schema import validate_hardware_profile


def test_valid_sim_profile():
    data = {
        "id": "sim-diffdrive-v1",
        "name": "Sim",
        "type": "mobile_robot",
        "status": "experimental",
        "controllers": [{"controller_id": "c1", "kind": "motor_controller", "driver": "sim", "interface": "sim", "transport": {"kind": "sim", "timeout_ms": 500, "retries": 1}}],
        "sensors": [],
        "limits": {"max_linear_speed_mps": 0.5, "max_angular_speed_rps": 1.0, "max_acceleration_mps2": 0.8},
        "safety": {"command_ttl_ms": 500, "watchdog_timeout_ms": 300},
    }
    assert validate_hardware_profile(data) == []


def test_invalid_profile_reports_errors():
    data = {"id": "x", "status": "bogus", "controllers": [{"controller_id": "c1"}], "limits": {"max_linear_speed_mps": -1}, "safety": {"command_ttl_ms": 0, "watchdog_timeout_ms": 100}}
    errs = validate_hardware_profile(data)
    assert any("missing field" in e for e in errs)
    assert any("invalid status" in e for e in errs)
    assert any("controllers[0]" in e for e in errs)
    assert any("max_linear_speed_mps" in e for e in errs)
    assert any("command_ttl_ms" in e for e in errs)


def test_serial_and_can_transport_validation():
    base = {
        "id": "mc", "name": "Motor", "type": "mobile_robot", "status": "experimental",
        "sensors": [], "limits": {"max_linear_speed_mps": 0.5},
        "safety": {"command_ttl_ms": 500, "watchdog_timeout_ms": 300},
    }
    serial = {**base, "controllers": [{"controller_id": "c1", "kind": "motor_controller", "driver": "serial_v1", "interface": "serial", "transport": {"kind": "serial", "path": "/dev/ttyUSB0", "baudrate": 115200, "timeout_ms": 500, "retries": 1}}]}
    assert validate_hardware_profile(serial) == []
    can = {**base, "controllers": [{"controller_id": "c2", "kind": "motor_controller", "driver": "can_v1", "interface": "can", "transport": {"kind": "can", "interface": "can0", "channel": 3, "mtu": 8}}]}
    assert validate_hardware_profile(can) == []
    bad = {**base, "controllers": [{"controller_id": "c3", "kind": "motor_controller", "driver": "can_v1", "interface": "can", "transport": {"kind": "can", "channel": 999}}]}
    errs = validate_hardware_profile(bad)
    assert any("interface is required" in e for e in errs)
    assert any("channel" in e for e in errs)


def test_watchdog_must_not_exceed_command_ttl():
    data = {
        "id": "x", "name": "X", "type": "mobile_robot", "status": "experimental",
        "controllers": [], "sensors": [], "limits": {"max_linear_speed_mps": 0.5},
        "safety": {"command_ttl_ms": 100, "watchdog_timeout_ms": 500},
    }
    assert any("watchdog_timeout_ms" in e for e in validate_hardware_profile(data))

