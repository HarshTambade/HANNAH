export type PerceptionEvent = {
  source: "window" | "directory" | "repository" | "inbox" | "presence";
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
};

/** Unified event schema emitted by every perception source. */
export interface WindowEvent {
  source: "window";
  type: "window.focused" | "window.blurred" | "window.changed";
  timestamp: string;
  payload: { title?: string; app?: string; idle?: boolean };
}

export interface DirectoryEvent {
  source: "directory";
  type: "directory.changed" | "directory.created" | "directory.deleted";
  timestamp: string;
  payload: { path: string; changeType?: "created" | "modified" | "deleted" };
}

export interface RepositoryEvent {
  source: "repository";
  type: "repository.commit" | "repository.branch_changed" | "repository.status_changed";
  timestamp: string;
  payload: { repository: string; branch?: string; sha?: string };
}

export interface InboxEvent {
  source: "inbox";
  type: "inbox.message" | "inbox.notification";
  timestamp: string;
  payload: { from?: string; subject?: string; unreadCount?: number };
}

export interface PresenceEvent {
  source: "presence";
  type: "presence.active" | "presence.idle" | "presence.away";
  timestamp: string;
  payload: { idle: boolean; idleSeconds?: number };
}

export type PerceptionSourceEvent =
  | WindowEvent
  | DirectoryEvent
  | RepositoryEvent
  | InboxEvent
  | PresenceEvent;

export interface PerceptionSource {
  id: "window" | "directory" | "repository" | "inbox" | "presence";
  enabled: boolean;
  consented: boolean;
  start(): void;
  stop(): void;
  health(): { active: boolean; lastEventAt?: string };
}

function consentKey(id: string) {
  return `shanaya.perception.${id}.consent`;
}

class BaseSource implements PerceptionSource {
  id: PerceptionSource["id"];
  enabled = false;
  consented = false;
  protected timer: number | null = null;
  protected lastEventAt: string | undefined;

  constructor(id: PerceptionSource["id"]) {
    this.id = id;
    try {
      this.consented = window.localStorage.getItem(consentKey(id)) === "true";
    } catch {
      this.consented = false;
    }
  }

  start() {
    if (!this.consented) return;
    this.enabled = true;
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

class WindowSource extends BaseSource {
  constructor() { super("window"); }
  // Disabled by default; full native integration deferred.
}

class DirectorySource extends BaseSource {
  constructor() { super("directory"); }
  start() {
    if (!this.consented) return;
    super.start();
    this.timer = window.setInterval(() => {
      this.lastEventAt = new Date().toISOString();
      PerceptionBus.emit({
        source: "directory",
        type: "directory.changed",
        timestamp: this.lastEventAt,
        payload: { path: "app-documents" },
      });
    }, 60000);
  }
  stop() {
    super.stop();
  }
}

class RepositorySource extends BaseSource {
  constructor() { super("repository"); }
}

class InboxSource extends BaseSource {
  constructor() { super("inbox"); }
}

class PresenceSource extends BaseSource {
  constructor() { super("presence"); }
  start() {
    if (!this.consented) return;
    super.start();
    this.timer = window.setInterval(() => {
      this.lastEventAt = new Date().toISOString();
      PerceptionBus.emit({
        source: "presence",
        type: "presence.active",
        timestamp: this.lastEventAt,
        payload: { idle: false },
      });
    }, 30000);
  }
  stop() {
    super.stop();
  }
}

type Listener = (event: PerceptionEvent) => void;

export const PerceptionBus = {
  sources: {
    window: new WindowSource(),
    directory: new DirectorySource(),
    repository: new RepositorySource(),
    inbox: new InboxSource(),
    presence: new PresenceSource(),
  } as Record<string, PerceptionSource>,
  listeners: new Set<Listener>(),
  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  },
  unsubscribe(listener: Listener) {
    this.listeners.delete(listener);
  },
  emit(event: PerceptionEvent) {
    this.listeners.forEach((listener) => listener(event));
  },
  consent(sourceId: string) {
    const source = this.sources[sourceId];
    if (source) {
      source.consented = true;
      try {
        window.localStorage.setItem(consentKey(sourceId), "true");
      } catch {
        // Best effort.
      }
    }
  },
  revoke(sourceId: string) {
    const source = this.sources[sourceId];
    if (source) {
      source.consented = false;
      source.stop();
      try {
        window.localStorage.removeItem(consentKey(sourceId));
      } catch {
        // Best effort.
      }
    }
  },
  start(sourceId: string) {
    const source = this.sources[sourceId];
    if (source?.consented) source.start();
  },
  stop(sourceId: string) {
    this.sources[sourceId]?.stop();
  },
  startAllConsented() {
    Object.keys(this.sources).forEach((id) => {
      if (this.sources[id]?.consented) this.sources[id].start();
    });
  },
  health() {
    return Object.fromEntries(
      Object.entries(this.sources).map(([id, source]) => [id, source ? source.health() : { active: false }]),
    );
  },
};