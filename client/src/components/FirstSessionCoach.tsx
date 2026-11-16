import { MessageCircleHeart } from "lucide-react";

type FirstSessionCoachProps = {
  messageCount: number;
  onSuggestion?: (suggestion: string) => void;
};

const SUGGESTIONS = [
  "Tell her something you did today.",
  "Ask her a question you’ve been thinking about.",
  "Share a small win or a frustrating moment.",
];

export default function FirstSessionCoach({ messageCount, onSuggestion }: FirstSessionCoachProps) {
  if (messageCount >= 3) return null;

  return (
    <div className="mx-4 mb-3 rounded-xl border border-cyan-100 bg-cyan-50 px-4 py-3 text-[11px] leading-6 text-cyan-700 sm:mx-8 shadow-soft">
      <p className="flex items-center gap-2 font-bold text-cyan-600">
        <MessageCircleHeart size={14} /> HANNAH is curious about you.
      </p>
      <p className="mt-1 text-[10px] text-cyan-600">
        Try telling her something you did today, or ask her a question.
      </p>
      {onSuggestion && (
        <div className="mt-2 flex flex-wrap gap-2">
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => onSuggestion(suggestion)}
              className="rounded-full border border-cyan-200 bg-white px-3 py-1 text-[9px] font-medium text-cyan-600 transition hover:bg-cyan-100/80"
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}