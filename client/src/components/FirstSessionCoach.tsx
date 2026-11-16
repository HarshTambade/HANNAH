import { MessageCircleHeart } from "lucide-react";

type FirstSessionCoachProps = {
  messageCount: number;
  onSuggestion?: (suggestion: string) => void;
};

// Each suggestion is written as the user would actually say it, because
// choosing one places it in the message box ready to send.
const SUGGESTIONS = [
  "I want to talk through something that's been on my mind.",
  "Can you help me plan the rest of my week?",
  "Tell me something interesting I probably don't know.",
];

export default function FirstSessionCoach({ messageCount, onSuggestion }: FirstSessionCoachProps) {
  if (messageCount > 0) return null;

  return (
    <div className="mx-1 mb-1 rounded-2xl border border-brand-100 bg-brand-50/70 px-4 py-3 sm:mx-9">
      <p className="flex items-center gap-2 text-sm font-semibold text-brand-700">
        <MessageCircleHeart size={16} /> Not sure where to start?
      </p>
      <p className="mt-1 text-xs leading-relaxed text-slate-600">Pick one to fill in the message box, or just say hello.</p>
      {onSuggestion && (
        <div className="mt-3 flex flex-wrap gap-2">
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => onSuggestion(suggestion)}
              className="rounded-full border border-brand-200 bg-white px-3 py-1.5 text-left text-xs font-medium text-brand-700 transition hover:border-brand-300 hover:bg-brand-50"
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
