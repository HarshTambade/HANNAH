import { useEffect, useState } from "react";
import { Cloud, HardDrive, Mic, Play, Speaker } from "lucide-react";
import type { SpeechLanguage } from "../types";
import { loadVoiceProviders, readVoiceSettings, saveVoiceSettings, systemVoices, VoiceOut, type VoiceProviders, type VoiceSettings } from "../services/VoiceEngines";

const TEST_LINE = "Hi, I'm HANNAH. This is how I'll sound.";

function readLanguage(): SpeechLanguage {
  try {
    const value = window.localStorage.getItem("hannah.speechLanguage");
    return value === "hi-IN" || value === "mr-IN" ? value : "en-US";
  } catch {
    return "en-US";
  }
}

function Choice({ name, value, checked, onChange, title, detail, badge, disabled }: { name: string; value: string; checked: boolean; onChange: () => void; title: string; detail: string; badge: "device" | "hosted"; disabled?: boolean }) {
  return (
    <label className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition ${checked ? "border-brand-300 bg-brand-50/60" : "border-slate-200 bg-white"} ${disabled ? "cursor-not-allowed opacity-55" : ""}`}>
      <input type="radio" name={name} value={value} checked={checked} disabled={disabled} onChange={onChange} className="mt-1 accent-brand-600" />
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">{title}
          <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">{badge === "device" ? <HardDrive size={11} /> : <Cloud size={11} />}{badge === "device" ? "On this device" : "Hosted"}</span>
        </span>
        <span className="mt-0.5 block text-xs leading-5 text-slate-500">{detail}</span>
      </span>
    </label>
  );
}

/** Settings → Voice: speaking and listening engines, voice choice and barge-in. */
export default function VoiceSettingsPanel() {
  const [settings, setSettings] = useState<VoiceSettings>(readVoiceSettings);
  const [providers, setProviders] = useState<VoiceProviders | null>(null);
  const [voices, setVoices] = useState(() => systemVoices(readLanguage()));
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState("");
  const language = readLanguage();

  useEffect(() => {
    void loadVoiceProviders().then(setProviders);
    const synthesis = typeof window !== "undefined" ? window.speechSynthesis : undefined;
    const refresh = () => setVoices(systemVoices(language));
    synthesis?.addEventListener?.("voiceschanged", refresh);
    return () => synthesis?.removeEventListener?.("voiceschanged", refresh);
  }, [language]);

  const update = (change: Partial<VoiceSettings>) => setSettings(saveVoiceSettings(change));
  const openai = providers?.tts.find((item) => item.id === "openai");
  const whisper = providers?.stt.find((item) => item.id === "groq-whisper");
  const recordingSupported = typeof MediaRecorder !== "undefined";

  const test = async () => {
    setTesting(true);
    setStatus("");
    try {
      const voice = await VoiceOut.speak(TEST_LINE, language);
      setStatus(voice === "interrupted" ? "Stopped." : `Played with ${voice}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Couldn't play the voice.");
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-6">
      <fieldset>
        <legend className="flex items-center gap-1.5 text-sm font-semibold text-ink"><Speaker size={14} /> HANNAH's voice</legend>
        <div className="mt-2 grid gap-2">
          <Choice name="tts" value="auto" checked={settings.tts === "auto"} onChange={() => update({ tts: "auto" })} badge={providers?.mithi ? "hosted" : "device"}
            title="Automatic" detail={providers?.mithi ? "The Mithi voice on this HANNAH server, falling back to your device's voice." : "Your device's voice. Uses the Mithi voice if the server adds it later."} />
          <Choice name="tts" value="system" checked={settings.tts === "system"} onChange={() => update({ tts: "system" })} badge="device"
            title="Device voice" detail="Built into your browser or phone. Works offline and nothing leaves the device." />
          <Choice name="tts" value="openai" checked={settings.tts === "openai"} onChange={() => update({ tts: "openai" })} badge="hosted" disabled={!openai?.available && settings.tts !== "openai"}
            title="OpenAI voices" detail={openai?.available ? `Natural voices from OpenAI (${openai.model}). Reply text is sent to OpenAI to synthesize.` : "Needs an OpenAI key saved to your account (Settings → Account) or set on the server."} />
        </div>
        {settings.tts === "openai" && openai && (
          <div className="mt-3">
            <label htmlFor="openai-voice" className="mb-1 block text-xs font-medium text-slate-600">Voice</label>
            <select id="openai-voice" value={settings.openaiVoice} onChange={(event) => update({ openaiVoice: event.target.value })} className="w-full max-w-xs rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm capitalize">
              {openai.voices.map((voice) => <option key={voice} value={voice}>{voice}</option>)}
            </select>
          </div>
        )}
        {settings.tts !== "openai" && voices.length > 0 && (
          <div className="mt-3">
            <label htmlFor="system-voice" className="mb-1 block text-xs font-medium text-slate-600">Device voice ({language})</label>
            <select id="system-voice" value={settings.systemVoice} onChange={(event) => update({ systemVoice: event.target.value })} className="w-full max-w-sm rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
              <option value="">HANNAH's pick (a soft voice for your language)</option>
              {voices.map((voice) => <option key={voice.name} value={voice.name}>{voice.name}{voice.local ? "" : " · online"}</option>)}
            </select>
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => void test()} disabled={testing} className="btn-outline"><Play size={13} /> {testing ? "Playing…" : "Test voice"}</button>
          {testing && <button type="button" onClick={() => void VoiceOut.cancel()} className="btn-ghost">Stop</button>}
          {status && <span role="status" className="text-xs text-slate-500">{status}</span>}
        </div>
      </fieldset>

      <fieldset>
        <legend className="flex items-center gap-1.5 text-sm font-semibold text-ink"><Mic size={14} /> Listening</legend>
        <div className="mt-2 grid gap-2">
          <Choice name="stt" value="system" checked={settings.stt === "system"} onChange={() => update({ stt: "system" })} badge="device"
            title="Browser or device recognition" detail="Chrome, Edge and Safari send audio to their own speech service; the phone apps use the device's recognizer." />
          <Choice name="stt" value="groq-whisper" checked={settings.stt === "groq-whisper"} onChange={() => update({ stt: "groq-whisper" })} badge="hosted" disabled={(!whisper?.available || !recordingSupported) && settings.stt !== "groq-whisper"}
            title="Groq Whisper" detail={!recordingSupported ? "This browser can't record audio." : whisper?.available ? "Accurate transcription in many languages, in any browser that can record. Each utterance is sent to Groq." : "Needs a Groq key: yours, your account's, or the server's."} />
        </div>
      </fieldset>

      <label className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-4">
        <span>
          <span className="block text-sm font-semibold text-ink">Interrupt by talking</span>
          <span className="mt-0.5 block text-xs text-slate-500">While HANNAH speaks, the microphone listens (with echo cancellation) and she stops as soon as you start talking. Audio isn't recorded or sent anywhere for this.</span>
        </span>
        <input type="checkbox" checked={settings.bargeIn} onChange={(event) => update({ bargeIn: event.target.checked })} className="h-5 w-5 accent-brand-600" aria-label="Interrupt by talking" />
      </label>
    </div>
  );
}
