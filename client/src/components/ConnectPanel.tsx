import { useEffect, useState, type FormEvent } from "react";
import { ArrowRight, Check, Eye, EyeOff, KeyRound, ShieldCheck, X } from "lucide-react";
import { apiBase, canRememberKey, isGroqKey, rememberGroqKey, verifyApiAccess } from "../services/api";
import { Account, databaseLabel, type AccountStatus } from "../services/Account";
import { IS_WEBSITE } from "../config/site";
import { SignInForm } from "./AccountPanel";

type ConnectPanelProps = {
  onStart: (credentials: { apiToken: string; groqApiKey: string }) => void;
  /** Shown as a close button when the panel sits in a dialog. */
  onClose?: () => void;
};

/**
 * Connect with a Groq key, an operator's access token, or an account. Used in
 * the website's connect dialog and on the apps' welcome screen.
 */
export default function ConnectPanel({ onStart, onClose }: ConnectPanelProps) {
  const [apiToken, setApiToken] = useState("");
  const [groqApiKey, setGroqApiKey] = useState("");
  const [showApiToken, setShowApiToken] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [keyError, setKeyError] = useState("");
  const [verifying, setVerifying] = useState(false);
  // Website only: keep the key in a cookie this page can't read, for 30 days.
  const rememberable = canRememberKey();
  const [remember, setRemember] = useState(true);
  const [accountInfo, setAccountInfo] = useState<AccountStatus | null>(null);
  const [accountMode, setAccountMode] = useState(false);

  useEffect(() => {
    let active = true;
    Account.status().then((status) => { if (active) setAccountInfo(status); }).catch(() => {});
    return () => { active = false; };
  }, []);
  const accountsEnabled = Boolean(accountInfo?.accounts.enabled);
  // This server answers for its accounts with its own models: a new visitor needs an email, not an API key.
  const keyless = Boolean(accountInfo?.accounts.enabled && accountInfo.accounts.signup && accountInfo.accounts.serverKeys);
  const [choseKey, setChoseKey] = useState(false);
  useEffect(() => { if (keyless && !choseKey) setAccountMode(true); }, [keyless, choseKey]);

  const beginConversation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (verifying) return;
    const token = apiToken.trim();
    const key = groqApiKey.trim();
    const localDevelopment = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(window.location.hostname);
    if (!token && !key) {
      setKeyError("Paste your Groq API key to start. It's free to create at console.groq.com/keys.");
      return;
    }
    if (key && !isGroqKey(key)) {
      setKeyError("That doesn't look like a Groq key. Groq keys start with gsk_ and have no spaces.");
      return;
    }
    if (token && (token.length < 32 || token.length > 512 || /\s/.test(token))) {
      setKeyError("An access token is 32–512 characters without spaces. Leave it empty if you're using your own Groq key.");
      return;
    }
    if (!window.isSecureContext && !localDevelopment) {
      setKeyError("For your safety, connect over HTTPS before sending an API key.");
      return;
    }
    const configuredApiUrl = apiBase();
    if (configuredApiUrl) {
      try {
        const apiOrigin = new URL(configuredApiUrl, window.location.href);
        const localApi = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(apiOrigin.hostname);
        if (apiOrigin.protocol !== "https:" && !localApi) {
          setKeyError("Configure your API server to use HTTPS before sending an API key.");
          return;
        }
      } catch {
        setKeyError("The configured API server address is invalid.");
        return;
      }
    }
    setVerifying(true);
    setKeyError("");
    const access = await verifyApiAccess({ token, groqKey: key });
    setVerifying(false);
    if (!access.ok) {
      setKeyError(access.message);
      return;
    }
    onStart({ apiToken: token, groqApiKey: key });
    if (rememberable && key && !token) void rememberGroqKey(remember);
  };


  return (
    <div className="deck-card tone-plain !p-0">
      <div className="tone-sky relative px-6 pb-6 pt-5 sm:px-7">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 text-sm font-medium text-ink"><span className="logo-ring" aria-hidden="true" /> HANNAH</span>
          {onClose && <button type="button" aria-label="Close" onClick={onClose} className="flex h-9 w-9 items-center justify-center rounded-full bg-white/70 text-slate-600 transition hover:bg-white hover:text-ink"><X size={15} /></button>}
        </div>
        <span className="pill-badge mt-6"><span className="pill-badge-dot"><Check size={9} strokeWidth={3} /></span>{accountMode ? (keyless ? "Free · No API key needed" : "Your account on this server") : "Free · No sign-up"}</span>
        <h2 id="connect-title" className="display-title mt-3 text-[2rem]">{accountMode ? (keyless ? "Start talking to HANNAH." : "Welcome back.") : "Connect with HANNAH."}</h2>
        <p className="mt-2 text-sm leading-6 text-slate-700">{accountMode
          ? keyless
            ? "Create a free account with an email and a password. There's no API key to find and nothing to pay; your memories and reminders follow you to any device."
            : `Sign in to use your saved keys, memories and reminders on any device. Stored on ${databaseLabel(accountInfo?.database.provider)}, run by this server's operator.`
          : "Paste your own Groq API key and start talking. There's no account and nothing to pay."}</p>
      </div>

      {accountMode && accountInfo ? (
        <div className="px-6 pb-6 pt-5 sm:px-7">
          <SignInForm key={keyless ? "keyless" : "keyed"} signupAllowed={accountInfo.accounts.signup} vault={accountInfo.vault} serverKeys={accountInfo.accounts.serverKeys} startWith={keyless ? "signup" : "signin"} onSignedIn={(key) => onStart({ apiToken: "", groqApiKey: key })} />
          <button type="button" onClick={() => { setChoseKey(true); setAccountMode(false); }} className="mt-4 w-full text-center text-xs font-medium text-slate-600 underline decoration-slate-300 underline-offset-2 hover:text-ink">Use a Groq key without an account</button>
        </div>
      ) : (
      <form className="px-6 pb-6 pt-5 sm:px-7" onSubmit={beginConversation}>
        <label htmlFor="groq-key" className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-slate-700"><KeyRound size={13} /> Your Groq API key</label>
        <div className="flex items-center rounded-2xl border border-slate-200 bg-slate-50 pr-2 transition focus-within:border-sky-400 focus-within:bg-white">
          <input
            id="groq-key"
            type={showApiKey ? "text" : "password"}
            value={groqApiKey}
            onChange={(event) => { setGroqApiKey(event.target.value); setKeyError(""); }}
            placeholder="gsk_…"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={512}
            autoFocus
            className="min-w-0 flex-1 bg-transparent px-4 py-3 font-mono text-base text-ink outline-none placeholder:font-sans placeholder:text-slate-400 sm:text-sm"
          />
          <button type="button" onClick={() => setShowApiKey((visible) => !visible)} aria-label={showApiKey ? "Hide Groq API key" : "Show Groq API key"} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-slate-500 transition hover:bg-slate-200 hover:text-ink">
            {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
        <p className="mt-2 text-xs text-slate-500">No key yet? <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer" className="font-medium text-ink underline decoration-slate-300 underline-offset-2 hover:decoration-ink">Create one free at Groq</a>. It takes about a minute.</p>

        <details className="mt-5 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm" open={Boolean(apiToken)}>
          <summary className="cursor-pointer select-none text-xs font-semibold text-slate-600">I have an access token</summary>
          <p className="mt-2 text-xs leading-5 text-slate-500">Only needed if the person running this server gave you one, for example to use their models, voice or desktop features. Operators set it as <code className="rounded bg-slate-100 px-1 font-mono text-[11px]">HANNAH_API_TOKEN</code>.</p>
          <label htmlFor="hannah-api-token" className="sr-only">HANNAH API access token</label>
          <div className="mt-3 flex items-center rounded-xl border border-slate-200 bg-slate-50 pr-2 transition focus-within:border-sky-400 focus-within:bg-white">
            <input
              id="hannah-api-token"
              type={showApiToken ? "text" : "password"}
              value={apiToken}
              onChange={(event) => { setApiToken(event.target.value); setKeyError(""); }}
              placeholder="Access token (optional)"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={512}
              className="min-w-0 flex-1 bg-transparent px-3 py-2.5 text-base text-ink outline-none placeholder:text-slate-400 sm:text-sm"
            />
            <button type="button" onClick={() => setShowApiToken((visible) => !visible)} aria-label={showApiToken ? "Hide HANNAH access token" : "Show HANNAH access token"} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-200 hover:text-ink">
              {showApiToken ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </details>

        {keyError && <p role="alert" className="mt-4 rounded-xl border border-rose-100 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700">{keyError}</p>}
        {rememberable && (
          <label className="mt-4 flex items-start gap-2 text-xs leading-5 text-slate-600">
            <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} className="mt-0.5 h-4 w-4 rounded border-slate-300" />
            <span><span className="font-semibold text-slate-700">Remember on this browser</span> for 30 days, in a secure cookie this page's scripts can't read. Disconnect forgets it.</span>
          </label>
        )}
        <p className="mt-4 flex items-start gap-2 text-xs leading-5 text-slate-500"><ShieldCheck size={14} className="mt-0.5 shrink-0 text-teal-600" /> {IS_WEBSITE && rememberable && remember ? "" : IS_WEBSITE ? "Kept only in this browser tab and cleared when you close it." : "Kept in this app's private storage on this device until you disconnect."} Your key is sent to Groq through HANNAH's server and never stored there.</p>
        <button type="submit" disabled={verifying} className="btn-primary group mt-5 min-h-[3.25rem] w-full !rounded-2xl text-sm disabled:cursor-wait">
          {verifying ? "Checking your key…" : "Continue to HANNAH"} {!verifying && <ArrowRight size={15} className="transition group-hover:translate-x-0.5" />}
        </button>
        {accountsEnabled && (
          <button type="button" onClick={() => { setAccountMode(true); setKeyError(""); }} className="mt-4 w-full text-center text-xs font-medium text-slate-600 underline decoration-slate-300 underline-offset-2 hover:text-ink">Have an account? Sign in or create one</button>
        )}
      </form>
      )}
    </div>
  );
}
