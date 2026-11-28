These files are copied unchanged from sros2 (https://github.com/ros2/sros2,
commit bb2505b58b44ab18d1b2005bb22b70c611c58acc), licensed under the Apache
License 2.0:

- `governance.xsd`, `permissions.xsd` from `sros2/sros2/policy/schemas/dds/`
  (sros2's copies of the OMG DDS Security 1.1 governance and permissions schemas)
- `governance.default.xml` from `sros2/sros2/policy/defaults/dds/governance.xml`

HANNAH uses them only to check the governance and permissions documents it
generates (server/trust/sros2.js), the same check sros2 makes before it writes
a keystore.
