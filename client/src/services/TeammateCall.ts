/**
 * A spoken conversation with a teammate: listen, send what the person said to
 * the teammate's conversation, say the answer, listen again.
 *
 * It is half-duplex on purpose: the microphone is off while the answer is
 * spoken, so the teammate never hears itself. The messages are ordinary
 * conversation messages, with the same usage limits and memory rules. A
 * proposed task is never queued by voice: the call says it's in the chat,
 * where the person queues it with a tap.
 */
import type { ConversationMessage } from "./Workforce";

export type CallState = "starting" | "listening" | "thinking" | "speaking" | "ended";

export type CallDeps = {
  /** Start listening; final pieces of speech arrive through `onFinal`. Returns a stop function. */
  listen: (onHeard: (text: string, isFinal: boolean) => void, onError: (message: string) => void) => Promise<() => void | Promise<void>>;
  speak: (text: string) => Promise<unknown>;
  stopSpeaking: () => Promise<unknown>;
  send: (content: string) => Promise<{ messages: ConversationMessage[] }>;
  onState: (state: CallState, detail?: { heard?: string; said?: string; error?: string }) => void;
  /** How long a pause ends what the person is saying. */
  pauseMs?: number;
  setTimer?: (callback: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
};

const SPOKEN_LIMIT = 700;
const GOODBYE = /^(?:ok(?:ay)?[, ]+)?(?:end (?:the )?call|hang up|goodbye|bye(?: bye)?|that's all|stop the call)[.! ]*$/i;

/** What to say for a teammate's answer: short enough to listen to, and honest about what's only in the chat. */
export function spokenReply(messages: ConversationMessage[], teammate: string): string {
  const reply = [...messages].reverse().find((item) => item.role === "teammate");
  const notice = [...messages].reverse().find((item) => item.role === "system");
  if (!reply) return notice?.content || `${teammate} didn't answer.`;
  let text = reply.content.replace(/```[\s\S]*?```/g, " (code is in the chat) ").replace(/[*_#>`]/g, "").replace(/\s+/g, " ").trim();
  if (text.length > SPOKEN_LIMIT) {
    const cut = text.slice(0, SPOKEN_LIMIT);
    text = `${cut.slice(0, Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), 200) + 1)} The rest is in the chat.`;
  }
  const proposal = messages.find((item) => item.data?.proposal?.status === "proposed")?.data.proposal;
  if (proposal) text = `${text} I've proposed a task, “${proposal.title}”. It's in the chat; queue it there if you want it.`;
  return text || `${teammate} answered in the chat.`;
}

export function startTeammateCall(teammate: string, deps: CallDeps) {
  const setTimer = deps.setTimer ?? ((callback, ms) => window.setTimeout(callback, ms));
  const clearTimer = deps.clearTimer ?? ((id) => window.clearTimeout(id));
  const pauseMs = deps.pauseMs ?? 1300;
  let state: CallState = "starting";
  let stopListening: null | (() => void | Promise<void>) = null;
  let heard = "";
  let timer = 0;
  let ended = false;

  const set = (next: CallState, detail?: { heard?: string; said?: string; error?: string }) => { state = next; deps.onState(next, detail); };

  const stopMic = async () => {
    const stop = stopListening;
    stopListening = null;
    if (stop) await Promise.resolve(stop()).catch(() => undefined);
  };

  const end = async (error?: string) => {
    if (ended) return;
    ended = true;
    clearTimer(timer);
    await stopMic();
    await deps.stopSpeaking().catch(() => undefined);
    set("ended", error ? { error } : undefined);
  };

  const listen = async () => {
    if (ended) return;
    heard = "";
    try {
      stopListening = await deps.listen((text, isFinal) => {
        if (ended || state !== "listening") return;
        if (!isFinal) { clearTimer(timer); return; }
        heard = `${heard}${heard ? " " : ""}${text.trim()}`.trim();
        deps.onState("listening", { heard });
        clearTimer(timer);
        timer = setTimer(() => void finishTurn(), pauseMs);
      }, (message) => void end(message));
      if (ended) { await stopMic(); return; }
      set("listening");
    } catch (error) {
      await end(error instanceof Error ? error.message : "The microphone didn't start.");
    }
  };

  const finishTurn = async () => {
    const content = heard.trim();
    if (ended || state !== "listening" || !content) return;
    await stopMic();
    if (GOODBYE.test(content)) { await end(); return; }
    set("thinking", { heard: content });
    let said: string;
    try {
      said = spokenReply((await deps.send(content)).messages, teammate);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The message didn't go through.";
      set("speaking", { said: message });
      await deps.speak(message).catch(() => undefined);
      await end(message);
      return;
    }
    if (ended) return;
    set("speaking", { said });
    await deps.speak(said).catch(() => undefined);
    await listen();
  };

  void listen();
  return {
    end: () => end(),
    /** Stop listening now and send what was heard, without waiting for the pause. */
    sendNow: () => { clearTimer(timer); return finishTurn(); },
    /** Cut the spoken answer short and listen again. */
    interrupt: async () => { if (state === "speaking") await deps.stopSpeaking().catch(() => undefined); },
    get state() { return state; },
  };
}
