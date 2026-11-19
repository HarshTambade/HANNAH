/**
 * Which models each hosted provider really serves, from its live model list.
 *
 * HANNAH's curated profiles (shared/model-profiles.json) and catalog outlive
 * models a provider retires; Auto routing to a retired model fails every
 * request. Discovery records each hosted provider's live list here (a hosted
 * provider's models are the same for every key), and routing skips a model
 * the list doesn't have. Unknown (no list yet, or it expired) means "don't
 * skip": a request then fails over to the next model as before.
 */
const TTL_MS = 30 * 60_000;
const served = new Map();

/** Record a hosted provider's live model ids (ignored when the list is empty). */
function rememberServed(providerId, models, now = Date.now()) {
  const ids = [...new Set((models || []).filter((id) => typeof id === "string" && id.trim()))];
  if (!providerId || !ids.length) return;
  served.set(providerId, { models: new Set(ids), until: now + TTL_MS });
}

/** true or false once the provider's live list is known and fresh; null when unknown. */
function servedStatus(providerId, model, now = Date.now()) {
  const entry = served.get(providerId);
  if (!entry || entry.until <= now) return null;
  return entry.models.has(model);
}

/** Whether the provider's live list is known and fresh. */
function knowsServed(providerId, now = Date.now()) {
  const entry = served.get(providerId);
  return Boolean(entry && entry.until > now);
}

/** The provider's served model ids, freshest list, or [] when unknown. */
function servedModels(providerId, now = Date.now()) {
  const entry = served.get(providerId);
  return entry && entry.until > now ? [...entry.models] : [];
}

function resetServed() {
  served.clear();
}

module.exports = { knowsServed, rememberServed, resetServed, servedModels, servedStatus };
