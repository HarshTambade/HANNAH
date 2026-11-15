import { Capacitor } from "@capacitor/core";
import type { InferenceMode } from "../types";
import { getDesktopBridge } from "./DesktopBridge";

export type FeedbackPlatform = "iOS" | "Android" | "Web" | "Desktop";

export function getAppVersion(): string {
  if (typeof __SHANAYA_APP_VERSION__ === "string" && __SHANAYA_APP_VERSION__.trim()) {
    return __SHANAYA_APP_VERSION__.trim();
  }
  return import.meta.env.VITE_APP_VERSION?.trim() || "1.0.0";
}

export function detectPlatform(): FeedbackPlatform {
  const platform = Capacitor.getPlatform();
  if (platform === "ios") return "iOS";
  if (platform === "android") return "Android";
  if (platform === "electron" || getDesktopBridge()) return "Desktop";
  return "Web";
}

/** Collapse the six runtime modes into the two values the feedback schema stores. */
export function coarseInferenceMode(mode: InferenceMode): "Cloud" | "Local" {
  return mode === "cloud" || mode === "mobileclaw" || mode === "desktop" ? "Cloud" : "Local";
}
