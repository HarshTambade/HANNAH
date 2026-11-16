import { useEffect, useState } from "react";
import { readRoutingPreferences, ROUTING_EVENT, ROUTING_MODES, ROUTING_TIERS, saveRoutingPreferences, type RoutingPreferences } from "../services/ModelRouting";

/** Routing mode for the Auto model, shown in the chat settings. */
export default function RoutingSettings({ providers, disabled }: { providers: Array<{ id: string; label: string }>; disabled?: boolean }) {
  const [preferences, setPreferences] = useState<RoutingPreferences>(() => readRoutingPreferences());

  useEffect(() => {
    const refresh = () => setPreferences(readRoutingPreferences());
    window.addEventListener(ROUTING_EVENT, refresh);
    window.addEventListener("hannah:settings", refresh);
    return () => {
      window.removeEventListener(ROUTING_EVENT, refresh);
      window.removeEventListener("hannah:settings", refresh);
    };
  }, []);

  const update = (next: Partial<RoutingPreferences>) => setPreferences(saveRoutingPreferences(next));
  const current = ROUTING_MODES.find((item) => item.id === preferences.mode) ?? ROUTING_MODES[0];

  return (
    <fieldset className="mt-3 border-t border-brand-100 pt-3" disabled={disabled}>
      <legend className="mb-1.5 text-xs font-semibold text-slate-700">How Auto chooses</legend>
      <div role="radiogroup" aria-label="Routing mode" className="grid grid-cols-2 gap-1.5">
        {ROUTING_MODES.map((mode) => (
          <button
            key={mode.id}
            type="button"
            role="radio"
            aria-checked={preferences.mode === mode.id}
            onClick={() => update({ mode: mode.id })}
            className={`rounded-lg border px-2 py-1.5 text-left text-xs transition ${preferences.mode === mode.id ? "border-brand-300 bg-white font-semibold text-brand-700" : "border-slate-200 bg-white/70 text-slate-600 hover:bg-white"}`}
          >
            {mode.label}
          </button>
        ))}
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-slate-500">{current.description}</p>

      {preferences.mode === "custom" && (
        <div className="mt-2 space-y-2 rounded-lg border border-slate-200 bg-white/70 p-2.5">
          <div>
            <p className="mb-1 text-xs font-medium text-slate-700">Providers HANNAH may use</p>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {providers.map((provider) => (
                <label key={provider.id} className="flex items-center gap-1.5 text-xs text-slate-600">
                  <input
                    type="checkbox"
                    checked={preferences.providers.includes(provider.id)}
                    onChange={(event) => update({ providers: event.target.checked ? [...preferences.providers, provider.id] : preferences.providers.filter((id) => id !== provider.id) })}
                  />
                  {provider.label}
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-slate-400">None ticked means any provider you can use.</p>
          </div>
          <label className="block text-xs text-slate-700">
            Most capable tier
            <select
              value={preferences.maxTier ?? ""}
              onChange={(event) => update({ maxTier: (event.target.value || null) as RoutingPreferences["maxTier"] })}
              className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs"
            >
              <option value="">No limit</option>
              {ROUTING_TIERS.map((tier) => <option key={tier} value={tier}>{tier[0].toUpperCase() + tier.slice(1)}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-xs text-slate-600">
            <input type="checkbox" checked={preferences.localOnly} onChange={(event) => update({ localOnly: event.target.checked })} />
            Self-hosted models only
          </label>
        </div>
      )}

      <label className="mt-2 block text-xs text-slate-700">
        Ask before sending when the estimate is at least
        <span className="mt-1 flex items-center gap-1">
          <span className="text-slate-500">$</span>
          <input
            type="number"
            min={0}
            max={100}
            step={0.01}
            value={preferences.confirmAboveUsd}
            onChange={(event) => update({ confirmAboveUsd: Number(event.target.value) })}
            className="w-24 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs"
          />
        </span>
      </label>
      <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
        Estimates appear only for prices an operator has checked and dated. For fully offline use, pick the browser or on-device mode above: they never use the network.
      </p>
    </fieldset>
  );
}
