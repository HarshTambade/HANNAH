# HANNAH OS — deployment guide

How to try the device layer with simulated devices, and how to put a hub on a computer. **There is no HANNAH OS image to install yet.** Today the hub is a program you start on a computer you already have. The only setup that has been tested is the one in section 1.

## 1. Try it with simulated devices (tested)

You need Python 3.9 or newer, and a HANNAH server with a key vault (`HANNAH_VAULT_KEY` set).

```sh
# 1. Simulated devices: an MQTT broker with a room sensor, a fan and a lamp, and a Modbus TCP power meter.
cd hannah-os/runtime
python3 -m hannah_edge simulate
#    It prints the addresses, for example mqtt 127.0.0.1:18830 and modbus 127.0.0.1:15020.

# 2. In HANNAH: Devices → "Add a hub". It shows a command with a one-time code. In another terminal:
python3 -m hannah_edge enroll --server https://your-hannah-server --code XXXX-XXXX
python3 -m hannah_edge run
#    The screen shows the hub as connected, with the same key fingerprint the enroll command printed.

# 3. In HANNAH: "Add a device" → pick "Simulated room sensor" → enter the broker address and port → it is checked → "Switch on".
#    Add the fan the same way, allow HANNAH to change its power, and switch it on or build an automation.
```

In the simulator's terminal you can type `heat 9` to warm the simulated room, `heat 0` to let it cool, `stuck on` to make the fan ignore commands, `mute on` to silence the sensor.

For a server on the same computer over plain HTTP, the address must be `http://127.0.0.1:…` or `http://localhost:…`. Any other plain-HTTP address is refused unless you add `--allow-insecure`, which is for a closed development network only.

## 2. A hub on a Linux computer, by hand (written, not run)

The service unit was written on a machine without systemd and has never been started. Expect to adjust it.

```sh
sudo useradd --system --home /var/lib/hannah-edge --create-home hannah-edge
sudo cp -r hannah-os/runtime /opt/hannah-edge
sudo -u hannah-edge python3 -m hannah_edge doctor --state-dir /var/lib/hannah-edge/state     # what is ready, what isn't
sudo -u hannah-edge python3 -m hannah_edge enroll --server https://… --code … --state-dir /var/lib/hannah-edge/state
sudo cp hannah-os/images/systemd/hannah-edge.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now hannah-edge
```

The hub needs outbound HTTPS to the HANNAH server and access to the devices' network. It needs no incoming connection; close them all.

`doctor` checks the Python version, the adapters, that the state folder and the key file are readable only by the hub's user, the server address and the clock. It sends nothing and changes nothing. The service runs it before every start.

Each built-in device adapter runs in a child process, and discovery commands use a short-lived child process with a bounded timeout. They inherit the hub service's account and permissions; they are not security sandboxes or separate systemd units. Automation, telemetry and updates still run in the main hub process. This process layout and the service unit have not been exercised on a Linux systemd host.

## 3. Images (described, not built)

`hannah-os/images/profiles.json` describes five images that share one core:

| Profile | Base | For |
|---|---|---|
| HANNAH OS Desktop/Edge | Ubuntu Server 24.04 LTS | A mini PC or single-board computer as the household's hub |
| HANNAH OS Robotics | Ubuntu Server 24.04 LTS, ROS 2 Jazzy | A robot's own computer |
| HANNAH OS IoT Gateway | Ubuntu Core 24 | A small unattended box that only runs the hub |
| HANNAH OS Industrial Edge | Ubuntu Core 24 | A gateway on a plant network |
| HANNAH OS Developer Edition | Ubuntu Server 24.04 LTS | Building and testing integrations |

```sh
python3 hannah-os/tools/image_manifest.py --check         # the description is consistent
python3 hannah-os/tools/image_manifest.py iot-gateway     # what would go into that image, with a SHA-256 for every file
```

What a build would use, when there is a Linux machine to build on:

- Ubuntu Server profiles: a stock image for the board, with `hannah-os/images/first-boot/user-data.yaml` as its cloud-init user data and the runtime and the unit file copied in.
- Ubuntu Core profiles: `snapcraft` in `hannah-os/images/snap`, then `ubuntu-image` with a model that includes the snap.
- A Yocto build is not described. It is the case for one specific board, when there is one.

No board is listed as supported. A board is added to `validatedHardware` only with a record of booting it; a test fails otherwise.

## 4. Enrollment and keys

- A code works once and lasts 15 minutes. "New code" on a hub that hasn't enrolled gives another.
- The key is in `identity.json` in the hub's state folder, readable only by the hub's user. Back it up only if you can keep the copy as safe; otherwise enroll again.
- To move a hub to another computer, or if the key may have leaked: revoke the hub in HANNAH, add it again, enroll the new computer. Devices have to be added to the new hub.
- No secret belongs in an image. A hub is enrolled by a person after first boot.

## 5. Updates

- **The hub's own software.** Under Devices → Hub updates, a signed-in person can announce a version, byte size, SHA-256 and bundle URL for one enrolled hub. The server signs the command; the hub accepts HTTPS (HTTP is allowed only on loopback for development), checks size and hash, unpacks ordinary files, imports the staged package in a clean Python process, then switches versions and restarts after the server receives the result. It confirms the new version after the hub reaches the server. If it restarts three times without confirming, the next start restores the previous version. This per-hub path was exercised with a local test bundle; staged rollout controls and a production image or installed service have not been tested.
- **The operating system.** Ubuntu Server: its own security updates (the first-boot configuration turns on unattended upgrades). Ubuntu Core: its own transactional updates. Neither has been run with HANNAH.
- **A device's firmware.** HANNAH does not update it, and a profile cannot expose it.

## 6. Removing

Remove a device or a hub under Devices. On the hub's computer: stop and disable the service, delete `/opt/hannah-edge` and `/var/lib/hannah-edge`. Removing a hub in HANNAH deletes its devices, automations, readings and events from the server.

## 7. The control plane

Nothing changes in how the HANNAH server is hosted. The device registry needs the account database (migration 22 adds its tables) and the key vault. It works on the serverless deployment because a hub polls; there is no long-lived connection.
