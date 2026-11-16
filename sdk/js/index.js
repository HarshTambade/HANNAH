/**
 * HANNAH SDK: a dependency-free client for HANNAH's /v1 API (OpenAI-compatible)
 * and its A2A endpoint. Works in Node 18+, Deno, Bun and browsers.
 *
 *   import { Hannah } from "@hannah/sdk";
 *   const hannah = new Hannah({ baseUrl: "https://your-hannah.example", apiKey: "hk_…" });
 *   const { text } = await hannah.chat("Plan my week");
 *   for await (const piece of hannah.stream("Tell me a story")) process.stdout.write(piece);
 *
 * Credentials: a developer API key (hk_…, from Settings → Account), the
 * operator's access token, or your own Groq key via { groqKey }.
 */

export class HannahError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "HannahError";
    this.status = status;
    this.code = code;
  }
}

export class Hannah {
  constructor({ baseUrl, apiKey, groqKey, fetch: fetchImpl, timeoutMs = 60_000 } = {}) {
    if (!baseUrl) throw new HannahError("baseUrl is required, for example https://your-hannah.example");
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.groqKey = groqKey;
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
    this.timeoutMs = timeoutMs;
  }

  headers(extra = {}) {
    return {
      "Content-Type": "application/json",
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      ...(this.groqKey ? { "X-Groq-API-Key": this.groqKey } : {}),
      ...extra,
    };
  }

  async request(path, { method = "GET", body, headers, signal } = {}) {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(headers),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal || AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new HannahError(data?.error?.message || data?.error || `HANNAH returned HTTP ${response.status}.`, { status: response.status, code: data?.error?.code || data?.code });
    }
    return response;
  }

  /** GET /v1/models */
  async models() {
    return (await (await this.request("/v1/models")).json()).data;
  }

  /** GET /v1/usage: today's estimated spend and budget for this credential. */
  async usage() {
    return (await this.request("/v1/usage")).json();
  }

  /** POST /v1/chat/completions with the full OpenAI request shape. */
  async completions(request) {
    return (await this.request("/v1/chat/completions", { method: "POST", body: { model: "hannah-auto", ...request, stream: false } })).json();
  }

  /** One message (or a message list) in, text out. */
  async chat(input, { model = "hannah-auto", system, ...rest } = {}) {
    const messages = typeof input === "string" ? [{ role: "user", content: input }] : input;
    const result = await this.completions({ model, messages: system ? [{ role: "system", content: system }, ...messages] : messages, ...rest });
    const choice = result.choices?.[0]?.message || {};
    return { text: choice.content || "", toolCalls: choice.tool_calls || [], model: result.model, usage: result.usage, hannah: result.hannah, raw: result };
  }

  /** Stream text deltas over SSE. */
  async *stream(input, { model = "hannah-auto", system, signal, ...rest } = {}) {
    const messages = typeof input === "string" ? [{ role: "user", content: input }] : input;
    const response = await this.request("/v1/chat/completions", { method: "POST", signal, body: { model, messages: system ? [{ role: "system", content: system }, ...messages] : messages, ...rest, stream: true } });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const event = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
        if (!data || data === "[DONE]") continue;
        const chunk = JSON.parse(data);
        if (chunk.error) throw new HannahError(chunk.error.message, { code: chunk.error.code });
        const piece = chunk.choices?.[0]?.delta?.content;
        if (piece) yield piece;
      }
    }
  }

  /** A2A message/send: talk to HANNAH as another agent. */
  async sendAgentMessage(text, { contextId } = {}) {
    const response = await this.request("/api/a2a", {
      method: "POST",
      body: { jsonrpc: "2.0", id: Date.now(), method: "message/send", params: { message: { role: "user", messageId: globalThis.crypto?.randomUUID?.() || String(Date.now()), ...(contextId ? { contextId } : {}), parts: [{ kind: "text", text }] } } },
    });
    const data = await response.json();
    if (data.error) throw new HannahError(data.error.message, { code: data.error.code });
    return { text: (data.result?.parts || []).filter((part) => part.kind === "text").map((part) => part.text).join("\n"), message: data.result };
  }
}

export default Hannah;
