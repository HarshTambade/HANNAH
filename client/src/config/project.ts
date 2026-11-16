import { getAppVersion } from "../services/appInfo";

/** The public source repository. Every GitHub link in the app comes from here. */
export const REPOSITORY_URL = "https://github.com/HarshTambade/Shanaya-Your-AI-companion";
export const RELEASES_URL = `${REPOSITORY_URL}/releases`;

/** The version this build was made from, for example "1.3.0". */
export const APP_VERSION = getAppVersion();
export const RELEASE_NOTES_URL = `${RELEASES_URL}/tag/v${APP_VERSION}`;

/**
 * A file from the newest published release. Names are fixed by the release
 * workflow (.github/workflows/build.yml, "Stage platform installers").
 */
export const latestDownload = (fileName: string) => `${RELEASES_URL}/latest/download/${fileName}`;

export type PlatformDownload = {
  id: "android" | "ios" | "macos" | "windows" | "linux" | "web";
  name: string;
  files: Array<{ label: string; href: string }>;
  /** What the person should know before installing, stated plainly. */
  note: string;
};

const env = import.meta.env;

export const PLATFORM_DOWNLOADS: PlatformDownload[] = [
  {
    id: "web",
    name: "Web",
    files: [],
    note: "Runs in any modern browser and can be installed as an app (PWA). Nothing to download.",
  },
  {
    id: "macos",
    name: "macOS",
    files: env.VITE_MACOS_DOWNLOAD_URL?.trim()
      ? [{ label: "Download for Mac", href: env.VITE_MACOS_DOWNLOAD_URL.trim() }]
      : [
        { label: "Apple silicon (M1 and later)", href: latestDownload("HANNAH-macOS-AppleSilicon.dmg") },
        { label: "Intel", href: latestDownload("HANNAH-macOS-Intel.dmg") },
      ],
    note: "Not yet notarized by Apple. The first time, Control-click HANNAH in Applications and choose Open.",
  },
  {
    id: "windows",
    name: "Windows",
    files: [{ label: "Installer (64-bit)", href: env.VITE_WINDOWS_DOWNLOAD_URL?.trim() || latestDownload("HANNAH-Windows.exe") }],
    note: "Not yet code-signed, so SmartScreen may warn you. Choose More info, then Run anyway. Uninstall from Settings → Apps.",
  },
  {
    id: "linux",
    name: "Linux",
    files: [
      { label: "AppImage", href: env.VITE_LINUX_DOWNLOAD_URL?.trim() || latestDownload("HANNAH-Linux.AppImage") },
      { label: ".deb (Debian, Ubuntu)", href: latestDownload("HANNAH-Linux.deb") },
    ],
    note: "x86-64. Make the AppImage executable (chmod +x) and run it, or install the .deb with your package manager.",
  },
  {
    id: "android",
    name: "Android",
    files: [{ label: "APK", href: env.VITE_ANDROID_DOWNLOAD_URL?.trim() || latestDownload("HANNAH-Android.apk") }],
    note: "Not on Google Play yet. Allow installs from your browser to sideload the APK.",
  },
  {
    id: "ios",
    name: "iPhone and iPad",
    files: env.VITE_IOS_DOWNLOAD_URL?.trim() ? [{ label: "Get it on TestFlight", href: env.VITE_IOS_DOWNLOAD_URL.trim() }] : [],
    note: "Not distributed yet: iOS apps need Apple signing first. Use the web app in Safari, or build from source with Xcode.",
  },
];
