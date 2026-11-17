/**
 * Persistent execution log for agent runs.
 *
 * Every chat turn that reaches the agent becomes a run with its tool steps and
 * final status. Runs survive reloads; a run that was still "running" when the
 * page closed is marked "interrupted" next time, so the log never claims a
 * task finished when it didn't. Stores tool names and outcomes only, never
 * tool arguments, file contents or replies.
 */

import { Diagnostics } from "./Diagnostics";

export type RunStatus = "running" | "succeeded" | "failed" | "stopped" | "declined" | "blocked" | "interrupted";
export type StepOutcome = "ok" | "failed" | "declined" | "blocked";
export type RunStep = { at: number; tool: string; outcome: StepOutcome; detail?: string };
export type AgentRun = {
  id: string;
  startedAt: number;
  finishedAt?: number;
  objective: string;
  mode: string;
  model?: string;
  status: RunStatus;
  steps: RunStep[];
  error?: string;
};

const STORAGE_KEY = "hannah.agentRuns.v1";
export const AGENT_RUNS_EVENT = "hannah:agent-runs";
const MAX_RUNS = 50;
const MAX_STEPS = 40;

function read(): AgentRun[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is AgentRun => Boolean(item) && typeof item.id === "string" && Array.isArray(item.steps)) : [];
  } catch {
    return [];
  }
}

function write(runs: AgentRun[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(runs.slice(-MAX_RUNS)));
  } catch {
    // The log is best effort.
  }
  try {
    window.dispatchEvent(new Event(AGENT_RUNS_EVENT));
  } catch {
    // No window events in some test environments.
  }
}

function update(id: string, change: (run: AgentRun) => AgentRun) {
  const runs = read();
  const index = runs.findIndex((run) => run.id === id);
  if (index < 0) return;
  runs[index] = change(runs[index]);
  write(runs);
}

let recovered = false;

export const AgentRunLog = {
  list() {
    if (!recovered) {
      recovered = true;
      const runs = read();
      if (runs.some((run) => run.status === "running")) {
        write(runs.map((run) => (run.status === "running" ? { ...run, status: "interrupted" as const, finishedAt: run.finishedAt ?? Date.now() } : run)));
      }
    }
    return read().reverse();
  },
  start(input: { objective: string; mode: string; model?: string }) {
    const run: AgentRun = {
      id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `run-${Date.now()}`,
      startedAt: Date.now(),
      objective: input.objective.replace(/\s+/g, " ").trim().slice(0, 160),
      mode: input.mode,
      model: input.model,
      status: "running",
      steps: [],
    };
    // Recover stale runs before adding the new one.
    this.list();
    write([...read(), run]);
    return run.id;
  },
  step(id: string, step: Omit<RunStep, "at">) {
    update(id, (run) => ({ ...run, steps: [...run.steps, { ...step, at: Date.now(), detail: step.detail?.slice(0, 200) }].slice(-MAX_STEPS) }));
  },
  finish(id: string, status: Exclude<RunStatus, "running">, details: { model?: string; error?: string } = {}) {
    update(id, (run) => (run.status !== "running" ? run : { ...run, status, finishedAt: Date.now(), model: details.model ?? run.model, error: details.error?.slice(0, 200) }));
    if (status === "failed") Diagnostics.log("error", "agent", `An agent run failed${details.model ? ` (${details.model})` : ""}: ${details.error || "no reason given"}`);
  },
  clear() {
    write([]);
  },
};
