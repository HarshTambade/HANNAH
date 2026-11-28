/**
 * The Device Intelligence Graph as a readable list: entities grouped by type,
 * each one's relationships as sentences ("Chiller 3 —LOCATED_IN→ Plant room
 * B"), its history, and the context answer for a sensor or device (machine,
 * place, robots, approved workflows), where every robot, device and workflow
 * was checked against its live source just now (server/graph).
 *
 * Entities derived from robots, hubs, devices and workflows are refreshed
 * from those records; people add machines, places and relationships here.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { GitBranch, Loader2, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { DeviceGraph, type GraphContext, type GraphEdge, type GraphNode, type GraphSchema } from "../../services/EdgeGraph";

const card = "rounded-2xl border border-slate-200 bg-white p-4 shadow-sm";
const heading = "text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500";
const button = "inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50";
const input = "rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900";
const message = (error: unknown) => (error instanceof Error ? error.message : "That didn't work.");
const LABEL_TONE: Record<string, string> = { current: "bg-emerald-50 text-emerald-800 border-emerald-200", "not current": "bg-amber-50 text-amber-900 border-amber-200", recorded: "bg-slate-100 text-slate-700 border-slate-200" };

function LiveBadge({ node }: { node: GraphNode }) {
  if (!node.label || !node.live) return null;
  return <span className={`rounded-full border px-1.5 py-0.5 text-[11px] ${LABEL_TONE[node.label]}`} title={node.live.detail}>{node.label}</span>;
}

export function ContextView({ context }: { context: GraphContext }) {
  const group = (title: string, nodes: GraphNode[]) => (
    <div>
      <p className={heading}>{title}</p>
      {nodes.length === 0 ? <p className="text-sm text-slate-500">None recorded.</p> : (
        <ul className="space-y-0.5 text-sm">
          {nodes.map((node) => <li key={node.id} className="flex flex-wrap items-center gap-1.5"><span className="font-medium text-slate-900">{node.name}</span><LiveBadge node={node} /><span className="text-xs text-slate-600">{node.live?.detail}</span></li>)}
        </ul>
      )}
    </div>
  );
  return (
    <div className="space-y-2 rounded-xl border border-sky-200 bg-sky-50/50 p-3" data-testid="graph-context">
      <p className="text-sm text-slate-800">{context.summary}</p>
      {group("Equipment", context.machines)}
      {group("Location", context.places)}
      {group("Robots there", context.robots)}
      {group("Workflows", context.workflows)}
      <p className="text-xs text-slate-600">{context.note}</p>
    </div>
  );
}

export function DeviceGraphPanel() {
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [schema, setSchema] = useState<GraphSchema | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [context, setContext] = useState<GraphContext | null>(null);
  const [history, setHistory] = useState<Awaited<ReturnType<typeof DeviceGraph.history>> | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [draft, setDraft] = useState({ type: "machine", name: "" });
  const [link, setLink] = useState({ type: "LOCATED_IN", to: "" });

  const load = useCallback(async () => {
    try {
      const graph = await DeviceGraph.list();
      setNodes(graph.nodes);
      setEdges(graph.edges);
      setError("");
    } catch (failure) {
      setError(message(failure));
    }
  }, []);
  useEffect(() => {
    void load();
    DeviceGraph.schema().then(setSchema).catch((failure) => setError(message(failure)));
  }, [load]);

  const run = async (label: string, work: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await work();
      setError("");
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy("");
    }
  };

  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const groups = useMemo(() => {
    const wanted = filter.trim().toLowerCase();
    const out = new Map<string, GraphNode[]>();
    for (const node of nodes) {
      if (wanted && !node.name.toLowerCase().includes(wanted) && !node.typeLabel.toLowerCase().includes(wanted)) continue;
      out.set(node.typeLabel, [...(out.get(node.typeLabel) || []), node]);
    }
    return [...out.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [nodes, filter]);
  const current = selected ? byId.get(selected) || null : null;
  const relations = current ? edges.filter((edge) => edge.from === current.id || edge.to === current.id) : [];
  const allowed = useMemo(() => (schema && current ? schema.relations.filter((rel) => rel.from.includes(current.type)) : []), [schema, current]);
  const targets = useMemo(() => {
    const rel = schema?.relations.find((item) => item.id === link.type);
    return rel && current ? nodes.filter((node) => node.id !== current.id && rel.to.includes(node.type)) : [];
  }, [schema, link.type, nodes, current]);

  const choose = (id: string) => { setSelected(id); setContext(null); setHistory(null); };

  return (
    <section className={`${card} space-y-3`} aria-labelledby="device-graph-title" data-testid="device-graph-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="device-graph-title" className="flex items-center gap-2 font-semibold text-slate-900"><GitBranch className="h-4 w-4" aria-hidden="true" />Device graph</h2>
        <button type="button" className={button} disabled={Boolean(busy)} onClick={() => void run("populate", async () => { await DeviceGraph.populate(); await load(); })}>
          {busy === "populate" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}Refresh from robots and devices
        </button>
      </div>
      <p className="text-sm text-slate-600">How your robots, devices, machines, places and workflows relate. Add machines and places, link them, then ask a sensor what it affects.</p>
      {error && <p className="text-sm text-rose-700" role="alert">{error}</p>}

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div className="space-y-2">
          <label className="flex items-center gap-2"><Search className="h-4 w-4 text-slate-500" aria-hidden="true" /><span className="sr-only">Filter entities</span><input className={`${input} w-full`} value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter by name or type" /></label>
          {nodes.length === 0 && <p className="text-sm text-slate-600">The graph is empty. Refresh it from your robots and devices, or add an entity.</p>}
          <div className="max-h-96 space-y-2 overflow-y-auto pr-1">
            {groups.map(([label, items]) => (
              <div key={label}>
                <p className={heading}>{label} ({items.length})</p>
                <ul className="mt-0.5 space-y-0.5">
                  {items.map((node) => (
                    <li key={node.id}>
                      <button type="button" onClick={() => choose(node.id)} className={`w-full rounded-lg px-2 py-1 text-left text-sm ${selected === node.id ? "bg-slate-900 text-white" : "bg-slate-50 text-slate-800 hover:bg-slate-100"}`}>
                        {node.name}{node.derived && <span className={`ml-1 text-[11px] ${selected === node.id ? "text-slate-300" : "text-slate-500"}`}>from {node.source.slice(5)}</span>}{node.scope.team && <span className="ml-1 text-[11px]">· team</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <form className="flex flex-wrap items-center gap-1.5" onSubmit={(event) => { event.preventDefault(); if (!draft.name.trim()) return; void run("add", async () => { const { node } = await DeviceGraph.addNode(draft); setDraft({ ...draft, name: "" }); await load(); choose(node.id); }); }}>
            <label className="sr-only" htmlFor="graph-new-type">Entity type</label>
            <select id="graph-new-type" className={input} value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value })}>
              {(schema?.entities || []).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
            <label className="sr-only" htmlFor="graph-new-name">Name</label>
            <input id="graph-new-name" className={`${input} min-w-0 flex-1`} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Name, e.g. Chiller 3" />
            <button type="submit" className={button} disabled={Boolean(busy) || !draft.name.trim()}><Plus className="h-4 w-4" aria-hidden="true" />Add</button>
          </form>
        </div>

        <div className="space-y-2">
          {!current ? <p className="text-sm text-slate-600">Choose an entity to see its relationships.</p> : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-semibold text-slate-900">{current.name}</h3>
                <span className="text-xs text-slate-600">{current.typeLabel} · {current.derived ? `derived from your ${current.source.slice(5)} records` : "added by a person"}</span>
                {!current.derived && <button type="button" className={`${button} ml-auto`} disabled={Boolean(busy)} onClick={() => void run("remove", async () => { await DeviceGraph.removeNode(current.id); setSelected(null); await load(); })}><Trash2 className="h-4 w-4" aria-hidden="true" />Remove</button>}
              </div>
              <div>
                <p className={heading}>Relationships</p>
                {relations.length === 0 ? <p className="text-sm text-slate-500">None yet.</p> : (
                  <ul className="space-y-0.5 text-sm">
                    {relations.map((edge) => (
                      <li key={edge.id} className="flex items-center gap-1.5 rounded-lg bg-slate-50 px-2 py-1">
                        <button type="button" className="font-medium text-slate-900 hover:underline" onClick={() => choose(edge.from)}>{byId.get(edge.from)?.name || "?"}</button>
                        <span className="font-mono text-xs text-slate-600">—{edge.type}{edge.typeVersion !== edge.currentTypeVersion ? ` v${edge.typeVersion}` : ""}→</span>
                        <button type="button" className="font-medium text-slate-900 hover:underline" onClick={() => choose(edge.to)}>{byId.get(edge.to)?.name || "?"}</button>
                        {!edge.derived && <button type="button" className="ml-auto text-slate-500 hover:text-rose-700" aria-label={`Remove ${edge.type}`} disabled={Boolean(busy)} onClick={() => void run("unlink", async () => { await DeviceGraph.removeEdge(edge.id); await load(); })}><Trash2 className="h-3.5 w-3.5" aria-hidden="true" /></button>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {allowed.length > 0 && (
                <form className="flex flex-wrap items-center gap-1.5" onSubmit={(event) => { event.preventDefault(); if (!link.to) return; void run("link", async () => { await DeviceGraph.addEdge({ type: link.type, from: current.id, to: link.to }); setLink({ ...link, to: "" }); await load(); }); }}>
                  <label className="sr-only" htmlFor="graph-link-type">Relationship</label>
                  <select id="graph-link-type" className={input} value={allowed.some((rel) => rel.id === link.type) ? link.type : ""} onChange={(event) => setLink({ type: event.target.value, to: "" })}>
                    {!allowed.some((rel) => rel.id === link.type) && <option value="">Relationship…</option>}
                    {allowed.map((rel) => <option key={rel.id} value={rel.id} title={rel.description}>{rel.id}</option>)}
                  </select>
                  <label className="sr-only" htmlFor="graph-link-to">To</label>
                  <select id="graph-link-to" className={`${input} min-w-0 flex-1`} value={link.to} onChange={(event) => setLink({ ...link, to: event.target.value })}>
                    <option value="">{targets.length ? "Choose…" : "No entity of a matching type"}</option>
                    {targets.map((node) => <option key={node.id} value={node.id}>{node.name} ({node.typeLabel})</option>)}
                  </select>
                  <button type="submit" className={button} disabled={Boolean(busy) || !link.to}>Link</button>
                </form>
              )}
              <div className="flex flex-wrap gap-2">
                <button type="button" className={button} disabled={Boolean(busy)} onClick={() => void run("context", async () => setContext(await DeviceGraph.context(current.id)))}>{busy === "context" && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}What does this affect?</button>
                <button type="button" className={button} disabled={Boolean(busy)} onClick={() => void run("history", async () => setHistory(await DeviceGraph.history(current.id)))}>History</button>
              </div>
              {context && <ContextView context={context} />}
              {history && (
                <div className="space-y-1 text-xs text-slate-700" data-testid="graph-history">
                  <p className={heading}>Versions</p>
                  <ul>{history.versions.map((item) => <li key={item.version}>v{item.version} “{item.name}” from {new Date(item.validFrom).toLocaleString()}{item.validTo ? ` to ${new Date(item.validTo).toLocaleString()}` : " (current record)"} · {item.source}</li>)}</ul>
                  <p className={heading}>Relationships over time</p>
                  <ul>{history.edges.map((edge) => <li key={edge.id}>{edge.fromName} —{edge.type}→ {edge.toName}: {new Date(edge.validFrom).toLocaleString()}{edge.validTo ? ` to ${new Date(edge.validTo).toLocaleString()}` : " onward"} · {edge.source}</li>)}</ul>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

export default DeviceGraphPanel;
