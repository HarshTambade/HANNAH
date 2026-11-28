"use strict";

/**
 * Caches that are safe to clear: clearing one only costs a refetch. A cache
 * registers here with what it holds; diagnostics' "clear safe cache" clears
 * these and nothing else. Nothing that holds state a person made (sessions,
 * keys, queued work, recordings) may register.
 */
const registry = new Map();

function registerSafeCache(id, { description, clear, size }) {
  if (typeof clear !== "function") throw new Error(`Cache ${id} needs a clear function.`);
  registry.set(String(id), { id: String(id), description: String(description || id), clear, size: typeof size === "function" ? size : () => null });
}
function safeCaches() {
  return [...registry.values()].map((entry) => { let entries = null; try { entries = entry.size(); } catch { entries = null; } return { id: entry.id, description: entry.description, entries }; });
}
/** Clear every registered cache (or the ones named). Returns what each held before and after. */
function clearSafeCaches(ids = null) {
  const out = [];
  for (const entry of registry.values()) {
    if (ids && !ids.includes(entry.id)) continue;
    let before = null;
    try { before = entry.size(); } catch { before = null; }
    entry.clear();
    let after = null;
    try { after = entry.size(); } catch { after = null; }
    out.push({ id: entry.id, before, after });
  }
  return out;
}

module.exports = { clearSafeCaches, registerSafeCache, safeCaches };
