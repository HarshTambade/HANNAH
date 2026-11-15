import { describe, expect, it, vi } from "vitest";

vi.mock("@sentry/react", () => ({
  init: vi.fn(),
  captureException: vi.fn(),
}));

import {
  redactSensitiveText,
  sanitizeBreadcrumb,
  sanitizeSentryEvent,
  sanitizeSentryTransaction,
  sanitizeUrl,
} from "../services/telemetry";

describe("client telemetry scrubbers", () => {
  it("redacts provider keys, bearer tokens, and local filesystem paths", () => {
    const input = [
      "Groq gsk_abcdefghijklmnopqrstuvwxyz123456",
      "Anthropic sk-ant-abcdefghijklmnopqrstuvwxyz",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      "model at /Users/anya/models/shanaya.gguf",
      "windows C:\\Users\\anya\\secrets.txt",
    ].join(" ");

    const output = redactSensitiveText(input);
    expect(output).not.toContain("gsk_abcdefghijklmnopqrstuvwxyz123456");
    expect(output).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz");
    expect(output).not.toContain("Bearer abcdefghijklmnopqrstuvwxyz");
    expect(output).not.toContain("/Users/anya");
    expect(output).not.toContain("C:\\Users\\anya");
    expect(output).toContain("<redacted>");
    expect(output).toContain("<file-path>");
  });

  it("strips query data and embedded credentials from URLs", () => {
    const output = sanitizeUrl("https://user:pass@api.example.com/chat?token=secret#fragment");
    expect(output).not.toContain("token");
    expect(output).not.toContain("user");
    expect(output).not.toContain("pass");
    expect(output).not.toContain("fragment");
    expect(output.startsWith("https://api.example.com/chat")).toBe(true);
  });

  it("removes identity, request payloads, and chat text from error events", () => {
    const event = {
      user: { id: "user-1", email: "anya@example.com", ip_address: "203.0.113.9" },
      server_name: "local-mac",
      message: "Failed with gsk_abcdefghijklmnopqrstuvwxyz123456",
      request: {
        url: "https://api.example.com/chat?token=secret",
        data: { messages: [{ role: "user", content: "My private journal" }] },
        cookies: { session: "abc" },
        query_string: "token=secret",
        headers: {
          Authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
          Cookie: "session=abc",
          "Content-Type": "application/json",
          "X-Request-Id": "req-123",
        },
      },
      extra: {
        prompt: "Tell me a secret",
        nested: { reply: "private answer", model: "gpt-oss-120b" },
        accessToken: "opaque-access-token-value",
        userMessage: "My private journal",
        sourceURL: "https://user:pass@api.example.com/chat?token=secret",
      },
      breadcrumbs: [
        { category: "console", message: "user typed a private message", data: { text: "hi" } },
        { category: "navigation", message: "Opened /chat", data: { path: "/chat" } },
      ],
      exception: {
        values: [{
          type: "Error",
          value: "Request failed with Bearer abcdefghijklmnopqrstuvwxyz",
          stacktrace: {
            frames: [{
              filename: "/Users/anya/project/src/App.tsx",
              abs_path: "/Users/anya/project/src/App.tsx",
              lineno: 12,
              vars: { userMessage: "My private journal" },
              context_line: "const key = 'gsk_abcdefghijklmnopqrstuvwxyz123456';",
              pre_context: ["// private source"],
              post_context: ["// private source"],
            }, {
              filename: "https://shanaya.example/assets/main.js?token=secret",
              abs_path: "https://shanaya.example/assets/main.js#x",
              lineno: 3,
            }],
          },
        }],
      },
    };

    const clean = sanitizeSentryEvent(event as unknown as Parameters<typeof sanitizeSentryEvent>[0]);
    expect("user" in clean).toBe(false);
    expect("server_name" in clean).toBe(false);
    expect("data" in (clean.request as object)).toBe(false);
    expect("cookies" in (clean.request as object)).toBe(false);
    expect("query_string" in (clean.request as object)).toBe(false);
    expect(clean.request?.headers?.Authorization).toBeUndefined();
    expect(clean.request?.headers?.Cookie).toBeUndefined();
    expect(clean.request?.headers?.["X-Request-Id"]).toBeUndefined();
    expect(clean.request?.url).not.toContain("token");
    expect(clean.extra?.prompt).toBe("<redacted>");
    expect((clean.extra?.nested as Record<string, unknown>).reply).toBe("<redacted>");
    expect((clean.extra?.nested as Record<string, unknown>).model).toBe("gpt-oss-120b");
    expect(clean.extra?.accessToken).toBe("<redacted>");
    expect(clean.extra?.userMessage).toBe("<redacted>");
    expect(clean.extra?.sourceURL).toBe("https://api.example.com/chat");
    expect(clean.breadcrumbs?.[0].message).toBe("[redacted]");
    expect(clean.breadcrumbs?.[0].data).toBeUndefined();
    expect(clean.exception?.values?.[0].value).not.toContain("abcdefghijklmnopqrstuvwxyz");
    const frame = clean.exception?.values?.[0].stacktrace?.frames?.[0] as { filename: string; abs_path: string };
    expect(frame.filename).toBe("<file-path>/App.tsx");
    expect(frame.abs_path).toBe("<file-path>/App.tsx");
    for (const key of ["vars", "context_line", "pre_context", "post_context"]) {
      expect(key in (frame as unknown as Record<string, unknown>)).toBe(false);
    }
    const bundledFrame = clean.exception?.values?.[0].stacktrace?.frames?.[1] as { filename: string; abs_path: string };
    expect(bundledFrame.filename).toBe("https://shanaya.example/assets/main.js");
    expect(bundledFrame.abs_path).toBe("https://shanaya.example/assets/main.js");
  });

  it("scrubs transaction span descriptions", () => {
    const clean = sanitizeSentryTransaction({
      transaction: "POST /chat",
      spans: [{
        description: "fetch https://api.example.com/chat?key=secret",
        data: {
          prompt: "private ask",
          provider: "groq",
          "http.request.body": "private request body",
          "http.request.header.authorization": "Bearer abcdefghijklmnopqrstuvwxyz",
          "db.statement": "INSERT INTO notes VALUES ('private journal')",
          "db.query.text": "SELECT * FROM notes WHERE body = 'private'",
          "gen_ai.usage.input_tokens": 42,
        },
      }],
    } as unknown as Parameters<typeof sanitizeSentryTransaction>[0]);
    const spans = (clean as unknown as { spans: Array<{ description: string; data: Record<string, unknown> }> }).spans;
    expect(spans[0].description).not.toContain("secret");
    expect(spans[0].data.prompt).toBe("<redacted>");
    expect(spans[0].data.provider).toBe("groq");
    expect(spans[0].data["http.request.body"]).toBe("<redacted>");
    expect(spans[0].data["http.request.header.authorization"]).toBe("<redacted>");
    expect(spans[0].data["db.statement"]).toBe("<redacted>");
    expect(spans[0].data["db.query.text"]).toBe("<redacted>");
    expect(spans[0].data["gen_ai.usage.input_tokens"]).toBe(42);
  });

  it("drops console breadcrumb data and redacts messages", () => {
    const consoleCrumb = sanitizeBreadcrumb({
      category: "console",
      message: "user typed private text",
      data: { text: "private" },
    });
    expect(consoleCrumb.message).toBe("[redacted]");
    expect(consoleCrumb.data).toBeUndefined();

    const navigationCrumb = sanitizeBreadcrumb({
      category: "navigation",
      message: "Opened /chat with Bearer abcdefghijklmnopqrstuvwxyz",
    });
    expect(navigationCrumb.message).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });
});
