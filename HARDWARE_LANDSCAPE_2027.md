# Hardware Landscape 2027

Expected consumer companion robot devices and their communication protocols, as documented in the HardwarePartnershipRegistry.

## Partnered Device Families

| Device | Manufacturer | Protocol | Modalities | Pairing | mTLS | Status |
|---|---|---|---|---|---|---|
| Apple Tabletop Robot (T2027) | Apple | mTLS WebSocket + HomeKit | audio, vision, expression, sensor | bluetooth | Yes | available |
| Somnia Lab Intimate Humanoid (SL-1) | Somnia Lab | mTLS WebSocket + proprietary binary | audio, vision, actuation, expression, thermal, sensor | nfc | Yes | available |
| D-Link Companion (DCH-2027) | D-Link | mTLS WebSocket + ONVIF | audio, vision, sensor | wifi | Yes | available |

## Protocol Gaps

- **No universal discovery protocol**: Each vendor uses a different pairing method (bluetooth, NFC, Wi-Fi).
- **mTLS certificate provisioning**: No standard for provisioning device identity certificates at scale.
- **Latency variance**: Expression latency ranges from 60ms (Somnia) to 120ms (D-Link), affecting real-time avatar sync.
- **Safety constraint divergence**: Thermal limits, camera cutoffs, and actuation limits vary by vendor with no common schema.

## Partnership Roadmap

1. **Q1 2027**: Finalize mTLS certificate provisioning flow with Apple and Somnia Lab.
2. **Q2 2027**: Implement HardwareAdapter implementations for Apple T2027 and Somnia SL-1.
3. **Q3 2027**: Add D-Link DCH-2027 ONVIF integration.
4. **Q4 2027**: Publish unified companion hardware specification under the AIPF working group.
