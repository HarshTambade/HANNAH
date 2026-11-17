import ConnectPanel from "./ConnectPanel";
import { APP_VERSION } from "../config/project";

/**
 * The first screen of the desktop and mobile apps (the website shows its
 * landing page instead). Same look as the splash screen, then straight to
 * connecting; once connected, the apps open on chat.
 */
export default function AppWelcome({ onStart }: { onStart: (credentials: { apiToken: string; groqApiKey: string }) => void }) {
  return (
    <main className="app-welcome relative flex min-h-[100dvh] flex-col items-center overflow-y-auto px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(2.5rem,env(safe-area-inset-top))]">
      <div className="flex flex-col items-center text-center">
        <svg viewBox="0 0 512 512" className="h-16 w-16" aria-hidden="true">
          <defs>
            <linearGradient id="welcome-a" gradientUnits="userSpaceOnUse" x1="256" y1="106" x2="406" y2="256"><stop offset="0" stopColor="#4f8ff0" /><stop offset="1" stopColor="#8be3f2" /></linearGradient>
            <linearGradient id="welcome-b" gradientUnits="userSpaceOnUse" x1="406" y1="256" x2="256" y2="406"><stop offset="0" stopColor="#8be3f2" /><stop offset="1" stopColor="#f7e27a" /></linearGradient>
            <linearGradient id="welcome-c" gradientUnits="userSpaceOnUse" x1="256" y1="406" x2="106" y2="256"><stop offset="0" stopColor="#f7e27a" /><stop offset="1" stopColor="#f4a9c0" /></linearGradient>
            <linearGradient id="welcome-d" gradientUnits="userSpaceOnUse" x1="106" y1="256" x2="256" y2="106"><stop offset="0" stopColor="#f4a9c0" /><stop offset="1" stopColor="#4f8ff0" /></linearGradient>
          </defs>
          <g fill="none" strokeWidth="78">
            <path d="M256 106a150 150 0 0 1 150 150" stroke="url(#welcome-a)" />
            <path d="M406 256a150 150 0 0 1-150 150" stroke="url(#welcome-b)" />
            <path d="M256 406a150 150 0 0 1-150-150" stroke="url(#welcome-c)" />
            <path d="M106 256a150 150 0 0 1 150-150" stroke="url(#welcome-d)" />
          </g>
        </svg>
        <h1 className="mt-4 text-2xl font-semibold tracking-[0.2em] text-white">HANNAH</h1>
        <p className="mt-1 text-sm text-slate-400">Your Personal AI</p>
      </div>
      <div className="deck-frame mt-8 w-full max-w-md">
        <ConnectPanel onStart={onStart} />
      </div>
      <p className="mt-auto pt-6 text-[11px] text-slate-500">Version {APP_VERSION}</p>
    </main>
  );
}
