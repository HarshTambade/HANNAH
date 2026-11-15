export default function AnnualPlanPrompt({ tasksCompleted = 0, timeSavedMinutes = 0 }: { tasksCompleted?: number; timeSavedMinutes?: number }) {
  return (
    <div className="rounded-xl border border-emerald-100 bg-emerald-50 p-4 shadow-soft">
      <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-emerald-600">Annual plan</h3>
      <p className="mt-2 text-[10px] text-slate-600">Tasks completed: {tasksCompleted}. Time saved: {timeSavedMinutes} minutes.</p>
      <button type="button" className="mt-3 rounded-lg border border-emerald-200 bg-white px-3 py-1 text-[8px] text-emerald-600 hover:bg-emerald-100/80">Upgrade to annual</button>
    </div>
  );
}