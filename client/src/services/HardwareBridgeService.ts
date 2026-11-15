export const HardwareBridgeService = {
  paired: false,
  device: null as { id: string; battery: number; connected: boolean } | null,
  pair(deviceId: string) {
    this.paired = true;
    this.device = { id: deviceId, battery: 100, connected: true };
  },
  unpair() {
    this.paired = false;
    this.device = null;
  },
  sendCommand(command: string) {
    if (!this.paired) throw new Error("No hardware paired.");
    return { command, status: "sent" };
  },
};