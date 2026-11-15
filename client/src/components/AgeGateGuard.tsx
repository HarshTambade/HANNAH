import { useState } from "react";
import { ShieldAlert } from "lucide-react";

const CONSENT_KEY = "shanaya.ageConsent.v1";

function ageGateEnabled() {
  try {
    return import.meta.env.VITE_AGE_GATE_18_PLUS === "true";
  } catch {
    return false;
  }
}

function hasConsent() {
  try {
    const raw = window.localStorage.getItem(CONSENT_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return Boolean(parsed?.consentedAt);
  } catch {
    return false;
  }
}

function recordConsent() {
  try {
    window.localStorage.setItem(CONSENT_KEY, JSON.stringify({ consentedAt: new Date().toISOString() }));
  } catch {
    // Best effort.
  }
}

type AgeGateGuardProps = {
  children: React.ReactNode;
};

export default function AgeGateGuard({ children }: AgeGateGuardProps) {
  const [consented, setConsented] = useState(() => !ageGateEnabled() || hasConsent());

  if (consented) return <>{children}</>;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#03050b] p-6 text-slate-100">
      <section className="w-full max-w-md rounded-3xl border border-rose-300/20 bg-[#0d111d] p-6 shadow-2xl">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-rose-300/20 bg-rose-300/[0.08] text-rose-200">
            <ShieldAlert size={18} />
          </span>
          <div>
            <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-rose-200/80">Age confirmation</p>
            <h1 className="mt-1 font-['Manrope'] text-xl font-semibold text-white">This app is for adults.</h1>
          </div>
        </div>
        <p className="mt-4 text-[11px] leading-6 text-slate-400">
          Shanaya is declared as an 18+ app. You must confirm that you are at least 18 years old before using chat or voice features.
        </p>
        <button
          type="button"
          onClick={() => {
            recordConsent();
            setConsented(true);
          }}
          className="mt-6 flex w-full items-center justify-center rounded-xl bg-gradient-to-r from-cyan-200 to-violet-300 px-4 py-3 text-[11px] font-bold text-[#090d1a]"
        >
          I am 18 or older
        </button>
        <p className="mt-3 text-[9px] leading-5 text-slate-500">
          Your confirmation timestamp is stored locally on this device. If you are under 18, close this page.
        </p>
      </section>
    </div>
  );
}