export type Modality = "image" | "audio" | "sensor";

const CONSENT_KEY = "hannah.perception.consent";

export const PerceptionService = {
  consent: {} as Record<Modality, boolean>,
  loadConsent() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(CONSENT_KEY) || "{}");
      this.consent = { image: false, audio: false, sensor: false, ...parsed };
    } catch {
      this.consent = { image: false, audio: false, sensor: false };
    }
  },
  setConsent(modality: Modality, value: boolean) {
    this.loadConsent();
    this.consent[modality] = value;
    try {
      window.localStorage.setItem(CONSENT_KEY, JSON.stringify(this.consent));
    } catch {
      // Best effort.
    }
  },
  async processImage(_file: File) {
    this.loadConsent();
    if (!this.consent.image) throw new Error("Image perception not consented.");
    return { tags: ["image"], source: "perceived context" };
  },
  async processAudio(_blob: Blob) {
    this.loadConsent();
    if (!this.consent.audio) throw new Error("Audio perception not consented.");
    return { transcript: "", source: "perceived context" };
  },
  logItem(item: string) {
    try {
      const key = "hannah.perception.log";
      const parsed = JSON.parse(window.localStorage.getItem(key) || "[]");
      const entries = Array.isArray(parsed) ? parsed : [];
      entries.push({ item, at: Date.now() });
      window.localStorage.setItem(key, JSON.stringify(entries.slice(-100)));
    } catch {
      // Best effort.
    }
  },
};