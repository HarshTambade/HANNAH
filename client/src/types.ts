export type Emotion = "happy" | "sad" | "angry" | "neutral" | "surprised" | "thinking";

export type InferenceMode = "cloud" | "webllm" | "ollama" | "native" | "mobileclaw" | "desktop";

export type SpeechLanguage = "en-US" | "hi-IN" | "mr-IN";

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
  /** Stable id for content reporting and list keys. */
  id?: string;
};
