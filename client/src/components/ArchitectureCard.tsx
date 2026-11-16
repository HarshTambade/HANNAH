import { useState, useEffect } from "react";
import { Cpu, Brain, Server, Activity } from "lucide-react";

type Node = {
  label: string;
  sub: string;
  icon: React.ReactNode;
  color: "purple" | "blue" | "mint" | "peach";
  active?: boolean;
};

const COLOR_MAP: Record<string, string> = {
  purple: "border-purple-200 bg-purple-50 text-purple-700",
  blue: "border-blue-200 bg-blue-50 text-blue-700",
  mint: "border-emerald-200 bg-emerald-50 text-emerald-700",
  peach: "border-orange-200 bg-orange-50 text-orange-700",
};

const getActiveProvider = (): "cloud" | "local" | "offline" => {
  if (typeof window === "undefined") return "offline";
  try {
    const stored = window.localStorage.getItem("shanaya.cloudProvider");
    const mode = window.localStorage.getItem("shanaya.inferenceMode");
    if (mode === "webllm" || mode === "native" || mode === "ollama") return "local";
    if (stored === "groq" || stored === "ollama" || !stored) return "cloud";
    return "cloud";
  } catch {
    return "cloud";
  }
};

const ACTIVE_COLORS: Record<string, string> = {
  purple: "border-purple-400 bg-purple-100 text-purple-800 shadow-[0_0_15px_rgba(139,92,246,0.4)]",
  blue: "border-blue-400 bg-blue-100 text-blue-800 shadow-[0_0_15px_rgba(59,130,246,0.4)]",
  mint: "border-emerald-400 bg-emerald-100 text-emerald-800 shadow-[0_0_15px_rgba(16,185,129,0.4)]",
  peach: "border-orange-400 bg-orange-100 text-orange-800 shadow-[0_0_15px_rgba(253,186,116,0.4)]",
};

const NODES: Node[] = [
  {
    label: "Multi-Agent Router",
    sub: "Cloud: Groq · Anthropic · OpenAI",
    icon: <Brain size={16} strokeWidth={2} />,
    color: "purple",
  },
  {
    label: "Local Inference",
    sub: "WebLLM · llama.cpp · GGUF",
    icon: <Cpu size={16} strokeWidth={2} />,
    color: "blue",
  },
  {
    label: "Memory Evolution",
    sub: "LanceDB · Persona anchors",
    icon: <Brain size={16} strokeWidth={2} />,
    color: "mint",
  },
  {
    label: "Kernel Senses",
    sub: "eBPF · Window · Presence",
    icon: <Activity size={16} strokeWidth={2} />,
    color: "peach",
  },
  {
    label: "MCP Tools",
    sub: "Device control · File system",
    icon: <Server size={16} strokeWidth={2} />,
    color: "blue",
  },
];

export default function ArchitectureCard() {
  const [activeProvider, setActiveProvider] = useState<"cloud" | "local" | "offline">("cloud");

  useEffect(() => {
    setActiveProvider(getActiveProvider());
    const handler = () => setActiveProvider(getActiveProvider());
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  const isCloudActive = activeProvider === "cloud";
  const isLocalActive = activeProvider === "local";

  return (
    <div className="bento-card span-2-2 relative overflow-hidden">
      {/* Decorative gradient orb behind center node */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_50%,rgba(139,92,246,0.08),transparent_60%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_80%_-30%,rgba(253,186,116,0.06),transparent_50%)]" />

      <div className="relative z-10 flex flex-col items-center justify-center min-h-[420px]">
        <div className="bento-kicker mb-1">System Architecture</div>
        <div className="bento-title mb-6">How Shanaya Works</div>
        <div className="bento-desc text-center max-w-[300px] mx-auto mb-8">
          Every request flows through governance gates: intent assessment, policy enforcement,
          and tool execution — all with human-in-the-loop approval for irreversible actions.
        </div>

        {/* Center glossy sphere / Shanaya logo */}
        <div className="relative flex items-center justify-center h-32 w-32 mb-8 rounded-full border border-white/60 bg-white shadow-[0_0_50px_rgba(139,92,246,0.35)] relative overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-tr from-blue-400/40 to-purple-400/40 blur-[40px]" />
          <div className="relative z-10 flex flex-col items-center justify-center h-full w-full p-4">
            <div className="w-16 h-16 rounded-full bg-white/80 backdrop-blur-md border border-white/60 flex items-center justify-center shadow-[0_0_30px_rgba(0,0,0,0.05)]">
              <svg className="w-8 h-8 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7vL13 10z" />
                <circle cx="1" cy="19" r="1" stroke="currentColor" />
                <circle cx="13" cy="13" r="1" stroke="currentColor" />
              </svg>
            </div>
          </div>
          <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1 px-2 py-0.5 rounded-full border border-white/40 bg-white/70 backdrop-blur-sm">
            <span className="relative flex h-1.5 w-1.5"><span className="absolute inset-0 rounded-full bg-emerald-500 animate-ping" /><span className="relative inset-0 rounded-full bg-emerald-500" /></span>
            <span className="text-[10px] font-bold text-ink">Shanaya Core</span>
          </div>
        </div>

        {/* Surrounding nodes in a circle */}
        <div className="relative w-full max-w-[460px] h-48 flex items-center justify-center">
          {NODES.map((node, i) => {
            const angle = (i / NODES.length) * 360;
            const radius = 110;
            const x = Math.cos((angle * Math.PI) / 180) * radius;
            const y = Math.sin((angle * Math.PI) / 180) * radius;
            const baseColor = COLOR_MAP[node.color];
            const activeColor = ACTIVE_COLORS[node.color];

            // Determine if this node is active based on provider
            const isNodeActive = (node.label === "Multi-Agent Router" && isCloudActive) ||
              (node.label === "Local Inference" && isLocalActive) ||
              (node.label === "Memory Evolution" && isLocalActive) ||
              (node.label === "Kernel Senses") || // always active
              (node.label === "MCP Tools"); // always active

            return (
              <div
                key={i}
                className={`absolute flex flex-col items-center gap-1 transition-all duration-300 group ${
                  isNodeActive ? activeColor : baseColor
                } ${isNodeActive ? "shadow-lg" : "shadow-soft"}`}
                style={{ left: `calc(50% + ${x}px)`, top: `calc(50% + ${y}px)` }}
                role="button"
                tabIndex={0}
                aria-label={`${node.label}: ${node.sub}`}
                aria-pressed={isNodeActive}
              >
                <div className="flex items-center justify-center h-10 w-10 rounded-full border ${baseColor} group-hover:border-${node.color}-400 group-hover:bg-white/90">
                  {node.icon}
                </div>
                <div className={`mt-2 text-center whitespace-nowrap text-[10px] font-bold ${isNodeActive ? "" : "opacity-70"}`}>
                  {node.label}
                </div>
                <div className={`absolute -top-8 left-1/2 -translate-x-1/2 w-px h-4 bg-slate-200 group-hover:bg-${node.color}-200`} />
              </div>
            );
          })}
        </div>

        {/* Connection lines from center to nodes */}
        <svg className="absolute inset-0 pointer-events-none w-full h-full" style={{ overflow: "visible" }}>
          {NODES.map((_node, i) => {
            const angle = (i / NODES.length) * 360;
            const radius = 88;
            const x2 = Math.cos((angle * Math.PI) / 180) * radius;
            const y2 = Math.sin((angle * Math.PI) / 180) * radius;
            return (
              <line
                key={`line-${i}`}
                x1="50%"
                y1="50%"
                x2={`calc(50% + ${x2}px)`}
                y2={`calc(50% + ${y2}px)`}
                stroke="#e2e8f0"
                strokeWidth="1"
              />
            );
          })}
        </svg>
      </div>
    </div>
  );
}
