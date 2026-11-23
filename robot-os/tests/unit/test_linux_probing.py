from pathlib import Path

from hannah_robot_os.hardware.providers import LinuxSerialDiscoveryProvider, SocketCANDiscoveryProvider


def test_linux_serial_discovery_from_fixtures(tmp_path: Path):
    by_id = tmp_path / "by-id"
    by_id.mkdir()
    target = tmp_path / "ttyUSB0"
    target.mkdir()
    link = by_id / "usb-FTDI_MotorController-if00"
    try:
        link.symlink_to(target)
    except (OSError, NotImplementedError):
        return  # symlinks unavailable on this FS; skip assertion
    tty = tmp_path / "tty"
    tty.mkdir()
    (tty / "ttyUSB0").mkdir()
    provider = LinuxSerialDiscoveryProvider(serial_by_id=by_id, sys_class_tty=tty)
    found = provider.discover()
    ids = [d.device_id for d in found]
    assert "serial-by-id-usb-FTDI_MotorController-if00" in ids
    assert "tty-ttyUSB0" in ids
    byid = next(d for d in found if d.device_id.startswith("serial-by-id"))
    assert byid.config["by_id"] is True
    assert byid.manufacturer == "FTDI"


def test_socketcan_discovery_from_fixture(tmp_path: Path):
    net = tmp_path / "net"
    (net / "can0").mkdir(parents=True)
    (net / "can0" / "operstate").write_text("up\n")
    (net / "can0" / "mtu").write_text("16\n")
    (net / "eth0").mkdir()
    found = SocketCANDiscoveryProvider(sysfs_net=net).discover()
    assert len(found) == 1
    assert found[0].config["name"] == "can0"
    assert found[0].config["operstate"] == "up"
