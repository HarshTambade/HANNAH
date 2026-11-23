from pathlib import Path

from hannah_robot_os.hardware.providers import StaticCANDiscoveryProvider, StaticSerialDiscoveryProvider, SysfsUSBDiscoveryProvider


def test_sysfs_usb_discovery_read_only(tmp_path: Path):
    dev = tmp_path / "1-1"
    dev.mkdir()
    (dev / "idVendor").write_text("1234\n")
    (dev / "idProduct").write_text("abcd\n")
    (dev / "manufacturer").write_text("Acme\n")
    (dev / "product").write_text("MotorCtl\n")
    p = SysfsUSBDiscoveryProvider(sysfs_root=tmp_path)
    found = p.discover()
    assert len(found) == 1
    assert found[0].config["vendor_id"] == "1234"
    assert found[0].config["product_id"] == "abcd"
    assert found[0].interface == "usb"


def test_static_serial_and_can():
    serial = StaticSerialDiscoveryProvider(ports=["/dev/ttyUSB0", "/dev/ttyUSB0", "/dev/ttyACM0"]).discover()
    assert [d.config["path"] for d in serial] == ["/dev/ttyACM0", "/dev/ttyUSB0"]
    can = StaticCANDiscoveryProvider(interfaces=["can0"]).discover()
    assert can[0].kind == "can_interface"
