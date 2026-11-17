// Test harness only (loaded with --require into a real HANNAH server started by e2e/workflows.spec.ts):
// calls to api.groq.com get a deterministic local answer, so browser tests exercise the real engine without a real key.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (!url.startsWith("https://api.groq.com/")) return realFetch(input, init);
  if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "openai/gpt-oss-120b" }] }), { status: 200, headers: { "content-type": "application/json" } });
  const body = JSON.parse(init.body || "{}");
  const prompt = body.messages?.find((message) => message.role === "user")?.content || "";
  const fields = /Fields: \{/.test(prompt);
  const content = fields
    ? JSON.stringify({ vendor: /from ([A-Z][\w&]+)/.exec(prompt)?.[1] ?? null, amount: Number(/total ([\d.]+)/i.exec(prompt)?.[1]) || null, date: /(\d{4}-\d{2}-\d{2})/.exec(prompt)?.[1] ?? null, invoiceNumber: null })
    : `Reviewed: ${prompt.replace(/\s+/g, " ").slice(0, 80)}`;
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }], usage: { prompt_tokens: 12, completion_tokens: 8 } }), { status: 200, headers: { "content-type": "application/json" } });
};
