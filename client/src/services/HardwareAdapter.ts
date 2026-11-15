export type HardwareModality = "audio" | "vision" | "actuation" | "thermal" | "expression" | "sensor";

export type HardwareCharacteristics = {
  supportedModalities: HardwareModality[];
  latencyMs: { audio: number; vision: number; actuation: number; expression: number };
  safetyConstraints: string[]; // e.g., "no camera after 10pm", "max speed 0.5 m/s"
  mTLSRequired: boolean;
  pairingMethod: "bluetooth" | "wifi" | "nfc" | "usb";
};

export type HardwareAdapter = {
  id: string;
  family: string;
  name: string;
  characteristics: HardwareCharacteristics;
  isPaired: () => boolean;
  pair: (deviceId: string) => Promise<void>;
  unpair: () => Promise<void>;
  sendCommand: (command: { type: HardwareModality; payload: unknown }) => Promise<{ status: string }>;
  getHealth: () => Promise<{ battery?: number; connected: boolean; lastSeen: number }>;
};

export class BaseHardwareAdapter implements HardwareAdapter {
  id: string = crypto.randomUUID();
  family = "generic";
  name = "Generic Companion";
  characteristics: HardwareCharacteristics = {
    supportedModalities: ["audio"],
    latencyMs: { audio: 200, vision: 500, actuation: 300, expression: 100 },
    safetyConstraints: [],
    mTLSRequired: true,
    pairingMethod: "bluetooth",
  };

  isPaired(): boolean {
    return false;
  }

  async pair(_deviceId: string): Promise<void> {
    throw new Error("pair not implemented");
  }

  async unpair(): Promise<void> {
    throw new Error("unpair not implemented");
  }

  async sendCommand(_command: { type: HardwareModality; payload: unknown }): Promise<{ status: string }> {
    throw new Error("sendCommand not implemented");
  }

  async getHealth(): Promise<{ battery?: number; connected: boolean; lastSeen: number }> {
    return { connected: false, lastSeen: 0 };
  }
}