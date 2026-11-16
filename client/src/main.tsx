import React from "react";
import ReactDOM from "react-dom/client";
import * as Sentry from "@sentry/react";
import { Aperture, RotateCcw } from "lucide-react";
import App from "./App";
import AgeGateGuard from "./components/AgeGateGuard";
import "./index.css";
import { initClientTelemetry } from "./services/telemetry";
import { initAnalytics } from "./services/analytics";
import PwaUpdatePrompt from "./components/PwaUpdatePrompt";
import DesktopUpdateToast from "./components/DesktopUpdateToast";

// A DSN-less build is a no-op; the error boundary still protects the app.
initClientTelemetry();
initAnalytics();

function CrashFallback() {
  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-[#080b14] px-5 text-slate-100">
      <section className="w-full max-w-md rounded-3xl border border-white/[0.09] bg-[#0b0e17]/90 p-6 text-center shadow-[0_30px_100px_rgba(0,0,0,0.55)] backdrop-blur-2xl sm:p-8">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-violet-300/20 bg-violet-300/[0.08] text-violet-200">
          <Aperture size={22} strokeWidth={1.7} />
        </span>
        <p className="mt-5 text-[9px] font-bold uppercase tracking-[0.2em] text-cyan-100/70">Shanaya</p>
        <h1 className="mt-2 font-['Manrope'] text-2xl font-semibold tracking-[-0.04em] text-white">A moment of stillness.</h1>
        <p className="mt-3 text-[11px] leading-6 text-slate-400">
          Something interrupted the interface. Your conversation was never stored on a server. Reload to return, or use
          the feedback button once the app is back to tell us what happened.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-6 inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-200 to-violet-300 px-5 text-[11px] font-bold text-[#090d1a] transition hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-100/70"
        >
          <RotateCcw size={14} /> Reload Shanaya
        </button>
      </section>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Sentry.ErrorBoundary fallback={<CrashFallback />} showDialog={false}>
      <AgeGateGuard>
        <App />
        <PwaUpdatePrompt />
        <DesktopUpdateToast />
      </AgeGateGuard>
    </Sentry.ErrorBoundary>
  </React.StrictMode>,
);
