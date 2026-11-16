import { PluginManifestSchema, type PluginManifest, type InstalledPlugin } from "./PluginManifest";
import { GuardianAgent } from "./GuardianAgent";

const STORAGE_KEY = "hannah.plugins.v1";

function readPlugins(): InstalledPlugin[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writePlugins(plugins: InstalledPlugin[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(plugins.slice(0, 500)));
  } catch {
    // Best effort.
  }
}

export const PluginLoader = {
  async fetchManifest(url: string): Promise<PluginManifest> {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Failed to fetch plugin manifest: ${response.status}`);
    const data = await response.json();
    const parsed = PluginManifestSchema.safeParse(data);
    if (!parsed.success) {
      const errors = parsed.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`);
      throw new Error(`Invalid plugin manifest: ${errors.join("; ")}`);
    }
    return parsed.data;
  },

  async validate(manifest: PluginManifest): Promise<{ valid: boolean; issues: string[] }> {
    const issues: string[] = [];

    // GuardianAgent inspection
    const guard = GuardianAgent.evaluate({
      tool: "plugin_install",
      args: { name: manifest.name, permissions: manifest.permissions },
      intent: "plugin_install",
    });
    if (!guard.allowed) {
      issues.push(`GuardianAgent blocked: ${guard.reason}`);
    }

    // Check permissions against declared
    const declaredPerms = manifest.permissions;
    if (declaredPerms.includes("network") && !manifest.repository) {
      issues.push("Network permission declared but no repository URL provided");
    }

    // Version check
    if (manifest.minHannahVersion) {
      const current = "1.0.3";
      if (manifest.minHannahVersion > current) {
        issues.push(`Requires HANNAH v${manifest.minHannahVersion}, current is v${current}`);
      }
    }

    return { valid: issues.length === 0, issues };
  },

  async install(manifest: PluginManifest, sourceUrl?: string): Promise<InstalledPlugin> {
    const validation = await this.validate(manifest);
    if (!validation.valid) {
      throw new Error(`Plugin validation failed: ${validation.issues.join("; ")}`);
    }

    const now = new Date().toISOString();
    const plugin: InstalledPlugin = {
      ...manifest,
      installedAt: now,
      enabled: true,
      sourceUrl,
    };

    const plugins = readPlugins();
    const existing = plugins.findIndex((p) => p.id === manifest.id);
    if (existing >= 0) {
      plugins[existing] = plugin;
    } else {
      plugins.push(plugin);
    }
    writePlugins(plugins);

    return plugin;
  },

  list(): InstalledPlugin[] {
    return readPlugins();
  },

  get(id: string): InstalledPlugin | undefined {
    return readPlugins().find((p) => p.id === id);
  },

  uninstall(id: string) {
    const plugins = readPlugins().filter((p) => p.id !== id);
    writePlugins(plugins);
  },

  toggle(id: string, enabled: boolean) {
    const plugins = readPlugins();
    const plugin = plugins.find((p) => p.id === id);
    if (plugin) {
      plugin.enabled = enabled;
      writePlugins(plugins);
    }
  },

  update(id: string, updates: Partial<InstalledPlugin>) {
    const plugins = readPlugins();
    const plugin = plugins.find((p) => p.id === id);
    if (plugin) {
      Object.assign(plugin, updates);
      writePlugins(plugins);
    }
  },
};
