export const ProactiveParticipationService = {
  settings: { paused: false, quietHours: { start: 22, end: 8 }, dailyLimit: 2, weeklyLimit: 7 },
  canSend(now = new Date()) {
    if (this.settings.paused) return false;
    const hour = now.getHours();
    if (hour >= this.settings.quietHours.start || hour < this.settings.quietHours.end) return false;
    return true;
  },
  pause(value: boolean) {
    this.settings.paused = value;
  },
};