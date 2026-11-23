from hannah_robot_os.updates.recovery import RecoveryManager, RecoveryState


def test_recovery_enter_persists_and_exit_requires_ready(tmp_path):
    state_path = tmp_path / "recovery.json"
    recovery = RecoveryManager(now=lambda: 1234)

    state = recovery.enter("failed health check", "0.1.0")
    assert state.active is True
    assert state.entered_at_ms == 1234
    recovery.save(state_path)

    loaded = RecoveryManager(RecoveryState.load(state_path))
    try:
        loaded.exit(robot_ready=False)
        assert False, "exit should require READY"
    except RuntimeError:
        pass

    loaded.exit(robot_ready=True)
    assert loaded.state.active is False
    assert loaded.state.reason == ""


def test_recovery_requires_reason_and_writes_diagnostics(tmp_path):
    recovery = RecoveryManager(now=lambda: 5678)
    try:
        recovery.enter("  ")
        assert False, "reason should be required"
    except ValueError:
        pass

    recovery.enter("watchdog timeout", "0.1.0")
    report = recovery.write_diagnostics(tmp_path / "diagnostics.json", {
        "services": {"motor-controller": "fault"},
    })
    assert report.exists()
