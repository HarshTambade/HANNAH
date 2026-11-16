import { useState, useEffect, useRef, useCallback } from "react";
import { X, Search, Mic, Command, ArrowRight, Zap, Brain, ShieldCheck } from "lucide-react";
import { AgentKernel } from "../services/AgentKernel";

type PortalUIProps = {
  open: boolean;
  onClose: () => void;
};

export default function PortalUI({ open, onClose }: PortalUIProps) {
  const [query, setQuery] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSuggestions(AgentKernel.getSuggestedActions());
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Keyboard shortcut: Cmd+K / Ctrl+K
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        // Toggle handled by parent
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const handleExecute = useCallback(async () => {
    if (!query.trim() || isProcessing) return;
    setIsProcessing(true);
    try {
      await AgentKernel.execute(query.trim());
    } finally {
      setIsProcessing(false);
      setQuery("");
      onClose();
    }
  }, [query, isProcessing, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[10vh] bg-ink/40 backdrop-blur-md"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="portal-title"
    >
      <div className="w-full max-w-2xl mx-4 rounded-[2rem] border border-white/40 bg-white/90 backdrop-blur-xl shadow-[0_24px_48px_-8px_rgba(0,0,0,0.12)] overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 p-4 border-b border-slate-100">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-brand-100 bg-brand-50 text-brand-600">
            <Zap size={18} />
          </div>
          <h2 id="portal-title" className="font-display font-bold text-lg text-ink">HANNAH Portal</h2>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => setIsListening(!isListening)}
              className="flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-200"
              aria-label={isListening ? "Stop voice input" : "Start voice input"}
            >
              <Mic size={16} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-200"
              aria-label="Close portal"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Input */}
        <div className="p-4">
          <div className="relative flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-soft">
            <Search size={18} className="text-slate-400" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleExecute(); }}
              placeholder="What can HANNAH help with?"
              className="flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-slate-400"
              aria-label="Agent portal input"
              autoFocus
            />
            <kbd className="hidden sm:inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] font-medium text-slate-500">
              <Command size={10} /> Enter
            </kbd>
          </div>
        </div>

        {/* Suggestions */}
        {suggestions.length > 0 && (
          <div className="px-4 pb-4">
            <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500 mb-2">Suggested actions</div>
            <div className="space-y-1">
              {suggestions.map((suggestion, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => { setQuery(suggestion); }}
                  className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-brand-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-200"
                >
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-brand-100 bg-brand-50 text-brand-600">
                    <Zap size={14} />
                  </div>
                  <span className="text-[12px] font-medium text-ink">{suggestion}</span>
                  <ArrowRight size={14} className="ml-auto text-slate-400" />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Processing indicator */}
        {isProcessing && (
          <div className="px-4 pb-4">
            <div className="flex items-center gap-2 text-[11px] text-slate-500">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600" />
              Processing your request...
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 bg-slate-50/50">
          <div className="flex items-center gap-4 text-[10px] text-slate-500">
            <span className="flex items-center gap-1">
              <Brain size={10} /> AI Kernel
            </span>
            <span className="flex items-center gap-1">
              <ShieldCheck size={10} /> Governed
            </span>
          </div>
          <div className="text-[10px] text-slate-400">
            Press <kbd className="px-1.5 py-0.5 rounded border border-slate-200 bg-white text-slate-600 font-medium">Esc</kbd> to close
          </div>
        </div>
      </div>
    </div>
  );
}
