import {
  HardwareAdapter,
  HardwareCharacteristics,
  HardwareModality,
  BaseHardwareAdapter,
} from "./HardwareAdapter";

export type PartneredDevice = {
  id: string;
  name: string;
  manufacturer: string;
  model: string;
  protocol: string;
  characteristics: HardwareCharacteristics;
  adapter: HardwareAdapter;
  status: "available" | "paired" | "unsupported";
  notes: string;
};

export const HardwarePartnershipRegistry = {
  devices: [] as PartneredDevice[],

  register(device: Omit<PartneredDevice, "id">) {
    const entry: PartneredDevice = { ...device, id: crypto.randomUUID() };
    this.devices.push(entry);
    return entry;
  },

  list(): PartneredDevice[] {
    return [...this.devices];
  },

  get(id: string): PartneredDevice | undefined {
    return this.devices.find((d) => d.id === id);
  },

  setStatus(id: string, status: PartneredDevice["status"]) {
    const device = this.devices.find((d) => d.id === id);
    if (device) device.status = status;
  },

  findByModality(modality: HardwareModality): PartneredDevice[] {
    return this.devices.filter((d) => d.characteristics.supportedModalities.includes(modality));
  },
};

// Adapter stubs for device families
class AppleTabletopAdapter extends BaseHardwareAdapter {
  family = "apple";
  name = "Apple Tabletop Robot";
  characteristics: HardwareCharacteristics = {
    supportedModalities: ["audio", "vision", "expression", "sensor"],
    latencyMs: { audio: 150, vision: 300, actuation: 400, expression: 80 },
    safetyConstraints: ["no camera after 10pm", "no facial recognition without consent"],
    mTLSRequired: true,
    pairingMethod: "bluetooth",
  };
}

class SomniaLabAdapter extends BaseHardwareAdapter {
  family = "somnia";
  name = "Somnia Lab Intimate Humanoid";
  characteristics: HardwareCharacteristics = {
    supportedModalities: ["audio", "vision", "actuation", "expression", "thermal", "sensor"],
    latencyMs: { audio: 180, vision: 350, actuation: 250, expression: 60 },
    safetyConstraints: ["no actuation during sleep mode", "thermal limit 45C"],
    mTLSRequired: true,
    pairingMethod: "nfc",
  };
}

class DLinkAdapter extends BaseHardwareAdapter {
  family = "dlink";
  name = "D-Link Companion";
  characteristics: HardwareCharacteristics = {
    supportedModalities: ["audio", "vision", "sensor"],
    latencyMs: { audio: 200, vision: 400, actuation: 500, expression: 120 },
    safetyConstraints: ["no recording without LED indicator", "local storage only"],
    mTLSRequired: true,
    pairingMethod: "wifi",
  };
}

// Register known 2027 companion device families as stubs
HardwarePartnershipRegistry.register({
  name: "Apple Tabletop Robot",
  manufacturer: "Apple",
  model: "T2027",
  protocol: "mTLS WebSocket + HomeKit",
  characteristics: new AppleTabletopAdapter().characteristics,
  adapter: new AppleTabletopAdapter(),
  status: "available",
  notes: "Expected 2027 release; SiriKit integration anticipated.",
});

HardwarePartnershipRegistry.register({
  name: "Somnia Lab Intimate Humanoid",
  manufacturer: "Somnia Lab",
  model: "SL-1",
  protocol: "mTLS WebSocket + proprietary binary",
  characteristics: new SomniaLabAdapter().characteristics,
  adapter: new SomniaLabAdapter(),
  status: "available",
  notes: "Intimate companion form factor; strict privacy constraints.",
});

HardwarePartnershipRegistry.register({
  name: "D-Link Companion",
  manufacturer: "D-Link",
  model: "DCH-2027",
  protocol: "mTLS WebSocket + ONVIF",
  characteristics: new DLinkAdapter().characteristics,
  adapter: new DLinkAdapter(),
  status: "available",
  notes: "Home security-adjacent companion; ONVIF camera profile.",
});