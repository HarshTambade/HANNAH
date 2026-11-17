import { useState } from "react";
import { Aperture, ClipboardCopy, Download, LogOut, RotateCcw } from "lucide-react";
import { Diagnostics, describeError } from "../services/Diagnostics";
import { clearApiSession } from "../services/api";
import { getAppVersion } from "../services/appInfo";

/**
 * What the interface shows when a screen crashes. It says what went wrong in
 * one line (secrets removed), and offers the ways out: reload, copy the
 * details or export diagnostics to send with feedback, or disconnect and
 * start again when the crash happens right after connecting.
 */
export default function CrashScreen({ error }: { error: unknown }) {
  const [copied, setCopied] = useState(false);
  const described = describeError(error);
  const details = [`HANNAH ${getAppVersion()}`, described.message, described.detail ?? ""].filter(Boolean).join("\n");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(details);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const exportDiagnostics = () => {
    const blob = new Blob([JSON.stringify(Diagnostics.report(), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `hannah-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const disconnect = () => {
    clearApiSession();
    window.location.reload();
  };

  const button = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-[11px] font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-100/70";

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-[#080b14] px-5 text-slate-100">
      <section className="w-full max-w-md rounded-3xl border border-white/[0.09] bg-[#0b0e17]/90 p-6 text-center shadow-[0_30px_100px_rgba(0,0,0,0.55)] backdrop-blur-2xl sm:p-8" aria-labelledby="crash-title">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-violet-300/20 bg-violet-300/[0.08] text-violet-200">
          <Aperture size={22} strokeWidth={1.7} />
        </span>
        <p className="mt-5 text-[9px] font-bold uppercase tracking-[0.2em] text-cyan-100/70">HANNAH</p>
        <h1 id="crash-title" className="mt-2 font-['Manrope'] text-2xl font-semibold tracking-[-0.04em] text-white">A moment of stillness.</h1>
        <p className="mt-3 text-[11px] leading-6 text-slate-400">
          Something interrupted the interface. Your conversation was never stored on a server. Reload to return; if it happens again, copy the details or export diagnostics and send them with feedback.
        </p>
        <p className="mt-4 break-words rounded-xl border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-left font-mono text-[11px] leading-5 text-rose-200" aria-label="Error details">{described.message}</p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <button type="button" onClick={() => window.location.reload()} className={`${button} bg-gradient-to-r from-cyan-200 to-violet-300 px-5 text-[#090d1a] hover:brightness-105`}>
            <RotateCcw size={14} /> Reload HANNAH
          </button>
          <button type="button" onClick={() => void copy()} className={`${button} border border-white/[0.12] text-slate-200 hover:bg-white/[0.06]`}>
            <ClipboardCopy size={14} /> {copied ? "Copied" : "Copy details"}
          </button>
          <button type="button" onClick={exportDiagnostics} className={`${button} border border-white/[0.12] text-slate-200 hover:bg-white/[0.06]`}>
            <Download size={14} /> Export diagnostics
          </button>
          <button type="button" onClick={disconnect} className={`${button} text-slate-400 hover:text-rose-200`}>
            <LogOut size={14} /> Disconnect and reload
          </button>
        </div>
      </section>
    </main>
  );
}
