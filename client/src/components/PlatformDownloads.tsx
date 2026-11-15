import { useState } from "react";
import { Download, ExternalLink } from "lucide-react";

const releasesUrl = "https://github.com/HarshTambade/Shanaya---Your-AI-companion-/releases";
const latestAssetUrl = `${releasesUrl}/latest/download`;

const platforms = [
  { name: "Android", packageType: "APK · GitHub Release", href: import.meta.env.VITE_ANDROID_DOWNLOAD_URL?.trim() || `${latestAssetUrl}/Shanaya-Android.apk` },
  { name: "iOS", packageType: "TestFlight / App Store · Apple signing required", href: import.meta.env.VITE_IOS_DOWNLOAD_URL?.trim() || releasesUrl },
  { name: "macOS", packageType: "DMG · GitHub Release", href: import.meta.env.VITE_MACOS_DOWNLOAD_URL?.trim() || `${latestAssetUrl}/Shanaya-macOS.dmg` },
  { name: "Windows", packageType: "EXE · GitHub Release", href: import.meta.env.VITE_WINDOWS_DOWNLOAD_URL?.trim() || `${latestAssetUrl}/Shanaya-Windows.exe` },
  { name: "Linux", packageType: "AppImage · GitHub Release", href: import.meta.env.VITE_LINUX_DOWNLOAD_URL?.trim() || `${latestAssetUrl}/Shanaya-Linux.AppImage` },
];

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
          aria-label="Shanaya downloads by platform"
          className="absolute right-0 top-[calc(100%+0.6rem)] z-50 w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-slate-200 bg-white p-3 shadow-soft-lg"
        >
          <p className="px-2 pb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">Choose your platform</p>
          <div className="space-y-1">
            {platforms.map((platform) => (
              <a
                key={platform.name}
                role="menuitem"
                href={platform.href}
                target="_blank"
                rel="noreferrer"
                onClick={() => setIsOpen(false)}
                className="flex items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 transition hover:border-brand-200 hover:bg-brand-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-200/50"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-ink">Download for {platform.name}</span>
                  <span className="mt-0.5 block truncate text-[10px] text-slate-500">
                    {platform.packageType}
                  </span>
                </span>
                <ExternalLink size={13} className="shrink-0 text-slate-500" />
              </a>
            ))}
          </div>
          <p className="mt-2 border-t border-slate-200 px-2 pt-2 text-[10px] leading-relaxed text-slate-500">
            Android and desktop installers download from the latest GitHub Release. iOS installation requires Apple signing and TestFlight or the App Store. Set a platform URL in the client environment to use a store listing or another installer host.
          </p>
        </div>
      )}
    </div>
  );
}
