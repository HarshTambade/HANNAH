import { apiFetch, apiUrl } from "./api";
import type { WorkflowSchema } from "./WorkflowSchema";

export type TaskStatus = "pending" | "running" | "paused" | "completed" | "cancelled" | "failed";

export type Task = {
  id: string;
  title: string;
  prompt: string;
  status: TaskStatus;
  progress: number;
  result?: unknown;
  error?: string;
  pendingAction?: unknown;
  createdAt: string;
  updatedAt: string;
  kind?: "task" | "workflow";
  workflow?: WorkflowSchema;
};

const STORAGE_KEY = "shanaya.tasks.v1";

function readTasks(): Task[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeTasks(tasks: Task[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks.slice(0, 100)));
  } catch {
    // Best effort.
  }
}

export const TaskSpineService = {
  create(title: string, prompt: string): Task {
    const now = new Date().toISOString();
    const task: Task = { id: crypto.randomUUID(), title, prompt, status: "pending", progress: 0, createdAt: now, updatedAt: now };
    writeTasks([task, ...readTasks()]);
    return task;
  },
  createWorkflow(workflow: WorkflowSchema): Task {
    const now = new Date().toISOString();
    const task: Task = {
      id: workflow.id,
      title: workflow.name,
      prompt: `Workflow schema v${workflow.version}`,
      status: "pending",
      progress: 0,
      kind: "workflow",
      workflow: { ...workflow, updatedAt: now },
      createdAt: workflow.createdAt || now,
      updatedAt: now,
    };
    write([task, ...readTasks().filter((item) => item.id !== task.id)]);
    return task;
  },
  list(): Task[] {
    return readTasks();
  },
  get(id: string): Task | undefined {
    return readTasks().find((task) => task.id === id);
  },
  update(id: string, changes: Partial<Task>) {
    const tasks = readTasks();
    const index = tasks.findIndex((task) => task.id === id);
    if (index < 0) return;
    tasks[index] = { ...tasks[index], ...changes, updatedAt: new Date().toISOString() };
    writeTasks(tasks);
  },
  pause(id: string) {
    this.update(id, { status: "paused" });
  },
  resume(id: string) {
    this.update(id, { status: "pending" });
  },
  cancel(id: string) {
    this.update(id, { status: "cancelled" });
  },
  approve(id: string, approved: boolean) {
    this.update(id, { pendingAction: undefined, status: approved ? "pending" : "cancelled" });
  },
  async sync() {
    try {
      const response = await apiFetch(apiUrl("/api/tasks"));
      if (!response.ok) return;
      const tasks = await response.json();
      if (Array.isArray(tasks)) writeTasks(tasks as Task[]);
    } catch {
      // Local state remains authoritative when the backend is unavailable.
    }
  },
};
