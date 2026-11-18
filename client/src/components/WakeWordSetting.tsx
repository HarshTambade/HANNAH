import { useEffect, useState } from "react";
import { Ear, Loader2 } from "lucide-react";
import { WAKE_STATE_EVENT, WakeWord, wakeWordSupported, type WakeState } from "../services/WakeWord";

const stateText: Record<WakeState, string> = {
  off: "Off.",
  loading: "Getting ready… The first time, this downloads the speech model (about 41 MB) and keeps it on this device.",
  listening: "Listening for “Hey HANNAH”. Say it, then what you need.",
  paused: "Paused while HANNAH is listening to you or speaking.",
  error: "",
  unsupported: "This device can't run the wake word.",
};

/** Settings → Voice → "Hey HANNAH". */
export default function WakeWordSetting() {
  const [enabled, setEnabled] = useState(WakeWord.enabled);
  const [state, setState] = useState<WakeState>(WakeWord.state);
  const [error, setError] = useState(WakeWord.error);
  useEffect(() => {
    const update = () => { setState(WakeWord.state()); setError(WakeWord.error()); setEnabled(WakeWord.enabled()); };
    window.addEventListener(WAKE_STATE_EVENT, update);
    return () => window.removeEventListener(WAKE_STATE_EVENT, update);
  }, []);
  const supported = wakeWordSupported();

  return (
    <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-xl">
          <p className="flex items-center gap-2 text-sm font-semibold text-ink"><Ear size={15} /> “Hey HANNAH”</p>
          <p className="mt-1 text-xs leading-5 text-slate-600">Start talking hands-free. Detection runs on this device and only listens for its name; no audio is sent anywhere until you speak to HANNAH after it. In the desktop app it keeps listening while the window is hidden (the menu bar says so). On Android it keeps listening in the background, with a notification and a Stop button the whole time. In a browser, only while this tab is open.</p>
        </div>
        <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-700">
          <input
            type="checkbox"
            className="h-4 w-4 accent-violet-600"
            checked={enabled}
            disabled={!supported}
            onChange={(event) => { setEnabled(event.target.checked); void WakeWord.setEnabled(event.target.checked); }}
          />
          Listen for “Hey HANNAH”
        </label>
      </div>
      {enabled && (
        <p role="status" className={`mt-3 flex items-start gap-2 rounded-xl px-3 py-2 text-xs ${state === "error" ? "bg-rose-50 text-rose-800" : state === "listening" ? "bg-emerald-50 text-emerald-900" : "bg-slate-50 text-slate-700"}`}>
          {state === "loading" && <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin motion-reduce:animate-none" />}
          <span>{state === "error" ? error : stateText[state]}</span>
        </p>
      )}
      {!supported && <p className="mt-3 text-xs text-slate-600">iPhone doesn't let apps listen for their own name. Say “Hey Siri, talk to HANNAH” instead, or add it as a shortcut in the Shortcuts app; HANNAH opens ready to listen.</p>}
    </div>
  );
}
