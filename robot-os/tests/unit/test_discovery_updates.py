from pathlib import Path

from hannah_robot_os.common import AuditLog
from hannah_robot_os.hardware.discovery import HardwareDiscoveryService, SimulatedDiscoveryProvider
from hannah_robot_os.hardware.models import HardwareDevice
from hannah_robot_os.hardware.registry import HardwareRegistry
from hannah_robot_os.updates.state import UpdateState


def test_discovery_registers_devices():
    audit = AuditLog()
    reg = HardwareRegistry(audit=audit)
    provider = SimulatedDiscoveryProvider(devices=[
        HardwareDevice(device_id="cam1", kind="camera", interface="usb"),
        HardwareDevice(device_id="mc1", kind="motor_controller", interface="serial"),
    ])
    svc = HardwareDiscoveryService(audit=audit, registry=reg, providers=[provider])
    found = svc.scan()
    assert len(found) == 2
    assert reg.get("cam1") is not None
    assert reg.get("mc1") is not None


def test_update_state_ab_rollback(tmp_path: Path):
    p = tmp_path / "update-state.json"
    st = UpdateState(current_slot="a", current_version="0.1.0", last_good_slot="a", last_good_version="0.1.0")
    st.stage("0.2.0")
    assert st.pending_slot == "b"
    assert st.status == "staged"
    st.mark_verifying()
    st.mark_healthy()
    assert st.current_slot == "b"
    assert st.current_version == "0.2.0"
    st.save(p)
    loaded = UpdateState.load(p)
    loaded.stage("0.3.0")
    loaded.mark_verifying()
    loaded.rollback()
    assert loaded.current_slot == "b"
    assert loaded.current_version == "0.2.0"
    assert loaded.status == "rolled_back"
