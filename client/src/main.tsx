import React from "react";
import ReactDOM from "react-dom/client";
import * as Sentry from "@sentry/react";
import App from "./App";
import AgeGateGuard from "./components/AgeGateGuard";
import "./index.css";
import { initClientTelemetry } from "./services/telemetry";
import { Diagnostics } from "./services/Diagnostics";
import { initAnalytics } from "./services/analytics";
import PwaUpdatePrompt from "./components/PwaUpdatePrompt";
import DesktopUpdateToast from "./components/DesktopUpdateToast";
import CrashScreen from "./components/CrashScreen";
import { isNativeShell, removeServiceWorkers } from "./services/appShell";

// A DSN-less build is a no-op; the error boundary still protects the app.
initClientTelemetry();
initAnalytics();
// Crashes, uncaught errors, freezes and a start that didn't finish, kept on this device for Settings → Diagnostics.
Diagnostics.install();

// The offline service worker is for the website. The Android, iOS and desktop
// apps already carry their files and update through the store or the desktop
// updater; a worker there would serve the old bundle after an app update (and
// on Android its install fails, because the app shell answers /favicon.ico
// with an empty response). Those apps drop any worker an older version left.
const usesServiceWorker = !isNativeShell();
if (!usesServiceWorker) void removeServiceWorkers();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Sentry.ErrorBoundary fallback={({ error }) => <CrashScreen error={error} />} showDialog={false} onError={(error) => Diagnostics.error("crash", error, "The interface crashed")}>
      <AgeGateGuard>
        <App />
        {usesServiceWorker && <PwaUpdatePrompt />}
        <DesktopUpdateToast />
      </AgeGateGuard>
    </Sentry.ErrorBoundary>
  </React.StrictMode>,
);

// The apps' splash (index.html) fades out once HANNAH has drawn its first
// screen, after at least a moment so it doesn't flash.
const bootSplash = document.getElementById("boot-splash");
if (bootSplash) {
  const hide = () => {
    bootSplash.classList.add("boot-splash-done");
    window.setTimeout(() => bootSplash.remove(), 400);
  };
  requestAnimationFrame(() => window.setTimeout(hide, Math.max(0, 700 - performance.now())));
}
