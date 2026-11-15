export type PairedDevice = {
  id: string;
  name: string;
  battery: number;
  connected: boolean;
  lastSeen: number;
  modalities: string[];
};

export type HardwareCommand = {
  type: "audio_stream" | "vision_frame" | "actuator" | "expression" | "gesture" | "interrupt";
  payload: unknown;
};

export const HardwareBridgeService = {
  paired: false,
  device: null as PairedDevice | null,
  socket: null as WebSocket | null,
  async pair(deviceId: string, name = "Companion Device") {
    this.paired = true;
    this.device = { id: deviceId, name, battery: 100, connected: true, lastSeen: Date.now(), modalities: ["audio", "vision", "sensor"] };
    return this.device;
  },
  unpair() {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.paired = false;
    this.device = null;
  },
  async sendCommand(command: HardwareCommand) {
    if (!this.paired || !this.device) throw new Error("No hardware paired.");
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(command));
    }
    this.device.lastSeen = Date.now();
    return { command, status: "sent", deviceId: this.device.id };
  },
  async connectWebSocket(url: string) {
    // Mutual TLS WebSocket is handled by the browser/platform TLS stack; the URL
    // must use wss:// and present a client certificate configured at the OS level.
    this.socket = new WebSocket(url);
    return new Promise<void>((resolve, reject) => {
      this.socket!.onopen = () => resolve();
      this.socket!.onerror = (err) => reject(err);
    });
  },
  getHealth() {
    return {
      paired: this.paired,
      device: this.device,
      socketOpen: this.socket?.readyState === WebSocket.OPEN,
    };
  },
};