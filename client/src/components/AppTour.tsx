import { useRef, useState, type KeyboardEvent } from "react";
import { Bot, Check, Cpu, MessagesSquare, PlugZap, Workflow } from "lucide-react";

/** A tour of real HANNAH screens (captured from this release), one tab per screen. */
const stops = [
  {
    id: "chat",
    label: "Chat",
    icon: MessagesSquare,
    path: "/chat",
    image: "/screens/chat.webp",
    alt: "HANNAH's chat screen: the 3D avatar beside the conversation, with the chosen model shown above the message box.",
    title: "Talk, type or call",
    points: ["The 3D avatar reacts to the mood of every reply", "See which model HANNAH picked, and why, before you send", "Voice in English, Hindi and Marathi, and you can interrupt"],
  },
  {
    id: "models",
    label: "Models",
    icon: Cpu,
    path: "/models",
    image: "/screens/models.webp",
    alt: "HANNAH's Models screen: your device, what you need, and recommended models with their trade-offs.",
    title: "The right model for you",
    points: ["Recommendations for your task, budget and hardware", "Local models that fit your memory, with the KV cache counted", "One click to use a model in chat"],
  },
  {
    id: "automations",
    label: "Automations",
    icon: Workflow,
    path: "/automations",
    image: "/screens/automations.webp",
    alt: "HANNAH's Automations screen: editing a Morning plan routine that runs on weekdays at 08:00, with an Ask HANNAH step and an output step.",
    title: "Routines that run themselves",
    points: ["Pick the days and time, or every few hours", "Steps run in order, each using the last result", "Start from a template; actions wait for your approval"],
  },
  {
    id: "agents",
    label: "Agents",
    icon: Bot,
    path: "/agents",
    image: "/screens/agents.webp",
    alt: "HANNAH's Agents screen: research, coding, memory and tasks specialists with the tools each may use.",
    title: "A team when you need one",
    points: ["Research, Coding, Memory and Tasks specialists", "Pick a model for each, or let Auto decide", "Every tool goes through the Guardian and your approval"],
  },
  {
    id: "integrations",
    label: "Integrations",
    icon: PlugZap,
    path: "/integrations",
    image: "/screens/integrations.webp",
    alt: "HANNAH's Integrations guide: REST and OpenAI-compatible APIs, MCP, A2A and webhooks.",
    title: "Connect it to everything",
    points: ["OpenAI-compatible API, MCP server and client, A2A", "Signed webhooks for reminders, teams and budgets", "Your own Postgres, Supabase, Neon or SQLite database"],
  },
] as const;

export default function AppTour({ version }: { version: string }) {
  const [active, setActive] = useState(0);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const stop = stops[active];
  const host = typeof window === "undefined" ? "hannah" : window.location.host || "hannah";

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    let next = active;
    if (event.key in keys) next = (active + keys[event.key] + stops.length) % stops.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = stops.length - 1;
    else return;
    event.preventDefault();
    setActive(next);
    tabs.current[next]?.focus();
  };

  return (
    <div className="mt-10 grid gap-6 lg:grid-cols-[19rem_minmax(0,1fr)] lg:gap-8">
      <div role="tablist" aria-label="App screens" aria-orientation="vertical" onKeyDown={onKeyDown} className="-mx-5 flex gap-2 overflow-x-auto px-5 pb-1 sm:mx-0 sm:px-0 lg:flex-col lg:overflow-visible">
        {stops.map((item, index) => {
          const selected = index === active;
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              ref={(element) => { tabs.current[index] = element; }}
              type="button"
              role="tab"
              id={`tour-tab-${item.id}`}
              aria-selected={selected}
              aria-controls="tour-panel"
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(index)}
              className={`group shrink-0 rounded-2xl border text-left transition lg:w-full ${selected ? "border-slate-300 bg-white shadow-soft" : "border-transparent bg-white/40 hover:border-slate-200 hover:bg-white/80"} px-4 py-3 lg:px-5 lg:py-4`}
            >
              <span className="flex items-center gap-3">
                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition ${selected ? "bg-ink text-white" : "bg-white text-slate-600 ring-1 ring-slate-200"}`}><Icon size={16} aria-hidden="true" /></span>
                <span className="min-w-0">
                  <span className="block whitespace-nowrap text-[14px] font-semibold text-ink">{item.label}</span>
                  <span className="hidden text-[13px] text-slate-600 lg:block">{item.title}</span>
                </span>
              </span>
              {selected && (
                <ul className="mt-3 hidden space-y-1.5 pl-12 lg:block">
                  {item.points.map((point) => (
                    <li key={point} className="flex gap-2 text-[13px] leading-5 text-slate-700"><Check size={14} className="mt-0.5 shrink-0 text-emerald-600" aria-hidden="true" />{point}</li>
                  ))}
                </ul>
              )}
            </button>
          );
        })}
      </div>

      <div id="tour-panel" role="tabpanel" aria-labelledby={`tour-tab-${stop.id}`} className="min-w-0">
        <figure className="overflow-hidden rounded-[1.4rem] border border-slate-200 bg-white shadow-[0_40px_90px_-50px_rgba(38,44,74,0.55)]">
          <div className="flex items-center gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2.5">
            <span className="flex gap-1.5" aria-hidden="true"><span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" /><span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" /><span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" /></span>
            <span className="mx-auto min-w-0 truncate rounded-md bg-white px-3 py-1 font-mono text-[11px] text-slate-600 ring-1 ring-slate-200 sm:min-w-[16rem] sm:text-center">{host}{stop.path}</span>
            <span className="hidden w-[42px] sm:block" aria-hidden="true" />
          </div>
          <img key={stop.id} src={stop.image} width={1280} height={800} loading="lazy" decoding="async" alt={stop.alt} className="block aspect-[16/10] w-full motion-safe:animate-[fadeIn_.25s_ease-out] bg-slate-100 object-cover object-top" />
          <figcaption className="border-t border-slate-200 px-4 py-3 lg:hidden">
            <p className="text-[14px] font-semibold text-ink">{stop.title}</p>
            <ul className="mt-2 space-y-1.5">
              {stop.points.map((point) => (
                <li key={point} className="flex gap-2 text-[13px] leading-5 text-slate-700"><Check size={14} className="mt-0.5 shrink-0 text-emerald-600" aria-hidden="true" />{point}</li>
              ))}
            </ul>
          </figcaption>
        </figure>
        <p className="mt-3 text-center text-[12px] text-slate-500 lg:text-left">Real screens from HANNAH {version}.</p>
      </div>
    </div>
  );
}
