/**
 * Adding a device, without writing anything by hand.
 *
 * Three ways in, one way out:
 *   - pick a device from the list of profiles;
 *   - give HANNAH the device's manual, and check what it read;
 *   - describe the device yourself (the Hardware Studio).
 * Each ends with a device profile. Then the person enters how to reach the
 * device, and the hub checks it. Nothing is switched on here: that is a
 * separate step, after the check, on the device's own card.
 *
 * A manual's values are shown with the page and the line each came from, and
 * every one starts as unverified.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, FileText, Loader2, Plus, Trash2, Wrench } from "lucide-react";
import { AccountError } from "../services/Account";
import { Devices, type Compatibility, type Device, type Hub, type ManualAnalysis, type Profile, type SettingField } from "../services/Devices";

const button = "inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50";
const primary = "inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50";
const input = "w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900";
const heading = "text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500";
const message = (error: unknown) => (error instanceof Error ? error.message : "That didn't work.");
const LEVEL_TONE: Record<string, string> = {
  "plug-and-play": "border-emerald-200 bg-emerald-50 text-emerald-800", guided: "border-sky-200 bg-sky-50 text-sky-900", experimental: "border-amber-200 bg-amber-50 text-amber-900",
  simulation: "border-violet-200 bg-violet-50 text-violet-900", "developer-required": "border-slate-300 bg-slate-100 text-slate-800", unsupported: "border-rose-200 bg-rose-50 text-rose-800",
};

export function LevelChip({ compatibility }: { compatibility?: Compatibility }) {
  if (!compatibility) return null;
  return <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${LEVEL_TONE[compatibility.level] || LEVEL_TONE.unsupported}`} title={compatibility.reasons.join(" ")} data-testid="level">{compatibility.label}</span>;
}
const Problem = ({ children }: { children: ReactNode }) => <p className="flex items-start gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900" role="alert"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /><span>{children}</span></p>;

function toBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The file couldn't be read."));
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.readAsDataURL(file);
  });
}

/** Read a manual, show what was found with where it was found, and keep the proposed description if the person wants it. */
function ManualReader({ onProfile, onStudio }: { onProfile: (profile: Profile) => void; onStudio: () => void }) {
  const [file, setFile] = useState<{ name: string; data: string } | null>(null);
  const [analysis, setAnalysis] = useState<ManualAnalysis | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const read = async (chosen: File | undefined) => {
    if (!chosen) return;
    setBusy("Reading the document…"); setError(""); setAnalysis(null); setChecked([]);
    try {
      const data = await toBase64(chosen);
      setFile({ name: chosen.name, data });
      setAnalysis(await Devices.readManual(chosen.name, data));
    } catch (reason) { setError(message(reason)); } finally { setBusy(""); }
  };
  const keep = async () => {
    if (!file) return;
    setBusy("Keeping the description…"); setError("");
    try { onProfile((await Devices.keepManualProfile(file.name, file.data, checked)).profile); } catch (reason) { setError(message(reason)); } finally { setBusy(""); }
  };
  return (
    <div className="space-y-3" data-testid="manual-reader">
      <p className="text-sm text-slate-700">Give HANNAH the device's manual or datasheet (PDF, Word, text or an image of a label or diagram). It reads supported text and shows where each value came from. Images are shown as source evidence, but aren't interpreted yet. A manual can't prove the description is right; your hub checks that when it connects.</p>
      <label className="block text-sm font-medium text-slate-800">The manual
        <input type="file" accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg,.gif,.webp,image/png,image/jpeg,image/gif,image/webp" className="mt-1 block w-full text-sm" data-testid="manual-file" onChange={(event) => void read(event.target.files?.[0])} />
      </label>
      {busy && <p className="flex items-center gap-2 text-sm text-slate-700"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{busy}</p>}
      {error && <Problem>{error}</Problem>}
      {analysis && (
        <div className="space-y-3">
          <p className="text-sm text-slate-700" data-testid="manual-summary">Read {analysis.document.pagesWithText} of {analysis.document.pages} page{analysis.document.pages === 1 ? "" : "s"} of <span className="font-medium">{analysis.document.name}</span>. {analysis.facts.length} value{analysis.facts.length === 1 ? "" : "s"} found. {analysis.document.notes.join(" ")}</p>
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{analysis.reminder}</p>
          {analysis.document.kind === "image" && analysis.document.source && file && (
            <figure className="rounded-xl border border-slate-200 bg-slate-50 p-3" data-testid="manual-image-source">
              <img className="max-h-96 max-w-full rounded-lg object-contain" src={`data:${analysis.document.source.mediaType};base64,${file.data}`} alt={`Uninterpreted source image: ${analysis.document.source.name}`} />
              <figcaption className="mt-2 break-all text-xs text-slate-600">Source image · {analysis.document.source.mediaType} · SHA-256 {analysis.document.source.id}</figcaption>
            </figure>
          )}
          {analysis.facts.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm" data-testid="facts">
                <thead><tr className={heading}><th className="py-1 pr-3">What</th><th className="py-1 pr-3">Value</th><th className="py-1 pr-3">Page</th><th className="py-1 pr-3">The line it came from</th><th className="py-1">I checked it</th></tr></thead>
                <tbody>
                  {analysis.facts.map((fact) => (
                    <tr key={fact.id} className="border-t border-slate-100 align-top" data-testid="fact-row">
                      <td className="py-1.5 pr-3 text-slate-800">{fact.label}{fact.hazardous && <span className="ml-1 rounded bg-rose-100 px-1 text-xs font-medium text-rose-800">electrical</span>}</td>
                      <td className="py-1.5 pr-3 font-medium text-slate-900">{fact.shown || String(fact.value)}</td>
                      <td className="py-1.5 pr-3 text-slate-700">{fact.page}</td>
                      <td className="py-1.5 pr-3 text-slate-700"><q>{fact.quote}</q>{fact.note && <span className="mt-0.5 block text-xs text-rose-800">{fact.note}</span>}</td>
                      <td className="py-1.5"><input type="checkbox" aria-label={`I checked ${fact.label}`} checked={checked.includes(fact.id)} onChange={(event) => setChecked((list) => (event.target.checked ? [...list, fact.id] : list.filter((item) => item !== fact.id)))} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {analysis.proposal ? (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3" data-testid="manual-proposal">
              <p className="flex flex-wrap items-center gap-2 font-medium text-slate-900">Proposed: {analysis.proposal.public.manufacturer} {analysis.proposal.public.model} <LevelChip compatibility={analysis.proposal.compatibility} /></p>
              <p className="mt-1 text-sm text-slate-700">{analysis.proposal.public.protocol.label}. It would read: {analysis.proposal.public.points.map((point) => `${point.name}${point.unit ? ` (${point.unit})` : ""}`).join(", ")}. It would change nothing.</p>
              {analysis.proposal.notes.map((note) => <p key={note} className="mt-1 text-sm text-slate-700">• {note}</p>)}
              <button type="button" className={`${primary} mt-2`} disabled={Boolean(busy)} onClick={() => void keep()}>Keep this description and connect the device</button>
            </div>
          ) : (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3" data-testid="manual-missing">
              <p className="font-medium text-slate-900">HANNAH can't connect this device from its manual.</p>
              <ul className="mt-1 list-disc pl-5 text-sm text-slate-700">{analysis.missing.map((item) => <li key={item}>{item}</li>)}</ul>
              <button type="button" className={`${button} mt-2`} onClick={onStudio}><Wrench className="h-4 w-4" aria-hidden="true" />Describe it yourself instead</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type StudioPoint = { name: string; changes: boolean; type: "number" | "boolean"; unit: string; low: string; high: string; a: string; b: string; c: string; table: string; format: string; scale: string };
const blankPoint = (): StudioPoint => ({ name: "", changes: false, type: "number", unit: "", low: "", high: "", a: "", b: "", c: "", table: "holding", format: "uint16", scale: "" });
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^([^a-z])/, "p_$1").slice(0, 40);
const CATEGORY = [["sensor", "Sensor"], ["light", "Light"], ["switch", "Switch or plug"], ["fan", "Fan"], ["thermostat", "Thermostat"], ["appliance", "Appliance"], ["energy-meter", "Energy meter"], ["environment", "Environment monitor"], ["industrial-sensor", "Industrial sensor"], ["other", "Other"]];
const BROKER_FIELDS = [
  { id: "host", label: "Broker address", type: "text", required: true }, { id: "port", label: "Port", type: "number", default: 1883, min: 1, max: 65535 },
  { id: "username", label: "User name", type: "text" }, { id: "password", label: "Password", type: "secret" }, { id: "tls", label: "Encrypted (TLS)", type: "toggle", default: false },
];
const FIELDS: Record<string, unknown[]> = {
  mqtt: BROKER_FIELDS,
  "modbus-tcp": [{ id: "host", label: "Device address", type: "text", required: true }, { id: "port", label: "Port", type: "number", default: 502, min: 1, max: 65535 }, { id: "unit", label: "Unit number", type: "number", default: 1, min: 0, max: 255 }],
  http: [{ id: "url", label: "Device address (http://…)", type: "text", required: true }, { id: "username", label: "User name", type: "text" }, { id: "password", label: "Password", type: "secret" }],
};
const LABELS: Record<string, [string, string, string]> = { mqtt: ["Topic it reports on", "Field in the message (optional)", "Topic that changes it"], "modbus-tcp": ["Register address", "", ""], http: ["Path it reports on (/status)", "Field in the answer", "Path that changes it"] };

/** The description a person builds, as the profile the server checks. Exported so a test can check it against the server's validator. */
export function studioProfile(form: { name: string; maker: string; model: string; category: string; protocol: string }, points: StudioPoint[]) {
  const used = new Set<string>();
  return {
    format: 1, id: `user.studio.${slug(`${form.maker}_${form.model}`).replace(/_/g, "-") || "device"}`, version: "0.1.0", name: form.name.trim() || `${form.maker} ${form.model}`.trim(), author: "You", manufacturer: form.maker.trim(), model: form.model.trim(),
    category: form.category, domain: form.category === "industrial-sensor" || form.protocol === "modbus-tcp" ? "industrial" : "iot", protocol: { adapter: form.protocol },
    connection: { instructions: ["Connect the device to the same network as your hub.", "Enter how to reach it."], fields: FIELDS[form.protocol] },
    points: points.filter((point) => point.name.trim()).map((point) => {
      let id = slug(point.name) || "point";
      while (used.has(id)) id = `${id.slice(0, 36)}_${used.size}`;
      used.add(id);
      const number = point.type === "number";
      const range = number && point.low !== "" && point.high !== "" ? { range: [Number(point.low), Number(point.high)] } : {};
      const base = { id, name: point.name.trim(), kind: point.changes ? "actuator" : "sensor", type: point.type, access: point.changes ? "read-write" : "read", ...(number && point.unit.trim() ? { unit: point.unit.trim() } : {}), ...range };
      if (form.protocol === "modbus-tcp") return { ...base, binding: { register: { table: number ? point.table : point.table === "discrete" ? "discrete" : "coil", address: Number(point.a), ...(number ? { type: point.format } : {}), ...(number && point.scale ? { scale: Number(point.scale) } : {}) } } };
      if (form.protocol === "http") return { ...base, binding: { ...(point.a ? { state: { path: point.a, json: point.b } } : {}), ...(point.changes && point.c ? { command: { method: "POST", path: point.c, body: { value: "{value}" } } } : {}) } };
      return { ...base, binding: { ...(point.a ? { state: { topic: point.a, ...(point.b ? { json: point.b } : {}), ...(number ? {} : { on: "ON", off: "OFF" }) } } : {}), ...(point.changes && point.c ? { command: { topic: point.c, ...(number ? {} : { on: "ON", off: "OFF" }) } } : {}) } };
    }),
    constraints: form.protocol === "modbus-tcp" ? ["Modbus has no sign-in or encryption: anything on the same network can write to this device."] : [],
    permissions: ["network-local"], dependencies: [], tests: { level: "unit", passed: 0, total: 0, evidence: "" }, documentation: "Described by its owner in the Hardware Studio.",
  };
}

export type StudioSimulation = {
  status: "preview" | "refused";
  message: string;
  mapping?: { adapter: string; target: string; value: string };
};

/** Describe the command a draft profile would make, without contacting a hub or device. */
export function simulateStudioChange(profile: ReturnType<typeof studioProfile>, pointId: string, value: boolean | number): StudioSimulation {
  const point = profile.points.find((item) => item.id === pointId);
  if (!point) return { status: "refused", message: "Preview refused: choose an output in this profile." };
  if (point.access !== "read-write") return { status: "refused", message: `Preview refused: ${point.name} is read-only in this profile.` };
  if (point.type === "boolean" ? typeof value !== "boolean" : typeof value !== "number" || !Number.isFinite(value)) {
    return { status: "refused", message: `Preview refused: enter a ${point.type === "boolean" ? "state" : "number"} for ${point.name}.` };
  }
  if (point.type === "number") {
    const range = point.range;
    if (!range) return { status: "refused", message: `Preview refused: ${point.name} needs an allowed range before its value can be checked.` };
    const numericValue = Number(value);
    if (numericValue < range[0] || numericValue > range[1]) return { status: "refused", message: `Preview refused: ${numericValue} is outside ${point.name}'s allowed range of ${range[0]} to ${range[1]}.` };
  }

  const binding = point.binding as Record<string, unknown>;
  const adapter = profile.protocol.adapter;
  let target = "";
  let wireValue = "";
  if (adapter === "mqtt") {
    const command = binding.command as Record<string, unknown> | undefined;
    if (!command || typeof command.topic !== "string" || !command.topic.trim()) return { status: "refused", message: `Preview refused: ${point.name} has no MQTT command topic.` };
    target = `MQTT topic ${command.topic}`;
    if (point.type === "boolean") wireValue = String(value ? command.on ?? "ON" : command.off ?? "OFF");
    else {
      const scale = Number(command.scale) || 1;
      const raw = (Number(value) - (Number(command.offset) || 0)) / scale;
      wireValue = Number.isInteger(raw) ? String(raw) : String(Number(raw.toFixed(6)));
    }
    if (typeof command.json === "string" && command.json) wireValue = JSON.stringify({ [command.json]: point.type === "boolean" ? wireValue : Number(wireValue) });
  } else if (adapter === "http") {
    const command = binding.command as Record<string, unknown> | undefined;
    if (!command || typeof command.path !== "string" || !command.path.startsWith("/")) return { status: "refused", message: `Preview refused: ${point.name} has no valid HTTP command path.` };
    target = `${String(command.method || "POST").toUpperCase()} ${command.path}`;
    const body = command.body && typeof command.body === "object" ? command.body as Record<string, unknown> : {};
    const mapped = Object.fromEntries(Object.entries(body).map(([key, item]) => [key, item === "{value}" ? value : item]));
    wireValue = JSON.stringify(Object.keys(mapped).length ? mapped : { value });
  } else if (adapter === "modbus-tcp") {
    const register = binding.register as Record<string, unknown> | undefined;
    if (!register || !["coil", "holding"].includes(String(register.table))) return { status: "refused", message: `Preview refused: ${point.name} has no writable Modbus coil or holding register.` };
    target = `Modbus ${register.table} register ${String(register.address)}`;
    if (register.table === "coil") wireValue = String(Boolean(value));
    else {
      const scale = Number(register.scale) || 1;
      const raw = (Number(value) - (Number(register.offset) || 0)) / scale;
      wireValue = String(register.type === "float32" ? raw : Math.round(raw));
    }
  } else return { status: "refused", message: "Preview refused: this profile uses an adapter the Studio can't simulate." };

  const displayValue = typeof value === "boolean" ? (value ? "on" : "off") : `${value}${point.unit ? ` ${point.unit}` : ""}`;
  return {
    status: "preview",
    message: `Simulation only: ${point.name} would be requested at ${displayValue}. Nothing was sent, and this cannot confirm how the device will respond.`,
    mapping: { adapter, target, value: wireValue },
  };
}

/** Describe a device with form controls. The description is checked by the server before it can be used. */
function HardwareStudio({ onProfile, hubs = [], hub = "" }: { onProfile: (profile: Profile) => void; hubs?: Hub[]; hub?: string }) {
  const [form, setForm] = useState({ name: "", maker: "", model: "", category: "sensor", protocol: "mqtt" });
  const [points, setPoints] = useState<StudioPoint[]>([blankPoint()]);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [lookOpen, setLookOpen] = useState(false);
  const [lookHub, setLookHub] = useState(hub || (hubs[0]?.id || ""));
  const [lookHost, setLookHost] = useState("");
  const [lookPort, setLookPort] = useState("1883");
  const [lookUser, setLookUser] = useState("");
  const [lookPass, setLookPass] = useState("");
  const [lookTls, setLookTls] = useState(false);
  const [lookBusy, setLookBusy] = useState(false);
  const [lookTopics, setLookTopics] = useState<Array<{ topic: string; messages: number; sample?: string }> | null>(null);
  const [lookError, setLookError] = useState("");
  const [previewPointId, setPreviewPointId] = useState("");
  const [previewValue, setPreviewValue] = useState("");
  const [simulation, setSimulation] = useState<StudioSimulation | null>(null);
  const profile = useMemo(() => studioProfile(form, points), [form, points]);
  const previewPoints = profile.points.filter((point) => point.access === "read-write");
  const selectedPreviewPoint = previewPoints.find((point) => point.id === previewPointId);
  const change = (index: number, patch: Partial<StudioPoint>) => { setSimulation(null); setPoints((list) => list.map((point, at) => (at === index ? { ...point, ...patch } : point))); };
  const runPreview = () => {
    if (!selectedPreviewPoint || previewValue.trim() === "") return;
    const value = selectedPreviewPoint.type === "boolean" ? previewValue === "on" : Number(previewValue);
    setSimulation(simulateStudioChange(profile, previewPointId, value));
  };
  const look = async () => {
    if (!lookHub) return;
    setLookBusy(true); setLookError(""); setLookTopics(null);
    try {
      const answer = await Devices.look(lookHub, "mqtt", { host: lookHost.trim(), port: Number(lookPort) || undefined, username: lookUser.trim() || undefined, password: lookPass || undefined, tls: lookTls });
      setLookTopics(answer.discovered?.topics || []);
    } catch (reason) { setLookError(message(reason)); } finally { setLookBusy(false); }
  };
  const applyTopic = (topic: string) => {
    setSimulation(null);
    setPoints((list) => {
      const next = [...list];
      const index = next.findIndex((point) => !point.a.trim());
      const target = index === -1 ? next.length - 1 : index;
      if (target < 0) return list;
      next[target] = { ...next[target], a: topic };
      return next;
    });
  };
  const save = async () => {
    setBusy(true); setProblems([]);
    try { onProfile((await Devices.saveProfile(profile)).profile); } catch (reason) {
      const detail = reason instanceof AccountError && Array.isArray(reason.body?.problems) ? reason.body.problems.map(String) : [];
      setProblems(detail.length ? detail : [message(reason)]);
    } finally { setBusy(false); }
  };
  const labels = LABELS[form.protocol];
  return (
    <div className="space-y-3" data-testid="studio">
      <p className="text-sm text-slate-700">Describe the device with the values from its manual. HANNAH checks that the description is complete, then your hub checks that the device answers. HANNAH can't know whether what you entered matches the device: a wrong address reads the wrong thing.</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-sm text-slate-800">Maker<input className={input} value={form.maker} onChange={(event) => { setSimulation(null); setForm({ ...form, maker: event.target.value }); }} /></label>
        <label className="text-sm text-slate-800">Model<input className={input} value={form.model} onChange={(event) => { setSimulation(null); setForm({ ...form, model: event.target.value }); }} /></label>
        <label className="text-sm text-slate-800">What kind of device<select className={input} value={form.category} onChange={(event) => { setSimulation(null); setForm({ ...form, category: event.target.value }); }}>{CATEGORY.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="text-sm text-slate-800">How it talks<select className={input} value={form.protocol} onChange={(event) => { setSimulation(null); setPreviewPointId(""); setPreviewValue(""); setForm({ ...form, protocol: event.target.value }); setPoints([blankPoint()]); }}><option value="mqtt">MQTT</option><option value="modbus-tcp">Modbus TCP</option><option value="http">HTTP on the local network</option></select></label>
      </div>
      <p className={heading}>What it reports and what can be changed</p>
      {points.map((point, index) => (
        <fieldset key={index} className="space-y-2 rounded-xl border border-slate-200 p-3" data-testid="studio-point">
          <legend className="sr-only">Point {index + 1}</legend>
          <div className="grid gap-2 sm:grid-cols-4">
            <label className="text-sm text-slate-800 sm:col-span-2">Name<input className={input} placeholder="Temperature" value={point.name} onChange={(event) => change(index, { name: event.target.value })} /></label>
            <label className="text-sm text-slate-800">It is<select className={input} value={point.type} onChange={(event) => change(index, { type: event.target.value as StudioPoint["type"] })}><option value="number">a number</option><option value="boolean">on or off</option></select></label>
            <label className="flex items-end gap-2 pb-1.5 text-sm text-slate-800"><input type="checkbox" checked={point.changes} onChange={(event) => change(index, { changes: event.target.checked })} />HANNAH may change it</label>
          </div>
          <div className="grid gap-2 sm:grid-cols-4">
            {point.type === "number" && <label className="text-sm text-slate-800">Unit<input className={input} placeholder="°C" value={point.unit} onChange={(event) => change(index, { unit: event.target.value })} /></label>}
            {point.type === "number" && <label className="text-sm text-slate-800">Lowest<input className={input} inputMode="decimal" value={point.low} onChange={(event) => change(index, { low: event.target.value })} /></label>}
            {point.type === "number" && <label className="text-sm text-slate-800">Highest<input className={input} inputMode="decimal" value={point.high} onChange={(event) => change(index, { high: event.target.value })} /></label>}
            {form.protocol === "modbus-tcp" ? (
              <>
                <label className="text-sm text-slate-800">Table<select className={input} value={point.table} onChange={(event) => change(index, { table: event.target.value })}>{(point.type === "number" ? ["holding", "input"] : ["coil", "discrete"]).map((name) => <option key={name}>{name}</option>)}</select></label>
                <label className="text-sm text-slate-800">{labels[0]}<input className={input} inputMode="numeric" value={point.a} onChange={(event) => change(index, { a: event.target.value })} /></label>
                {point.type === "number" && <label className="text-sm text-slate-800">Number format<select className={input} value={point.format} onChange={(event) => change(index, { format: event.target.value })}>{["uint16", "int16", "uint32", "int32", "float32"].map((name) => <option key={name}>{name}</option>)}</select></label>}
                {point.type === "number" && <label className="text-sm text-slate-800">Multiply by<input className={input} inputMode="decimal" placeholder="0.1" value={point.scale} onChange={(event) => change(index, { scale: event.target.value })} /></label>}
              </>
            ) : (
              <>
                <label className="text-sm text-slate-800 sm:col-span-2">{labels[0]}<input className={input} value={point.a} onChange={(event) => change(index, { a: event.target.value })} /></label>
                <label className="text-sm text-slate-800">{labels[1]}<input className={input} value={point.b} onChange={(event) => change(index, { b: event.target.value })} /></label>
                {point.changes && <label className="text-sm text-slate-800 sm:col-span-2">{labels[2]}<input className={input} value={point.c} onChange={(event) => change(index, { c: event.target.value })} /></label>}
              </>
            )}
          </div>
          {points.length > 1 && <button type="button" className={button} onClick={() => { setSimulation(null); setPoints((list) => list.filter((_item, at) => at !== index)); }}><Trash2 className="h-4 w-4" aria-hidden="true" />Remove this one</button>}
        </fieldset>
      ))}
      <button type="button" className={button} onClick={() => { setSimulation(null); setPoints((list) => [...list, blankPoint()]); }}><Plus className="h-4 w-4" aria-hidden="true" />Add another</button>
      <section className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3" data-testid="studio-simulation">
        <p className={heading}>Try a change before connecting it</p>
        <p className="text-sm text-slate-700">This local preview checks the profile's allowed value and shows the command it describes. It never contacts a hub or device. After connecting, a real change still needs the usual approval and device readback.</p>
        {previewPoints.length ? (
          <div className="grid gap-2 sm:grid-cols-3">
            <label className="text-sm text-slate-800">Point to preview<select className={input} aria-label="Point to preview" value={previewPointId} onChange={(event) => { setPreviewPointId(event.target.value); setPreviewValue(""); setSimulation(null); }}><option value="">Choose an output</option>{previewPoints.map((point) => <option key={point.id} value={point.id}>{point.name}</option>)}</select></label>
            {selectedPreviewPoint?.type === "boolean" ? (
              <label className="text-sm text-slate-800">Requested state<select className={input} aria-label="Preview value" value={previewValue} onChange={(event) => { setPreviewValue(event.target.value); setSimulation(null); }}><option value="">Choose a state</option><option value="on">On</option><option value="off">Off</option></select></label>
            ) : <label className="text-sm text-slate-800">Requested value{selectedPreviewPoint?.unit ? ` (${selectedPreviewPoint.unit})` : ""}<input className={input} aria-label="Preview value" inputMode="decimal" value={previewValue} onChange={(event) => { setPreviewValue(event.target.value); setSimulation(null); }} /></label>}
            <div className="flex items-end"><button type="button" className={button} disabled={!selectedPreviewPoint || previewValue.trim() === ""} onClick={runPreview}>Preview change</button></div>
          </div>
        ) : <p className="text-sm text-slate-600">Add an output and allow it to change to preview a command.</p>}
        {simulation && <div className={`rounded-lg border px-3 py-2 text-sm ${simulation.status === "preview" ? "border-slate-300 bg-white text-slate-800" : "border-rose-200 bg-rose-50 text-rose-900"}`} role={simulation.status === "preview" ? "status" : "alert"} data-result={simulation.status}>
          <p>{simulation.message}</p>
          {simulation.mapping && <p className="mt-1 font-mono text-xs" data-testid="studio-simulation-mapping">{simulation.mapping.adapter} · {simulation.mapping.target} · {simulation.mapping.value}</p>}
        </div>}
      </section>
      {form.protocol === "mqtt" && hubs.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3" data-testid="studio-broker-look">
          <button type="button" className={button} onClick={() => setLookOpen((value) => !value)} data-testid="studio-look-broker">Look at a broker's topics</button>
          {lookOpen && (
            <div className="mt-2 space-y-2">
              {hubs.length > 1 && <label className="block text-sm text-slate-800">Hub<select className={input} value={lookHub} onChange={(event) => setLookHub(event.target.value)}>{hubs.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="block text-sm text-slate-800">Broker address<input className={input} data-testid="studio-look-host" value={lookHost} onChange={(event) => setLookHost(event.target.value)} /></label>
                <label className="block text-sm text-slate-800">Port<input className={input} data-testid="studio-look-port" inputMode="numeric" value={lookPort} onChange={(event) => setLookPort(event.target.value)} /></label>
                <label className="block text-sm text-slate-800">User name (optional)<input className={input} value={lookUser} onChange={(event) => setLookUser(event.target.value)} /></label>
                <label className="block text-sm text-slate-800">Password (optional)<input className={input} type="password" value={lookPass} onChange={(event) => setLookPass(event.target.value)} /></label>
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-800"><input type="checkbox" checked={lookTls} onChange={(event) => setLookTls(event.target.checked)} />Encrypted (TLS)</label>
              <button type="button" className={primary} disabled={lookBusy || !lookHost.trim() || !lookHub} data-testid="studio-look-submit" onClick={() => void look()}>{lookBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}Look</button>
              {lookError && <Problem>{lookError}</Problem>}
              {lookTopics && (
                <div data-testid="studio-broker-topics">
                  <p className="text-sm text-slate-700">{lookTopics.length} topic{lookTopics.length === 1 ? "" : "s"} heard. Click one to use it for a reading.</p>
                  <ul className="mt-1 space-y-0.5 text-sm text-slate-800">{lookTopics.map((item) => <li key={item.topic}><button type="button" className="font-mono text-xs text-sky-800 underline" data-testid="studio-broker-topic" onClick={() => applyTopic(item.topic)}>{item.topic}</button></li>)}</ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {problems.length > 0 && <Problem><span data-testid="studio-problems">{problems.join(" ")}</span></Problem>}
      <div><button type="button" className={primary} disabled={busy || !form.maker.trim() || !form.model.trim()} onClick={() => void save()}>Save the description and connect the device</button></div>
      <details className="text-sm text-slate-700"><summary className="cursor-pointer">Developer mode: the description HANNAH will check</summary><pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100" data-testid="studio-json">{JSON.stringify(profile, null, 2)}</pre></details>
    </div>
  );
}

function SettingInput({ field, value, onChange }: { field: SettingField; value: string | boolean; onChange: (value: string | boolean) => void }) {
  const idFor = `setting-${field.id}`;
  if (field.type === "toggle") return <label className="flex items-center gap-2 text-sm text-slate-800"><input id={idFor} data-testid={idFor} type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />{field.label}</label>;
  return (
    <label className="block text-sm text-slate-800" htmlFor={idFor}>{field.label}{field.required ? "" : " (optional)"}
      {field.type === "choice"
        ? <select id={idFor} data-testid={idFor} className={input} value={String(value)} onChange={(event) => onChange(event.target.value)}>{(field.choices || []).map((choice) => <option key={choice}>{choice}</option>)}</select>
        : <input id={idFor} data-testid={idFor} className={input} type={field.type === "secret" ? "password" : "text"} inputMode={field.type === "number" ? "numeric" : undefined} autoComplete="off" value={String(value)} onChange={(event) => onChange(event.target.value)} />}
      {field.help && <span className="mt-0.5 block text-xs text-slate-600">{field.help}</span>}
    </label>
  );
}

/** The whole "add a device" flow. `onAdded` is called with the device once the hub has checked it (or failed to). */
export default function DeviceSetup({ hubs, onAdded, onCancel, initialProfileId }: { hubs: Hub[]; onAdded: (device: Device) => void; onCancel: () => void; initialProfileId?: string }) {
  const usable = hubs.filter((hub) => hub.status === "enrolled");
  const [way, setWay] = useState<"list" | "manual" | "studio">("list");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [hub, setHub] = useState(usable[0]?.id || "");
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [settings, setSettings] = useState<Record<string, string | boolean>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const choose = (chosen: Profile) => {
    setProfile(chosen); setError("");
    setName((current) => current || chosen.model);
    setSettings(Object.fromEntries(chosen.connection.fields.map((field) => [field.id, field.type === "toggle" ? field.default === true : field.default === undefined ? "" : String(field.default)])));
  };
  useEffect(() => {
    void Devices.profiles().then((answer) => {
      setProfiles(answer.profiles);
      const preselected = answer.profiles.find((item) => item.id === initialProfileId);
      if (preselected && !["developer-required", "unsupported"].includes(preselected.compatibility?.level || "")) choose(preselected);
    }).catch((reason) => setError(message(reason)));
  }, [initialProfileId]);
  const add = async () => {
    if (!profile) return;
    setBusy("Adding the device…"); setError("");
    try {
      const { device } = await Devices.add({ hub, profileId: profile.id, name, location, settings });
      setBusy("Your hub is connecting to it and listening. This takes a few seconds…");
      const tested = await Devices.test(device.id).catch(() => null);
      onAdded(tested?.device || device);
    } catch (reason) { setError(message(reason)); } finally { setBusy(""); }
  };
  if (!usable.length) return <p className="text-sm text-slate-700">Add a hub first. A device is reached through a hub on the same network.</p>;
  return (
    <div className="space-y-4" data-testid="device-setup">
      {!profile ? (
        <>
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="How to add the device">
            {([["list", "Pick from the list"], ["manual", "Use its manual"], ["studio", "Describe it yourself"]] as const).map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={way === id} className={way === id ? primary : button} onClick={() => setWay(id)}>{id === "manual" && <FileText className="h-4 w-4" aria-hidden="true" />}{id === "studio" && <Wrench className="h-4 w-4" aria-hidden="true" />}{label}</button>)}
          </div>
          {way === "list" && (
            <ul className="grid gap-2 sm:grid-cols-2">
              {profiles.map((item) => {
                const blocked = ["developer-required", "unsupported"].includes(item.compatibility?.level || "");
                return (
                  <li key={item.id}>
                    <button type="button" className="w-full rounded-xl border border-slate-200 bg-white p-3 text-left hover:border-slate-400 disabled:opacity-60" disabled={blocked} onClick={() => choose(item)} data-testid="profile-option">
                      <span className="flex flex-wrap items-center gap-2 font-medium text-slate-900">{item.name} <LevelChip compatibility={item.compatibility} /></span>
                      <span className="mt-0.5 block text-sm text-slate-700">{item.manufacturer} {item.model} · {item.categoryLabel} · {item.protocol.label}</span>
                      <span className="mt-0.5 block text-xs text-slate-600">{item.compatibility?.reasons.join(" ")}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {way === "manual" && <ManualReader onProfile={choose} onStudio={() => setWay("studio")} />}
          {way === "studio" && <HardwareStudio onProfile={choose} hubs={usable} hub={hub} />}
        </>
      ) : (
        <div className="space-y-3">
          <p className="flex flex-wrap items-center gap-2 font-medium text-slate-900">{profile.manufacturer} {profile.model} <LevelChip compatibility={profile.compatibility} /><button type="button" className="text-sm font-normal text-sky-800 underline" onClick={() => setProfile(null)}>choose another</button></p>
          <ol className="list-decimal space-y-0.5 pl-5 text-sm text-slate-700">{profile.connection.instructions.map((line) => <li key={line}>{line}</li>)}</ol>
          {profile.constraints.map((line) => <p key={line} className="flex items-start gap-1.5 text-sm text-amber-900"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />{line}</p>)}
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block text-sm text-slate-800">What to call it<input className={input} data-testid="device-name" value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label className="block text-sm text-slate-800">Where it is (optional)<input className={input} value={location} onChange={(event) => setLocation(event.target.value)} /></label>
            {usable.length > 1 && <label className="block text-sm text-slate-800">Reached through<select className={input} value={hub} onChange={(event) => setHub(event.target.value)}>{usable.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
            {profile.connection.fields.map((field) => <SettingInput key={field.id} field={field} value={settings[field.id] ?? ""} onChange={(value) => setSettings((current) => ({ ...current, [field.id]: value }))} />)}
          </div>
          {error && <Problem>{error}</Problem>}
          {busy && <p className="flex items-center gap-2 text-sm text-slate-700"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{busy}</p>}
          <button type="button" className={primary} disabled={Boolean(busy) || !name.trim()} onClick={() => void add()}>Add it and check the connection</button>
        </div>
      )}
      {!profile && error && <Problem>{error}</Problem>}
      <button type="button" className={button} onClick={onCancel}>Cancel</button>
    </div>
  );
}
