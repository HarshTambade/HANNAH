/**
 * A conversation with one teammate.
 *
 * Messages, answers, proposed tasks, instructions to running work, reactions
 * and replies are the server's records (`/api/workforce/bots/:id/messages`).
 * A teammate can't act from here: when it proposes work, nothing is queued
 * until the person accepts the proposal. Dictation uses HANNAH's voice service.
 * Talk is a spoken conversation (services/TeammateCall.ts): the same messages,
 * said aloud, with the microphone off while the teammate speaks.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CornerUpLeft, Mic, MicOff, Paperclip, Phone, PhoneOff, Send, Trash2, X } from "lucide-react";
import workforce, { shortTime, type Artifact, type Bot, type ConversationMessage, type ConversationThread } from "../services/Workforce";
import { VoiceService } from "../services/VoiceService";
import { SpeechService } from "../services/SpeechService";
import { startTeammateCall, type CallState } from "../services/TeammateCall";
import type { SpeechLanguage } from "../types";

const button = "inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50";
const primary = "inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50";
const input = "w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900";
const message = (error: unknown) => (error instanceof Error ? error.message : "That didn't work.");

function Proposal({ bot, item, onDone }: { bot: Bot; item: ConversationMessage; onDone: (note: string) => Promise<void> }) {
  const proposal = item.data.proposal!;
  const [title, setTitle] = useState(proposal.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const decide = async (decision: "accept" | "dismiss") => {
    setBusy(true); setError("");
    try {
      const result = await workforce.conversationProposal(bot.id, item.id, decision, decision === "accept" && title.trim() !== proposal.title ? { title: title.trim() } : undefined);
      await onDone(decision === "accept" && result.task ? `Task queued: "${result.task.title}". Follow it in Agent Activity.` : "Proposal dismissed.");
    } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm" data-testid={`proposal-${item.id}`}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Proposed task</p>
      {proposal.status === "proposed"
        ? <input className={`${input} mt-1`} value={title} onChange={(event) => setTitle(event.target.value)} aria-label="Task title" maxLength={160} />
        : <p className="mt-1 font-semibold text-slate-900">{proposal.title}</p>}
      <p className="mt-1 whitespace-pre-wrap text-slate-700">{proposal.objective}</p>
      {proposal.deliverable && <p className="mt-1 text-xs text-slate-500">Deliverable: {proposal.deliverable}</p>}
      {proposal.status === "proposed" ? (
        <div className="mt-2 flex gap-2">
          <button type="button" className={primary} disabled={busy || !title.trim()} onClick={() => void decide("accept")} data-testid={`proposal-accept-${item.id}`}><Check size={14} /> Queue this task</button>
          <button type="button" className={button} disabled={busy} onClick={() => void decide("dismiss")}><X size={14} /> Not now</button>
        </div>
      ) : (
        <p className="mt-2 text-xs font-medium text-slate-600">{proposal.status === "accepted" ? <>Queued. <a className="underline" href="/activity#tasks">Open in Agent Activity</a></> : "Dismissed."}</p>
      )}
      {error && <p className="mt-1 text-xs text-rose-700" role="alert">{error}</p>}
    </div>
  );
}

export default function TeammateChat({ bot }: { bot: Bot }) {
  const [thread, setThread] = useState<ConversationThread | null>(null);
  const [text, setText] = useState("");
  const [taskId, setTaskId] = useState("");
  const [replyTo, setReplyTo] = useState<ConversationMessage | null>(null);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [library, setLibrary] = useState<Artifact[] | null>(null);
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [listening, setListening] = useState(false);
  const [language, setLanguage] = useState<SpeechLanguage>("en-US");
  const stopVoice = useRef<null | (() => void | Promise<void>)>(null);
  const call = useRef<ReturnType<typeof startTeammateCall> | null>(null);
  const [callState, setCallState] = useState<CallState | null>(null);
  const [callHeard, setCallHeard] = useState("");
  const [callSaid, setCallSaid] = useState("");
  const bottom = useRef<HTMLDivElement | null>(null);
  const count = thread?.messages.length ?? 0;

  const load = useCallback(async () => { setThread(await workforce.conversation(bot.id)); }, [bot.id]);
  useEffect(() => {
    void load().catch((e) => setError(message(e)));
    const timer = setInterval(() => void load().catch(() => undefined), 8_000);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [count]);
  useEffect(() => () => { void stopVoice.current?.(); void call.current?.end(); }, []);

  const startCall = () => {
    if (call.current || listening) return;
    setError(""); setNote(""); setCallHeard(""); setCallSaid("");
    call.current = startTeammateCall(bot.name, {
      listen: (onHeard, onError) => VoiceService.startSession(language, onHeard, onError),
      speak: (said) => SpeechService.speak(said, language),
      stopSpeaking: () => SpeechService.cancel(),
      send: async (content) => {
        const result = await workforce.conversationSend(bot.id, { content });
        setThread((current) => (current ? { ...current, messages: [...current.messages, ...result.messages] } : current));
        void load().catch(() => undefined);
        return result;
      },
      onState: (state, detail) => {
        setCallState(state);
        if (detail?.heard !== undefined) setCallHeard(detail.heard);
        if (detail?.said !== undefined) setCallSaid(detail.said);
        if (state === "listening" && detail?.heard === undefined) setCallHeard("");
        if (state === "ended") { call.current = null; if (detail?.error) setError(detail.error); else setNote("Call ended. The conversation is above."); }
      },
    });
  };

  const done = async (text: string) => { setNote(text); setError(""); await load().catch((e) => setError(message(e))); };

  const send = async () => {
    const content = text.trim();
    if (!content || sending) return;
    setSending(true); setError(""); setNote("");
    try {
      const result = await workforce.conversationSend(bot.id, { content, ...(replyTo ? { replyTo: replyTo.id } : {}), ...(taskId ? { taskId } : {}), ...(!taskId && attachments.length ? { attachments } : {}) });
      setText(""); setReplyTo(null); setAttachments([]);
      setThread((current) => (current ? { ...current, messages: [...current.messages, ...result.messages] } : current));
      await load();
    } catch (e) { setError(message(e)); }
    finally { setSending(false); }
  };

  const toggleVoice = async () => {
    if (listening) { await stopVoice.current?.(); stopVoice.current = null; setListening(false); return; }
    setError("");
    try {
      stopVoice.current = await VoiceService.startSession(language, (heard, isFinal) => {
        if (isFinal) setText((current) => `${current}${current && !current.endsWith(" ") ? " " : ""}${heard}`);
      }, (problem) => { setError(problem); setListening(false); });
      setListening(true);
    } catch (e) { setError(message(e)); setListening(false); }
  };

  const openLibrary = async () => {
    if (library) { setLibrary(null); return; }
    try { setLibrary((await workforce.artifacts()).artifacts); } catch (e) { setError(message(e)); }
  };

  const clear = async () => {
    if (!window.confirm(`Delete your conversation with ${bot.name}? Notes it saved to memory stay in Memory.`)) return;
    try { const result = await workforce.conversationClear(bot.id); await done(`Deleted ${result.deleted} messages.`); } catch (e) { setError(message(e)); }
  };

  const byId = new Map((thread?.messages ?? []).map((item) => [item.id, item]));
  const paused = bot.status === "paused";
  const usage = thread?.usage.messages;

  return (
    <section className="mt-3 rounded-2xl border border-slate-200 bg-white" aria-label={`Conversation with ${bot.name}`} data-testid="teammate-chat">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-3 py-2 text-xs text-slate-500">
        <span>{thread?.model.available ? `Answers come from ${thread.model.provider}${thread.model.model ? ` · ${thread.model.model}` : ""}` : thread ? thread.model.reason || "No AI provider is configured." : "Loading…"}</span>
        <span className="flex items-center gap-2">
          {usage && <span>{usage.used} / {usage.limit} messages today</span>}
          <button type="button" onClick={() => void clear()} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-rose-600" aria-label="Delete this conversation" title="Delete this conversation"><Trash2 size={14} /></button>
        </span>
      </div>

      <ol className="max-h-[26rem] space-y-3 overflow-y-auto px-3 py-3" aria-live="polite">
        {thread && !thread.messages.length && <li className="text-sm text-slate-500">Ask {bot.name} something, or ask for work. When it proposes a task, nothing starts until you queue it.</li>}
        {thread?.messages.map((item) => {
          const quoted = item.replyTo ? byId.get(item.replyTo) : null;
          if (item.role === "system") {
            return <li key={item.id} className="text-center text-xs text-slate-500" data-testid={`notice-${item.id}`}>{item.content}</li>;
          }
          const mine = item.role === "person";
          return (
            <li key={item.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${mine ? "bg-slate-900 text-white" : "border border-slate-200 bg-white text-slate-900"}`}>
                {item.kind === "instruction" && <p className={`mb-1 text-[11px] font-semibold ${mine ? "text-slate-300" : "text-slate-500"}`}>Instruction for “{item.data.taskTitle}”</p>}
                {quoted && item.role === "person" && <p className="mb-1 border-l-2 border-slate-500 pl-2 text-xs text-slate-300">{quoted.content.slice(0, 140)}</p>}
                <p className="whitespace-pre-wrap">{item.content}</p>
                {!!item.data.attachments?.length && <p className={`mt-1 text-xs ${mine ? "text-slate-300" : "text-slate-500"}`}>Attached: {item.data.attachments.map((file) => file.name).join(", ")}</p>}
                {item.data.proposal && <Proposal bot={bot} item={item} onDone={done} />}
                {!!item.data.remembered?.length && <p className="mt-1 text-xs text-emerald-700">Saved to {bot.name}'s memory: {item.data.remembered.map((entry) => entry.content).join("; ")}</p>}
                {item.data.memoryRefused?.includes("secret-refused") && <p className="mt-1 text-xs text-amber-700">Not saved: it looked like a credential. Use the Secure Vault for those.</p>}
                {item.data.memoryRefused?.includes("scope-not-allowed") && <p className="mt-1 text-xs text-amber-700">Not saved: this teammate isn't allowed private memory.</p>}
                {item.data.unparsed && <p className="mt-1 text-xs text-amber-700">The answer wasn't in the expected format, so it's shown as written.</p>}
                <div className={`mt-1 flex flex-wrap items-center gap-2 text-[11px] ${mine ? "text-slate-400" : "text-slate-500"}`}>
                  <span>{shortTime(item.createdAt)}</span>
                  {!mine && item.data.context && (item.data.context.memoryIds.length > 0 || item.data.context.attachmentIds.length > 0) && (
                    <span title="What this answer was based on">used {item.data.context.memoryIds.length} memor{item.data.context.memoryIds.length === 1 ? "y" : "ies"}{item.data.context.attachmentIds.length ? `, ${item.data.context.attachmentIds.length} file${item.data.context.attachmentIds.length === 1 ? "" : "s"}` : ""}</span>
                  )}
                  {!mine && (thread.reactions || []).map((emoji) => (
                    <button key={emoji} type="button" onClick={() => void workforce.conversationReact(bot.id, item.id, emoji).then(() => load()).catch((e) => setError(message(e)))}
                      className={`rounded-full px-1.5 ${item.reactions.includes(emoji) ? "bg-slate-200" : "opacity-50 hover:opacity-100"}`} aria-pressed={item.reactions.includes(emoji)} aria-label={`React ${emoji}`}>{emoji}</button>
                  ))}
                  {!mine && <button type="button" onClick={() => setReplyTo(item)} className="inline-flex items-center gap-0.5 hover:text-slate-900" aria-label="Reply to this message"><CornerUpLeft size={11} /> Reply</button>}
                </div>
              </div>
            </li>
          );
        })}
        {sending && <li className="text-xs text-slate-500">{bot.name} is answering…</li>}
        <div ref={bottom} />
      </ol>

      {callState && callState !== "ended" && (
        <div className="border-t border-slate-100 bg-slate-50 px-3 py-2 text-sm" role="region" aria-label={`Talking with ${bot.name}`} data-testid="teammate-call">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-medium text-slate-800" aria-live="polite">{callState === "starting" ? "Starting the microphone…" : callState === "listening" ? "Listening… pause when you're done." : callState === "thinking" ? `${bot.name} is thinking…` : `${bot.name} is speaking.`}</p>
            <div className="flex gap-1.5">
              {callState === "listening" && callHeard && <button type="button" className={button} onClick={() => void call.current?.sendNow()}>Send now</button>}
              {callState === "speaking" && <button type="button" className={button} onClick={() => void call.current?.interrupt()}>Skip</button>}
              <button type="button" className={primary} onClick={() => void call.current?.end()} data-testid="chat-end-call"><PhoneOff size={14} /> End</button>
            </div>
          </div>
          {callHeard && <p className="mt-1 text-xs text-slate-600">You: {callHeard}</p>}
          {callState === "speaking" && callSaid && <p className="mt-1 text-xs text-slate-600">{bot.name}: {callSaid}</p>}
          <p className="mt-1 text-[11px] text-slate-500">The microphone is off while {bot.name} speaks. Say “end call” to hang up. Proposed tasks wait in the chat for you to queue.</p>
        </div>
      )}

      <form className="border-t border-slate-100 p-3" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        {replyTo && <p className="mb-2 flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-2 py-1 text-xs text-slate-600"><span className="truncate">Replying to: {replyTo.content.slice(0, 120)}</span><button type="button" onClick={() => setReplyTo(null)} aria-label="Cancel reply"><X size={12} /></button></p>}
        {!!thread?.openTasks.length && (
          <label className="mb-2 block text-xs text-slate-600">Send as
            <select className={`${input} mt-1`} value={taskId} onChange={(event) => setTaskId(event.target.value)} data-testid="chat-target">
              <option value="">A message to {bot.name}</option>
              {thread.openTasks.map((task) => <option key={task.id} value={task.id}>An instruction for “{task.title}” ({task.status})</option>)}
            </select>
          </label>
        )}
        <textarea className={`${input} min-h-[4.5rem]`} value={text} onChange={(event) => setText(event.target.value)} disabled={paused}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }}
          placeholder={paused ? `${bot.name} is paused. Resume it to talk.` : taskId ? "What should change in this task?" : `Message ${bot.name}`} aria-label={`Message ${bot.name}`} data-testid="chat-input" maxLength={taskId ? 2000 : 8000} />
        {library && !taskId && (
          <div className="mt-2 max-h-36 overflow-y-auto rounded-lg border border-slate-200 p-2 text-sm">
            {library.length ? library.slice(0, 40).map((artifact) => (
              <label key={artifact.id} className="flex items-center gap-2 py-0.5">
                <input type="checkbox" checked={attachments.includes(artifact.id)} disabled={!attachments.includes(artifact.id) && attachments.length >= 5}
                  onChange={() => setAttachments((list) => (list.includes(artifact.id) ? list.filter((value) => value !== artifact.id) : [...list, artifact.id]))} />
                <span className="truncate">{artifact.name}</span><span className="text-xs text-slate-500">{artifact.type}</span>
              </label>
            )) : <p className="text-xs text-slate-500">No artifacts yet. Add files in the Artifact Library.</p>}
          </div>
        )}
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            {!taskId && <button type="button" className={button} onClick={() => void openLibrary()} aria-pressed={Boolean(library)}><Paperclip size={14} /> {attachments.length ? `${attachments.length} attached` : "Attach"}</button>}
            <button type="button" className={button} onClick={startCall} disabled={paused || listening || Boolean(callState && callState !== "ended")} data-testid="chat-talk"><Phone size={14} /> Talk</button>
            <button type="button" className={button} onClick={() => void toggleVoice()} disabled={paused || Boolean(callState && callState !== "ended")} aria-pressed={listening}>{listening ? <MicOff size={14} /> : <Mic size={14} />} {listening ? "Stop" : "Dictate"}</button>
            <select className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs" value={language} onChange={(event) => setLanguage(event.target.value as SpeechLanguage)} aria-label="Dictation language" disabled={listening}>
              <option value="en-US">English</option><option value="hi-IN">हिन्दी</option><option value="mr-IN">मराठी</option>
            </select>
          </div>
          <button type="submit" className={primary} disabled={sending || paused || !text.trim()} data-testid="chat-send"><Send size={14} /> {taskId ? "Send instruction" : "Send"}</button>
        </div>
        {note && <p className="mt-2 text-xs text-emerald-700" role="status">{note}</p>}
        {error && <p className="mt-2 text-xs text-rose-700" role="alert">{error}</p>}
      </form>
    </section>
  );
}
