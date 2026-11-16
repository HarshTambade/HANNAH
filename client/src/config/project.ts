import { IS_WEBSITE, SITE_URL } from "./site";
import { getAppVersion } from "../services/appInfo";

/** The public source repository. Every GitHub link in the app comes from here. */
export const REPOSITORY_URL = "https://github.com/HarshTambade/Shanaya-Your-AI-companion";
export const RELEASES_URL = `${REPOSITORY_URL}/releases`;

/** The version this build was made from, for example "1.3.0". */
export const APP_VERSION = getAppVersion();
export const RELEASE_NOTES_URL = `${RELEASES_URL}/tag/v${APP_VERSION}`;

/**
 * Download link on HANNAH's own domain, for example /download/android. The
 * server (server/downloads.js) redirects it to the newest published release
 * that contains that package, so the download starts directly and older
 * releases' file names still work. Package ids match the server's list.
 * On the website it's a link on the same domain; the apps link to the website.
 */
export type DownloadPackage = "android" | "macos-arm64" | "macos-intel" | "windows" | "linux-appimage" | "linux-deb";
export const downloadUrl = (packageId: DownloadPackage) => `${IS_WEBSITE ? "" : SITE_URL}/download/${packageId}`;

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
        { label: "Apple silicon (M1 and later)", href: downloadUrl("macos-arm64") },
        { label: "Intel", href: downloadUrl("macos-intel") },
      ],
    note: "Not yet notarized by Apple. The first time, Control-click HANNAH in Applications and choose Open.",
  },
  {
    id: "windows",
    name: "Windows",
    files: [{ label: "Installer (64-bit)", href: env.VITE_WINDOWS_DOWNLOAD_URL?.trim() || downloadUrl("windows") }],
    note: "Not yet code-signed, so SmartScreen may warn you. Choose More info, then Run anyway. Uninstall from Settings → Apps.",
  },
  {
    id: "linux",
    name: "Linux",
    files: [
      { label: "AppImage", href: env.VITE_LINUX_DOWNLOAD_URL?.trim() || downloadUrl("linux-appimage") },
      { label: ".deb (Debian, Ubuntu)", href: downloadUrl("linux-deb") },
    ],
    note: "x86-64. Make the AppImage executable (chmod +x) and run it, or install the .deb with your package manager.",
  },
  {
    id: "android",
    name: "Android",
    files: [{ label: "APK", href: env.VITE_ANDROID_DOWNLOAD_URL?.trim() || downloadUrl("android") }],
    note: "Not on Google Play yet. Allow installs from your browser to sideload the APK.",
  },
  {
    id: "ios",
    name: "iPhone and iPad",
    files: env.VITE_IOS_DOWNLOAD_URL?.trim() ? [{ label: "Get it on TestFlight", href: env.VITE_IOS_DOWNLOAD_URL.trim() }] : [],
    note: "Not distributed yet: iOS apps need Apple signing first. Use the web app in Safari, or build from source with Xcode.",
  },
];
