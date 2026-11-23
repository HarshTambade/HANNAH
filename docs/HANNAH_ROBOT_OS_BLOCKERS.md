# HANNAH ROBOT OS — Blockers

Updated: 2026-11-23

Owner indicated RB2–RB6 resources can be provided, but no actual runner, signing material, reviewer assignment or credentials have been provisioned to this session. Execution runbook: `HANNAH_ROBOT_OS_EXTERNAL_EXECUTION_RUNBOOK.md`; manual CI entry point: `.github/workflows/robot-os-external-acceptance.yml`. No blocker is complete until its evidence artifact exists.

| ID | Blocker | Impact | Owner action needed | Workaround / progress |
|---|---|---|---|---|
| RB1 | No physical robot, motor controllers, sensors, or powered hardware | Cannot physically commission motors/sensors/navigation/safety circuits | Provide target robot hardware, controller datasheets, wiring, qualified operator | Implement adapters, sims, HIL interfaces, commissioning checklists |
| RB2 | No Docker/QEMU/snapcraft/Yocto/ubuntu-image build host validated in this environment | Cannot build/boot OS images here | Provide Linux build host/CI runner with required tools | Create reproducible build definitions, scripts, CI config, manifest checks |
| RB3 | No ROS 2 Jazzy/Gazebo/Nav2/colcon runtime installed on dev machine | Cannot run ROS2 integration tests locally | Provide Linux ROS2 environment or container | Write ROS2 packages/configs, static checks, unit tests, Dockerfile |
| RB4 | No independent security/safety reviewer | Cannot claim independent review/certification | Engage qualified security and functional safety assessors | Implement security controls, tests, threat model, standards mapping |
| RB5 | No production signing keys/HSM/infrastructure | Cannot perform production-signed releases | Provide signing infrastructure and release policy | Implement signing verification, manifest format, dev key flow |
| RB6 | Live model/provider credentials not configured in environment | Cannot prove live AI-driven robot agent flows end-to-end | Provide test credentials/policy | Keep deterministic safety path; test with scripted/mock model providers |
