import json
from pathlib import Path

from hannah_robot_os.common import AuditLog, ServiceState, now_ms
from hannah_robot_os.hardware.models import HardwareDevice
from hannah_robot_os.hardware.registry import HardwareRegistry
from hannah_robot_os.sensors.manager import SensorManager, SensorReading
from hannah_robot_os.services.health import ServiceHealthManager
from hannah_robot_os.updates.manifest import UpdateManifest, sha256_file, verify_manifest


def test_service_health_ready_gate():
    audit = AuditLog()
    hm = ServiceHealthManager(audit=audit, required_services=["safety-gateway", "motor-controller"])
    hm.set_state("safety-gateway", ServiceState.READY)
    hm.set_state("motor-controller", ServiceState.STARTING)
    snap = hm.snapshot()
    assert snap["robot_ready"] is False
    hm.set_state("motor-controller", ServiceState.READY)
    snap = hm.snapshot()
    assert snap["robot_ready"] is True


def test_sensor_required_ok():
    audit = AuditLog()
    reg = HardwareRegistry(audit=audit)
    sm = SensorManager(audit=audit, registry=reg, required_sensor_ids=["imu1"], stale_after_ms=1000)
    sm.register_sensor(HardwareDevice(device_id="imu1", kind="imu"))
    assert sm.required_sensors_ok(now=now_ms()) is False
    sm.ingest(SensorReading(device_id="imu1", ts_ms=now_ms(), data={"z": 0.1}))
    assert sm.required_sensors_ok(now=now_ms()) is True


def test_update_manifest_verification(tmp_path: Path):
    from hannah_robot_os.updates import ed25519
    from hannah_robot_os.updates.manifest import sign_manifest

    secret = bytes(range(32))
    signers = {"dev": ed25519.public_key(secret)}
    artifact = tmp_path / "robot-os.tar.gz"
    artifact.write_bytes(b"test-artifact")
    fields = {
        "version": "0.1.1",
        "build": "20261123",
        "artifact": artifact.name,
        "sha256": sha256_file(artifact),
        "size_bytes": artifact.stat().st_size,
        "signature": "",
        "signer": "dev",
    }
    unsigned = UpdateManifest.from_dict(fields)
    manifest = UpdateManifest.from_dict({**fields, "signature": sign_manifest(unsigned, secret)})
    verify_manifest(manifest, artifact, trusted_signers=signers)
    for change, message in (({"sha256": "0" * 64}, "hash"), ({"signature": "ZGV2c2ln"}, "signature"), ({"build": "20261124"}, "signature"), ({"signer": "other"}, "untrusted")):
        bad = UpdateManifest.from_dict({**manifest.__dict__, **change})
        try:
            verify_manifest(bad, artifact, trusted_signers=signers)
            assert False, "should fail"
        except ValueError as e:
            assert message in str(e), str(e)
    try:
        verify_manifest(manifest, artifact)
        assert False, "no trusted signer: nothing can be trusted"
    except ValueError as e:
        assert "untrusted" in str(e)
