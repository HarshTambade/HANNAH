import { apiFetch, apiUrl, isLocalDevelopmentHost } from "./api";
import { CommunitySkills } from "./CommunitySkills";
import type { HANNAHTool } from "./DeviceTools";
import type { InferenceMode } from "../types";
import { resolveInferenceMode, getNetworkStatus } from "./AIService";
import { ChaosEngine } from "./ChaosEngine";
import type { PersonalizationContext } from "./DynamicFewShotInjector";
import { routingRequest } from "./ModelRouting";

export type AgentMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
};

export type AgentToolCall = { id: string; name: string; arguments: Record<string, unknown> };
export type AgentStepMeta = { provider?: string; model?: string; inputTokens?: number; outputTokens?: number };
export type AgentStep = { content: string; toolCalls: AgentToolCall[]; meta?: AgentStepMeta };

function configuredPythonFallback() {
  const configured = import.meta.env.VITE_PYTHON_FALLBACK_URL?.trim().replace(/\/+$/, "");
  if (!configured) return isLocalDevelopmentHost() ? "http://127.0.0.1:8000" : "";
  // A loopback fallback only makes sense when the app itself runs locally;
  // from a hosted site it would just add a confusing second error.
  try {
    const host = new URL(configured).hostname;
    if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(host) && !isLocalDevelopmentHost()) return "";
  } catch {
    return "";
  }
  return configured;
}

export class AgentApiError extends Error {
  /** Set for a provider's rate limit: how long to wait before retrying. */
  retryAfterMs?: number;
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "AgentApiError";
  }
}

/** Optional daily spending cap set in Settings; the server enforces it. */
export const DAILY_BUDGET_KEY = "hannah.budget.dailyUsd";
function dailyBudgetUsd() {
  try {
    const value = Number(window.localStorage.getItem(DAILY_BUDGET_KEY));
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function normalizeStep(data: any): AgentStep {
  const message = data.message && typeof data.message === "object" ? data.message : {};
  const textContent = typeof message.content === "string" ? message.content : "";
  const providerCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const promptCalls = providerCalls.length ? [] : parsePromptToolCalls(textContent);
  const calls: any[] = providerCalls.length ? providerCalls : promptCalls.map((call: any) => ({
    id: typeof call?.id === "string" ? call.id : undefined,
    function: { name: call?.name, arguments: call?.arguments },
  }));
  const usage = data.usage && typeof data.usage === "object" ? data.usage : {};
  const meta: AgentStepMeta = {
    ...(typeof data.provider === "string" ? { provider: data.provider } : {}),
    ...(typeof data.model === "string" ? { model: data.model } : {}),
    ...(Number.isFinite(usage.inputTokens) ? { inputTokens: usage.inputTokens } : {}),
    ...(Number.isFinite(usage.outputTokens) ? { outputTokens: usage.outputTokens } : {}),
  };
  return {
    content: promptCalls.length ? "" : textContent,
    meta,
    toolCalls: calls.map((call: any) => {
      const fn = call?.function ?? {};
      let args: Record<string, unknown> = {};
      try {
        const parsed = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : fn.arguments;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed;
        else if (parsed !== undefined && parsed !== null) throw new Error("Arguments must be a JSON object.");
      } catch {
        throw new Error(`The model returned invalid arguments for ${String(fn.name ?? "a tool")}.`);
      }
      const id = typeof call?.id === "string" ? call.id : `tool-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
      return { id, name: String(fn.name ?? ""), arguments: args };
    }),
  };
}

/** How long to wait before trying again when the provider says it's busy (429). Exported for tests. */
export function rateLimitWaitMs(retryAfter: string | null, attempt: number) {
  const seconds = Number(retryAfter);
  return (Number.isFinite(seconds) && seconds > 0 ? Math.min(60, seconds) : 10 * (attempt + 1)) * 1000;
}

/** A timeout that also ends when `signal` (Stop) fires. */
function withStop(timeoutMs: number, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([timeout, signal]);
  const controller = new AbortController();
  const abort = (source: AbortSignal) => controller.abort(source.reason);
  if (signal.aborted) abort(signal);
  signal.addEventListener("abort", () => abort(signal), { once: true });
  timeout.addEventListener("abort", () => abort(timeout), { once: true });
  return controller.signal;
}

async function requestAgentStep(url: string, body: Record<string, unknown>, timeoutMs = 90_000, groqApiKey?: string, useApiToken = false, stop?: AbortSignal): Promise<AgentStep> {
  // A busy provider (429) is waited out a few times, so a long task (such as
  // notes from a lecture) isn't lost to a per-minute limit.
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await requestAgentStepOnce(url, body, timeoutMs, groqApiKey, useApiToken, stop);
    } catch (error) {
      if (stop?.aborted || !(error instanceof AgentApiError) || error.status !== 429 || attempt >= 3 || !error.retryAfterMs) throw error;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, error.retryAfterMs);
        stop?.addEventListener("abort", () => { clearTimeout(timer); resolve(undefined); }, { once: true });
      });
      if (stop?.aborted) throw error;
    }
  }
}

async function requestAgentStepOnce(url: string, body: Record<string, unknown>, timeoutMs: number, groqApiKey?: string, useApiToken = false, stop?: AbortSignal): Promise<AgentStep> {
  let response: Response;
  try {
    const request = useApiToken ? apiFetch : fetch;
    response = await request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(groqApiKey ? { "X-Groq-API-Key": groqApiKey } : {}),
      },
      body: JSON.stringify(body),
      signal: withStop(timeoutMs, stop),
    });
  } catch (error) {
    if (stop?.aborted) throw error;
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    let endpointLabel = "the configured server";
    try {
      const target = new URL(url, window.location.href);
      endpointLabel = `${target.origin}${target.pathname}`;
    } catch {
      // Do not echo malformed URLs or query parameters into the chat error.
    }
    throw new AgentApiError(
      timedOut
        ? "The AI request timed out while waiting for the configured provider. Check the API server and provider connection."
        : isLocalDevelopmentHost()
          ? `Could not reach the AI API at ${endpointLabel}. Start the server with npm run dev from the project root.`
          : "Could not reach the HANNAH server. Check your internet connection and try again.",
      timedOut ? 408 : undefined,
    );
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof data.error === "string" ? data.error : typeof data.detail === "string" ? data.detail : "The agent service could not complete the request.";
    const error = new AgentApiError(message, response.status);
    // Only a provider's rate limit is retried, not HANNAH's own request cap.
    if (response.status === 429 && data.code === "rate_limited") error.retryAfterMs = rateLimitWaitMs(response.headers.get("retry-after"), 0);
    throw error;
  }
  if (!data.message || typeof data.message !== "object") throw new AgentApiError("The agent service returned an invalid response.");
  return normalizeStep(data);
}

function shouldUsePythonFallback(error: unknown) {
  if (!(error instanceof AgentApiError)) return true;
  return error.status === undefined || error.status === 404 || error.status === 408 || error.status === 429 || (error.status ?? 0) >= 500;
}

export function shouldUseLocalFallback(error: unknown) {
  return shouldUsePythonFallback(error);
}

function parsePromptToolCalls(content: string): unknown[] {
  const text = content.trim().replace(/^```(?:[a-z0-9_-]+)?\s*/i, "").replace(/\s*```$/, "");
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}" && --depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, index + 1));
          return Array.isArray(parsed?.toolCalls) ? parsed.toolCalls : [];
        } catch {
          break;
        }
      }
    }
  }
  return [];
}

export type RoutingDecision = { useOnDevice: boolean; reason: string };

export class LLMRouter {
  static logRoutingDecision(decision: RoutingDecision) {
    try {
      console.info("[LLMRouter]", decision.useOnDevice ? "on-device" : "cloud", decision.reason);
    } catch {
      // Best effort.
    }
  }

  static routeTask(prompt: string): RoutingDecision {
    const text = prompt.toLowerCase();
    if (/research|compare|analyze|large context|code generation|refactor/.test(text)) {
      return { useOnDevice: false, reason: "complex reasoning or code generation beyond on-device threshold" };
    }
    if (/weather|status|battery|hello|how are you|simple/.test(text)) {
      return { useOnDevice: true, reason: "everyday task suitable for on-device model" };
    }
    return { useOnDevice: true, reason: "default to on-device for emotional chat and simple Q&A" };
  }
  static async resolveMode(preferred: InferenceMode, browserConnected: boolean) {
    if (!browserConnected) return resolveInferenceMode(preferred, false);
    const network = await getNetworkStatus().catch(() => ({ connected: browserConnected }));
    return resolveInferenceMode(preferred, browserConnected && network.connected);
  }

  static async requestStep(mode: Extract<InferenceMode, "cloud" | "ollama">, messages: AgentMessage[], tools: HANNAHTool[], model?: string, groqApiKey?: string, providerId = "groq", marketplaceItemIds: string[] = [], personalization?: PersonalizationContext, memories: string[] = [], extra: { routeHint?: "simple" | "standard" | "complex"; signal?: AbortSignal } = {}): Promise<AgentStep> {
    if (mode === "cloud" && ChaosEngine.consume("network-drop")) {
      ChaosEngine.setDegraded("Offline: cloud request dropped; switching to local AI.");
      throw new Error("Chaos injection: simulated cloud network drop.");
    }
    const selectedProvider = mode === "ollama" ? "ollama" : providerId;
    const body = {
      mode,
      provider: selectedProvider,
      // Ollama gets the model picked on the Models page; without one the server uses its OLLAMA_MODEL.
      ...(model && (mode === "cloud" || model !== "auto") ? { model } : {}),
      ...(mode === "cloud" && model === "auto" && extra.routeHint ? { routeHint: extra.routeHint } : {}),
      // Auto: HANNAH chooses across your providers within your routing mode (Private stays self-hosted).
      ...(mode === "cloud" && model === "auto" ? { routing: routingRequest() } : {}),
      ...(marketplaceItemIds.length ? { marketplaceItemIds } : {}),
      ...(personalization ? { personalization } : {}),
      ...(memories.length ? { memories } : {}),
      ...(dailyBudgetUsd() ? { budget: { dailyUsd: dailyBudgetUsd() } } : {}),
      ...(CommunitySkills.runtimeSkills().length ? { communitySkills: CommunitySkills.runtimeSkills() } : {}),
      messages,
      tools: tools.map(({ name, description, inputSchema }) => ({ type: "function", function: { name, description, parameters: inputSchema } })),
    };
    try {
      // A visitor's Groq key goes along for Auto too; the server only ever uses it with Groq.
      const result = await requestAgentStep(apiUrl("/api/agent"), body, 90_000, mode === "cloud" && (selectedProvider === "groq" || model === "auto") ? groqApiKey : undefined, true, extra.signal);
      if (mode === "cloud") ChaosEngine.clearDegraded();
      return result;
    } catch (primaryError) {
      const fallbackBase = configuredPythonFallback();
      if (extra.signal?.aborted || !fallbackBase || mode !== "cloud" || selectedProvider !== "groq" || groqApiKey || !shouldUsePythonFallback(primaryError)) throw primaryError;
      // If the connection dropped during the cloud request, let AgentRuntime
      // switch straight to WebLLM/llama.cpp instead of waiting on an unreachable
      // Python endpoint. A reachable local Python service still gets its cold-load budget.
      const network = await getNetworkStatus().catch(() => ({ connected: typeof navigator === "undefined" || navigator.onLine }));
      if (!network.connected) throw primaryError;
      try {
        // The Python route may cold-load a local llama.cpp model, so give it a longer budget.
        const fallbackStep = await requestAgentStep(`${fallbackBase}/api/agent/step`, body, 45_000);
        ChaosEngine.setDegraded("Degraded mode: the local Python agent fallback answered this turn.");
        return fallbackStep;
      } catch (fallbackError) {
        const primaryMessage = primaryError instanceof Error ? primaryError.message : "The primary Node API failed.";
        const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : "The Python fallback API failed.";
        const retryable = shouldUseLocalFallback(primaryError) || shouldUseLocalFallback(fallbackError);
        const status = retryable ? 503 : fallbackError instanceof AgentApiError ? fallbackError.status : undefined;
        throw new AgentApiError(`${primaryMessage} Python fallback: ${fallbackMessage}`, status);
      }
    }
  }
}
