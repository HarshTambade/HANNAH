// Test harness only (loaded with --require into a real HANNAH server started by e2e/media.spec.ts):
// the chat model answers like fake-ai-preload.cjs, and OpenAI's image endpoint returns a small PNG,
// so the browser test exercises the real media route without a real key.
require("./fake-ai-preload.cjs");
const chatFetch = globalThis.fetch;
// A 2x2 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8DwnwEJMDEgAUYGBgAo8QMDuFzCtgAAAABJRU5ErkJggg==";
globalThis.__mediaRequests = [];
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url === "https://api.openai.com/v1/models") {
    return new Response(JSON.stringify({ data: [{ id: "gpt-image-2" }] }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url === "https://api.openai.com/v1/images/generations") {
    globalThis.__mediaRequests.push(JSON.parse(init.body || "{}"));
    return new Response(JSON.stringify({ created: 1, data: [{ b64_json: PNG }] }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return chatFetch(input, init);
};
