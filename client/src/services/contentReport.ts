import type { InferenceMode } from "../types";
import { apiFetch, apiUrl } from "./api";
import { coarseInferenceMode, detectPlatform, getAppVersion } from "./appInfo";

export type ContentReportReason = "harmful" | "sexual" | "misinformation" | "other";

export type ContentReportSubmission = {
  messageId: string;
  reason: ContentReportReason;
  inferenceMode: InferenceMode;
};

export const CONTENT_REPORT_REASONS: Array<{ id: ContentReportReason; label: string; detail: string }> = [
  { id: "harmful", label: "Harmful or dangerous", detail: "Violence, self-harm, or instructions for harm." },
  { id: "sexual", label: "Sexual content", detail: "Sexual content involving minors or non-consensual content." },
  { id: "misinformation", label: "Misleading", detail: "False or deceptive claims presented as fact." },
  { id: "other", label: "Something else", detail: "Another safety or quality concern." },
];

const REPORTED_KEY = "hannah.reportedContent.v1";
const MAX_REMEMBERED_REPORTS = 250;

function readReportedIds(): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(REPORTED_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

export function wasContentReported(messageId: string): boolean {
  return readReportedIds().includes(messageId);
}

function rememberReportedId(messageId: string): void {
  try {
    const next = [messageId, ...readReportedIds().filter((id) => id !== messageId)].slice(0, MAX_REMEMBERED_REPORTS);
    window.localStorage.setItem(REPORTED_KEY, JSON.stringify(next));
  } catch {
    // The report already reached the server; deduplication is best effort.
  }
}

/**
 * Report an assistant message for safety review.
 *
 * Only the message id, reason, app version, platform, and coarse inference
 * mode are sent. The message text never leaves the device through this path,
 * and the server appends the report to a metadata-only JSONL audit file.
 */
export async function reportAIContent({ messageId, reason, inferenceMode }: ContentReportSubmission) {
  const response = await apiFetch(apiUrl("/api/report-content"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messageId,
      reason,
      appVersion: getAppVersion(),
      platform: detectPlatform(),
      inferenceMode: coarseInferenceMode(inferenceMode),
      modeDetail: inferenceMode,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 429) throw new Error("You’ve sent several reports recently. Please wait before reporting again.");
    if (response.status === 503) throw new Error("Content reporting is not configured on this server.");
    throw new Error(typeof data.error === "string" ? data.error : "The report could not be sent. Please try again.");
  }
  rememberReportedId(messageId);
  return {
    ok: true,
    id: typeof data.id === "string" ? data.id : undefined,
  };
}
