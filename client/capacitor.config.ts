import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.hannah.companion",
  appName: "HANNAH",
  webDir: "dist",
  plugins: {
    // Edge-to-edge on Android 15+: the app draws behind the system bars and pads
    // itself with env(safe-area-inset-*) (index.html uses viewport-fit=cover).
    // "LIGHT" gives dark status-bar icons, readable on HANNAH's light interface.
    SystemBars: {
      insetsHandling: "css",
      initialViewportFitValueHint: "cover",
      style: "LIGHT",
    },
    LiveUpdate: {
      appId: "com.hannah.companion",
      autoUpdate: true,
      readyTimeout: 10000,
    },
  },
};

export default config;
