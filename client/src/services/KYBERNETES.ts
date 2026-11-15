export const KYBERNETES = {
  paused: false,
  snapshot: null as unknown,
  bigRedButton() {
    this.paused = true;
    this.snapshot = { specialists: [] };
  },
  resume() {
    this.paused = false;
  },
  canCreate() {
    return !this.paused;
  },
};