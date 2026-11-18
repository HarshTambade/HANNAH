/**
 * Hardware companions (a speaker, a robot, a sensor box) that HANNAH can pair
 * with and send commands to.
 *
 * `WebSocketHardwareAdapter` is a working adapter for the HANNAH device
 * protocol, a small JSON protocol any device can implement (an ESP32, a
 * Raspberry Pi, a phone app):
 *
 *   app → device   {"type":"hello","app":"hannah","version":1,"pairingCode":"…"}
 *   device → app   {"type":"welcome","deviceId":"…","name":"…","modalities":["audio",…],"battery":87}
 *                  or {"type":"refused","reason":"…"}
 *   app → device   {"type":"command","id":"…","command":{"type":"audio","payload":…}}
 *   device → app   {"type":"ack","id":"…","status":"ok"|"error","detail":"…"}
 *   device → app   {"type":"status","battery":80}        (any time; a heartbeat)
 *
 * Pairing succeeds only when the device answers "welcome" to the pairing
 * code; a command succeeds only when the device acknowledges it. Over the
 * internet the address must be wss:// (TLS); ws:// is accepted only for
 * devices on this computer or the local network.
 */
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
  /** `deviceId` is the device's address (ws:// or wss://), optionally with "#<pairing code>". */
  pair: (deviceId: string) => Promise<void>;
  unpair: () => Promise<void>;
  sendCommand: (command: { type: HardwareModality; payload: unknown }) => Promise<{ status: string }>;
  getHealth: () => Promise<{ battery?: number; connected: boolean; lastSeen: number }>;
};

/** The shared parts; a subclass supplies the transport. Calling it directly says what's missing. */
export class BaseHardwareAdapter implements HardwareAdapter {
  id: string = crypto.randomUUID();
  family = "generic";
  name = "Generic Companion";
  characteristics: HardwareCharacteristics = {
    supportedModalities: ["audio"],
    latencyMs: { audio: 200, vision: 500, actuation: 300, expression: 100 },
    safetyConstraints: [],
    mTLSRequired: true,
    pairingMethod: "wifi",
  };

  isPaired(): boolean {
    return false;
  }

  async pair(_deviceId: string): Promise<void> {
    throw new Error(`${this.name} has no connection method. Use a device that speaks the HANNAH device protocol (WebSocketHardwareAdapter).`);
  }

  async unpair(): Promise<void> {
    // Nothing is connected.
  }

  async sendCommand(_command: { type: HardwareModality; payload: unknown }): Promise<{ status: string }> {
    throw new Error(`${this.name} isn't paired.`);
  }

  async getHealth(): Promise<{ battery?: number; connected: boolean; lastSeen: number }> {
    return { connected: false, lastSeen: 0 };
  }
}

type SocketLike = { readyState: number; send(data: string): void; close(): void; onopen: ((event: unknown) => void) | null; onmessage: ((event: { data: unknown }) => void) | null; onerror: ((event: unknown) => void) | null; onclose: ((event: unknown) => void) | null };
type SocketFactory = (url: string) => SocketLike;
const OPEN = 1;

/** A device address HANNAH may connect to: wss:// anywhere, ws:// only on this computer or the local network. Exported for tests. */
export function checkDeviceAddress(input: string): { url: string; pairingCode: string } {
  const [address, code = ""] = String(input ?? "").trim().split("#");
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new Error("Give the device's address, like wss://speaker.local:8765 (add #code for its pairing code).");
  }
  if (url.protocol !== "wss:" && url.protocol !== "ws:") throw new Error("A device address starts with wss:// (or ws:// on your local network).");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const local = host === "localhost" || host.endsWith(".local") || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host === "::1" || /^f[cd]/i.test(host);
  if (url.protocol === "ws:" && !local) throw new Error("Over the internet the device must use wss:// (encrypted).");
  return { url: url.toString(), pairingCode: decodeURIComponent(code).slice(0, 64) };
}

export class WebSocketHardwareAdapter extends BaseHardwareAdapter {
  family = "hannah-protocol";
  name = "HANNAH device protocol (WebSocket)";
  characteristics: HardwareCharacteristics = {
    supportedModalities: ["audio", "vision", "actuation", "expression", "sensor"],
    latencyMs: { audio: 150, vision: 300, actuation: 250, expression: 80 },
    safetyConstraints: ["the device acknowledges every command", "wss:// required outside the local network"],
    mTLSRequired: false,
    pairingMethod: "wifi",
  };

  device: { id: string; name: string; modalities: HardwareModality[]; battery?: number } | null = null;
  private socket: SocketLike | null = null;
  private lastSeen = 0;
  private waiting = new Map<string, { resolve: (value: { status: string }) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private connect: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike, private timeoutMs = 10_000) {
    super();
  }

  isPaired() {
    return Boolean(this.device && this.socket && this.socket.readyState === OPEN);
  }

  async pair(deviceId: string): Promise<void> {
    const { url, pairingCode } = checkDeviceAddress(deviceId);
    await this.unpair();
    const socket = this.connect(url);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const fail = (message: string) => {
        clearTimeout(timer);
        socket.close();
        if (this.socket === socket) this.socket = null;
        reject(new Error(message));
      };
      const timer = setTimeout(() => fail("The device didn't answer within 10 seconds."), this.timeoutMs);
      socket.onopen = () => socket.send(JSON.stringify({ type: "hello", app: "hannah", version: 1, pairingCode }));
      socket.onerror = () => fail("Couldn't connect to the device.");
      socket.onclose = () => { if (!this.device) fail("The device closed the connection."); else this.handleClose(); };
      socket.onmessage = (event) => {
        const message = this.parse(event.data);
        if (!message) return;
        this.lastSeen = Date.now();
        if (!this.device) {
          if (message.type === "refused") return fail(`The device refused pairing: ${String(message.reason ?? "wrong pairing code")}.`);
          if (message.type !== "welcome" || typeof message.deviceId !== "string") return fail("The device didn't speak the HANNAH device protocol.");
          clearTimeout(timer);
          const modalities = (Array.isArray(message.modalities) ? message.modalities : []).filter((item: unknown): item is HardwareModality => typeof item === "string" && ["audio", "vision", "actuation", "thermal", "expression", "sensor"].includes(item));
          this.device = { id: message.deviceId.slice(0, 120), name: String(message.name ?? "Companion device").slice(0, 80), modalities, ...(typeof message.battery === "number" ? { battery: message.battery } : {}) };
          resolve();
          return;
        }
        this.handleMessage(message);
      };
    });
  }

  private parse(data: unknown): Record<string, unknown> | null {
    try {
      const value = JSON.parse(String(data));
      return value && typeof value === "object" ? value as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }

  private handleMessage(message: Record<string, unknown>) {
    if (message.type === "status" && this.device && typeof message.battery === "number") this.device.battery = message.battery;
    if (message.type === "ack" && typeof message.id === "string") {
      const pending = this.waiting.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.waiting.delete(message.id);
      if (message.status === "ok") pending.resolve({ status: "acknowledged" });
      else pending.reject(new Error(`The device couldn't do it: ${String(message.detail ?? "error")}.`));
    }
  }

  private handleClose() {
    for (const pending of this.waiting.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("The device disconnected before confirming."));
    }
    this.waiting.clear();
    this.socket = null;
  }

  async unpair(): Promise<void> {
    const socket = this.socket;
    this.device = null;
    this.socket = null;
    this.handleClose();
    try {
      socket?.close();
    } catch {
      // Already closed.
    }
  }

  async sendCommand(command: { type: HardwareModality; payload: unknown }): Promise<{ status: string }> {
    if (!this.isPaired() || !this.socket || !this.device) throw new Error("No device is paired.");
    if (this.device.modalities.length && !this.device.modalities.includes(command.type)) throw new Error(`${this.device.name} doesn't support ${command.type}.`);
    const id = crypto.randomUUID();
    const socket = this.socket;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error("The device didn't confirm the command within 10 seconds."));
      }, this.timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ type: "command", id, command }));
    });
  }

  async getHealth(): Promise<{ battery?: number; connected: boolean; lastSeen: number }> {
    return { ...(this.device?.battery !== undefined ? { battery: this.device.battery } : {}), connected: this.isPaired(), lastSeen: this.lastSeen };
  }
}
