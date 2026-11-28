"""An installed package reaches only the hardware and permissions it declared."""
from hannah_robot_os.common import AuditLog
from hannah_robot_os.safety.package_policy import PackagePolicy

GRANT = {"packageId": "org.example.lidar-driver", "status": "active", "permissions": ["read-sensors", "hardware-access"], "interfaces": [{"type": "serial", "match": "/dev/ttyUSB*"}]}


def _policy(*grants):
    policy = PackagePolicy(audit=AuditLog())
    policy.load(list(grants))
    return policy


def test_declared_interface_is_allowed_and_others_are_denied_and_audited():
    policy = _policy(GRANT)
    assert policy.check_interface("org.example.lidar-driver", "serial", "/dev/ttyUSB0") == (True, "ok")
    assert policy.check_interface("org.example.lidar-driver", "serial", "/dev/ttyACM0")[0] is False
    assert policy.check_interface("org.example.lidar-driver", "can", "can0")[0] is False
    assert policy.check_interface("org.example.lidar-driver", "serial", "/dev/ttyUSB0/../mem")[0] is False
    denied = [event for event in policy.audit.list() if event.event == "access_denied"]
    assert len(denied) == 3


def test_undeclared_permission_unknown_package_and_revoked_install_get_nothing():
    policy = _policy(GRANT, {**GRANT, "packageId": "org.example.old", "status": "revoked"})
    assert policy.check_permission("org.example.lidar-driver", "network-internet")[0] is False
    assert policy.check_permission("org.example.unknown", "read-sensors")[1] == "package not installed"
    assert policy.check_interface("org.example.old", "serial", "/dev/ttyUSB0")[0] is False


def test_hardware_needs_hardware_access_even_with_a_matching_interface():
    policy = _policy({**GRANT, "permissions": ["read-sensors"]})
    assert policy.check_interface("org.example.lidar-driver", "serial", "/dev/ttyUSB0") == (False, "permission hardware-access not declared")


def test_malformed_grants_are_dropped_not_widened():
    policy = _policy({**GRANT, "interfaces": [{"type": "serial", "match": "/dev/../*"}, {"type": "flux", "match": "*"}]})
    assert policy.grants["org.example.lidar-driver"]["interfaces"] == []
