// Test harness only (loaded with --require into a real HANNAH server started by e2e/actions.spec.ts):
// calls to api.groq.com get scripted answers for the coding service's three prompts (review, plan, edit),
// so the browser test exercises the real engine, the real git repository and the real test run without a key.
const path = require("node:path");
const { BUG_LINE, FIXED_AVERAGE } = require(path.join(__dirname, "..", "..", "server", "test-fixtures", "seeded-repo.js"));

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (!url.startsWith("https://api.groq.com/")) return realFetch(input, init);
  if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "openai/gpt-oss-120b" }] }), { status: 200, headers: { "content-type": "application/json" } });
  const body = JSON.parse(init.body || "{}");
  const system = body.messages?.find((message) => message.role === "system")?.content || "";
  let content = JSON.stringify({ reply: "ok", emotion: "neutral" });
  if (/reviewing source code/.test(system)) {
    content = JSON.stringify({ findings: [
      { file: "src/math.js", line: 11, evidence: BUG_LINE.trim(), title: "Average divides by one too few", severity: "high", category: "logic", explanation: "The total is divided by the count minus one, so every average is too high.", fix: "Divide by values.length." },
      { file: "src/math.js", line: 2, evidence: "eval(request.body.code)", title: "Invented finding", severity: "critical", category: "security", explanation: "This line is not in the file.", fix: "n/a" },
    ] });
  } else if (/planning a precise change/.test(system)) {
    content = JSON.stringify({ understanding: "Fix average() so it divides by the number of values", rootCause: "average() divides the total by values.length - 1.", approach: "Divide by values.length in src/math.js.", files: [{ path: "src/math.js", change: "Correct the divisor" }], create: [], verify: ["test"], affects: ["POST /orders/average"], risks: [], needsInfo: "" });
  } else if (/making a precise, minimal change/.test(system)) {
    content = `@@@ EDIT src/math.js\n<<<<<<< FIND\n${BUG_LINE}\n=======\n${FIXED_AVERAGE}\n>>>>>>> REPLACE\n@@@ END`;
  }
  return new Response(JSON.stringify({ model: body.model, choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 200, completion_tokens: 100 } }), { status: 200, headers: { "content-type": "application/json" } });
};
