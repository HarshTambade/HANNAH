import { useState } from "react";
import { MapPin, Play, Sunrise, Volume2 } from "lucide-react";
import { Briefing, SECTION_IDS, SECTION_LABELS, type BriefingData, type BriefingLocation, type BriefingSectionId } from "../services/Briefing";
import { defaultDeps } from "../services/AutomationService";

const HINTS: Record<BriefingSectionId, string> = {
  calendar: "Today's events from your connected calendar.",
  reminders: "Reminders due today, including overdue ones.",
  mail: "The newest messages in your connected mail, as information only.",
  memory: "Routines and preferences HANNAH remembers (never sensitive ones).",
  weather: "Today's forecast from Open-Meteo for the place you choose. Only the place's coordinates are sent.",
  news: "Hacker News front-page headlines, from Algolia's public API. Nothing about you is sent.",
};

/** Settings → Daily briefing: which sections, the place for the weather, and a preview. */
export default function BriefingSettings() {
  const [settings, setSettings] = useState(() => Briefing.settings());
  const [place, setPlace] = useState("");
  const [candidates, setCandidates] = useState<BriefingLocation[] | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [preview, setPreview] = useState<{ data: BriefingData; narrative: string } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState("");

  const toggle = (id: BriefingSectionId, enabled: boolean) => setSettings(Briefing.saveSettings({ sections: { ...settings.sections, [id]: enabled } }));

  const lookUp = async () => {
    setLookingUp(true);
    setError("");
    try {
      const found = await Briefing.lookupLocation(place);
      setCandidates(found);
      if (!found.length) setError("No place with that name was found.");
    } catch (cause) {
      setError(cause instanceof Error ? `The place lookup failed: ${cause.message}` : "The place lookup failed.");
    } finally {
      setLookingUp(false);
    }
  };

  const choose = (location: BriefingLocation | null) => {
    setSettings(Briefing.saveSettings({ location }));
    setCandidates(null);
    setPlace("");
  };

  const runPreview = async () => {
    setPreviewing(true);
    setError("");
    try {
      setPreview(await Briefing.generate(defaultDeps.ask));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The briefing couldn't be made.");
    } finally {
      setPreviewing(false);
    }
  };

  const speak = async () => {
    if (!preview) return;
    const { SpeechService } = await import("../services/SpeechService");
    await SpeechService.speak(preview.narrative.slice(0, 1500), "en-US").catch(() => undefined);
  };

  return (
    <div className="space-y-4">
      <ul className="grid gap-2 sm:grid-cols-2" aria-label="Briefing sections">
        {SECTION_IDS.map((id) => (
          <li key={id} className="rounded-xl border border-slate-200 bg-white/70 px-3 py-2">
            <label className="flex items-start gap-2 text-sm text-ink">
              <input type="checkbox" checked={settings.sections[id]} onChange={(event) => toggle(id, event.target.checked)} className="mt-1" />
              <span><span className="font-semibold">{SECTION_LABELS[id]}</span><span className="block text-xs text-slate-500">{HINTS[id]}</span></span>
            </label>
          </li>
        ))}
      </ul>

      {settings.sections.weather && (
        <div className="rounded-2xl border border-slate-200 bg-white/70 p-3">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-ink"><MapPin size={14} /> Place for the weather</p>
          {settings.location ? (
            <p className="mt-1 text-sm text-slate-700">{settings.location.name} <button type="button" onClick={() => choose(null)} className="ml-2 text-xs font-semibold text-rose-700 underline-offset-2 hover:underline">Clear</button></p>
          ) : (
            <p className="mt-1 text-xs text-slate-500">No place chosen yet, so the weather is skipped.</p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input value={place} onChange={(event) => setPlace(event.target.value)} placeholder="City or town" aria-label="City or town" className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-sm text-ink outline-none focus:border-amber-400" onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void lookUp(); } }} />
            <button type="button" onClick={() => void lookUp()} disabled={!place.trim() || lookingUp} className="btn-outline !py-1.5 text-xs disabled:opacity-40">{lookingUp ? "Looking up…" : "Find"}</button>
          </div>
          {candidates && candidates.length > 0 && (
            <ul className="mt-2 space-y-1" aria-label="Matching places">
              {candidates.map((candidate) => (
                <li key={`${candidate.latitude},${candidate.longitude}`}>
                  <button type="button" onClick={() => choose(candidate)} className="w-full rounded-xl bg-white px-3 py-1.5 text-left text-sm text-ink hover:bg-amber-50">{candidate.name}</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void runPreview()} disabled={previewing} className="btn-outline !py-1.5 text-xs disabled:opacity-40"><Play size={13} /> {previewing ? "Making your briefing…" : "Preview today's briefing"}</button>
        {preview && <button type="button" onClick={() => void speak()} className="btn-ghost !py-1.5 text-xs"><Volume2 size={13} /> Speak it</button>}
        <span className="text-xs text-slate-500">Uses the AI chosen in chat.</span>
      </div>
      {error && <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>}
      {preview && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50/60 p-4">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-900"><Sunrise size={13} /> {preview.data.day}</p>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink">{preview.narrative}</p>
          <details className="mt-3 text-xs text-slate-600">
            <summary className="cursor-pointer font-semibold">What was collected</summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-xl bg-white p-3 font-sans">{Briefing.render(preview.data) || "Nothing: every section is off or empty."}</pre>
          </details>
        </div>
      )}
    </div>
  );
}
