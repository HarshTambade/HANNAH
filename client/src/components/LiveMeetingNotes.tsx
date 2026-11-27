/**
 * Live notes for one meeting, from this device's microphone.
 *
 * Starting asks the person to confirm that everyone present knows HANNAH is
 * transcribing and agreed; the meeting must also have recording consent. The
 * browser then asks for the microphone. Pieces are transcribed on the server
 * with the account's own key and only the text is kept. HANNAH doesn't join
 * the call itself: whatever this device's microphone hears is what's noted.
 */
import { useEffect, useRef, useState } from "react";
import { Mic, Square } from "lucide-react";
import workforce, { type Meeting } from "../services/Workforce";
import { pickAudioType, startLiveRecorder } from "../services/LiveMeetingRecorder";

const button = "inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50";
const primary = "inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50";
const message = (error: unknown) => (error instanceof Error ? error.message : "That didn't work.");

export default function LiveMeetingNotes({ meeting, onChanged }: { meeting: Meeting; onChanged: (note: string) => Promise<void> }) {
  const [agreed, setAgreed] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const recorder = useRef<ReturnType<typeof startLiveRecorder> | null>(null);
  const consent = meeting.consent as { record?: boolean; transcript?: boolean; live?: { lastSeq?: number; endedAt?: number | null } };
  const live = meeting.status === "live";
  const supported = typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== "undefined" && Boolean(pickAudioType());

  useEffect(() => () => { void recorder.current?.stop(); }, []);

  const record = (firstSeq: number) => {
    const type = pickAudioType();
    recorder.current = startLiveRecorder({
      firstSeq,
      getStream: () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }),
      createRecorder: (stream) => new MediaRecorder(stream, type ? { mimeType: type } : undefined),
      upload: (seq, atMs, piece) => workforce.meetingLiveAudio(meeting.id, seq, atMs, piece),
      onText: (line) => setLines((current) => [...current, line].slice(-200)),
      onProblem: (text, fatal) => { setProblem(text); if (fatal) { setRecording(false); void recorder.current?.stop(); recorder.current = null; } },
    });
    setRecording(true);
    void recorder.current.ready.then((ok) => { if (!ok) setRecording(false); });
  };

  const start = async () => {
    setBusy(true); setProblem(""); setLines([]);
    try {
      await workforce.meetingLiveStart(meeting.id, { everyoneAgreed: true, language: (navigator.language || "en").slice(0, 2) });
      record(0);
      await onChanged(`Live notes started for "${meeting.title}".`);
    } catch (error) { setProblem(message(error)); } finally { setBusy(false); }
  };

  const resume = () => { setProblem(""); record((consent.live?.lastSeq ?? -1) + 1); };

  const stop = async () => {
    setBusy(true);
    try {
      await recorder.current?.stop();
      recorder.current = null;
      setRecording(false);
      await workforce.meetingLiveEnd(meeting.id);
      await onChanged(`Live notes ended for "${meeting.title}". Write the notes when you're ready.`);
    } catch (error) { setProblem(message(error)); } finally { setBusy(false); }
  };

  if (consent.record !== true || consent.transcript !== true) {
    return <p className="mt-2 text-xs text-slate-500">Live notes need consent to record and transcribe, recorded when the meeting was added.</p>;
  }
  if (!supported) return <p className="mt-2 text-xs text-slate-500">This browser can't record audio for live notes. Paste the transcript instead.</p>;

  return (
    <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-2 text-sm" data-testid={`live-notes-${meeting.id}`}>
      {!live && !recording && (
        <div className="space-y-2">
          <label className="flex items-start gap-2 text-sm text-slate-700"><input type="checkbox" className="mt-1" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} data-testid="live-notes-agreed" /> Everyone in this meeting knows HANNAH is transcribing it from this device's microphone, and agreed.</label>
          <button type="button" className={primary} disabled={busy || !agreed} onClick={() => void start()} data-testid="live-notes-start"><Mic size={14} /> Start live notes</button>
          <p className="text-xs text-slate-500">HANNAH doesn't join the call: it notes what this device hears, about every 20 seconds. Audio is transcribed with your account's Groq key and isn't kept.</p>
        </div>
      )}
      {(live || recording) && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-2 font-medium text-slate-800">{recording ? <><span className="h-2 w-2 animate-pulse rounded-full bg-rose-600" aria-hidden /> Live notes are on</> : "Live notes were started but aren't recording on this device."}</p>
            <div className="flex gap-2">
              {!recording && <button type="button" className={button} disabled={busy} onClick={resume}><Mic size={14} /> Record here</button>}
              <button type="button" className={primary} disabled={busy} onClick={() => void stop()} data-testid="live-notes-stop"><Square size={14} /> {busy ? "Finishing…" : "End live notes"}</button>
            </div>
          </div>
          {!!lines.length && <ol className="max-h-48 space-y-0.5 overflow-y-auto text-xs text-slate-700" aria-live="polite" data-testid="live-notes-lines">{lines.map((line, index) => <li key={index}>{line}</li>)}</ol>}
          {recording && !lines.length && <p className="text-xs text-slate-500">The first lines appear about 20 seconds after the meeting starts talking.</p>}
        </div>
      )}
      {problem && <p className="mt-1 text-xs text-rose-700" role="alert">{problem}</p>}
    </div>
  );
}
