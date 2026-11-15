# Shanaya Content Boundary

## Classification key
- **Allowed:** permitted by default.
- **Restricted:** permitted only with confirmation, limits, or operator configuration.
- **Prohibited:** blocked by guardrails and policy.

## Tools
| Tool | Classification | Reason | Policy reference |
| --- | --- | --- | --- |
| list_app_files | Restricted | Reads app-private files only. | Apple 5.1.1, Google Play user data |
| read_app_file | Restricted | Requires confirmation; cloud mode sends contents to provider. | Apple 5.1.2(i), Google Play data safety |
| write_app_file | Restricted | Requires confirmation; writes app-private storage. | Apple 5.1.1, Google Play |
| delete_app_file | Restricted | Requires confirmation; destructive. | Apple 5.1.1, Google Play |
| open_app | Restricted | Opens supported apps/HTTPS URLs only. | Apple 2.5.1, Google Play |
| make_call | Restricted | Requires confirmation; opens dialer only. | Apple 2.5.1, Google Play |
| send_message | Restricted | Requires confirmation; opens SMS composer only. | Apple 2.5.1, Google Play |
| toggle_setting | Restricted | Flashlight only; Wi-Fi/Bluetooth blocked. | Apple 2.5.1, Google Play |
| get_device_status | Allowed | Basic device metadata only. | Apple 5.1.1, Google Play |
| get_battery_status | Allowed | Battery metadata only. | Apple 5.1.1, Google Play |

## Prompt categories
| Category | Classification | Reason | Policy reference |
| --- | --- | --- | --- |
| General conversation | Allowed | Core app functionality. | Apple 1.2, Google Play |
| Voice input/output | Allowed | User-initiated speech features. | Apple 5.1.1, Google Play |
| Local inference | Allowed | On-device or user-controlled endpoint. | Apple 5.1.2(i) |
| Cloud inference | Restricted | Sends prompts to configured third-party provider. | Apple 5.1.2(i), Google Play data safety |
| Desktop computer use | Restricted | Screenshots and confirmed actions only. | Apple 2.5.1, Google Play |
| File access | Restricted | App-private storage and confirmation. | Apple 5.1.1, Google Play |
| PII extraction | Prohibited | Privacy and safety policy. | Apple 5.1.2, Google Play |
| Malware or exploits | Prohibited | Safety policy. | Apple 1.2, Google Play |
| Non-consensual sexual content | Prohibited | Safety policy and store rules. | Apple 1.2, Google Play |
| Self-harm instructions | Prohibited | Safety policy. | Apple 1.2, Google Play |
PY