import { useCallback, useEffect, useState } from "react";
import { CalendarDays, Check, Mail, RefreshCw } from "lucide-react";
import { Connections, type ConnectionProvider, type ConnectionProviderId } from "../services/Connections";
import { ACCOUNT_EVENT, getAccountHint } from "../services/api";

const logo: Record<ConnectionProviderId, string> = { google: "G", microsoft: "M" };

/** Settings → Calendar and email. */
export default function ConnectionsPanel() {
  const [signedIn, setSignedIn] = useState(() => Boolean(getAccountHint()));
  const [providers, setProviders] = useState<ConnectionProvider[]>(Connections.cached);
  const [vault, setVault] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!getAccountHint()) return;
    try {
      const status = await Connections.status();
      setProviders(status.providers);
      setVault(status.vault);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    // Back from the provider's sign-in page (web): say how it went, then tidy the address.
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const failed = params.get("connection-error");
    if (connected || failed) {
      setNotice(connected ? `${connected === "microsoft" ? "Microsoft" : "Google"} connected. Ask HANNAH about your calendar or email.` : "");
      if (failed) setError(params.get("message") || "The account wasn't connected.");
      ["connected", "connection-error", "message"].forEach((key) => params.delete(key));
      const search = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${search ? `?${search}` : ""}`);
    }
    void refresh();
    const onAccount = () => { setSignedIn(Boolean(getAccountHint())); void refresh(); };
    // In the apps, sign-in happens in the system browser; check again when HANNAH comes back.
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener(ACCOUNT_EVENT, onAccount);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      window.removeEventListener(ACCOUNT_EVENT, onAccount);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [refresh]);

  const connect = async (provider: ConnectionProvider, features: Array<"chat"> = []) => {
    setBusy(provider.id);
    setError("");
    try {
      // Keep Google Chat when connecting again for another reason.
      const keep = provider.features?.chat ? ["chat" as const] : [];
      const result = await Connections.connect(provider.id, [...new Set([...keep, ...features])]);
      if (result === "external") setNotice(`Finish signing in to ${provider.label} in your browser, then come back here.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async (provider: ConnectionProvider) => {
    setBusy(provider.id);
    try {
      await Connections.disconnect(provider.id);
      setNotice(`${provider.label} disconnected. HANNAH deleted its sign-in${provider.id === "google" ? " and revoked it at Google" : ""}.`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  if (!signedIn) {
    return <p className="rounded-xl border border-dashed border-slate-300 px-4 py-3 text-sm text-slate-600">Sign in to your HANNAH account above first. Connected calendars and mail belong to your account, so they work on all your devices.</p>;
  }

  const list = providers.length ? providers : [
    { id: "google", label: "Google", services: "Google Calendar and Gmail", configured: false, connected: false, email: null, connectedAt: null, redirectUri: "" },
    { id: "microsoft", label: "Microsoft", services: "Outlook Calendar and Mail", configured: false, connected: false, email: null, connectedAt: null, redirectUri: "" },
  ] satisfies ConnectionProvider[];

  return (
    <div className="space-y-3">
      <ul className="grid gap-3 sm:grid-cols-2" aria-label="Calendar and email accounts">
        {list.map((provider) => (
          <li key={provider.id} className="flex flex-col rounded-2xl border border-slate-200 bg-white p-4">
            <div className="flex items-start gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-900 text-sm font-bold text-white" aria-hidden="true">{logo[provider.id]}</span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink">{provider.label}</p>
                <p className="text-xs text-slate-600">{provider.services}</p>
              </div>
            </div>
            {provider.connected ? (
              <>
                <p className="mt-3 flex items-center gap-1.5 text-xs font-medium text-emerald-800"><Check size={13} /> Connected{provider.email ? ` as ${provider.email}` : ""}</p>
                {provider.features && !provider.features.organize && <p className="mt-1 text-xs leading-5 text-amber-800">Connected before HANNAH could archive and label mail. <button type="button" className="underline" onClick={() => void connect(provider)}>Connect again</button> to allow it.</p>}
                {provider.id === "google" && provider.features?.chat && <p className="mt-1 flex items-center gap-1.5 text-xs text-emerald-800"><Check size={13} /> Google Chat: reads spaces you're in; posts only after you approve.</p>}
              </>
            ) : !provider.configured ? (
              <p className="mt-3 text-xs leading-5 text-slate-600">Not set up on this server yet. The operator registers a {provider.label} sign-in app and sets its client ID and secret (see docs/CALENDAR_AND_EMAIL.md).</p>
            ) : (
              <p className="mt-3 text-xs leading-5 text-slate-600">You sign in on {provider.label}'s own page. HANNAH never sees your password.</p>
            )}
            <div className="mt-auto pt-3">
              {provider.connected ? (
                <div className="flex flex-wrap gap-2">
                  {provider.id === "google" && !provider.features?.chat && <button type="button" className="btn-outline !py-1.5" disabled={busy === provider.id} onClick={() => void connect(provider, ["chat"])}>Also connect Google Chat</button>}
                  <button type="button" className="btn-outline !py-1.5 text-rose-700" disabled={busy === provider.id} onClick={() => void disconnect(provider)}>Disconnect</button>
                </div>
              ) : (
                <button type="button" className="btn-primary !py-1.5" disabled={!provider.configured || !vault || busy === provider.id} onClick={() => void connect(provider)}>Connect {provider.label}</button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
        <span className="inline-flex items-center gap-1.5"><CalendarDays size={13} /> Reads your calendar; adds events only after you approve each one.</span>
        <span className="inline-flex items-center gap-1.5"><Mail size={13} /> Searches and reads mail when you ask; drafts and sends only after you approve.</span>
        <button type="button" className="btn-ghost !px-2 !py-1 text-xs" onClick={() => void refresh()}><RefreshCw size={12} /> Check again</button>
      </div>
      {!vault && <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900">This server can't store sign-ins yet: the operator needs to connect Supabase through Vercel, or set HANNAH_VAULT_KEY.</p>}
      {notice && <p role="status" className="rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-900">{notice}</p>}
      {error && <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-800">{error}</p>}
    </div>
  );
}
