import { useState } from "react";
import { House, Bot, MessageSquare, Settings2, ShieldCheck, Activity, ArrowRight, Mic, Paperclip } from "lucide-react";
import AvatarCard from "./components/AvatarCard";
import ArchitectureCard from "./components/ArchitectureCard";
import IntegrationsPage from "./components/IntegrationsPage";
import LandingPage from "./components/LandingPage";
import MarketplacePage from "./components/MarketplacePage";

type Screen = "landing" | "companion" | "integrations" | "marketplace";

export default function App() {
  const [screen, setScreen] = useState<Screen>("landing");
  const [integrationReturnScreen, setIntegrationReturnScreen] = useState<"landing" | "companion">("landing");
  const [marketplaceReturnScreen, setMarketplaceReturnScreen] = useState<"landing" | "companion">("landing");

  if (screen === "integrations") {
    return <IntegrationsPage onBack={() => setScreen(integrationReturnScreen)} />;
  }

  if (screen === "marketplace") {
    return <MarketplacePage onBack={() => setScreen(marketplaceReturnScreen)} />;
  }

  if (screen === "landing") {
    return (
      <LandingPage
        onStart={() => setScreen("companion")}
        onIntegrations={() => { setIntegrationReturnScreen("landing"); setScreen("integrations"); }}
        onMarketplace={() => { setMarketplaceReturnScreen("landing"); setScreen("marketplace"); }}
      />
    );
  }

  return (
    <main className="dashboard-root">
      <div className="fixed inset-0 z-0 bg-mesh-indigo" />
      <div className="fixed inset-0 z-0 bg-mesh-pastel opacity-60" />
      <div className="fixed inset-0 z-0 soft-grid opacity-40" />

      <div className="relative z-10 max-w-[1400px] mx-auto px-6 py-8 h-screen overflow-y-auto">
        <header className="flex flex-col lg:flex-row lg:items-start justify-between gap-4 mb-8">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-[1.5rem] border border-brand-100 bg-brand-50 text-brand-600 shadow-soft">
              <Bot size={20} />
            </div>
            <div>
              <p className="font-display font-bold text-xl text-ink tracking-tight">Shanaya</p>
              <p className="text-xs text-slate-500 uppercase tracking-wider">AI Companion Dashboard</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setScreen("landing")} className="btn-ghost">
              <House size={16} /> <span className="hidden sm:inline">Home</span>
            </button>
            <button type="button" className="btn-outline">
              <Settings2 size={16} /> <span className="hidden sm:inline">Settings</span>
            </button>
          </div>
        </header>

        <div className="bento-grid">
          <AvatarCard />

          <div className="bento-card span-1-2 flex flex-col h-full">
            <div className="mb-4">
              <div className="bento-kicker">Focus Area Distribution</div>
              <div className="bento-title">Task Breakdown</div>
              <div className="bento-desc">Shanaya's task classification across all sessions.</div>
            </div>
            <div className="flex-1 flex items-center justify-center">
              <div className="w-full max-w-[300px]">
                <div className="flex items-center justify-center relative h-64">
                  <svg className="w-full h-full" viewBox="0 0 100 100">
                    <circle cx="50" cy="50" r="40" stroke="#e2e8f0" strokeWidth="8" fill="none" />
                    <circle cx="50" cy="50" r="40" stroke="#8B5CF6" strokeWidth="8" fill="none" strokeDasharray="251" strokeDashoffset={63} className="transition-all duration-1000" />
                    <text x="50" y="54" fontFamily="Manrope" fontSize="20" fontWeight="800" fill="#0f172a" textAnchor="middle">30%</text>
                  </svg>
                </div>
                <div className="mt-4 flex justify-between text-[11px]">
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-purple-500" />Automation 30%</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500" />Chat 25%</span>
                </div>
                <div className="mt-2 flex justify-between text-[11px]">
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-orange-500" />Code 25%</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500" />System 20%</span>
                </div>
              </div>
            </div>
          </div>

          <div className="bento-card span-1-1 flex flex-col h-full">
            <div className="mb-4">
              <div className="bento-kicker">Resolved Tasks</div>
              <div className="stat-big">14.2K</div>
              <div className="stat-label mt-1">Tasks in past 7 days</div>
            </div>
            <div className="mt-6 flex-1 flex items-end justify-center relative h-40">
              <svg className="w-full h-full" viewBox="0 0 120 120" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="sparkGrad2" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="#8B5CF6" /><stop offset="100%" stopColor="#FDBA74" />
                  </linearGradient>
                </defs>
                <path d="M10,90 Q30,50 50,80 T90,60" stroke="url(#sparkGrad2)" strokeWidth="3" fill="none" strokeLinecap="round" />
                {[10, 30, 50, 70, 90].map((x) => (
                  <circle key={x} cx={x} cy={x === 10 ? 90 : x === 30 ? 50 : x === 50 ? 80 : x === 70 ? 60 : 60} r="2.5" fill="#8B5CF6" />
                ))}
              </svg>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-3">
              <div className="text-center px-3 py-2 rounded-xl border border-slate-100 bg-white">
                <div className="text-[10px] font-bold uppercase text-slate-500">Success</div>
                <div className="font-display font-bold text-lg text-ink">99.4%</div>
              </div>
              <div className="text-center px-3 py-2 rounded-xl border border-slate-100 bg-white">
                <div className="text-[10px] font-bold uppercase text-slate-500">Avg Latency</div>
                <div className="font-display font-bold text-lg text-ink">140ms</div>
              </div>
              <div className="text-center px-3 py-2 rounded-xl border border-slate-100 bg-white">
                <div className="text-[10px] font-bold uppercase text-slate-500">Errors</div>
                <div className="font-display font-bold text-lg text-ink">0</div>
              </div>
            </div>
          </div>

          <ArchitectureCard />

          <div className="bento-card span-1-1 flex flex-col h-full">
            <div className="mb-4">
              <div className="bento-kicker">Memory Consolidation</div>
              <div className="stat-big">68%</div>
              <div className="stat-label mt-1">Long-term capacity used</div>
            </div>
            <div className="mt-6 flex flex-col items-center justify-center relative h-48 w-48 mx-auto">
              <svg className="w-full h-full" viewBox="0 0 100 100">
                <circle cx="50" cy="50" r="42" stroke="#e2e8f0" strokeWidth="8" fill="none" />
                <circle cx="50" cy="50" r="42" stroke="url(#memGrad3)" strokeWidth="8" fill="none" strokeDasharray="264" strokeDashoffset={84} />
                <defs>
                  <linearGradient id="memGrad3" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="#10B981" /><stop offset="100%" stopColor="#3B82F6" />
                  </linearGradient>
                </defs>
                <text x="50" y="55" fontFamily="Manrope" fontSize="20" fontWeight="800" fill="#0f172a" textAnchor="middle">68%</text>
              </svg>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="rounded-xl border border-white/50 bg-white/40 px-3 py-2 backdrop-blur-sm">
                <div className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-blue-500" /><span className="text-[10px] text-slate-600 font-medium">Episodic</span></div>
                <div className="mt-1 text-[11px] font-bold text-ink">1,204 items</div>
              </div>
              <div className="rounded-xl border border-white/50 bg-white/40 px-3 py-2 backdrop-blur-sm">
                <div className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-purple-500" /><span className="text-[10px] text-slate-600 font-medium">Persona</span></div>
                <div className="mt-1 text-[11px] font-bold text-ink">87 anchors</div>
              </div>
            </div>
          </div>

          <div className="bento-card span-1-1 flex flex-col h-full">
            <div className="mb-4">
              <div className="bento-kicker">Token Efficiency</div>
              <div className="stat-big">$14.20</div>
              <div className="stat-label mt-1">Cloud cost saved this week</div>
            </div>
            <div className="mt-4 flex-1 relative h-32">
              <svg className="w-full h-full" viewBox="0 0 140 100">
                <defs>
                  <linearGradient id="barGrad2" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stopColor="#8B5CF6" /><stop offset="100%" stopColor="#10B981" />
                  </linearGradient>
                </defs>
                {[65, 72, 68, 75, 70, 82, 88].map((val, i) => (
                  <rect key={i} x={i * 19} y={100 - val} width="14" height={val} fill="url(#barGrad2)" rx="2" />
                ))}
              </svg>
              <div className="absolute bottom-0 left-0 w-full flex justify-between text-[10px] text-slate-500 font-medium">
                Mon Tue Wed Thu Fri Sat Sun
              </div>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="text-center px-3 py-2 rounded-xl border border-slate-100 bg-white">
                <div className="text-[10px] font-bold uppercase text-slate-500">Local</div>
                <div className="font-display font-bold text-lg text-ink">70%</div>
              </div>
              <div className="text-center px-3 py-2 rounded-xl border border-slate-100 bg-white">
                <div className="text-[10px] font-bold uppercase text-slate-500">Cloud</div>
                <div className="font-display font-bold text-lg text-ink">30%</div>
              </div>
            </div>
          </div>

          <div className="bento-card span-2-2 flex flex-col h-full border border-slate-200 bg-white shadow-soft-lg">
            <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4 pb-6 border-b border-slate-100">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-[1rem] border border-purple-100 bg-purple-50 text-purple-600 shadow-soft">
                  <MessageSquare size={18} />
                </div>
                <div>
                  <div className="font-display font-bold text-lg text-ink">Conversation</div>
                  <div className="flex items-center gap-1 text-[11px]">
                    <span className="relative flex h-2 w-2"><span className="absolute inset-0 rounded-full bg-emerald-500 animate-ping" /><span className="relative inset-0 rounded-full bg-emerald-500" /></span>
                    <span className="font-medium text-slate-600">Shanaya is online</span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button type="button" className="btn-ghost"><Activity size={16} /></button>
                <button type="button" className="btn-ghost"><ShieldCheck size={16} /></button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar px-6 py-4">
              <div className="max-w-[600px] mx-auto space-y-4">
                <div className="flex flex-col gap-1">
                  <div className="rounded-2xl border border-slate-100 bg-white px-4 py-3 shadow-soft max-w-[80%]">
                    <p className="text-[13px] leading-relaxed text-ink">Hey, I'm Shanaya. It's lovely to meet you. What's on your mind today?</p>
                  </div>
                  <span className="text-[10px] text-slate-400">Just now</span>
                </div>
                <div className="flex justify-end">
                  <div className="rounded-2xl border border-purple-100 bg-purple-50 px-4 py-3 shadow-soft max-w-[80%]">
                    <p className="text-[13px] leading-relaxed text-purple-900">Can you help me analyze this data?</p>
                  </div>
                  <span className="text-[10px] text-slate-400">2 min ago</span>
                </div>
                <div className="flex flex-col gap-1">
                  <div className="rounded-2xl border border-slate-100 bg-white px-4 py-3 shadow-soft max-w-[80%]">
                    <p className="text-[13px] leading-relaxed text-ink">I'd be happy to help! Please share the data or paste what you'd like me to analyze.</p>
                  </div>
                  <span className="text-[10px] text-slate-400">Just now</span>
                </div>
              </div>
            </div>

            <div className="mx-6 mb-4 rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 shadow-soft flex items-start gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-full border border-amber-200 bg-amber-100 text-amber-600">
                <ShieldCheck size={14} />
              </div>
              <div className="flex-1">
                <div className="flex items-baseline gap-1 text-[11px] font-bold text-amber-700">
                  <span>Shanaya requests approval</span>
                  <span className="text-normal font-medium">·</span>
                  <span>run_shell</span>
                </div>
                <div className="mt-1 text-[11px] text-amber-600">Command: <span className="font-mono text-xs">ls -la /workspace</span></div>
                <div className="mt-3 flex items-end gap-2">
                  <button type="button" className="px-4 py-1.5 rounded-xl border border-amber-200 bg-white text-amber-700 font-medium text-xs hover:bg-amber-50 transition">Reject</button>
                  <button type="button" className="px-4 py-1.5 rounded-xl bg-amber-600 text-white font-medium text-xs hover:bg-amber-700 transition">Approve</button>
                </div>
              </div>
            </div>

            <div className="border-t border-slate-200 px-6 py-4 bg-white/50 backdrop-blur-sm">
              <form className="flex items-end gap-2 rounded-2xl border border-slate-200 bg-white p-1 shadow-sm">
                <select className="rounded-lg border border-slate-200 bg-white px-2 py-2 text-[11px] text-slate-600 outline-none focus:border-brand-400/60" defaultValue="en-US">
                  <option value="en-US">English</option>
                  <option value="hi-IN">हिन्दी</option>
                  <option value="mr-IN">मराठी</option>
                </select>
                <button type="button" className="btn-ghost"><Mic size={16} /></button>
                <button type="button" className="btn-ghost"><Paperclip size={16} /></button>
                <textarea className="flex-1 resize-none bg-transparent px-3 py-2.5 text-[12px] leading-relaxed text-ink outline-none placeholder:text-slate-400" placeholder="Message Shanaya..." rows={1} maxLength={4000} />
                <button type="submit" className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-r from-brand-600 to-violet-600 text-white shadow-lg shadow-brand-950/30 transition hover:brightness-105">
                  <ArrowRight size={18} strokeWidth={2.2} />
                </button>
              </form>
              <p className="mt-2 text-center text-[10px] text-slate-500">
                Groq Cloud · Local inference available · Messages stay on this device
              </p>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
