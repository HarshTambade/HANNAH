# HANNAH JavaScript SDK

A small, dependency-free client for HANNAH's OpenAI-compatible `/v1` API and its A2A endpoint. It runs in Node 18+, Deno, Bun and browsers.

```js
import { Hannah } from "@hannah/sdk";

const hannah = new Hannah({ baseUrl: "https://your-hannah.example", apiKey: process.env.HANNAH_API_KEY });

const { text, model } = await hannah.chat("Plan my week in three bullet points");
for await (const piece of hannah.stream("Tell me a short story")) process.stdout.write(piece);
console.log(await hannah.usage());
```

Credentials:

- `apiKey`: a developer key (`hk_…`) from **Settings → Account → Developer API keys**, or the operator's access token.
- `groqKey`: your own Groq key, sent as `X-Groq-API-Key`. It's forwarded only to Groq.

Errors throw `HannahError` with `status` and `code` (for example `budget_exceeded` or `rate_limited`).

Any OpenAI SDK also works against `/v1`. Set the base URL to `https://your-hannah.example/v1` and use `hannah-auto` or `provider/model` as the model.

The package isn't published to npm. Copy `sdk/js` into your project, or install it from a path (`npm install ./sdk/js`).
