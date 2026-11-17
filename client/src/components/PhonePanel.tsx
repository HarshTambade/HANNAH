import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Loader2, MessageSquare, Phone, PhoneCall, Smartphone, Trash2, Users } from "lucide-react";
import { getAccountHint } from "../services/api";
import { thisDevice } from "../services/DeviceTasks";
import {
  describeOutcome, isPhoneApp, pairThisPhone, phoneSettings, PhoneBridgeApi, recentPhoneEvents, unpairThisPhone, updateThisPhone, waitForPhone,
  type PairedPhone, type PhoneCapability, type PhoneCommand,
} from "../services/PhoneBridge";

const CAPABILITY_LABELS: Record<PhoneCapability, { label: string; detail: string }> = {
  call: { label: "Calls", detail: "Open the dialer with the number. You tap Call." },
  sms: { label: "Text messages", detail: "Open Messages with the recipient and text. You tap Send." },
  contacts: { label: "Find contacts by name", detail: "Look up a name on this phone; only matches are sent back." },
};

const ago = (at: number | null) => {
  if (!at) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  return seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.round(seconds / 60)} min ago` : new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

/** On the phone: pair it, choose what it allows, see what it did. */
function ThisPhone() {
  const [settings, setSettings] = useState(phoneSettings);
  const [code, setCode] = useState("");
  const [name, setName] = useState(() => thisDevice().name);
  const [capabilities, setCapabilities] = useState<PhoneCapability[]>(["call", "sms"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [events, setEvents] = useState(recentPhoneEvents);
  useEffect(() => {
    const refresh = () => { setSettings(phoneSettings()); setEvents(recentPhoneEvents()); };
    window.addEventListener("hannah:phone-bridge", refresh);
    return () => window.removeEventListener("hannah:phone-bridge", refresh);
  }, []);

  const pair = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await pairThisPhone(code, { name: name.trim() || thisDevice().name, capabilities });
      setCode("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Pairing failed.");
    } finally {
      setBusy(false);
    }
  };

  if (!settings.phoneId) {
    return (
      <form onSubmit={pair} className="space-y-3" aria-label="Pair this phone">
        <p className="text-sm leading-6 text-slate-600">On your computer, open HANNAH signed in to this same account, go to Settings → Phone and press <strong>Pair a phone</strong>. Then type the code it shows.</p>
        <label className="block text-xs font-semibold text-slate-700" htmlFor="pair-code">Pairing code</label>
        <input id="pair-code" value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder="ABCD-EFGH" autoCapitalize="characters" autoComplete="one-time-code" className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono text-base tracking-widest" />
        <label className="block text-xs font-semibold text-slate-700" htmlFor="phone-name">This phone's name</label>
        <input id="phone-name" value={name} onChange={(event) => setName(event.target.value)} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-base" />
        <fieldset className="space-y-2">
          <legend className="text-xs font-semibold text-slate-700">Your computer may ask this phone to</legend>
          {(Object.keys(CAPABILITY_LABELS) as PhoneCapability[]).map((capability) => (
            <label key={capability} className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={capabilities.includes(capability)} onChange={(event) => setCapabilities((list) => event.target.checked ? [...list, capability] : list.filter((item) => item !== capability))} />
              <span><span className="font-medium text-ink">{CAPABILITY_LABELS[capability].label}</span><span className="block text-xs text-slate-500">{CAPABILITY_LABELS[capability].detail}</span></span>
            </label>
          ))}
        </fieldset>
        {error && <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>}
        <button type="submit" className="btn-primary" disabled={busy || code.replace(/[^A-Z0-9]/gi, "").length !== 8}>{busy ? <Loader2 size={14} className="animate-spin" /> : <Smartphone size={14} />} Pair this phone</button>
      </form>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
        <p className="font-semibold">Paired with your account</p>
        <p className="mt-1">Check that your computer shows the same code: <span className="font-mono font-semibold" aria-label="Pairing fingerprint">{settings.fingerprint}</span></p>
      </div>
      <label className="flex items-start gap-3 text-sm">
        <input type="checkbox" className="mt-1" checked={settings.enabled} onChange={(event) => void updateThisPhone({ enabled: event.target.checked })} />
        <span><span className="font-semibold text-ink">Use this phone from my computer</span><span className="block text-xs leading-5 text-slate-500">While HANNAH is open on this phone, your computer can ask it to do what's ticked below. Requests are for the moment they're made: one that arrives while HANNAH is closed is dropped, never run later.</span></span>
      </label>
      <fieldset className="space-y-2 pl-6">
        {(Object.keys(CAPABILITY_LABELS) as PhoneCapability[]).map((capability) => (
          <label key={capability} className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" disabled={!settings.enabled} checked={settings.capabilities.includes(capability)} onChange={(event) => void updateThisPhone({ capabilities: event.target.checked ? [...settings.capabilities, capability] : settings.capabilities.filter((item) => item !== capability) })} />
            <span><span className="font-medium text-ink">{CAPABILITY_LABELS[capability].label}</span><span className="block text-xs text-slate-500">{CAPABILITY_LABELS[capability].detail}</span></span>
          </label>
        ))}
      </fieldset>
      {events.length > 0 && (
        <ul className="space-y-1 text-xs text-slate-600" aria-label="Recent requests on this phone">
          {events.map((entry, index) => <li key={`${entry.at}-${index}`}>{new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · {entry.action} {entry.who} · {entry.status}{entry.requestedBy ? ` · from ${entry.requestedBy}` : ""}</li>)}
        </ul>
      )}
      <button type="button" className="btn-outline text-rose-700" onClick={() => { if (window.confirm("Unpair this phone? Your computer won't be able to reach it until you pair again.")) void unpairThisPhone(); }}><Trash2 size={14} /> Unpair this phone</button>
    </div>
  );
}

/** On a computer: pair phones, see them, try them. */
function YourPhones() {
  const [phones, setPhones] = useState<PairedPhone[] | null>(null);
  const [history, setHistory] = useState<PhoneCommand[]>([]);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: number } | null>(null);
  const [paired, setPaired] = useState<PairedPhone | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [number, setNumber] = useState("");
  const [message, setMessage] = useState("");
  const [outcome, setOutcome] = useState("");

  const load = useCallback(async () => {
    try {
      const [{ phones: list }, { commands }] = await Promise.all([PhoneBridgeApi.phones(), PhoneBridgeApi.history(10)]);
      setPhones(list);
      setHistory(commands);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't load your phones.");
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(timer);
  }, [load]);

  // While a code is showing, watch for the phone to use it.
  useEffect(() => {
    if (!pairing) return undefined;
    const timer = window.setInterval(async () => {
      try {
        const status = await PhoneBridgeApi.pairingStatus(pairing.code);
        if (status.paired && status.phone) { setPaired(status.phone); setPairing(null); void load(); }
        else if (status.expired) setPairing(null);
      } catch { /* try again */ }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [pairing, load]);

  const startPairing = async () => {
    setError("");
    setPaired(null);
    try {
      setPairing(await PhoneBridgeApi.createPairingCode(thisDevice().name));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't make a pairing code.");
    }
  };

  const tryPhone = async (action: "call" | "sms") => {
    setBusy(action);
    setOutcome("");
    try {
      const phone = phones?.find((item) => item.isDefault) ?? phones?.[0];
      const prompt = action === "call" ? `Open the dialer on ${phone?.name} with ${number}?` : `Open Messages on ${phone?.name} to ${number} with “${message}”?`;
      if (!window.confirm(prompt)) return;
      const sent = await PhoneBridgeApi.send({ action, number, ...(action === "sms" ? { body: message } : {}), deviceName: thisDevice().name });
      setOutcome(describeOutcome(sent.command, sent.phone.name));
      const done = await waitForPhone(sent.command.id, { platform: sent.phone.platform });
      setOutcome(describeOutcome(done, sent.phone.name));
      void load();
    } catch (cause) {
      setOutcome(cause instanceof Error ? cause.message : "The request failed.");
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-ink">Your phones</h3>
          <button type="button" className="btn-outline" onClick={() => void startPairing()}><Smartphone size={14} /> Pair a phone</button>
        </div>
        {pairing && (
          <div className="mt-3 rounded-xl border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-slate-700" role="status">
            <p>On your phone, open HANNAH signed in to this same account → Settings → Phone, and type:</p>
            <p className="mt-2 font-mono text-2xl font-semibold tracking-[0.2em] text-ink" aria-label="Pairing code">{pairing.code}</p>
            <p className="mt-1 text-xs text-slate-500">Works once, until {new Date(pairing.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. Waiting for your phone…</p>
          </div>
        )}
        {paired && (
          <p className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900" role="status">
            {paired.name} is paired. Check that the phone shows the same code: <span className="font-mono font-semibold">{paired.fingerprint}</span>. If it doesn't, remove it below.
          </p>
        )}
        {phones === null ? <p className="mt-3 text-sm text-slate-500">Loading…</p> : phones.length === 0 ? (
          <p className="mt-3 rounded-xl border border-dashed border-slate-300 px-4 py-3 text-sm text-slate-600">No phone paired. Pair your Android phone or iPhone and HANNAH can open its dialer or Messages when you ask from here; you still tap Call or Send on the phone.</p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white" aria-label="Paired phones">
            {phones.map((phone) => (
              <li key={phone.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${phone.online ? "bg-emerald-500" : "bg-slate-300"}`} aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-ink">{phone.name}{phone.isDefault && <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-slate-600">Default</span>}</span>
                  <span className="block text-xs text-slate-500">{phone.platform === "ios" ? "iPhone" : "Android"} · {phone.online ? "Online" : `Offline, last seen ${ago(phone.lastSeenAt)}`} · allows {phone.capabilities.length ? phone.capabilities.map((item) => CAPABILITY_LABELS[item]?.label.toLowerCase() ?? item).join(", ") : "nothing"} · key {phone.fingerprint}</span>
                </span>
                {!phone.isDefault && <button type="button" className="btn-ghost text-xs" onClick={async () => { await PhoneBridgeApi.makeDefault(phone.id); void load(); }}>Make default</button>}
                <button type="button" className="btn-ghost text-rose-700" aria-label={`Remove ${phone.name}`} onClick={async () => { if (window.confirm(`Remove ${phone.name}? It won't receive requests until it's paired again.`)) { await PhoneBridgeApi.revoke(phone.id); void load(); } }}><Trash2 size={14} /></button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {Boolean(phones?.length) && (
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <h3 className="text-sm font-semibold text-ink">Try it</h3>
          <p className="mt-1 text-xs text-slate-500">Or just ask in chat: “call Aman using my phone”, “text my brother that I'm running late”.</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr]">
            <input aria-label="Phone number" value={number} onChange={(event) => setNumber(event.target.value)} placeholder="+91 98765 43210" className="rounded-xl border border-slate-200 px-3 py-2 text-base sm:text-sm" />
            <input aria-label="Message" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Message (for a text)" className="rounded-xl border border-slate-200 px-3 py-2 text-base sm:text-sm" />
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className="btn-outline" disabled={!number || Boolean(busy)} onClick={() => void tryPhone("call")}>{busy === "call" ? <Loader2 size={14} className="animate-spin" /> : <PhoneCall size={14} />} Call from my phone</button>
            <button type="button" className="btn-outline" disabled={!number || !message || Boolean(busy)} onClick={() => void tryPhone("sms")}>{busy === "sms" ? <Loader2 size={14} className="animate-spin" /> : <MessageSquare size={14} />} Text from my phone</button>
          </div>
          {outcome && <p role="status" className="mt-2 text-sm text-slate-700">{outcome}</p>}
        </div>
      )}

      {history.length > 0 && (
        <details className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <summary className="cursor-pointer text-sm font-semibold text-ink">Recent phone requests</summary>
          <ul className="mt-2 space-y-1 text-xs text-slate-600">
            {history.map((command) => (
              <li key={command.id} className="flex items-center gap-2">
                {command.action === "call" ? <Phone size={12} aria-hidden="true" /> : command.action === "sms" ? <MessageSquare size={12} aria-hidden="true" /> : <Users size={12} aria-hidden="true" />}
                <span className="min-w-0 flex-1 truncate">{command.action === "lookup" ? `Find “${command.payload.query}”` : `${command.payload.name ? `${command.payload.name} · ` : ""}${command.payload.number}`}</span>
                <span className="shrink-0">{command.status}</span>
                <span className="shrink-0 text-slate-400">{ago(command.createdAt)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {error && <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>}
    </div>
  );
}

/** Settings → Phone. */
export default function PhonePanel() {
  if (!getAccountHint()) return <p className="text-sm text-slate-600">Sign in (Account, above) on both your computer and your phone to connect them.</p>;
  return isPhoneApp() ? <ThisPhone /> : <YourPhones />;
}
