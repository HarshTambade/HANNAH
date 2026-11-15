import { useState } from "react";
import { PAPAdapter } from "../services/PAPAdapter";

export default function PAPSettings() {
  const [domain, setDomain] = useState("");
  const [result, setResult] = useState<unknown>(null);

  return (
    <div className="rounded-xl border border-slate-100 bg-white p-4 shadow-soft">
      <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">PAP permissions</h3>
      <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="business domain" className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-2 py-1 text-[10px] text-slate-600 outline-none focus:border-brand-400/60" />
      <button type="button" onClick={async () => setResult(await PAPAdapter.discover(domain))} className="mt-2 rounded-lg border border-slate-200 bg-white px-3 py-1 text-[8px] text-slate-600 hover:bg-slate-50">Discover</button>
      <pre className="mt-2 text-[8px] text-slate-500">{JSON.stringify(result)}</pre>
    </div>
  );
}