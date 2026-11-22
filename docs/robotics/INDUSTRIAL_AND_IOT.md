# Industrial and IoT systems: an evaluation

This page was written before anything was built, as an evaluation of how each system would fit. **Since then MQTT and Modbus TCP have been built** as adapters of the device hub, following the rules below, and tested with HANNAH's own simulated devices (and, for MQTT, an independent broker). They have not been tested with any physical device. See [`hannah-os/HANNAH_OS_DEVICE_COMPATIBILITY.md`](../../hannah-os/HANNAH_OS_DEVICE_COMPATIBILITY.md) for their real state.

Home Assistant, OPC UA, vendor PLC protocols and CAN are still not built, and the evaluation of them below stands.

## Rules any connector would follow

They are the robot rules, applied to machines.

| Rule | Meaning |
|---|---|
| A connector is an Action Engine service | The same permission levels, approvals, history and emergency stop as everything else. No second path |
| Reading and writing are different actions | Reading a tag is a read. Writing is a write, off until a person switches it on for that connection |
| A write goes only to a point a person has listed | An allow-list per connection: this coil, this node, this topic, with its allowed values or range. There is no "write to address N" tool, and the model never sees an address it could change |
| A write is checked before it is asked for | Type, range and the listed point, with the reason for a refusal, as the Safety Gateway does for robots |
| A value read back is the verification | "Done" means the device reported the new value, not that a write was sent |
| A stale value is marked stale | Every reading carries its time and source |
| The connector runs next to the equipment | Industrial protocols are not exposed to the internet. A small gateway on the plant network opens an outbound connection to HANNAH, as the robot runtime does. The server never connects inwards |
| It is not a safety function | Interlocks, guards and emergency stops stay in the PLC and the hardware |

## Each system

| System | What it is for | How it would connect | Reading | Writing | What stands in the way |
|---|---|---|---|---|---|
| **Home Assistant** | Homes: lights, plugs, climate, sensors | Its own HTTP and WebSocket API with a long-lived token, from the server (when it is reachable) or from a gateway on the home network | Entity states | Calling a service for a listed entity. Locks, alarms, garage doors and heating would always ask | An instance to test against. The most approachable of the six |
| **MQTT** | Sensors and small devices publishing to a broker | A gateway subscribed to listed topics, with the broker's own TLS and credentials | Listed topics | Publishing to a listed topic with a schema for the payload | **Built** (`hannah-os/runtime`): HANNAH's own MQTT 3.1.1 client, tested against its own test broker and an independent one. Still to do: a real device |
| **Modbus TCP** | Older industrial equipment and meters | A gateway on the plant network | Listed registers with their scaling and units, entered by a person | Listed coils and registers with allowed ranges, always asking | **Built** (`hannah-os/runtime`), local network addresses only, tested against HANNAH's own test server. Still to do: a real device or a vendor's simulator. The protocol has no authentication and no encryption: it must never leave its network |
| **OPC UA** | Modern PLCs and machines | A gateway with a client certificate; the server's own user and node permissions on top | Listed nodes | Listed nodes with allowed ranges, always asking | A server to test against; certificate handling; a client library chosen and pinned |
| **PLCs** | Machine control | Through OPC UA or the vendor's gateway. Never a vendor protocol driven by the model | As above | As above, and only setpoints the PLC program itself validates | The PLC program has to treat HANNAH's values as requests it may refuse. That is the owner's engineering, not HANNAH's |
| **CAN and CAN-FD** | Inside a robot or vehicle | Not from HANNAH. On a robot it belongs under `ros2_control` or the vendor's driver, below the ROS 2 boundary | Through the robot's own state report | Never as a HANNAH action | By design |

## What would be built first, if a system is named

1. A read-only connector to the one named system, tested against a real instance or the vendor's simulator.
2. The allow-list and its screen: which points exist, what they mean, their units.
3. One write, to one listed point, with a range, always asking, verified by reading back.
4. Only then anything broader.

## What the owner has to provide

- Which system, and what it controls.
- A test instance that is safe to write to.
- For anything industrial: the person responsible for that equipment agreeing which points may be read and written.
