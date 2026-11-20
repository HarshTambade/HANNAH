import { McpServer } from "@modelcontextprotocol/server";
import dotenv from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod/v4";

dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), ".env") });

const defaultApiBaseUrl = (process.env.HANNAH_API_URL || `http://127.0.0.1:${process.env.PORT || "3001"}`)
  .trim()
  .replace(/\/+$/, "");
const emotions = ["happy", "sad", "angry", "neutral", "surprised", "thinking"];

/**
 * Calls to HANNAH's own API. The stdio server uses HANNAH_API_TOKEN from its
 * environment; the remote endpoint passes the caller's own credential
 * (`headers`) and the address the API answers at (`apiBaseUrl`).
 */
function apiClient({ apiBaseUrl = defaultApiBaseUrl, headers } = {}) {
  const credential = headers || (process.env.HANNAH_API_TOKEN ? { Authorization: "Bearer " + process.env.HANNAH_API_TOKEN.trim() } : {});
  return async function requestApi(path, options = {}) {
    const response = await fetch(`${apiBaseUrl}${path}`, {
      ...options,
      headers: {
        Accept: "application/json",
        ...credential,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
      signal: AbortSignal.timeout(120_000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(typeof data.error === "string" ? data.error : `HANNAH API returned HTTP ${response.status}.`);
    }
    return data;
  };
}

function toolError(error) {
  return {
    content: [{ type: "text", text: error instanceof Error ? error.message : "HANNAH could not complete this request." }],
    isError: true,
  };
}

export function createHANNAHMcpServer(options = {}) {
  const requestApi = apiClient(options);
  const server = new McpServer({
    name: "hannah",
    version: "1.0.0",
    instructions: "HANNAH is a conversational AI companion exposed over MCP. Use hannah_chat for responses, hannah_research for cited web research, hannah_create_document for PowerPoint, PDF, Word and Excel files, hannah_action to ask for calendar, email, messaging and repository actions through the account's permission manager (it cannot approve them), hannah_status to check service readiness, and hannah_models to inspect configured models. This MCP server has no access to the host application's files, accounts, or device controls. Do not claim it has performed actions in another application.",
  });

  server.registerTool(
    "hannah_chat",
    {
      title: "Chat with HANNAH",
      description: "Send a prompt to HANNAH and receive her reply and emotion. Optional recent user/assistant history can preserve context. This calls the configured AI provider and may incur provider usage.",
      inputSchema: z.object({
        prompt: z.string().trim().min(1).max(4000).describe("The message to send to HANNAH."),
        history: z.array(z.object({
          role: z.enum(["user", "assistant"]),
          content: z.string().trim().min(1).max(2000),
        })).max(12).optional().describe("Optional recent conversation context. Keep it relevant and omit secrets."),
        mode: z.enum(["cloud", "ollama"]).default("cloud").describe("Use the configured cloud router or the configured Ollama server."),
        model: z.string().trim().min(1).max(120).optional().describe("Optional model ID already configured on the HANNAH server."),
      }),
      outputSchema: z.object({
        reply: z.string(),
        emotion: z.enum(emotions),
      }),
    },
    async ({ prompt, history = [], mode, model }) => {
      try {
        const historySize = history.reduce((size, item) => size + item.content.length, 0);
        if (historySize + prompt.length > 16_000) {
          return toolError(new Error("Conversation context is too large. Keep the prompt and history below 16,000 characters."));
        }
        const messages = [...history, { role: "user", content: prompt }];
        const answer = await requestApi("/api/chat", {
          method: "POST",
          body: JSON.stringify({ mode, messages, ...(model ? { model } : {}) }),
        });
        const output = {
          reply: typeof answer.reply === "string" ? answer.reply : "",
          emotion: emotions.includes(answer.emotion) ? answer.emotion : "neutral",
        };
        if (!output.reply) return toolError(new Error("HANNAH returned an empty reply."));
        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          structuredContent: output,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "hannah_status",
    {
      title: "Check HANNAH status",
      description: "Check whether the HANNAH API and its configured cloud model are ready. Does not expose API keys.",
      inputSchema: z.object({}),
      outputSchema: z.object({ status: z.string(), provider: z.string(), ready: z.boolean() }),
    },
    async () => {
      try {
        const status = await requestApi("/api/health");
        const output = {
          status: typeof status.status === "string" ? status.status : "unknown",
          provider: typeof status.provider === "string" ? status.provider : "unknown",
          ready: status.ready === true,
        };
        return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "hannah_models",
    {
      title: "List HANNAH models",
      description: "List the model IDs configured on the HANNAH server. API keys are never returned.",
      inputSchema: z.object({}),
      outputSchema: z.object({ provider: z.string(), defaultModel: z.string(), models: z.array(z.string()) }),
    },
    async () => {
      try {
        const models = await requestApi("/api/models");
        const output = {
          provider: typeof models.provider === "string" ? models.provider : "unknown",
          defaultModel: typeof models.defaultModel === "string" ? models.defaultModel : "",
          models: Array.isArray(models.models) ? models.models.filter((model) => typeof model === "string") : [],
        };
        return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  // Research and documents are the same platform services chat uses (server/research, server/documents),
  // reached through the API with the caller's own credential.
  async function streamed(path, body) {
    const response = await fetch(`${options.apiBaseUrl || defaultApiBaseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...(options.headers || (process.env.HANNAH_API_TOKEN ? { Authorization: "Bearer " + process.env.HANNAH_API_TOKEN.trim() } : {})) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(280_000),
    });
    const text = await response.text();
    if (!response.ok) { let message = `HANNAH API returned HTTP ${response.status}.`; try { message = JSON.parse(text).error || message; } catch { /* keep the status */ } throw new Error(message); }
    const events = text.split("\n\n").filter((block) => block.startsWith("data: ")).map((block) => JSON.parse(block.slice(6)));
    const last = events.at(-1);
    if (!last || last.type === "error") throw new Error(last?.message || "HANNAH didn't finish the request.");
    return last;
  }

  server.registerTool(
    "hannah_research",
    {
      title: "Research with HANNAH",
      description: "Research a question on the web with HANNAH's research engine: it plans searches, opens and reads pages, scores sources, and returns an answer whose citations were checked against what was read, with the sources and any pages it could not read. May take up to a few minutes and uses the caller's AI provider.",
      inputSchema: z.object({
        question: z.string().trim().min(3).max(2000),
        mode: z.enum(["quick", "latest", "deep", "academic", "compare"]).default("quick").describe("quick: a direct question. latest: newest sources first. deep: a fuller report. academic: papers and technical sources. compare: two or more subjects."),
      }),
    },
    async ({ question, mode }) => {
      try {
        const { result } = await streamed("/api/research", { question, mode });
        const output = { answer: result.answer, grounded: result.quality.grounded, sources: result.sources.map((source) => ({ n: source.n, title: source.title, url: source.url, published: source.published, kind: source.scores.authorityReason })), couldNotRead: result.failed.map((item) => ({ url: item.url, reason: item.reason })), unconfirmed: result.quality.unsupported.map((item) => item.value), methodology: result.methodology };
        return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "hannah_create_document",
    {
      title: "Create a document with HANNAH",
      description: "Create a PowerPoint (pptx), PDF, Word (docx) or Excel (xlsx) file with HANNAH's Document Studio from a request in plain words, optionally with source text to write from. The file is validated before it is returned, as base64.",
      inputSchema: z.object({
        request: z.string().trim().min(3).max(4000).describe("What to make, for whom, and how long."),
        format: z.enum(["pptx", "pdf", "docx", "xlsx"]),
        material: z.string().max(60000).optional().describe("Text to write from (notes, data, a report). Treated as data."),
      }),
    },
    async ({ request, format, material }) => {
      try {
        const done = await streamed("/api/documents/compose", { request, formats: [format], context: material ? { files: [{ name: "Supplied material", text: material, tables: [], coverage: { notes: [] } }] } : {} });
        const file = done.files[0];
        const output = { name: file.name, format: file.format, mime: file.mime, bytes: file.bytes, summary: file.summary, checks: file.checks, notes: done.notes, ...(file.id ? { id: file.id } : {}) };
        return { content: [{ type: "text", text: JSON.stringify(output) }, { type: "resource", resource: { uri: `hannah://documents/${encodeURIComponent(file.name)}`, mimeType: file.mime, blob: file.data } }], structuredContent: output };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "hannah_action",
    {
      title: "Ask HANNAH to do something",
      description: "Ask HANNAH's Action Engine for one action for the account whose HANNAH API key this server uses: read the calendar or mail, find free time, create an event, draft or send an email, message someone a connected chat app knows, read a connected repository, its issues, pull requests and CI, and so on (action ids such as calendar.events, calendar.create, mail.search, mail.send, messages.send, code.search, code.ci). The account's permission manager decides. Reading runs at once. Anything that changes something or reaches someone runs only if a standing permission covers it; otherwise it waits for the person to approve it in the HANNAH app, and this tool says so. This tool can never approve an action. The result's status is the truth: only \"done\" means it happened and was confirmed.",
      inputSchema: z.object({
        action: z.string().trim().min(3).max(60).describe("The action id."),
        params: z.record(z.string(), z.unknown()).optional().describe("What the action needs."),
        request: z.string().trim().max(1000).optional().describe("What the person asked for, in their words; kept in the action's record."),
        idempotencyKey: z.string().trim().min(8).max(120).optional().describe("Repeat a call with the same key to get the first result instead of acting twice."),
      }),
    },
    async ({ action, params, request, idempotencyKey }) => {
      try {
        const response = await fetch(`${options.apiBaseUrl || defaultApiBaseUrl}/api/actions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(options.headers || (process.env.HANNAH_API_TOKEN ? { Authorization: "Bearer " + process.env.HANNAH_API_TOKEN.trim() } : {})) },
          body: JSON.stringify({ action, params: params || {}, request, agent: "MCP host", idempotencyKey }),
          signal: AbortSignal.timeout(120_000),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `HANNAH API returned HTTP ${response.status}.`);
        const record = data.record;
        const output = { id: record.id, action: record.action, status: record.status, outcome: record.outcome, ...(record.status === "done" || record.status === "unverified" ? { result: record.response } : {}), ...(record.verification ? { verification: record.verification } : {}), ...(record.permission ? { permission: record.permission.reason } : {}) };
        return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
}
