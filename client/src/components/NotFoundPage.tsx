import { Compass } from "lucide-react";

/** Shown for any path HANNAH doesn't have, instead of a blank or wrong screen. */
export default function NotFoundPage({ onHome, onChat }: { onHome: () => void; onChat: () => void }) {
  return (
    <main className="deck-shell-bg flex min-h-[100dvh] items-center justify-center px-4 py-12">
      <div className="deck-frame w-full max-w-md">
        <div className="deck-card tone-plain text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-brand-600 shadow-sm"><Compass size={22} aria-hidden="true" /></span>
          <h1 className="display-title mt-4 text-3xl">Page not found</h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-600">
            There's nothing at <span className="font-mono text-ink">{window.location.pathname}</span>. It may have moved, or the link has a typo.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <button type="button" className="btn-primary" onClick={onChat}>Open chat</button>
            <button type="button" className="btn-outline" onClick={onHome}>Go to the home page</button>
          </div>
        </div>
      </div>
    </main>
  );
}
