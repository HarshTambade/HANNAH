export type HannahOptions = { baseUrl: string; apiKey?: string; groqKey?: string; fetch?: typeof fetch; timeoutMs?: number };
export type ChatMessage = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_call_id?: string; tool_calls?: unknown[] };
export type ChatOptions = { model?: string; system?: string; tools?: unknown[]; temperature?: number; max_tokens?: number; signal?: AbortSignal };
export type ChatResult = { text: string; toolCalls: unknown[]; model: string; usage: Record<string, number | null>; hannah?: Record<string, unknown>; raw: unknown };

export class HannahError extends Error {
  status?: number;
  code?: string;
}

export class Hannah {
  constructor(options: HannahOptions);
  models(): Promise<Array<{ id: string; owned_by: string; hannah?: Record<string, unknown> }>>;
  usage(): Promise<{ day: string; spentUsd: number; capUsd: number | null; remainingUsd: number | null; tight: boolean }>;
  completions(request: Record<string, unknown>): Promise<Record<string, unknown>>;
  chat(input: string | ChatMessage[], options?: ChatOptions): Promise<ChatResult>;
  stream(input: string | ChatMessage[], options?: ChatOptions): AsyncGenerator<string>;
  sendAgentMessage(text: string, options?: { contextId?: string }): Promise<{ text: string; message: unknown }>;
}

export default Hannah;
