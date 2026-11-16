import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.shanaya.companion",
  appName: "Shanaya",
  webDir: "dist",
  plugins: {
    LiveUpdate: {
      appId: "com.shanaya.companion",
      autoUpdate: true,
      readyTimeout: 10000,
    },
  },
};

export default config;
