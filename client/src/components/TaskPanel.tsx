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
    <div className="mx-4 mb-3 rounded-xl border border-cyan-100 bg-cyan-50 p-3 sm:mx-8 shadow-soft">
      <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-cyan-600">Background tasks</p>
      <div className="mt-2 space-y-2">
        {active.map((task) => (
          <div key={task.id} className="rounded-lg border border-slate-100 bg-white px-3 py-2 shadow-soft">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[10px] font-medium text-ink">{task.title}</span>
              <span className="text-[8px] uppercase tracking-[0.14em] text-slate-500">{task.status}</span>
            </div>
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-slate-200">
              <div className="h-full rounded-full bg-gradient-to-r from-cyan-200 to-violet-300 transition-all" style={{ width: `${Math.max(2, task.progress * 100)}%` }} />
            </div>
            <div className="mt-2 flex items-center gap-2">
              {task.status === "paused" ? (
                <button type="button" onClick={() => { TaskSpineService.resume(task.id); setTasks(TaskSpineService.list()); }} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[8px] text-slate-600 hover:bg-slate-50">
                  <Play size={10} /> Resume
                </button>
              ) : (
                <button type="button" onClick={() => { TaskSpineService.pause(task.id); setTasks(TaskSpineService.list()); }} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[8px] text-slate-600 hover:bg-slate-50">
                  <Pause size={10} /> Pause
                </button>
              )}
              <button type="button" onClick={() => { TaskSpineService.cancel(task.id); setTasks(TaskSpineService.list()); }} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[8px] text-slate-600 hover:bg-slate-50">
                <Square size={10} /> Cancel
              </button>
              {Boolean(task.result) && (
                <span className="ml-auto inline-flex items-center gap-1 text-[8px] text-cyan-600">
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