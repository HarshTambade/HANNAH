import { SpeechService } from "./SpeechService";

export type VoicePipelineResult = { transcript: string; source: "native" | "web" };

export const OnDeviceVoicePipeline = {
  async isNativeAvailable(): Promise<boolean> {
    try {
      return typeof window !== "undefined" && "speechSynthesis" in window;
    } catch {
      return false;
    }
  },
  async transcribe(): Promise<VoicePipelineResult> {
    if (await this.isNativeAvailable()) {
      return { transcript: "", source: "native" };
    }
    return { transcript: "", source: "web" };
  },
  async speak(text: string): Promise<void> {
    if (await this.isNativeAvailable() && typeof window !== "undefined" && "speechSynthesis" in window) {
      const utterance = new SpeechSynthesisUtterance(text);
      window.speechSynthesis.speak(utterance);
      return;
    }
    await SpeechService.speak(text, "en-US");
  },
};