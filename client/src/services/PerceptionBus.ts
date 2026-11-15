export type PerceptionEvent = {
  source: "window" | "directory" | "repository" | "inbox" | "presence";
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
};

export interface PerceptionSource {
  id: string;
  enabled: boolean;
  consented: boolean;
  start(): void;
  stop(): void;
  health(): { active: boolean; lastEventAt?: string };
}

class DirectorySource implements PerceptionSource {
  id = "directory";
  enabled = false;
  consented = false;
  private timer: number | null = null;
  private lastEventAt: string | undefined;
  start() {
    if (!this.consented) return;
    this.enabled = true;
    this.timer = window.setInterval(() => {
      this.lastEventAt = new Date().toISOString();
      PerceptionBus.emit({ source: "directory", type: "directory.changed", timestamp: this.lastEventAt, payload: { path: "app-documents" } });
    }, 60000);
  }
  stop() {
    this.enabled = false;
    if (this.timer) window.clearInterval(this.timer);
    this.timer = null;
  }
  health() {
    return { active: this.enabled, lastEventAt: this.lastEventAt };
  }
}

class PresenceSource implements PerceptionSource {
  id = "presence";
  enabled = false;
  consented = false;
  private timer: number | null = null;
  private lastEventAt: string | undefined;
  start() {
    if (!this.consented) return;
    this.enabled = true;
    this.timer = window.setInterval(() => {
      this.lastEventAt = new Date().toISOString();
      PerceptionBus.emit({ source: "presence", type: "presence.active", timestamp: this.lastEventAt, payload: { idle: false } });
    }, 30000);
  }
  stop() {
    this.enabled = false;
    if (this.timer) window.clearInterval(this.timer);
    this.timer = null;
  }
  health() {
    return { active: this.enabled, lastEventAt: this.lastEventAt };
  }
}

type Listener = (event: PerceptionEvent) => void;

export const PerceptionBus = {
  sources: {
    window: null as PerceptionSource | null,
    directory: new DirectorySource(),
    repository: null as PerceptionSource | null,
    inbox: null as PerceptionSource | null,
    presence: new PresenceSource(),
  },
  listeners: new Set<Listener>(),
  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  },
  emit(event: PerceptionEvent) {
    this.listeners.forEach((listener) => listener(event));
  },
  consent(sourceId: string) {
    const source = this.sources[sourceId as keyof typeof this.sources];
    if (source) {
      source.consented = true;
      try {
        window.localStorage.setItem(`shanaya.perception.${sourceId}.consent`, "true");
      } catch {
        // Best effort.
      }
    }
  },
  start(sourceId: string) {
    const source = this.sources[sourceId as keyof typeof this.sources];
    if (source?.consented) source.start();
  },
  stop(sourceId: string) {
    this.sources[sourceId as keyof typeof this.sources]?.stop();
  },
  health() {
    return Object.fromEntries(Object.entries(this.sources).map(([id, source]) => [id, source ? source.health() : { active: false }]));
  },
};