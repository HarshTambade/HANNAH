/**
 * A cloud computer's live view: Chromium's own screencast of the session's
 * browser, streamed from the server (GET /api/workforce/sessions/:id/stream).
 *
 * Watching is read-only. To use the page yourself (a verification step, a
 * sign-in only you can do) choose Take control: the teammate's browser
 * actions then wait, and your clicks, scrolling and typing go to the page.
 * Hand back gives it to the teammate again. What you type goes straight to
 * the page and isn't stored.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type WheelEvent } from "react";
import { Hand, RotateCcw } from "lucide-react";
import workforce from "../services/Workforce";

const button = "inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50";
const primary = "inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50";
const KEYS: Record<string, string> = { Enter: "Enter", Tab: "Tab", Backspace: "Backspace", Delete: "Delete", Escape: "Escape", ArrowUp: "ArrowUp", ArrowDown: "ArrowDown", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown" };
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const message = (error: unknown) => (error instanceof Error ? error.message : "That didn't work.");

export default function ComputerLiveView({ sessionId, status, onChanged }: { sessionId: string; status: string; onChanged: (note: string) => void }) {
  const [frame, setFrame] = useState<string | null>(null);
  const [frameAt, setFrameAt] = useState<number | null>(null);
  const [note, setNote] = useState("Connecting…");
  const [busy, setBusy] = useState(false);
  const control = status === "waiting-human";
  const typing = useRef({ text: "", timer: 0 });
  const scrolling = useRef({ dx: 0, dy: 0, x: 0.5, y: 0.5, timer: 0 });

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    void (async () => {
      while (!stopped) {
        let retryMs = 1000;
        try {
          await workforce.computerStream(sessionId, (event) => {
            if (event.kind === "frame") { setFrame(`data:image/jpeg;base64,${event.jpeg}`); setFrameAt(event.at); setNote(""); }
            else if (event.kind === "idle") { setNote(event.reason); retryMs = 5000; }
          }, controller.signal);
        } catch (error) {
          if (controller.signal.aborted) return;
          setNote(message(error));
          retryMs = 5000;
        }
        // The stream ends after a while or when the browser closes: open a new one.
        await new Promise((resolve) => window.setTimeout(resolve, retryMs));
      }
    })();
    return () => { stopped = true; controller.abort(); };
  }, [sessionId]);

  const send = async (input: Parameters<typeof workforce.computerInput>[1]) => {
    try { await workforce.computerInput(sessionId, input); } catch (error) { setNote(message(error)); }
  };
  const point = (event: MouseEvent<HTMLImageElement> | WheelEvent<HTMLImageElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: clamp((event.clientX - rect.left) / rect.width), y: clamp((event.clientY - rect.top) / rect.height) };
  };
  const flushTyping = () => {
    const text = typing.current.text;
    typing.current.text = "";
    if (text) void send({ type: "text", text });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!control || event.metaKey || event.ctrlKey || event.altKey) return;
    const key = KEYS[event.key];
    if (key) {
      event.preventDefault();
      flushTyping();
      void send({ type: "key", key });
    } else if (event.key.length === 1) {
      event.preventDefault();
      typing.current.text += event.key;
      window.clearTimeout(typing.current.timer);
      typing.current.timer = window.setTimeout(flushTyping, 150);
    }
  };
  const onWheel = (event: WheelEvent<HTMLImageElement>) => {
    if (!control) return;
    const at = point(event);
    Object.assign(scrolling.current, { dx: scrolling.current.dx + event.deltaX, dy: scrolling.current.dy + event.deltaY, ...at });
    window.clearTimeout(scrolling.current.timer);
    scrolling.current.timer = window.setTimeout(() => {
      const { dx, dy, x, y } = scrolling.current;
      Object.assign(scrolling.current, { dx: 0, dy: 0 });
      void send({ type: "scroll", x, y, dx: Math.round(dx), dy: Math.round(dy) });
    }, 120);
  };
  const take = async () => {
    setBusy(true);
    try { await workforce.computerHandoff(sessionId, { reason: "You took control in the live view.", instructions: "Use the page, then hand it back." }); onChanged("You have control. The teammate waits until you hand it back."); }
    catch (error) { setNote(message(error)); } finally { setBusy(false); }
  };
  const handBack = async () => {
    setBusy(true);
    flushTyping();
    try { await workforce.computerResume(sessionId); onChanged("Handed back to the teammate."); }
    catch (error) { setNote(message(error)); } finally { setBusy(false); }
  };

  return (
    <section className="mt-3 space-y-2" aria-label="Live view" data-testid="computer-live-view">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-600">{control ? "You have control: click, scroll and type on the page below. The teammate waits until you hand it back. What you type goes straight to the page and isn't stored." : "Watching live. Take control to use the page yourself, for example to finish a verification step."}</p>
        {control
          ? <button type="button" className={primary} disabled={busy} onClick={() => void handBack()} data-testid="live-hand-back"><RotateCcw size={13} /> Hand back</button>
          : <button type="button" className={button} disabled={busy} onClick={() => void take()} data-testid="live-take-control"><Hand size={13} /> Take control</button>}
      </div>
      <div tabIndex={0} onKeyDown={onKeyDown} className={`overflow-hidden rounded-xl border outline-none focus:ring-2 focus:ring-slate-400 ${control ? "border-amber-400" : "border-slate-200"}`} aria-label={control ? "The page. Click it, then type." : "The page, live"}>
        {frame
          ? <img src={frame} alt="The computer's browser, live" draggable={false} className={`block h-auto w-full select-none ${control ? "cursor-pointer" : ""}`} data-testid="live-frame"
            onClick={(event) => { if (control) { event.currentTarget.parentElement?.focus(); void send({ type: "click", ...point(event) }); } }}
            onDoubleClick={(event) => { if (control) void send({ type: "click", double: true, ...point(event) }); }}
            onWheel={onWheel} />
          : <p className="p-6 text-center text-sm text-slate-500">{note || "Waiting for the first frame…"}</p>}
      </div>
      <p className="text-[11px] text-slate-500" role="status">{frame && note ? note : frameAt ? `Live · last frame ${new Date(frameAt).toLocaleTimeString()}` : ""}</p>
    </section>
  );
}
