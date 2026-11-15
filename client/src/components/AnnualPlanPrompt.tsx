export default function AnnualPlanPrompt({ tasksCompleted = 0, timeSavedMinutes = 0 }: { tasksCompleted?: number; timeSavedMinutes?: number }) {
  return (
    <div className="rounded-2xl border border-emerald-300/10 bg-emerald-300/[0.04] p-4">
      <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-emerald-100/80">Annual plan</h3>
      <p className="mt-2 text-[10px] text-slate-200">Tasks completed: {tasksCompleted}. Time saved: {timeSavedMinutes} minutes.</p>
      <button type="button" className="mt-3 rounded-lg border border-emerald-200/20 px-3 py-1 text-[8px] text-emerald-100">Upgrade to annual</button>
    </div>
  );
}