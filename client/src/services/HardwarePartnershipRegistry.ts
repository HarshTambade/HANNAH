import { WebSocketHardwareAdapter, type HardwareAdapter, type HardwareCharacteristics, type HardwareModality } from "./HardwareAdapter";

/**
 * The kinds of hardware HANNAH can work with, each with an adapter that
 * really connects. Today that's any device speaking the HANNAH device
 * protocol over WebSocket (see HardwareAdapter.ts): DIY companions, an ESP32
 * or Raspberry Pi, or a vendor that implements it. A device family is listed
 * only once its adapter works; nothing here is announced ahead of time.
 */
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

const protocolAdapter = new WebSocketHardwareAdapter();
HardwarePartnershipRegistry.register({
  name: "HANNAH-compatible device",
  manufacturer: "Any",
  model: "HANNAH device protocol v1",
  protocol: "JSON over WebSocket (wss://; ws:// on the local network), pairing code, acknowledged commands",
  characteristics: protocolAdapter.characteristics,
  adapter: protocolAdapter,
  status: "available",
  notes: "Pair with the device's address and pairing code, e.g. wss://speaker.local:8765#4821. The protocol is in services/HardwareAdapter.ts.",
});
