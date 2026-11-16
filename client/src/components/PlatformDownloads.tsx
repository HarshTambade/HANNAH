import { useState } from "react";
import { Download, ExternalLink } from "lucide-react";
import { APP_VERSION, PLATFORM_DOWNLOADS, RELEASES_URL } from "../config/project";

export default function PlatformDownloads() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="pointer-events-auto relative">
      <button
        type="button"
        aria-expanded={isOpen}
        aria-controls="platform-download-menu"
        onClick={() => setIsOpen((open) => !open)}
        className="flex items-center gap-2 rounded-xl border border-brand-200 bg-brand-50 px-3 py-2.5 text-xs font-semibold text-brand-600 shadow-soft transition hover:border-brand-300 hover:bg-brand-100"
      >
        <Download size={14} />
        <span>Downloads</span>
      </button>

      {isOpen && (
        <div
          id="platform-download-menu"
          role="menu"
          aria-label="HANNAH downloads by platform"
          className="absolute right-0 top-[calc(100%+0.6rem)] z-50 w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-slate-200 bg-white p-3 shadow-soft-lg"
        >
          <p className="px-2 pb-2 text-[11px] font-semibold text-slate-500">HANNAH {APP_VERSION}</p>
          <div className="space-y-1">
            {PLATFORM_DOWNLOADS.filter((platform) => platform.files.length).flatMap((platform) => platform.files.map((file) => (
              <a
                key={file.href}
                role="menuitem"
                href={file.href}
                onClick={() => setIsOpen(false)}
                className="flex items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 transition hover:border-brand-200 hover:bg-brand-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-200/50"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-ink">{platform.name}</span>
                  <span className="mt-0.5 block truncate text-[11px] text-slate-500">{file.label}</span>
                </span>
                <Download size={13} className="shrink-0 text-slate-500" />
              </a>
            )))}
          </div>
          <a href={RELEASES_URL} target="_blank" rel="noreferrer" className="mt-2 flex items-center gap-1.5 border-t border-slate-200 px-2 pt-2 text-[11px] text-slate-500 hover:text-ink">
            All releases and install notes <ExternalLink size={11} />
          </a>
        </div>
      )}
    </div>
  );
}
