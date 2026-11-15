import { useState } from "react";
import { PAPAdapter } from "../services/PAPAdapter";

export default function PAPSettings() {
  const [domain, setDomain] = useState("");
  const [result, setResult] = useState<unknown>(null);

  return (
    <div className="rounded-2xl border border-white/[0.08] p-4">
      <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-slate-300">PAP permissions</h3>
      <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="business domain" className="mt-2 w-full rounded-lg border border-white/[0.08] bg-transparent px-2 py-1 text-[10px] text-slate-200" />
      <button type="button" onClick={async () => setResult(await PAPAdapter.discover(domain))} className="mt-2 rounded-lg border border-white/[0.08] px-3 py-1 text-[8px] text-slate-200">Discover</button>
      <pre className="mt-2 text-[8px] text-slate-400">{JSON.stringify(result)}</pre>
    </div>
  );
}