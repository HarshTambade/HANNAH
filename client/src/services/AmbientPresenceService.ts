export const AmbientPresenceService = {
  context: { location: null as string | null, gaze: null as string | null, nearbyPeople: 0, activeDevices: [] as string[] },
  update(patch: Partial<typeof this.context>) {
    this.context = { ...this.context, ...patch };
  },
  handoff(deviceId: string) {
    return { from: "current", to: deviceId, state: "conversation" };
  },
};