import { useEffect, useState } from "react";
import { Pause, Play, Square, ExternalLink } from "lucide-react";
import { Task, TaskSpineService } from "../services/TaskSpineService";

export default function TaskPanel() {
  const [tasks, setTasks] = useState<Task[]>(() => TaskSpineService.list());

  useEffect(() => {
    const refresh = () => setTasks(TaskSpineService.list());
    const timer = window.setInterval(refresh, 2000);
    return () => window.clearInterval(timer);
  }, []);

  const active = tasks.filter((task) => task.status === "pending" || task.status === "running" || task.status === "paused");

  if (active.length === 0) return null;

  return (
    <div className="mx-4 mb-3 rounded-2xl border border-cyan-200/10 bg-cyan-200/[0.04] p-3 sm:mx-8">
      <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-cyan-100/70">Background tasks</p>
      <div className="mt-2 space-y-2">
        {active.map((task) => (
          <div key={task.id} className="rounded-xl border border-white/[0.06] bg-[#080b13]/60 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[10px] font-medium text-slate-200">{task.title}</span>
              <span className="text-[8px] uppercase tracking-[0.14em] text-slate-500">{task.status}</span>
            </div>
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.08]">
              <div className="h-full rounded-full bg-gradient-to-r from-cyan-200 to-violet-300 transition-all" style={{ width: `${Math.max(2, task.progress * 100)}%` }} />
            </div>
            <div className="mt-2 flex items-center gap-2">
              {task.status === "paused" ? (
                <button type="button" onClick={() => { TaskSpineService.resume(task.id); setTasks(TaskSpineService.list()); }} className="inline-flex items-center gap-1 rounded-lg border border-white/[0.08] px-2 py-1 text-[8px] text-slate-300">
                  <Play size={10} /> Resume
                </button>
              ) : (
                <button type="button" onClick={() => { TaskSpineService.pause(task.id); setTasks(TaskSpineService.list()); }} className="inline-flex items-center gap-1 rounded-lg border border-white/[0.08] px-2 py-1 text-[8px] text-slate-300">
                  <Pause size={10} /> Pause
                </button>
              )}
              <button type="button" onClick={() => { TaskSpineService.cancel(task.id); setTasks(TaskSpineService.list()); }} className="inline-flex items-center gap-1 rounded-lg border border-white/[0.08] px-2 py-1 text-[8px] text-slate-300">
                <Square size={10} /> Cancel
              </button>
              {Boolean(task.result) && (
                <span className="ml-auto inline-flex items-center gap-1 text-[8px] text-cyan-200/80">
                  <ExternalLink size={10} /> Output ready
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}