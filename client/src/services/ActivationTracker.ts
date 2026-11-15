const KEY = "shanaya.activation.v1";

export const ActivationTracker = {
  state: { messages: 0, toolUsed: false, firstSeen: Date.now(), returnedWithin48h: false },
  load() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(KEY) || "null");
      if (parsed) this.state = { ...this.state, ...parsed };
    } catch {
      // Best effort.
    }
  },
  save() {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(this.state));
    } catch {
      // Best effort.
    }
  },
  recordMessage() {
    this.load();
    this.state.messages += 1;
    this.save();
  },
  recordToolUse() {
    this.load();
    this.state.toolUsed = true;
    this.save();
  },
  isActivated() {
    this.load();
    return this.state.messages >= 3 && this.state.toolUsed;
  },
};