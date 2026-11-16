import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "ai.projecthannah.companion",
  appName: "HANNAH",
  webDir: "../frontend/dist",
  server: {
    androidScheme: "https",
    iosScheme: "capacitor",
  },
  ios: { contentInset: "automatic" },
  android: { allowMixedContent: false },
};

export default config;
