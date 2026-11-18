/**
 * The paired hardware companion, through the HANNAH device protocol
 * (WebSocketHardwareAdapter). "Paired" means the device answered the pairing
 * code; "sent" means the device acknowledged the command. Battery and
 * last-seen come from the device itself.
 */
import { WebSocketHardwareAdapter, type HardwareModality } from "./HardwareAdapter";

export type PairedDevice = {
  id: string;
  name: string;
  battery: number | null;
  connected: boolean;
  lastSeen: number;
  modalities: string[];
};

export type HardwareCommand = {
  type: "audio_stream" | "vision_frame" | "actuator" | "expression" | "gesture" | "interrupt";
  payload: unknown;
};

const MODALITY: Record<HardwareCommand["type"], HardwareModality> = {
  audio_stream: "audio",
  vision_frame: "vision",
  actuator: "actuation",
  expression: "expression",
  gesture: "expression",
  interrupt: "actuation",
};

export const HardwareBridgeService = {
  adapter: new WebSocketHardwareAdapter(),
  paired: false,
  device: null as PairedDevice | null,

  /** Pair with a device at `address` (wss://… or ws:// on the local network), with "#code" for its pairing code. */
  async pair(address: string, name?: string) {
    await this.adapter.pair(address);
    const info = this.adapter.device!;
    const health = await this.adapter.getHealth();
    this.paired = true;
    this.device = { id: info.id, name: name || info.name, battery: info.battery ?? null, connected: health.connected, lastSeen: health.lastSeen, modalities: info.modalities };
    return this.device;
  },

  unpair() {
    void this.adapter.unpair();
    this.paired = false;
    this.device = null;
  },

  /** Send a command and wait for the device's acknowledgement. */
  async sendCommand(command: HardwareCommand) {
    if (!this.paired || !this.device) throw new Error("No hardware paired.");
    const result = await this.adapter.sendCommand({ type: MODALITY[command.type], payload: command.type === "interrupt" ? { interrupt: true, ...(command.payload as object ?? {}) } : command.payload });
    const health = await this.adapter.getHealth();
    this.device.lastSeen = health.lastSeen;
    if (health.battery !== undefined) this.device.battery = health.battery;
    return { command, status: result.status, deviceId: this.device.id };
  },

  /** Older entry point: connecting is pairing. */
  async connectWebSocket(url: string) {
    await this.pair(url);
  },

  getHealth() {
    return { paired: this.paired && this.adapter.isPaired(), device: this.device, socketOpen: this.adapter.isPaired() };
  },
};
