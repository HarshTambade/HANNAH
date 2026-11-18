import { useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, ChevronRight, Copy, RotateCcw, Square, X } from "lucide-react";
import { WorkflowApi, type ExecutionDetail as Detail, type NodeRun } from "../../services/WorkflowApi";
import { STATUS_STYLE, duration, emptyStops, when } from "./support";

const LIVE = new Set(["queued", "running"]);
export const FINAL = new Set(["completed", "failed", "cancelled", "timed-out"]);

export function StatusPill({ status }: { status: string }) {
  const style = STATUS_STYLE[status] ?? { label: status, tone: "bg-slate-100 text-slate-700 border-slate-200" };
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${style.tone}`}>{style.label}</span>;
}

function Json({ value }: { value: unknown }) {
  return <pre className="max-h-64 overflow-auto rounded-xl bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-slate-100">{JSON.stringify(value, null, 2)}</pre>;
}

function NodeRow({ run, open, onToggle }: { run: NodeRun; open: boolean; onToggle: () => void }) {
  const outputs = run.output ? Object.entries(run.output) : [];
  return (
    <li className={`rounded-2xl border bg-white ${run.status === "failed" ? "border-rose-200" : "border-slate-200"}`}>
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-3 px-3 py-2.5 text-left">
        {open ? <ChevronDown size={14} className="shrink-0 text-slate-400" /> : <ChevronRight size={14} className="shrink-0 text-slate-400" />}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{run.name}</span>
        {run.attempts > 1 && <span className="text-[11px] text-amber-800">{run.attempts} attempts</span>}
        <span className="text-[11px] tabular-nums text-slate-500">{duration(run.durationMs)}</span>
        <StatusPill status={run.status} />
      </button>
      {open && (
        <div className="space-y-3 border-t border-slate-100 px-3 py-3">
          {run.error && <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800"><span className="font-semibold">Error: </span>{run.error}</p>}
          <div className="grid gap-3 lg:grid-cols-2">
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Input {run.input ? `(${run.input.count} item${run.input.count === 1 ? "" : "s"})` : ""}</p>
              {run.input ? <Json value={run.input.items} /> : <p className="text-xs text-slate-500">No input (a trigger, or the step didn't start).</p>}
            </div>
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Output</p>
              {outputs.length ? outputs.map(([port, data]) => (
                <div key={port} className="mb-2">
                  {outputs.length > 1 && <p className="mb-1 text-[11px] font-semibold text-slate-600">{port}: {data.count} item{data.count === 1 ? "" : "s"}</p>}
                  <Json value={data.items} />
                </div>
              )) : <p className="text-xs text-slate-500">{run.status === "skipped" ? "Skipped: no items reached this step." : "No output."}</p>}
            </div>
          </div>
          {run.logs?.length ? (
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Console ({run.logs.length} line{run.logs.length === 1 ? "" : "s"})</p>
              <pre aria-label={`Console output of ${run.name}`} className="max-h-48 overflow-auto rounded-xl bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-emerald-200">{run.logs.join("\n")}</pre>
            </div>
          ) : null}
          <p className="text-[11px] text-slate-500">Started {when(run.startedAt)} · finished {when(run.finishedAt)} · values that look like secrets are hidden.</p>
        </div>
      )}
    </li>
  );
}

/** One execution: every step's status, data and errors, with retry, cancel and approval. */
export default function ExecutionDetail({ executionId, onOpenExecution, onClose, onLoaded }: { executionId: string; onOpenExecution?: (id: string) => void; onClose?: () => void; onLoaded?: (detail: Detail) => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      const next = await WorkflowApi.execution(executionId);
      setDetail(next);
      onLoaded?.(next);
      setError("");
      return next;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The run couldn't be loaded.");
      return null;
    }
  }, [executionId, onLoaded]);

  useEffect(() => {
    let stop = false;
    let timer: number | undefined;
    const poll = async () => {
      const next = await load();
      if (stop) return;
      // Keep watching while it's queued or running; waits and finished runs don't change on their own here.
      if (next && LIVE.has(next.execution.status)) timer = window.setTimeout(poll, 1200);
    };
    void poll();
    return () => { stop = true; window.clearTimeout(timer); };
  }, [load]);

  useEffect(() => {
    if (!detail?.execution.errorNode) return;
    setOpen((current) => (Object.keys(current).length ? current : { [detail.execution.errorNode!]: true }));
  }, [detail?.execution.errorNode]);

  const act = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    try {
      const result = await action();
      const next = (result as { executionId?: string })?.executionId;
      if (next && onOpenExecution) onOpenExecution(next);
      else await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That didn't work.");
    } finally {
      setBusy("");
    }
  };

  if (!detail) return <div className="p-4 text-sm text-slate-500" role="status">{error || "Loading the run…"}</div>;
  const { execution, nodes } = detail;
  const failedName = execution.errorNode ? nodes.find((node) => node.nodeId === execution.errorNode)?.name ?? detail.definition.nodes.find((node) => node.id === execution.errorNode)?.name : null;
  const total = execution.finishedAt && execution.startedAt ? execution.finishedAt - execution.startedAt : null;

  return (
    <section aria-label="Run details" className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-ink"><StatusPill status={execution.status} /> {execution.workflowName ?? "Run"} <span className="font-mono text-[11px] font-normal text-slate-500">{execution.id}</span></p>
          <p className="mt-1 text-xs text-slate-500">
            {({ manual: "Run by you", test: "Test run of the draft", schedule: "Scheduled", webhook: "Webhook", event: "HANNAH event", retry: "Retry" } as Record<string, string>)[execution.mode] ?? execution.mode}
            {" · "}started {when(execution.startedAt ?? execution.createdAt)} · {total !== null ? duration(total) : LIVE.has(execution.status) ? "running…" : "—"}
            {execution.retryOf && <> · retry of <button type="button" className="font-mono underline" onClick={() => onOpenExecution?.(execution.retryOf!)}>{execution.retryOf.slice(0, 14)}…</button></>}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {(LIVE.has(execution.status) || execution.status.startsWith("waiting")) && <button type="button" disabled={Boolean(busy)} className="btn-outline !py-1.5 text-xs text-rose-700" onClick={() => void act("cancel", () => WorkflowApi.cancel(execution.id))}><Square size={13} /> Cancel</button>}
          {["failed", "timed-out", "cancelled"].includes(execution.status) && execution.errorNode && <button type="button" disabled={Boolean(busy)} className="btn-outline !py-1.5 text-xs" onClick={() => void act("retry", () => WorkflowApi.retry(execution.id, "failed"))}><RotateCcw size={13} /> Retry from failed step</button>}
          {FINAL.has(execution.status) && <button type="button" disabled={Boolean(busy)} className="btn-ghost !py-1.5 text-xs" onClick={() => void act("rerun", () => WorkflowApi.retry(execution.id, "start"))}><RotateCcw size={13} /> Run again</button>}
          {onClose && <button type="button" className="btn-ghost !p-2" aria-label="Close run details" onClick={onClose}><X size={14} /></button>}
        </div>
      </header>

      {execution.error && (
        <div role="alert" className={`rounded-2xl border px-4 py-3 text-sm ${execution.status === "completed" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-rose-200 bg-rose-50 text-rose-800"}`}>
          {failedName && <p className="text-xs font-semibold uppercase tracking-wide">{execution.status === "completed" ? "Completed with errors" : `Failed at “${failedName}”`}</p>}
          <p className="mt-0.5">{execution.error}</p>
        </div>
      )}

      {execution.status === "completed" && emptyStops(detail.definition, nodes).map((stop) => (
        <div key={stop.nodeId} role="note" className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
          <p>“{stop.name}” returned nothing, so the {stop.skipped === 1 ? "step" : `${stop.skipped} steps`} after it didn't run.</p>
          <p className="mt-0.5 text-xs">That's expected when there was nothing to do. To run them anyway (for example to be told there's nothing today), use an Aggregate step right after it with “When nothing arrives” set to “Continue with an empty list”.</p>
        </div>
      ))}

      {execution.status === "waiting-approval" && execution.waiting && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-semibold text-amber-900">{execution.waiting.message ?? "This run is waiting for your approval."}</p>
          {execution.waiting.details !== undefined && execution.waiting.details !== null && <div className="mt-2"><Json value={execution.waiting.details} /></div>}
          <div className="mt-3 flex gap-2">
            <button type="button" disabled={Boolean(busy)} className="btn-primary !py-1.5 text-xs" onClick={() => void act("approve", () => WorkflowApi.answer(execution.id, true))}><Check size={13} /> Approve</button>
            <button type="button" disabled={Boolean(busy)} className="btn-outline !py-1.5 text-xs text-rose-700" onClick={() => void act("deny", () => WorkflowApi.answer(execution.id, false))}><X size={13} /> Deny</button>
          </div>
          {execution.waiting.until && <p className="mt-2 text-[11px] text-amber-900/80">Expires {when(execution.waiting.until)}.</p>}
        </div>
      )}
      {execution.status === "waiting" && execution.waiting && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          {execution.waiting.kind === "time" ? <>{execution.waiting.message && <span className="block font-semibold">{execution.waiting.message}</span>}Waiting until {when(execution.waiting.until)}, then it continues on its own.</> : execution.waiting.kind === "device" ? (
            <>
              <span className="block font-semibold">{execution.waiting.message ?? "Waiting for your desktop app."}</span>
              <span className="mt-1 block text-xs">It runs when the HANNAH desktop app is open and signed in to this account, with “Run workflow tasks” on in Settings → Desktop access; it asks you there first. If no desktop picks it up by {when(execution.waiting.until)}, the run stops.</span>
            </>
          ) : (
            <>
              Waiting for a request at this run's resume URL (expires {when(execution.waiting.until)}):
              {detail.resumeUrl && <span className="mt-2 flex items-center gap-2 font-mono text-[11px]"><span className="min-w-0 flex-1 truncate rounded-lg bg-white px-2 py-1">{detail.resumeUrl}</span><button type="button" className="btn-ghost !p-1.5" aria-label="Copy resume URL" onClick={() => void navigator.clipboard?.writeText(detail.resumeUrl!)}><Copy size={12} /></button></span>}
            </>
          )}
        </div>
      )}

      {error && <p role="alert" className="text-sm text-rose-700">{error}</p>}
      <ol className="space-y-2" aria-label="Steps">
        {nodes.map((run) => <NodeRow key={run.nodeId} run={run} open={Boolean(open[run.nodeId])} onToggle={() => setOpen((current) => ({ ...current, [run.nodeId]: !current[run.nodeId] }))} />)}
        {!nodes.length && <li className="text-sm text-slate-500">{LIVE.has(execution.status) ? "Starting…" : "No steps ran."}</li>}
      </ol>
    </section>
  );
}
