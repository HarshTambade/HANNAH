import { expect, test, type Page } from "@playwright/test";

/**
 * Code execution in chat (client/src/services/CodeRunner.ts): code runs in a
 * Web Worker in this browser. The AI server is a stand-in; the sandbox is real.
 * The Python test downloads Pyodide (~10 MB) from jsDelivr, so it runs only
 * with E2E_PYODIDE=1.
 */
const groqKey = "gsk_e2eCodeRunKey0123456789abcdefghijklmnop";
type AgentBody = { messages?: Array<{ role: string; content?: string; tool_call_id?: string }>; tools?: Array<{ name?: string; function?: { name?: string } }> };

async function chat(page: Page, replies: Array<(body: AgentBody) => Record<string, unknown>>) {
  const bodies: AgentBody[] = [];
  await page.route(/\/(api|v1)\//, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/health") return route.fulfill({ json: { status: "ok", provider: "Groq", ready: true } });
    if (path === "/api/providers") return route.fulfill({ json: { defaultProvider: "groq", providers: [{ id: "groq", label: "Groq", local: false, configured: true }] } });
    if (path === "/api/models") return route.fulfill({ json: { provider: "Groq", defaultModel: "openai/gpt-oss-120b", models: ["openai/gpt-oss-120b"] } });
    if (path === "/api/agent") {
      const body = (request.postDataJSON?.() ?? {}) as AgentBody;
      bodies.push(body);
      const reply = replies[Math.min(bodies.length - 1, replies.length - 1)];
      return route.fulfill({ json: { message: reply(body) } });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.addInitScript((key) => { sessionStorage.setItem("hannah.session.groqKey", key); localStorage.setItem("hannah.onboarding.v1", "complete"); }, groqKey);
  await page.goto("/chat");
  await expect(page.getByRole("textbox", { name: "Message HANNAH" })).toBeVisible();
  return bodies;
}
const send = async (page: Page, text: string) => { await page.getByRole("textbox", { name: "Message HANNAH" }).fill(text); await page.getByRole("button", { name: "Send message" }).click(); };
const say = (reply: string) => () => ({ content: JSON.stringify({ reply, emotion: "happy" }), tool_calls: [] });

test("Run on a JavaScript block in a reply shows its output, and the sandbox has no network", async ({ page }) => {
  const fence = "```";
  await chat(page, [say(`Here you go:\n\n${fence}js\nconst total = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].reduce((a, b) => a + b, 0);\nconsole.log("total", total);\ntotal * 2\n${fence}\n\nAnd a request:\n\n${fence}javascript\nawait fetch("https://example.com/");\n${fence}`)]);
  await send(page, "Show me some JavaScript");
  const blocks = page.getByTestId("code-block");
  await expect(blocks).toHaveCount(2);

  await blocks.nth(0).getByRole("button", { name: "Run this JavaScript code" }).click();
  const output = blocks.nth(0).getByTestId("code-output");
  await expect(output).toContainText("total 55");
  await expect(output).toContainText("110");
  await expect(blocks.nth(0).getByRole("button", { name: "Run this JavaScript code" })).toHaveText(/Run again/);

  await blocks.nth(1).getByRole("button", { name: "Run this JavaScript code" }).click();
  await expect(blocks.nth(1).getByTestId("code-output")).toContainText(/fetch is blocked in HANNAH's code sandbox/);
});

test("HANNAH runs code with run_code, reads the result, and the reply shows the code and its output", async ({ page }) => {
  const bodies = await chat(page, [
    (body) => {
      const names = (body.tools ?? []).map((tool) => tool.name ?? tool.function?.name);
      if (!names.includes("run_code")) return { content: JSON.stringify({ reply: `run_code was not offered: ${names.join(", ")}`, emotion: "sad" }), tool_calls: [] };
      return { content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "run_code", arguments: JSON.stringify({ language: "javascript", code: "let n = 1n;\nfor (let i = 1n; i <= 20n; i++) n *= i;\nconsole.log(n.toString());" }) } }] };
    },
    (body) => {
      const tool = [...(body.messages ?? [])].reverse().find((message) => message.role === "tool");
      return { content: JSON.stringify({ reply: `20! is ${/2432902008176640000/.test(tool?.content ?? "") ? "2432902008176640000" : "unknown"}.`, emotion: "happy" }), tool_calls: [] };
    },
  ]);
  await send(page, "Use JavaScript to calculate 20 factorial exactly");
  await expect(page.getByText("20! is 2432902008176640000.")).toBeVisible();
  const ran = page.getByTestId("code-block").filter({ hasText: "Code HANNAH ran" });
  await expect(ran).toBeVisible();
  await expect(ran.getByTestId("code-output")).toContainText("2432902008176640000");
  expect(bodies).toHaveLength(2);
});

test("Python runs in the browser with numpy and matplotlib, without network access", async ({ page }) => {
  test.skip(!process.env.E2E_PYODIDE, "Downloads Pyodide from jsDelivr; set E2E_PYODIDE=1 to run.");
  test.setTimeout(240_000);
  const fence = "```";
  await chat(page, [say(`${fence}python\nimport numpy as np\nimport matplotlib.pyplot as plt\nvalues = np.arange(1, 11)\nprint("sum", values.sum())\nplt.plot(values, values ** 2)\nvalues.mean()\n${fence}\n\n${fence}python\nimport js\nawait js.fetch("https://example.com/")\n${fence}`)]);
  await send(page, "Plot some squares in Python");
  const blocks = page.getByTestId("code-block");
  await blocks.nth(0).getByRole("button", { name: "Run this Python code" }).click();
  const output = blocks.nth(0).getByTestId("code-output");
  await expect(output).toContainText("sum 55", { timeout: 200_000 });
  await expect(output).toContainText("5.5");
  await expect(output.getByRole("img", { name: "Chart 1 made by the code" })).toBeVisible();

  await blocks.nth(1).getByRole("button", { name: "Run this Python code" }).click();
  await expect(blocks.nth(1).getByTestId("code-output")).toContainText(/blocked/, { timeout: 60_000 });
});
