import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.hannah.companion",
  appName: "HANNAH",
  webDir: "dist",
  plugins: {
    LiveUpdate: {
      appId: "com.hannah.companion",
      autoUpdate: true,
      readyTimeout: 10000,
    },
  },
};

export default config;
