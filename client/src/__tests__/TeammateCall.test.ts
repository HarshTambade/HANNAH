import { describe, expect, it } from "vitest";
import { spokenReply, startTeammateCall, type CallDeps, type CallState } from "../services/TeammateCall";
import type { ConversationMessage } from "../services/Workforce";

const msg = (role: ConversationMessage["role"], content: string, data: ConversationMessage["data"] = {}): ConversationMessage => ({ id: `m${Math.random()}`, botId: "b1", taskId: null, replyTo: null, role, kind: "message", content, reactions: [], createdAt: 0, updatedAt: 0, data });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(reply: (content: string) => ConversationMessage[] | Error) {
  const log: string[] = [];
  const states: CallState[] = [];
  let heard: ((text: string, isFinal: boolean) => void) | null = null;
  let timers: Array<{ id: number; callback: () => void }> = [];
  let next = 1;
  const deps: CallDeps = {
    listen: async (onHeard) => { heard = onHeard; log.push("mic on"); return () => { heard = null; log.push("mic off"); }; },
    speak: async (text) => { log.push(`say: ${text}`); },
    stopSpeaking: async () => { log.push("stop speaking"); },
    send: async (content) => { log.push(`send: ${content}`); const result = reply(content); if (result instanceof Error) throw result; return { messages: result }; },
    onState: (state) => { if (states.at(-1) !== state) states.push(state); },
    setTimer: (callback) => { const id = next++; timers.push({ id, callback }); return id; },
    clearTimer: (id) => { timers = timers.filter((timer) => timer.id !== id); },
  };
  const say = (text: string) => heard?.(text, true);
  const pause = async () => { const pending = timers; timers = []; for (const timer of pending) timer.callback(); for (let i = 0; i < 5; i += 1) await tick(); };
  return { deps, log, states, say, pause, micOpen: () => heard !== null };
}

describe("a spoken conversation with a teammate", () => {
  it("listens, sends after a pause, speaks the answer with the mic off, then listens again", async () => {
    const h = harness((content) => [msg("person", content), msg("teammate", "The deploy finished at noon.")]);
    const call = startTeammateCall("Pip", h.deps);
    await tick();
    expect(call.state).toBe("listening");
    h.say("When did");
    h.say("the deploy finish?");
    await h.pause();
    expect(h.log).toEqual(["mic on", "mic off", "send: When did the deploy finish?", "say: The deploy finished at noon.", "mic on"]);
    expect(h.states).toEqual(["listening", "thinking", "speaking", "listening"]);
    expect(h.micOpen()).toBe(true);
    await call.end();
    expect(h.states.at(-1)).toBe("ended");
    expect(h.micOpen()).toBe(false);
  });

  it("ends when the person says goodbye, without sending it", async () => {
    const h = harness(() => [msg("teammate", "x")]);
    startTeammateCall("Pip", h.deps);
    await tick();
    h.say("Okay, end the call.");
    await h.pause();
    expect(h.log.some((line) => line.startsWith("send:"))).toBe(false);
    expect(h.states.at(-1)).toBe("ended");
  });

  it("says why a message didn't go through (a usage limit) and ends", async () => {
    const h = harness(() => new Error("Pip has used its 200 messages for today."));
    startTeammateCall("Pip", h.deps);
    await tick();
    h.say("Hello");
    await h.pause();
    expect(h.log).toContain("say: Pip has used its 200 messages for today.");
    expect(h.states.at(-1)).toBe("ended");
  });

  it("a proposed task is mentioned, never queued by voice; long answers are cut with a pointer to the chat", () => {
    const proposal = { title: "Weekly report", objective: "Write it.", deliverable: "report.md", acceptance: "", status: "proposed" } as never;
    const spoken = spokenReply([msg("person", "write the report"), msg("teammate", "I can write that report.", { proposal }), msg("teammate", "I can write that report.")], "Pip");
    expect(spoken).toBe("I can write that report. I've proposed a task, “Weekly report”. It's in the chat; queue it there if you want it.");
    const long = spokenReply([msg("teammate", `${"This is a sentence. ".repeat(80)}`)], "Pip");
    expect(long.length).toBeLessThan(760);
    expect(long.endsWith("The rest is in the chat.")).toBe(true);
    expect(spokenReply([msg("teammate", "Run:\n```\nnpm test\n```\nthen check.")], "Pip")).toBe("Run: (code is in the chat) then check.");
    expect(spokenReply([msg("system", "Pip is paused.")], "Pip")).toBe("Pip is paused.");
  });
});
