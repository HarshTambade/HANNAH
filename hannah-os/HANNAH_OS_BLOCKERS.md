# HANNAH OS — what is blocked, and what each needs

These can't go further without something only the owner can provide. Everything that could be built and tested without them has been; what was prepared is listed, and none of it is called done.

| Id | What is missing | What it holds up | What is ready | What the owner provides |
|---|---|---|---|---|
| **H1** | A physical device, broker, PLC or machine to test against | Profiles for real products; the "plug and play" level; any statement about real hardware | The adapters, the hub's check, the profile format with its signature and test-evidence fields | Name one device (maker and model), put it on a network with a computer that can run the hub, and say which of its points are safe to change during a test |
| **H2** | A Linux build host with `ubuntu-image` or `snapcraft`, and a board or virtual machine to boot | Building, installing, booting and updating HANNAH OS images; secure boot, signed images, disk encryption | Five image profiles, the hub's service unit, a first-boot configuration, a snap description, a manifest tool. All written, none built | A Linux machine or a CI job allowed to build, and a target: a board, or a virtual machine to start with |
| **H3** | A Matter controller, a Zigbee or Z-Wave coordinator, a Bluetooth radio, and a stack for each on the hub | Matter, Zigbee, Z-Wave, Bluetooth | The app lists each as not built, with what it needs. A device behind a bridge that publishes to MQTT works today, in principle | The radio hardware, a device to pair, and agreement on which library to depend on (the hub has no dependencies today) |
| **H4** | ROS 2, Gazebo and a robot | Everything robotics that says Gazebo, ROS 2 or hardware | See `robotics/PROGRESS.md`, blockers B1 to B3 | As listed there |
| **H5** | A live language model run in the development environment | A model reading a manual; showing an agent using device tools with a real model | The evidence gate for a model's suggestions; the ten tools and their routing, tested with a scripted server | A provider key the owner is willing to use for tests, and a decision that manuals may be sent to that provider |
| **H6** | An independent security review | Any statement that the security design was reviewed | `HANNAH_OS_SECURITY_ARCHITECTURE.md` and the security tests | A reviewer who did not write the code |

## Decisions that need the owner, not hardware

- **Dependencies on the hub.** The hub uses Python's standard library only. Matter, Zigbee, Bluetooth and OPC UA each need a library. Adding one is a decision about what every hub must install.
- **Sending manuals to a model provider.** The pattern-based reader finds a lot and misses prose. A model would find more; it means a person's manual leaves the server.
- **Who may publish profiles.** The signature check exists. Whose keys HANNAH trusts by default, if anyone's, is a policy.

## What must not be done to get around a blocker

- Calling a profile "plug and play" because its description looks right.
- Counting a test against HANNAH's own simulator as a test of a product.
- Saying an image supports a board that was never booted with it.
- Writing a Matter, Zigbee or OPC UA adapter that was never run against anything.
