export type ChaosFault = "network-drop" | "tool-timeout" | "corrupted-memory" | "hitl-denial";
export type DegradedState = { degraded: boolean; reason?: string };
const ENABLED_KEY = "shanaya.dev.chaos.enabled";
const listeners = new Set<() => void>();
const armed: ChaosFault[] = [];
let degraded: DegradedState = { degraded: false };

function allowed() { return import.meta.env.DEV || import.meta.env.MODE === "test"; }
function enabled() {
  if (!allowed()) return false;
  try { return window.localStorage.getItem(ENABLED_KEY) === "true"; } catch { return false; }
}
function notify() { listeners.forEach((listener) => listener()); }

export const ChaosEngine = {
  available: allowed,
  isEnabled: enabled,
  setEnabled(value: boolean) {
    if (!allowed()) return;
    try { window.localStorage.setItem(ENABLED_KEY, String(value)); } catch { /* Best effort. */ }
    notify();
  },
  armOnce(fault: ChaosFault) { if (allowed()) armed.push(fault); },
  consume(fault: ChaosFault) {
    if (!allowed()) return false;
    const index = armed.indexOf(fault);
    if (index >= 0) { armed.splice(index, 1); return true; }
    return enabled() && Math.random() < 0.1;
  },
  setDegraded(reason: string) { degraded = { degraded: true, reason }; notify(); },
  clearDegraded() { degraded = { degraded: false }; notify(); },
  getDegraded() { return degraded; },
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  resetForTests() { armed.splice(0); degraded = { degraded: false }; try { window.localStorage.removeItem(ENABLED_KEY); } catch { /* test cleanup */ } notify(); },
};
