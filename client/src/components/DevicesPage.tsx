/**
 * Devices: the hubs on your network, the devices behind them, what each
 * reports, what HANNAH may change, and the automations a hub runs by itself.
 *
 * Everything shown is the server's record of what a hub reported
 * (services/Devices.ts → server/devices). The screen changes nothing itself:
 * it asks through the Action Engine, shows the approval a change needs, and
 * then shows what the device reported.
 *
 * Three things are always visible, because confusing them would matter:
 *   - whether a device is SIMULATED or real, and how far its description was
 *     tested (its compatibility level);
 *   - whether a value is live or only the last one known, and how old it is;
 *   - that HANNAH is not a safety system.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, CircleSlash, Clock, HelpCircle, Loader2, PauseCircle, PlayCircle, Plug, Plus, Router, Trash2, XCircle } from "lucide-react";
import { ACCOUNT_EVENT, isAccountSession } from "../services/api";
import { Operator, type ActionRecord } from "../services/Operator";
import { Devices, type Automation, type AutomationInput, type Check, type Device, type DeviceEvent, type Hub, type HubEnrollment, type Overview, type PointInfo, type RulePart } from "../services/Devices";
import DeviceSetup, { LevelChip } from "./DeviceSetup";
import { QrScanner } from "./QrScanner";

const card = "rounded-2xl border border-slate-200 bg-white p-4 shadow-sm";
const button = "inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50";
const primary = "inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50";
const input = "w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900";
const heading = "text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500";
const chip = "rounded-full border px-2 py-0.5 text-xs font-medium";
const message = (error: unknown) => (error instanceof Error ? error.message : "That didn't work.");
const clock = (at: number | null | undefined) => (at ? new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "never");
const ago = (seconds: number) => (seconds < 90 ? `${seconds} s ago` : seconds < 5400 ? `${Math.round(seconds / 60)} min ago` : `${Math.round(seconds / 3600)} h ago`);
const shown = (value: boolean | number | string | null | undefined, unit?: string | null) => (value === null || value === undefined ? "–" : typeof value === "boolean" ? (value ? "On" : "Off") : `${value}${unit ? ` ${unit}` : ""}`);
const HUB_STATE: Record<Hub["connection"], { label: string; tone: string }> = {
  online: { label: "Connected", tone: "border-emerald-200 bg-emerald-50 text-emerald-800" }, offline: { label: "Offline", tone: "border-amber-200 bg-amber-50 text-amber-900" },
  "never-connected": { label: "Enrolled, never connected", tone: "border-slate-200 bg-slate-100 text-slate-800" }, "awaiting-enrollment": { label: "Waiting to enroll", tone: "border-sky-200 bg-sky-50 text-sky-900" },
  revoked: { label: "Access revoked", tone: "border-rose-200 bg-rose-50 text-rose-800" },
};
const DEVICE_STATE: Record<Device["connection"], { label: string; tone: string }> = {
  online: { label: "Reporting", tone: "border-emerald-200 bg-emerald-50 text-emerald-800" }, offline: { label: "The device says it is offline", tone: "border-amber-200 bg-amber-50 text-amber-900" },
  "no-data": { label: "Connected, nothing heard yet", tone: "border-amber-200 bg-amber-50 text-amber-900" }, error: { label: "Can't be reached", tone: "border-rose-200 bg-rose-50 text-rose-800" },
  waiting: { label: "Waiting for its hub's report", tone: "border-slate-200 bg-slate-100 text-slate-800" }, "hub-offline": { label: "Its hub is offline", tone: "border-amber-200 bg-amber-50 text-amber-900" },
  "not-running": { label: "Not switched on", tone: "border-slate-200 bg-slate-100 text-slate-800" },
};
const RESULT: Record<Check["result"], { Icon: typeof Clock; tone: string; label: string }> = {
  pass: { Icon: CheckCircle2, tone: "text-emerald-700", label: "Passed" }, fail: { Icon: XCircle, tone: "text-rose-700", label: "Failed" }, warn: { Icon: AlertTriangle, tone: "text-amber-700", label: "Warning" },
  note: { Icon: AlertTriangle, tone: "text-amber-700", label: "Note" }, "not-checked": { Icon: HelpCircle, tone: "text-slate-500", label: "Not checked" },
};

const Notice = ({ tone = "slate", children }: { tone?: "slate" | "rose" | "amber" | "emerald"; children: ReactNode }) => {
  const tones = { slate: "border-slate-200 bg-slate-50 text-slate-800", rose: "border-rose-200 bg-rose-50 text-rose-900", amber: "border-amber-200 bg-amber-50 text-amber-900", emerald: "border-emerald-200 bg-emerald-50 text-emerald-900" };
  return <p className={`rounded-lg border px-3 py-2 text-sm ${tones[tone]}`} role={tone === "rose" ? "alert" : "status"}>{children}</p>;
};

function Approval({ record, onChanged }: { record: ActionRecord; onChanged: (record: ActionRecord | null) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const answer = async (approve: boolean) => {
    setBusy(true); setError("");
    let decided: ActionRecord | null = null;
    try { decided = await Operator.decide(record.id, approve); } catch (reason) { setError(message(reason)); } finally { setBusy(false); onChanged(decided); }
  };
  return (
    <div className="rounded-xl border border-sky-300 bg-sky-50 p-3" data-testid="device-approval">
      <p className="font-medium text-slate-900">{record.preview?.title}</p>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 text-sm text-slate-800">{(record.preview?.lines || []).map((line) => <div key={line.label} className="contents"><dt className="text-slate-600">{line.label}</dt><dd>{line.value}</dd></div>)}</dl>
      {record.preview?.body && <p className="mt-1 text-sm text-slate-700">{record.preview.body}</p>}
      {(record.preview?.warnings || []).map((warning) => <p key={warning} className="mt-1 flex items-start gap-1.5 text-sm text-amber-900"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />{warning}</p>)}
      <p className="mt-1 text-xs text-slate-600">{record.permission?.reason}</p>
      {error && <Notice tone="rose">{error}</Notice>}
      <div className="mt-2 flex gap-2">
        <button type="button" className={primary} disabled={busy} onClick={() => void answer(true)}>Approve</button>
        <button type="button" className={button} disabled={busy} onClick={() => void answer(false)}>Decline</button>
      </div>
    </div>
  );
}

function Verification({ device }: { device: Device }) {
  const report = device.verification;
  if (!report) return null;
  const summary = report.level === "verified" ? "The hub reached the device and heard every reading." : report.level === "partial" ? `The hub reached the device and heard ${report.heard} of ${report.expected} readings.` : "The hub could not reach the device, or heard nothing.";
  return (
    <div data-testid="verification" data-level={report.level}>
      <p className="text-sm font-medium text-slate-900">{summary} <span className="font-normal text-slate-600">Checked at {clock(report.at)}{report.simulated ? "; a simulated device" : ""}.</span></p>
      <ul className="mt-1 space-y-0.5 text-sm">
        {report.checks.map((check) => { const { Icon, tone, label } = RESULT[check.result]; return <li key={check.id} className="flex items-start gap-1.5" data-testid={`check-${check.id}`} data-result={check.result}><Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone}`} aria-label={label} /><span className="text-slate-800"><span className="font-medium">{check.label}.</span> {check.detail}</span></li>; })}
      </ul>
    </div>
  );
}

function PointRow({ device, point, ask, busy }: { device: Device; point: PointInfo; ask: (point: string, value: boolean | number) => void; busy: boolean }) {
  const reading = device.points[point.id];
  const allowed = point.access === "read-write" && device.writable.includes(point.id);
  const [level, setLevel] = useState("");
  const usable = device.status === "active" && device.connection === "online";
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-1.5" data-testid={`point-${point.id}`}>
      <span className="text-sm text-slate-800">{point.name}{point.risk && point.risk !== "low" && <span className="ml-1.5 rounded bg-amber-100 px-1 text-xs font-medium text-amber-900">{point.risk} risk: always asks</span>}</span>
      <span className="flex flex-wrap items-center gap-2">
        <span className="text-right">
          <span className="font-semibold text-slate-900" data-testid={`value-${point.id}`}>{shown(reading?.value, point.unit)}</span>
          {reading && <span className={`ml-2 text-xs ${reading.live ? "text-emerald-700" : "text-amber-800"}`} data-testid={`age-${point.id}`}>{reading.live ? "live" : `last known, ${ago(reading.ageS)}`}</span>}
        </span>
        {allowed && point.type === "boolean" && <button type="button" className={button} disabled={busy || !usable} data-testid={`switch-${point.id}`} onClick={() => ask(point.id, !(reading?.value === true))}>Switch {reading?.value === true ? "off" : "on"}</button>}
        {allowed && point.type === "number" && (
          <span className="flex items-center gap-1">
            <input className={`${input} w-24`} inputMode="decimal" aria-label={`New ${point.name}`} placeholder={point.range ? `${point.range[0]}–${point.range[1]}` : ""} value={level} onChange={(event) => setLevel(event.target.value)} />
            <button type="button" className={button} disabled={busy || !usable || level.trim() === "" || !Number.isFinite(Number(level))} data-testid={`set-${point.id}`} onClick={() => ask(point.id, Number(level))}>Set</button>
          </span>
        )}
      </span>
    </li>
  );
}

function DeviceCard({ device, onChanged, onRecord }: { device: Device; onChanged: () => void; onRecord: (record: ActionRecord) => void }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const changeable = device.profile.points.filter((point) => point.access === "read-write");
  const [allow, setAllow] = useState<string[]>(changeable.filter((point) => point.risk === "low").map((point) => point.id));
  const [more, setMore] = useState<{ events: DeviceEvent[] } | null>(null);
  const act = async (label: string, work: () => Promise<unknown>) => { setBusy(label); setError(""); try { await work(); onChanged(); } catch (reason) { setError(message(reason)); } finally { setBusy(""); } };
  const ask = (point: string, value: boolean | number) => void act("Asking…", async () => onRecord((await Devices.set(device.id, point, value)).record));
  const state = DEVICE_STATE[device.connection];
  const setup = device.status === "added" || device.status === "verified" || device.status === "failed";
  return (
    <li className={card} data-testid="device-card" data-device={device.name}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold text-slate-900">{device.name}{device.location && <span className="ml-2 text-sm font-normal text-slate-600">{device.location}</span>}</h3>
          <p className="text-sm text-slate-700">{device.profile.manufacturer} {device.profile.model} · {device.profile.categoryLabel} · {device.profile.protocol.label} · through {device.hub.name}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {device.profile.simulated && <span className={`${chip} border-violet-300 bg-violet-100 text-violet-900`}>SIMULATED DEVICE</span>}
          <LevelChip compatibility={device.compatibility} />
          <span className={`${chip} ${state.tone}`} data-testid="device-connection">{state.label}</span>
        </div>
      </div>
      {device.connectionDetail && device.connection !== "online" && device.status === "active" && <p className="mt-1 text-sm text-amber-900">{device.connectionDetail}</p>}
      {error && <div className="mt-2"><Notice tone="rose">{error}</Notice></div>}
      {setup ? (
        <div className="mt-3 space-y-3">
          {device.verification ? <Verification device={device} /> : <p className="text-sm text-slate-700">Not checked yet. Your hub has to reach the device before it can be switched on.</p>}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={device.status === "verified" ? button : primary} disabled={Boolean(busy)} data-testid="check-device" onClick={() => void act("Checking…", () => Devices.test(device.id))}>{busy === "Checking…" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}{device.verification ? "Check again" : "Check the connection"}</button>
            <button type="button" className={button} disabled={Boolean(busy)} onClick={() => { if (window.confirm(`Remove ${device.name}?`)) void act("Removing…", () => Devices.remove(device.id)); }}><Trash2 className="h-4 w-4" aria-hidden="true" />Remove</button>
          </div>
          {device.status === "verified" && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3" data-testid="switch-on">
              <p className="font-medium text-slate-900">Switch it on</p>
              <p className="text-sm text-slate-700">HANNAH will read {device.profile.points.map((point) => point.name.toLowerCase()).join(", ")}.{changeable.length ? " Choose what it may also change. You can alter this later; each change still follows your approval settings." : " This device has nothing that can be changed."}</p>
              {changeable.map((point) => <label key={point.id} className="mt-1 flex items-center gap-2 text-sm text-slate-800"><input type="checkbox" data-testid={`allow-${point.id}`} checked={allow.includes(point.id)} onChange={(event) => setAllow((list) => (event.target.checked ? [...list, point.id] : list.filter((item) => item !== point.id)))} />HANNAH may change {point.name.toLowerCase()}{point.range ? ` (${point.range[0]} to ${point.range[1]}${point.unit ? ` ${point.unit}` : ""})` : ""}{point.risk && point.risk !== "low" ? ` — ${point.risk} risk, asks every time` : ""}</label>)}
              <button type="button" className={`${primary} mt-2`} disabled={Boolean(busy)} data-testid="activate" onClick={() => void act("Switching on…", () => Devices.activate(device.id, allow, device.verification?.level === "partial" && window.confirm("Not every reading was heard. Switch it on anyway?")))}>Switch on</button>
            </div>
          )}
        </div>
      ) : (
        <ul className="mt-2 divide-y divide-slate-100">{device.profile.points.map((point) => <PointRow key={point.id} device={device} point={point} ask={ask} busy={Boolean(busy)} />)}</ul>
      )}
      {!setup && (
        <details className="mt-2 text-sm" onToggle={(event) => { if ((event.target as HTMLDetailsElement).open && !more) void Devices.get(device.id).then((answer) => setMore({ events: answer.events })).catch(() => setMore({ events: [] })); }}>
          <summary className="cursor-pointer text-slate-700">Permissions, the check it passed, and history</summary>
          <div className="mt-2 space-y-3">
            {changeable.length > 0 && (
              <div>
                <p className={heading}>What HANNAH may change</p>
                {changeable.map((point) => <label key={point.id} className="mt-1 flex items-center gap-2 text-slate-800"><input type="checkbox" checked={device.writable.includes(point.id)} disabled={Boolean(busy) || device.status !== "active"} onChange={(event) => void act("Saving…", () => Devices.update(device.id, { writable: event.target.checked ? [...device.writable, point.id] : device.writable.filter((item) => item !== point.id) }))} />{point.name}</label>)}
              </div>
            )}
            <Verification device={device} />
            {device.rejected > 0 && <p className="text-amber-900">{device.rejected} message{device.rejected === 1 ? "" : "s"} from this device didn't fit its description and {device.rejected === 1 ? "was" : "were"} dropped.</p>}
            {more && more.events.length > 0 && <ul className="space-y-0.5 text-slate-700">{more.events.slice(0, 8).map((event) => <li key={event.id}><span className="text-slate-500">{clock(event.at)}</span> {event.message}</li>)}</ul>}
            <div className="flex flex-wrap gap-2">
              <button type="button" className={button} disabled={Boolean(busy)} onClick={() => void act("Saving…", () => Devices.update(device.id, { disabled: device.status === "active" }))}>{device.status === "active" ? "Switch off in HANNAH" : "Switch back on"}</button>
              <button type="button" className={button} disabled={Boolean(busy)} onClick={() => { if (window.confirm(`Remove ${device.name}?`)) void act("Removing…", () => Devices.remove(device.id)); }}><Trash2 className="h-4 w-4" aria-hidden="true" />Remove</button>
            </div>
          </div>
        </details>
      )}
    </li>
  );
}

const partText = (part: RulePart) => `${part.deviceName} ${part.point}`;
const valueText = (value: boolean | number | string) => (typeof value === "boolean" ? (value ? "on" : "off") : String(value));
export const automationText = (rule: Pick<Automation, "when" | "then" | "otherwise">) => `When ${rule.when.map((part) => `${partText(part)} ${part.op} ${valueText(part.value)}`).join(" and ")}: ${rule.then.map((part) => `set ${partText(part)} to ${valueText(part.value)}`).join(", ")}${rule.otherwise.length ? `. When that stops being true: ${rule.otherwise.map((part) => `set ${partText(part)} to ${valueText(part.value)}`).join(", ")}` : ""}.`;

function AutomationBuilder({ devices, onRecord }: { devices: Device[]; onRecord: (record: ActionRecord) => void }) {
  const active = devices.filter((device) => device.status === "active");
  const targets = active.filter((device) => device.profile.points.some((point) => device.writable.includes(point.id)));
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  const [sourcePoint, setSourcePoint] = useState("");
  const [op, setOp] = useState(">");
  const [value, setValue] = useState("");
  const [target, setTarget] = useState("");
  const [targetPoint, setTargetPoint] = useState("");
  const [to, setTo] = useState("on");
  const [back, setBack] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const from = active.find((device) => device.id === source);
  const watched = from?.profile.points.find((point) => point.id === sourcePoint);
  const dest = targets.find((device) => device.id === target);
  const changed = dest?.profile.points.find((point) => point.id === targetPoint && dest.writable.includes(point.id));
  const ready = name.trim() && watched && changed && (watched.type === "boolean" || (value.trim() !== "" && Number.isFinite(Number(value)))) && (changed.type === "boolean" || (to.trim() !== "" && Number.isFinite(Number(to))));
  const create = async () => {
    if (!from || !watched || !dest || !changed) return;
    setBusy(true); setError("");
    const numeric = watched.type === "number";
    const set = changed.type === "boolean" ? to === "on" : Number(to);
    const rule: AutomationInput = {
      name: name.trim(), when: numeric ? { device: from.id, point: watched.id, op, value: Number(value), hysteresis: Math.abs(Number(value)) * 0.03 || 0.5 } : { device: from.id, point: watched.id, op: "==", value: op === "on" },
      then: [{ device: dest.id, point: changed.id, value: set }], ...(back && typeof set === "boolean" ? { otherwise: [{ device: dest.id, point: changed.id, value: !set }] } : {}),
    };
    try { onRecord((await Devices.createAutomation(rule)).record); setName(""); } catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  };
  if (!active.length || !targets.length) return <p className="text-sm text-slate-700">An automation needs a device that reports something and a device HANNAH may change. Switch on a device and allow a change first.</p>;
  return (
    <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3" data-testid="automation-builder">
      <p className="font-medium text-slate-900">New automation</p>
      <label className="block text-sm text-slate-800">Name<input className={input} placeholder="Cool the room" value={name} onChange={(event) => setName(event.target.value)} /></label>
      <div className="grid gap-2 sm:grid-cols-4">
        <label className="text-sm text-slate-800">When<select className={input} aria-label="Device to watch" value={source} onChange={(event) => { setSource(event.target.value); setSourcePoint(""); }}><option value="">choose a device</option>{active.map((device) => <option key={device.id} value={device.id}>{device.name}</option>)}</select></label>
        <label className="text-sm text-slate-800">reading<select className={input} aria-label="Reading to watch" value={sourcePoint} onChange={(event) => { setSourcePoint(event.target.value); const picked = from?.profile.points.find((point) => point.id === event.target.value); setOp(picked?.type === "boolean" ? "on" : ">"); }}><option value="">choose</option>{(from?.profile.points || []).filter((point) => point.type !== "text").map((point) => <option key={point.id} value={point.id}>{point.name}</option>)}</select></label>
        <label className="text-sm text-slate-800">is<select className={input} aria-label="Comparison" value={op} onChange={(event) => setOp(event.target.value)}>{watched?.type === "boolean" ? <><option value="on">on</option><option value="off">off</option></> : <><option value=">">above</option><option value="<">below</option></>}</select></label>
        {watched?.type !== "boolean" && <label className="text-sm text-slate-800">this value{watched?.unit ? ` (${watched.unit})` : ""}<input className={input} aria-label="Value to compare with" inputMode="decimal" value={value} onChange={(event) => setValue(event.target.value)} /></label>}
      </div>
      <div className="grid gap-2 sm:grid-cols-4">
        <label className="text-sm text-slate-800">then set<select className={input} aria-label="Device to change" value={target} onChange={(event) => { setTarget(event.target.value); setTargetPoint(""); }}><option value="">choose a device</option>{targets.map((device) => <option key={device.id} value={device.id}>{device.name}</option>)}</select></label>
        <label className="text-sm text-slate-800">its<select className={input} aria-label="What to change" value={targetPoint} onChange={(event) => { setTargetPoint(event.target.value); const picked = dest?.profile.points.find((point) => point.id === event.target.value); setTo(picked?.type === "boolean" ? "on" : ""); }}><option value="">choose</option>{(dest?.profile.points || []).filter((point) => dest?.writable.includes(point.id) && point.risk !== "high").map((point) => <option key={point.id} value={point.id}>{point.name}</option>)}</select></label>
        <label className="text-sm text-slate-800">to{changed?.type === "boolean" ? <select className={input} aria-label="New state" value={to} onChange={(event) => setTo(event.target.value)}><option value="on">on</option><option value="off">off</option></select> : <input className={input} aria-label="New value" inputMode="decimal" placeholder={changed?.range ? `${changed.range[0]}–${changed.range[1]}` : ""} value={to} onChange={(event) => setTo(event.target.value)} />}</label>
      </div>
      {changed?.type === "boolean" && <label className="flex items-center gap-2 text-sm text-slate-800"><input type="checkbox" checked={back} onChange={(event) => setBack(event.target.checked)} />and switch it back when that stops being true</label>}
      <p className="text-xs text-slate-600">Your hub runs this by itself, with no AI involved, and keeps running it without the internet. You approve it once.</p>
      {error && <Notice tone="rose">{error}</Notice>}
      <button type="button" className={primary} disabled={busy || !ready} data-testid="create-automation" onClick={() => void create()}>Create the automation</button>
    </div>
  );
}

function HubCard({ hub, enrollment, onChanged, onEnrollment }: { hub: Hub; enrollment: HubEnrollment | null; onChanged: () => void; onEnrollment: (value: HubEnrollment) => void }) {
  const [error, setError] = useState("");
  const [lookOpen, setLookOpen] = useState(false);
  const [lookHost, setLookHost] = useState("");
  const [lookPort, setLookPort] = useState("1883");
  const [lookUser, setLookUser] = useState("");
  const [lookPass, setLookPass] = useState("");
  const [lookTls, setLookTls] = useState(false);
  const [lookBusy, setLookBusy] = useState(false);
  const [lookTopics, setLookTopics] = useState<Array<{ topic: string; messages: number; sample?: string }> | null>(null);
  const state = HUB_STATE[hub.connection];
  const act = async (work: () => Promise<unknown>) => { setError(""); try { await work(); onChanged(); } catch (reason) { setError(message(reason)); } };
  const look = async () => {
    setLookBusy(true); setError(""); setLookTopics(null);
    try {
      const answer = await Devices.look(hub.id, "mqtt", { host: lookHost.trim(), port: Number(lookPort) || undefined, username: lookUser.trim() || undefined, password: lookPass || undefined, tls: lookTls });
      setLookTopics(answer.discovered?.topics || []);
    } catch (reason) { setError(message(reason)); } finally { setLookBusy(false); }
  };
  return (
    <li className="rounded-xl border border-slate-200 p-3" data-testid="hub-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-medium text-slate-900"><Router className="h-4 w-4 text-slate-500" aria-hidden="true" />{hub.name} <span className={`${chip} ${state.tone}`} data-testid="hub-connection">{state.label}</span></p>
        <div className="flex gap-2">
          {hub.status !== "enrolled" && <button type="button" className={button} onClick={() => void act(async () => onEnrollment(await Devices.newHubCode(hub.id)))}>New code</button>}
          <button type="button" className={button} onClick={() => setLookOpen((value) => !value)} data-testid="look-broker">Look at a broker's topics</button>
          <button type="button" className={button} onClick={() => { if (window.confirm(`Remove the hub ${hub.name} and every device behind it?`)) void act(() => Devices.removeHub(hub.id)); }}><Trash2 className="h-4 w-4" aria-hidden="true" />Remove</button>
        </div>
      </div>
      {hub.status === "enrolled" && <p className="mt-1 text-sm text-slate-700">{hub.system || "Unknown system"} · HANNAH Edge {hub.software || "?"} · speaks {hub.adapters.join(", ") || "nothing"} · last seen {clock(hub.lastSeenAt)}{hub.fingerprint && <> · key fingerprint <span className="font-mono text-xs" data-testid="hub-fingerprint">{hub.fingerprint}</span></>}</p>}
      {enrollment && hub.status !== "enrolled" && (
        <div className="mt-2 space-y-1 rounded-lg bg-slate-50 p-3 text-sm text-slate-800" data-testid="hub-enrollment">
          <p>On the computer that will be the hub (on the same network as your devices), with HANNAH Edge on it, run:</p>
          <pre className="overflow-x-auto rounded bg-slate-900 p-2 text-xs text-slate-100" data-testid="hub-command">{enrollment.command}</pre>
          <p>The code works once and expires at {clock(enrollment.enrollment.expiresAt)}. Then start it with <code className="rounded bg-slate-200 px-1">python3 -m hannah_edge run</code>. It prints a key fingerprint: it should match the one shown here afterwards.</p>
        </div>
      )}
      {lookOpen && (
        <div className="mt-2 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3" data-testid="broker-look">
          <p className="text-sm font-medium text-slate-900">Look at a broker's topics</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block text-sm text-slate-800">Broker address<input className={input} data-testid="look-host" value={lookHost} onChange={(event) => setLookHost(event.target.value)} /></label>
            <label className="block text-sm text-slate-800">Port<input className={input} data-testid="look-port" inputMode="numeric" value={lookPort} onChange={(event) => setLookPort(event.target.value)} /></label>
            <label className="block text-sm text-slate-800">User name (optional)<input className={input} value={lookUser} onChange={(event) => setLookUser(event.target.value)} /></label>
            <label className="block text-sm text-slate-800">Password (optional)<input className={input} type="password" value={lookPass} onChange={(event) => setLookPass(event.target.value)} /></label>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-800"><input type="checkbox" checked={lookTls} onChange={(event) => setLookTls(event.target.checked)} />Encrypted (TLS)</label>
          <button type="button" className={primary} disabled={lookBusy || !lookHost.trim() || hub.connection !== "online"} data-testid="look-submit" onClick={() => void look()}>{lookBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}Look</button>
          {lookTopics && (
            <div data-testid="broker-topics">
              <p className="text-sm text-slate-700">{lookTopics.length} topic{lookTopics.length === 1 ? "" : "s"} heard.</p>
              <ul className="mt-1 space-y-0.5 text-sm text-slate-800">{lookTopics.map((item) => <li key={item.topic} className="font-mono text-xs" data-testid="broker-topic">{item.topic}{item.messages ? ` (${item.messages})` : ""}</li>)}</ul>
            </div>
          )}
        </div>
      )}
      {error && <div className="mt-2"><Notice tone="rose">{error}</Notice></div>}
    </li>
  );
}

export default function DevicesPage() {
  const [signedIn, setSignedIn] = useState(isAccountSession());
  const [overview, setOverview] = useState<Overview | null>(null);
  const [protocols, setProtocols] = useState<{ available: Array<{ id: string; label: string }>; notBuilt: Array<{ id: string; reason: string }> } | null>(null);
  const [events, setEvents] = useState<DeviceEvent[]>([]);
  const [enrollment, setEnrollment] = useState<HubEnrollment | null>(null);
  const [hubName, setHubName] = useState("");
  const [adding, setAdding] = useState(false);
  const [waiting, setWaiting] = useState<ActionRecord[]>([]);
  const [outcome, setOutcome] = useState<{ text: string; tone: "emerald" | "rose" | "amber" | "slate" } | null>(null);
  const [error, setError] = useState("");
  const [scanOpen, setScanOpen] = useState(false);
  const [scanned, setScanned] = useState("");
  const [publishers, setPublishers] = useState<Array<{ keyId: string; owner: string; revokedAt: number | null }>>([]);
  const [pubKeyId, setPubKeyId] = useState("");
  const [pubOwner, setPubOwner] = useState("");
  const [pubKey, setPubKey] = useState("");
  const [pubBusy, setPubBusy] = useState(false);
  const [pubError, setPubError] = useState("");
  const [installJson, setInstallJson] = useState("");
  const [updateHubId, setUpdateHubId] = useState("");
  const [updateVersion, setUpdateVersion] = useState("");
  const [updateSize, setUpdateSize] = useState("");
  const [updateSha, setUpdateSha] = useState("");
  const [updateUrl, setUpdateUrl] = useState("");
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateError, setUpdateError] = useState("");
  const [updateResult, setUpdateResult] = useState("");
  const loadPublishers = useCallback(async () => { if (!isAccountSession()) return; try { setPublishers((await Devices.listPublishers()).keys.map(({ keyId, owner, revokedAt }) => ({ keyId, owner, revokedAt }))); } catch { /* ignore */ } }, []);

  const load = useCallback(async () => {
    if (!isAccountSession()) { setOverview(null); return; }
    try { setOverview(await Devices.overview()); setError(""); } catch (reason) { setError(message(reason)); }
    void Devices.events().then((answer) => setEvents(answer.events)).catch(() => undefined);
  }, []);
  useEffect(() => {
    const changed = () => { setSignedIn(isAccountSession()); void load(); };
    changed();
    window.addEventListener(ACCOUNT_EVENT, changed);
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 3000);
    return () => { window.removeEventListener(ACCOUNT_EVENT, changed); window.clearInterval(timer); };
  }, [load]);
  useEffect(() => { if (signedIn) void Devices.protocols().then(setProtocols).catch(() => undefined); }, [signedIn]);

  const record = useCallback((result: ActionRecord | null) => {
    setWaiting((list) => list.filter((item) => item.id !== result?.id && result !== null));
    if (!result) { void load(); return; }
    if (result.status === "waiting-approval") { setWaiting((list) => [...list.filter((item) => item.id !== result.id), result]); setOutcome(null); return; }
    setOutcome({ text: result.outcome, tone: result.status === "done" ? "emerald" : result.status === "unverified" ? "amber" : result.status === "declined" ? "slate" : "rose" });
    void load();
  }, [load]);
  const addHub = async () => {
    setError("");
    try { setEnrollment(await Devices.createHub(hubName)); setHubName(""); await load(); } catch (reason) { setError(message(reason)); }
  };
  const pause = async (on: boolean) => { try { await Devices.pauseAutomations(on); await load(); } catch (reason) { setError(message(reason)); } };
  const counts = overview?.counts;
  const hubs = useMemo(() => overview?.hubs || [], [overview]);
  const devices = overview?.devices || [];
  const rules = overview?.rules || [];

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-semibold text-slate-900"><Plug className="h-6 w-6" aria-hidden="true" />Devices</h1>
        <p className="mt-1 text-slate-700">Lights, plugs, fans, sensors and meters, reached through a hub on your own network. Add a device, check it, choose what HANNAH may change, then ask in plain words or set up an automation.</p>
      </header>
      <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="note">HANNAH is not a safety system. A lock, a heater or a machine keeps its own protections; an automation here is a convenience, never an interlock. Nothing on this screen is safety-certified.</p>
      {!signedIn && <Notice>Sign in to use devices. A hub and its devices belong to an account.</Notice>}
      {signedIn && <div className="flex justify-end"><button type="button" className={button} data-testid="scan-qr" onClick={() => setScanOpen(true)}>Scan a QR code</button></div>}
      {scanned && <Notice tone="emerald">Scanned: {scanned}</Notice>}
      {error && <Notice tone="rose">{error}</Notice>}
      {signedIn && overview && (
        <>
          <section className={card} aria-label="Overview" data-testid="devices-overview">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-slate-800">
                <div><dt className={heading}>Hubs</dt><dd><span className="text-lg font-semibold text-slate-900">{counts?.hubsOnline ?? 0}</span> of {counts?.hubs ?? 0} connected</dd></div>
                <div><dt className={heading}>Devices</dt><dd><span className="text-lg font-semibold text-slate-900">{counts?.reporting ?? 0}</span> reporting of {counts?.active ?? 0} switched on</dd></div>
                <div><dt className={heading}>Automations</dt><dd><span className="text-lg font-semibold text-slate-900">{counts?.rulesOn ?? 0}</span> on{overview.rulesSuspended ? ", all paused" : ""}</dd></div>
              </dl>
              {rules.length > 0 && (overview.rulesSuspended
                ? <button type="button" className={primary} onClick={() => void pause(false)}><PlayCircle className="h-4 w-4" aria-hidden="true" />Resume automations</button>
                : <button type="button" className={button} onClick={() => void pause(true)}><PauseCircle className="h-4 w-4" aria-hidden="true" />Pause every automation</button>)}
            </div>
            {overview.rulesSuspended && <p className="mt-2 text-sm text-amber-900">Every automation is paused. Devices stay as they are until you resume.</p>}
          </section>

          {(waiting.length > 0 || outcome) && (
            <section className="space-y-2" aria-label="Approvals and results">
              {waiting.map((item) => <Approval key={item.id} record={item} onChanged={record} />)}
              {outcome && <div data-testid="device-outcome"><Notice tone={outcome.tone}>{outcome.text}</Notice></div>}
            </section>
          )}

          <section className={card} aria-labelledby="hubs-heading">
            <h2 id="hubs-heading" className="text-lg font-semibold text-slate-900">Hubs</h2>
            <p className="text-sm text-slate-700">A hub is a computer on the same network as your devices running HANNAH Edge. It speaks to the devices and opens the connection to HANNAH; nothing connects in to it.</p>
            {!overview.canEnroll && <div className="mt-2"><Notice tone="amber">This server can't enroll hubs yet: it has no key vault to keep a hub's key in.</Notice></div>}
            <ul className="mt-3 space-y-2">{hubs.map((hub) => <HubCard key={hub.id} hub={hub} enrollment={enrollment?.hub.id === hub.id ? enrollment : null} onChanged={() => void load()} onEnrollment={setEnrollment} />)}</ul>
            <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); void addHub(); }}>
              <label className="text-sm text-slate-800">Name for a new hub<input className={input} placeholder="Home hub" value={hubName} onChange={(event) => setHubName(event.target.value)} /></label>
              <button type="submit" className={primary} disabled={!hubName.trim() || !overview.canEnroll}><Plus className="h-4 w-4" aria-hidden="true" />Add a hub</button>
            </form>
          </section>

          <section className="space-y-3" aria-labelledby="devices-heading">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="devices-heading" className="text-lg font-semibold text-slate-900">Your devices</h2>
              {!adding && <button type="button" className={primary} disabled={!hubs.some((hub) => hub.status === "enrolled")} onClick={() => setAdding(true)}><Plus className="h-4 w-4" aria-hidden="true" />Add a device</button>}
            </div>
            {adding && <div className={card}><DeviceSetup hubs={hubs} onCancel={() => setAdding(false)} onAdded={() => { setAdding(false); void load(); }} /></div>}
            {devices.length === 0 && !adding && <p className="text-sm text-slate-700">No devices yet.{hubs.some((hub) => hub.status === "enrolled") ? " Add one: pick it from the list, use its manual, or describe it yourself." : " Add a hub first."}</p>}
            <ul className="space-y-3">{devices.map((device) => <DeviceCard key={device.id} device={device} onChanged={() => void load()} onRecord={record} />)}</ul>
          </section>

          <section className={card} aria-labelledby="automations-heading">
            <h2 id="automations-heading" className="text-lg font-semibold text-slate-900">Automations</h2>
            <ul className="mt-2 space-y-2">
              {rules.map((rule) => (
                <li key={rule.id} className="rounded-xl border border-slate-200 p-3" data-testid="automation-card">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium text-slate-900">{rule.name} <span className={`${chip} ${rule.enabled ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-slate-200 bg-slate-100 text-slate-700"}`} data-testid="automation-status">{!rule.enabled ? "Off" : rule.status === "suspended" ? "Paused" : rule.status === "active" ? "Acting now" : rule.status === "waiting" ? "Waiting" : rule.status === "not-reported" ? "Being sent to the hub" : "Watching"}</span></p>
                    <div className="flex gap-2">
                      <button type="button" className={button} onClick={() => void Devices.setAutomation(rule.id, !rule.enabled).then((answer) => record(answer.record)).catch((reason) => setError(message(reason)))}>{rule.enabled ? <><CircleSlash className="h-4 w-4" aria-hidden="true" />Switch off</> : "Switch on"}</button>
                      <button type="button" className={button} onClick={() => void Devices.removeAutomation(rule.id).then((answer) => record(answer.record)).catch((reason) => setError(message(reason)))}><Trash2 className="h-4 w-4" aria-hidden="true" />Remove</button>
                    </div>
                  </div>
                  <p className="mt-1 text-sm text-slate-800">{automationText(rule)}</p>
                  <p className="text-sm text-slate-600">{rule.fires ? `Acted ${rule.fires} time${rule.fires === 1 ? "" : "s"}, last at ${clock(rule.lastFiredAt)}.` : "Has not acted yet."} {rule.detail} {rule.lastError && <span className="text-rose-800">{rule.lastError}</span>}</p>
                </li>
              ))}
            </ul>
            <div className="mt-3"><AutomationBuilder devices={devices} onRecord={record} /></div>
          </section>

          {protocols && (
            <details className={card}>
              <summary className="cursor-pointer text-lg font-semibold text-slate-900">What a hub can speak today, and what it can't</summary>
              <p className="mt-2 text-sm text-slate-800">Available: {protocols.available.map((item) => item.label).join(", ")}. Each was tested against HANNAH's own test servers, not against a physical device.</p>
              <ul className="mt-2 space-y-1 text-sm text-slate-700" data-testid="not-built">{protocols.notBuilt.map((item) => <li key={item.id}><span className="font-medium text-slate-900">{item.id}:</span> {item.reason}</li>)}</ul>
            </details>
          )}

          <details className={card}>
            <summary className="cursor-pointer text-lg font-semibold text-slate-900">Publisher keys and signed profiles</summary>
            <div className="mt-3 space-y-3">
              <p className="text-sm text-slate-700">Trust a publisher's public key to install profiles they signed. A profile can't be installed without a trusted, unrevoked key.</p>
              {pubError && <Notice tone="rose">{pubError}</Notice>}
              <ul className="space-y-1 text-sm text-slate-800" data-testid="publisher-list">{publishers.map((key) => <li key={key.keyId} className="flex items-center justify-between gap-2"><span>{key.owner} <span className="font-mono text-xs text-slate-500">{key.keyId}</span>{key.revokedAt ? " (revoked)" : ""}</span>{!key.revokedAt && <button type="button" className={button} onClick={() => void Devices.revokePublisher(key.keyId).then(() => loadPublishers()).catch((reason) => setPubError(message(reason)))}>Revoke</button>}</li>)}</ul>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="block text-sm text-slate-800">Key id<input className={input} value={pubKeyId} onChange={(event) => setPubKeyId(event.target.value)} /></label>
                <label className="block text-sm text-slate-800">Owner<input className={input} value={pubOwner} onChange={(event) => setPubOwner(event.target.value)} /></label>
                <label className="block text-sm text-slate-800 sm:col-span-2">Public key (PEM)<textarea className={input} rows={3} value={pubKey} onChange={(event) => setPubKey(event.target.value)} /></label>
              </div>
              <button type="button" className={primary} disabled={pubBusy || !pubKeyId.trim() || !pubKey.trim()} onClick={() => void (async () => { setPubBusy(true); setPubError(""); try { await Devices.addPublisher(pubKeyId.trim(), pubOwner.trim() || pubKeyId.trim(), pubKey.trim()); setPubKeyId(""); setPubOwner(""); setPubKey(""); await loadPublishers(); } catch (reason) { setPubError(message(reason)); } finally { setPubBusy(false); } })()}>Trust this key</button>
              <label className="block text-sm text-slate-800">Install a signed profile (paste its JSON)<textarea className={input} rows={4} value={installJson} onChange={(event) => setInstallJson(event.target.value)} data-testid="install-profile-json" /></label>
              <button type="button" className={button} disabled={pubBusy || !installJson.trim()} onClick={() => void (async () => { setPubBusy(true); setPubError(""); try { const profile = JSON.parse(installJson); const answer = await Devices.installProfile(profile); setInstallJson(""); await load(); alert(`Installed, signed by ${answer.signedBy}.`); } catch (reason) { setPubError(message(reason)); } finally { setPubBusy(false); } })()}>Install it</button>
            </div>
          </details>
          <details className={card}>
            <summary className="cursor-pointer text-lg font-semibold text-slate-900">Hub updates</summary>
            <div className="mt-3 space-y-3">
              <p className="text-sm text-slate-700">Announce a signed update to a hub. The hub checks its size and SHA-256, unpacks it, runs its health check, and switches over with a way back.</p>
              {updateError && <Notice tone="rose">{updateError}</Notice>}
              {updateResult && <Notice tone="emerald">{updateResult}</Notice>}
              <label className="block text-sm text-slate-800">Hub<select className={input} value={updateHubId} onChange={(event) => setUpdateHubId(event.target.value)}><option value="">choose</option>{hubs.map((hub) => <option key={hub.id} value={hub.id}>{hub.name} ({hub.software || "?"})</option>)}</select></label>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="block text-sm text-slate-800">Version<input className={input} placeholder="1.9.0" value={updateVersion} onChange={(event) => setUpdateVersion(event.target.value)} /></label>
                <label className="block text-sm text-slate-800">Size (bytes)<input className={input} inputMode="numeric" value={updateSize} onChange={(event) => setUpdateSize(event.target.value)} /></label>
                <label className="block text-sm text-slate-800 sm:col-span-2">SHA-256<input className={input} value={updateSha} onChange={(event) => setUpdateSha(event.target.value)} /></label>
                <label className="block text-sm text-slate-800 sm:col-span-2">Bundle URL<input className={input} value={updateUrl} onChange={(event) => setUpdateUrl(event.target.value)} /></label>
              </div>
              <button type="button" className={primary} disabled={updateBusy || !updateHubId || !updateVersion.trim() || !updateUrl.trim()} onClick={() => void (async () => { setUpdateBusy(true); setUpdateError(""); setUpdateResult(""); try { await Devices.updateHub(updateHubId, updateVersion.trim(), Number(updateSize) || 0, updateSha.trim(), updateUrl.trim()); setUpdateResult("Update announced. The hub will fetch and switch over."); } catch (reason) { setUpdateError(message(reason)); } finally { setUpdateBusy(false); } })()}>Announce update</button>
            </div>
          </details>
          {events.length > 0 && (
            <section className={card} aria-labelledby="activity-heading">
              <h2 id="activity-heading" className="text-lg font-semibold text-slate-900">Activity</h2>
              <ul className="mt-2 space-y-0.5 text-sm" data-testid="device-events">{events.slice(0, 14).map((event) => <li key={event.id} className={event.severity === "error" ? "text-rose-800" : event.severity === "warning" ? "text-amber-900" : "text-slate-700"}><span className="text-slate-500">{clock(event.at)}</span> {event.message}</li>)}</ul>
            </section>
          )}
        </>
      )}
      {scanOpen && <QrScanner onResult={(text) => { setScanned(text); setScanOpen(false); }} onClose={() => setScanOpen(false)} />}
    </div>
  );
}
