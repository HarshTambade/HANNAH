import type { InferenceMode } from "../types";
import { apiFetch, apiUrl } from "./api";
import { coarseInferenceMode, detectPlatform, getAppVersion } from "./appInfo";

export type FeedbackCategory = "bug" | "idea" | "privacy" | "other";

export type FeedbackSubmission = {
  message: string;
  category: FeedbackCategory;
  inferenceMode: InferenceMode;
};

/**
 * Submit only what the feedback schema needs. No IP, account identifier,
 * conversation transcript, device model, or User-Agent is sent from here.
 */
export async function submitFeedback({ message, category, inferenceMode }: FeedbackSubmission) {
  const response = await apiFetch(apiUrl("/api/feedback"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: message.trim(),
      category,
      appVersion: getAppVersion(),
      platform: detectPlatform(),
      inferenceMode: coarseInferenceMode(inferenceMode),
      modeDetail: inferenceMode,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 429) throw new Error("You’ve sent several notes recently. Please wait a moment and try again.");
    if (response.status === 503) throw new Error("Feedback isn’t configured on this server yet. Please try again later.");
    throw new Error(typeof data.error === "string" ? data.error : "Feedback could not be sent. Please try again.");
  }
  return {
    ok: true,
    id: typeof data.id === "string" ? data.id : undefined,
  };
}
