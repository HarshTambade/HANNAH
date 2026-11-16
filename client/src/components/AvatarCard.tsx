import { useState, useEffect } from "react";

type StatItem = {
  label: string;
  value: string;
  color: "purple" | "peach" | "blue" | "mint";
};

export default function AvatarCard() {
  const [latency, setLatency] = useState("120ms");

  useEffect(() => {
    const interval = setInterval(() => {
      setLatency(`${Math.floor(Math.random() * 200) + 50}ms`);
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  const stats: StatItem[] = [
    { label: "Active Model", value: "Groq Llama 3.3", color: "purple" },
    { label: "Latency", value: latency, color: "blue" },
    { label: "Memory Items", value: "1,204", color: "mint" },
    { label: "Session Uptime", value: "4h 12m", color: "peach" },
  ];

  return (
    <div className="bento-card span-2-2 relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-cyan-50 to-purple-50/40" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_80%_-20%,rgba(139,92,246,0.15),transparent_50%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_20%_120%,rgba(253,186,116,0.12),transparent_50%)]" />

      <div className="absolute top-4 left-4 z-10 flex items-center gap-2 rounded-full border border-white/60 bg-white/70 px-3 py-1.5 backdrop-blur-sm">
        <span className="relative flex h-2 w-2">
          <span className="absolute inset-0 rounded-full bg-emerald-500 animate-ping" />
          <span className="relative inset-0 rounded-full bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.6)]" />
        </span>
        <span className="text-[11px] font-bold text-ink">Shanaya is active</span>
      </div>

      <div className="relative z-10 flex flex-col items-center justify-center min-h-[420px]">
        <div className="relative w-full max-w-[380px] aspect-[4/5] mx-auto flex items-center justify-center rounded-[2rem] border border-white/40 bg-white/30 backdrop-blur-sm overflow-hidden">
          <div className="absolute inset-0 rounded-[2rem] bg-gradient-to-tr from-blue-200/40 to-purple-200/40 blur-[60px]" />
          <div className="relative z-10 flex flex-col items-center justify-center h-full w-full p-8">
            <div className="w-32 h-32 rounded-full bg-white/80 backdrop-blur-md border border-white/60 shadow-[0_0_40px_rgba(139,92,246,0.30)] flex items-center justify-center mb-6 relative overflow-hidden">
              <div className="absolute inset-0 rounded-full bg-gradient-to-tr from-blue-400/30 to-purple-400/30 blur-[20px]" />
              <div className="relative w-20 h-24 bg-white/60 rounded-t-[2rem] rounded-b-xl overflow-hidden border border-white/40">
                <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-6 h-6 bg-purple-500 rounded-full" />
                <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-4 h-4 bg-white absolute top-[15%] left-[50%]" />
                <div className="absolute bottom-1/3 left-1/2 -translate-x-1/2 w-8 h-2 bg-white/60 rounded-full" />
                <div className="absolute bottom-[20%] left-1/2 -translate-x-1/2 w-12 h-8 bg-white/80 rounded-full" />
              </div>
            </div>
            <div className="text-center">
              <h2 className="font-display font-bold text-2xl text-ink tracking-tight">Shanaya</h2>
              <p className="text-xs text-slate-500 mt-1 uppercase tracking-widest">AI Companion · Live</p>
            </div>
          </div>
        </div>

        <div className="mt-8 grid grid-cols-2 gap-4">
          {stats.map((stat, i) => (
            <div key={i} className="rounded-xl border border-white/50 bg-white/60 px-4 py-3 backdrop-blur-sm text-center">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{stat.label}</div>
              <div className="mt-1 font-display font-bold text-xl text-ink">{stat.value}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
