import { FormEvent, KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { useBrowserLLM } from "use-browser-llm";
import {
  ArrowUp, Bookmark, BookmarkCheck, Bot, Cpu, Globe2, HardDrive, KeyRound, Laptop, LockKeyhole, MessageSquarePlus, Mic, MicOff, Phone, PhoneOff,
  RotateCcw, Settings2, ShieldAlert, Smartphone, Speaker, VolumeX, X, ThumbsUp, Check, Pencil, ThumbsDown, Save,
} from "lucide-react";
import { ChatHistory } from "../services/ChatHistory";
import { UsageStats } from "../services/UsageStats";
import { MemoryService } from "../services/MemoryService";
import { notifyMemoryChanged } from "../services/MemoryStore";
import { AgentApiError } from "../services/LLMRouter";
import { ApprovalCenter, type ApprovalRequest } from "../services/ApprovalCenter";
import MessageContent from "./MessageContent";
import type { ChatMessage, Emotion, InferenceMode, SpeechLanguage } from "../types";
import { useConnectivity } from "../services/connectivity";
import {
  generateOfflineReply,
  getOfflineModelStatus,
  prepareOfflineModel,
  resolveInferenceMode,
  type OfflineModelStatus,
} from "../services/AIService";
import { apiFetch, apiHeaders, apiUrl, isLocalDevelopmentHost } from "../services/api";
import { SpeechService } from "../services/SpeechService";
import { VoiceService } from "../services/VoiceService";
import { agentRules, runAgentTurn, type AgentActivity } from "../services/AgentRuntime";
import { clearMobileAgentConversation, getMobileAgentStatus, removeMobileAgentApiKey, runMobileAgentTurn, setMobileAgentApiKey } from "../services/MobileAgent";
import { screenIncomingPrompt, screenOutgoingText } from "../services/AgentGuardrails";
import { hasDesktopBridge, runDesktopAgentTurn } from "../services/DesktopAgent";
import { trackEvent } from "../services/events";
import FeedbackModal from "./FeedbackModal";
import FirstSessionCoach from "./FirstSessionCoach";
import TaskPanel from "./TaskPanel";
import ReportButton from "./ReportButton";
import MemoryControls from "./MemoryControls";
import HITLApprovalCard from "./HITLApprovalCard";
import { PersonalizationEngine } from "../services/PersonalizationEngine";
import { CognitiveReadinessEngine } from "../services/CognitiveReadinessEngine";
import { ChaosEngine, type DegradedState } from "../services/ChaosEngine";

const WEBLLM_MODEL = "Llama-3.2-1B-Instruct-q4f16_1-MLC";
const welcomeMessage: ChatMessage = {
  id: "hannah-welcome",
  role: "assistant",
  content: "Hey, I’m HANNAH. It’s lovely to meet you. What’s on your mind?",
};

function createMessageId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const modeDetails: Record<InferenceMode, { label: string; description: string; icon: typeof Globe2 }> = {
  cloud: { label: "Groq Cloud", description: "Groq is the default; other configured model providers are available", icon: Globe2 },
  webllm: { label: "WebLLM Local", description: "Runs in this browser with WebGPU", icon: Cpu },
  ollama: { label: "Local Ollama", description: "Uses your configured Ollama server", icon: HardDrive },
  native: { label: "On-device AI", description: "Runs a downloaded llama.cpp model", icon: Smartphone },
  mobileclaw: { label: "MobileClaw · Anthropic", description: "Native agent using your Anthropic key", icon: Smartphone },
  desktop: { label: "Desktop Agent", description: "Uses the desktop with confirmation", icon: Laptop },
};

function modelLabel(model: string) {
  if (model === "openai/gpt-oss-120b") return "GPT-OSS 120B · Groq primary";
  if (model === "openai/gpt-oss-20b") return "GPT-OSS 20B · Groq fallback";
  if (model === "llama-3.3-70b-versatile") return "Llama 3.3 70B · Groq Enterprise";
  if (model === "llama-3.1-8b-instant") return "Llama 3.1 8B · Groq Enterprise";
  return model;
}

function normalizeEmotion(value: unknown): Emotion {
  return value === "happy" || value === "sad" || value === "angry" || value === "neutral" || value === "surprised" || value === "thinking"
    ? value
    : "neutral";
}

function parseAIResponse(value: unknown): { reply: string; emotion: Emotion } {
  let parsed = value;
  if (typeof value === "string") {
    const candidate = value.match(/\{[\s\S]*\}/)?.[0];
    if (candidate) {
      try {
        parsed = JSON.parse(candidate);
      } catch {
        return { reply: screenOutgoingText(value.trim()), emotion: "neutral" };
      }
    } else {
      return { reply: screenOutgoingText(value.trim()), emotion: "neutral" };
    }
  }

  if (parsed && typeof parsed === "object" && "reply" in parsed) {
    const result = parsed as { reply?: unknown; emotion?: unknown };
    if (typeof result.reply === "string" && result.reply.trim()) {
      return { reply: screenOutgoingText(result.reply.trim()), emotion: normalizeEmotion(result.emotion) };
    }
  }
  throw new Error("The companion returned an invalid response. Please try again.");
}

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remainder = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}

type ChatUIProps = {
  onEmotionChange: (emotion: Emotion) => void;
  panel?: boolean;
  groqApiKey: string;
  initialMode?: InferenceMode;
  /** Called when the server rejects the saved access token. */
  onSessionExpired?: () => void;
};

type ApiStatus = "checking" | "connected" | "offline" | "misconfigured" | "unauthorized";

function initialMessages(): ChatMessage[] {
  const saved = ChatHistory.load();
  return saved.length ? saved : [welcomeMessage];
}
type CloudProviderOption = { id: string; label: string; local: boolean; configured: boolean; defaultModel?: string };

export default function ChatUI({ onEmotionChange, panel = false, groqApiKey, initialMode = "cloud", onSessionExpired }: ChatUIProps) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [rememberedIds, setRememberedIds] = useState<Record<string, true>>({});
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<InferenceMode>(initialMode);
  const [cloudProviders, setCloudProviders] = useState<CloudProviderOption[]>([]);
  const [cloudProviderId, setCloudProviderId] = useState(() => {
    try {
      return window.localStorage.getItem("hannah.cloudProvider") || "groq";
    } catch {
      return "groq";
    }
  });
  const [cloudModels, setCloudModels] = useState<string[]>([]);
  const [cloudModel, setCloudModel] = useState("");
  const [cloudProvider, setCloudProvider] = useState("Groq");
  const [apiStatus, setApiStatus] = useState<ApiStatus>("checking");
  const [apiError, setApiError] = useState("");
  const [speechLanguage, setSpeechLanguage] = useState<SpeechLanguage>("en-US");
  const [voiceEnabled, setVoiceEnabled] = useState(() => {
    try {
      const saved = window.localStorage.getItem("hannah.voiceEnabled");
      return saved === null ? true : saved === "true";
    } catch {
      return true;
    }
  });
  const [voiceStatus, setVoiceStatus] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isVirtualCallActive, setIsVirtualCallActive] = useState(false);
  const [isCallMicEnabled, setIsCallMicEnabled] = useState(false);
  const [isCallSpeakerOn, setIsCallSpeakerOn] = useState(true);
  const [callStartedAt, setCallStartedAt] = useState<number | null>(null);
  const [callDuration, setCallDuration] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [prepareWebFallback, setPrepareWebFallback] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isFeedbackOpen, setIsFeedbackOpen] = useState(false);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editedResponse, setEditedResponse] = useState("");
  const [styleFeedback, setStyleFeedback] = useState<Record<string, string>>({});
  const [degradedState, setDegradedState] = useState<DegradedState>(ChaosEngine.getDegraded());

  useEffect(() => {
    trackEvent("chat_opened");
    const startedAt = Date.now();
    const handleVisibility = () => {
      if (document.visibilityState === "visible") trackEvent("app_foregrounded");
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      trackEvent("session_duration", { seconds: Math.round((Date.now() - startedAt) / 1000) });
    };
  }, []);
  useEffect(() => ChaosEngine.subscribe(() => setDegradedState(ChaosEngine.getDegraded())), []);
  // While chat is open, HITL confirmations appear as in-chat approval cards.
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  useEffect(() => ApprovalCenter.attachHost(setApprovals), []);
  useEffect(() => {
    // Keep only the real conversation; transient tool/status lines are not history.
    const durable = messages.filter((message) => message.role !== "system");
    if (durable.length <= 1 && durable[0]?.id === welcomeMessage.id) ChatHistory.clear();
    else ChatHistory.save(durable);
  }, [messages]);
  const [nativeStatus, setNativeStatus] = useState<OfflineModelStatus>("checking");
  const [isPreparingNative, setIsPreparingNative] = useState(false);
  const [nativeAgentStatus, setNativeAgentStatus] = useState({ available: false, initialized: false, hasApiKey: false });
  const [mobileApiKey, setMobileApiKey] = useState("");
  const [isSavingMobileApiKey, setIsSavingMobileApiKey] = useState(false);
  const [isRemovingMobileApiKey, setIsRemovingMobileApiKey] = useState(false);
  const [agentActivity, setAgentActivity] = useState<AgentActivity | null>(null);
  const [modelDownloadProgress, setModelDownloadProgress] = useState(0);
  const [error, setError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const callLogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const voiceSessionRef = useRef<(() => Promise<void> | void) | null>(null);
  const startCallListeningRef = useRef<() => void>(() => undefined);
  const callActiveRef = useRef(false);
  const callMicEnabledRef = useRef(false);
  const callSpeakerRef = useRef(true);
  const voiceEnabledRef = useRef(voiceEnabled);
  const voiceInputEnabledRef = useRef(false);
  const voiceTurnPendingRef = useRef(false);
  const voiceStartPendingRef = useRef(false);
  const isSubmittingTurnRef = useRef(false);
  voiceEnabledRef.current = voiceEnabled;
  const isOnline = useConnectivity();
  const platform = Capacitor.getPlatform();
  const isNative = platform === "ios" || platform === "android";
  const desktopAvailable = hasDesktopBridge();
  const effectiveMode = resolveInferenceMode(mode, isOnline);
  const localLLM = useBrowserLLM(effectiveMode === "webllm" || prepareWebFallback ? WEBLLM_MODEL : undefined);
  const localLLMRef = useRef(localLLM);
  // Keep in-flight API fallback work connected to the hook's latest load state.
  localLLMRef.current = localLLM;
  const selectedMode = effectiveMode === "cloud"
    ? {
      ...modeDetails.cloud,
      label: cloudProvider === "Groq" ? "Groq Cloud" : `${cloudProvider} AI`,
      description: `${cloudProvider} model with device tools`,
    }
    : modeDetails[effectiveMode];
  useEffect(() => {
    let active = true;
    const loadProviders = async () => {
      try {
        const response = await apiFetch(apiUrl("/api/providers"), { signal: AbortSignal.timeout(5_000) });
        if (response.status === 401) {
          if (active) setApiStatus("unauthorized");
          return;
        }
        if (!response.ok) throw new Error(`API returned HTTP ${response.status}.`);
        const data = await response.json();
        if (!active || !Array.isArray(data.providers)) return;
        const providers = (data.providers as unknown[]).filter((item: unknown): item is CloudProviderOption =>
          Boolean(item && typeof item === "object" && typeof (item as CloudProviderOption).id === "string"
            && typeof (item as CloudProviderOption).label === "string" && !(item as CloudProviderOption).local
            && ((item as CloudProviderOption).configured || (item as CloudProviderOption).id === "groq")));
        setCloudProviders(providers);
        setApiError("");
        let storedProvider: string | null = null;
        try {
          storedProvider = window.localStorage.getItem("hannah.cloudProvider");
        } catch {
          storedProvider = null;
        }
        const selected = providers.some((provider) => provider.id === storedProvider)
          ? storedProvider!
          : providers.some((provider) => provider.id === data.defaultProvider)
            ? data.defaultProvider
            : providers[0]?.id || "groq";
        setCloudProviderId(selected);
        setCloudProvider(providers.find((provider) => provider.id === selected)?.label || "Groq");
        setApiStatus(providers.length ? "checking" : "misconfigured");
      } catch {
        if (active) setApiStatus("offline");
      }
    };

    void loadProviders();
    const retryTimer = window.setInterval(() => void loadProviders(), 30_000);
    return () => {
      active = false;
      window.clearInterval(retryTimer);
    };
  }, []);

  useEffect(() => {
    if (!cloudProviderId) return;
    let active = true;
    setApiStatus("checking");
    setCloudModels([]);
    const headers = apiHeaders({ Accept: "application/json" });
    if (cloudProviderId === "groq" && groqApiKey) headers.set("X-Groq-API-Key", groqApiKey);
    const loadModels = async () => {
      try {
        const response = await fetch(apiUrl(`/api/models?provider=${encodeURIComponent(cloudProviderId)}`), { headers, signal: AbortSignal.timeout(8_000) });
        if (response.status === 401) {
          if (active) setApiStatus("unauthorized");
          return;
        }
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Provider model discovery failed.");
        if (!active || !Array.isArray(data.models)) return;
        const models = data.models.filter((model: unknown): model is string => typeof model === "string" && model.length > 0);
        setCloudModels(models);
        setCloudProvider(typeof data.provider === "string" ? data.provider : "Groq");
        setApiError("");
        setApiStatus(models.length ? "connected" : "misconfigured");
        let storedModel: string | null = null;
        try {
          storedModel = window.localStorage.getItem(`hannah.cloudModel:${cloudProviderId}`);
        } catch {
          storedModel = null;
        }
        setCloudModel(models.includes(storedModel || "") ? storedModel! : data.defaultModel || models[0] || "");
      } catch (error) {
        if (active) {
          setApiStatus("misconfigured");
          setCloudModels([]);
          setCloudModel("");
          setApiError(error instanceof Error ? error.message : "Model discovery failed.");
        }
      }
    };
    void loadModels();
    return () => { active = false; };
  }, [cloudProviderId, groqApiKey]);

  useEffect(() => {
    if (!cloudProviderId) return;
    try {
      window.localStorage.setItem("hannah.cloudProvider", cloudProviderId);
    } catch {
      // Provider preference remains available for this session if storage is unavailable.
    }
  }, [cloudProviderId]);

  useEffect(() => {
    if (!cloudProviderId || !cloudModel) return;
    try {
      window.localStorage.setItem(`hannah.cloudModel:${cloudProviderId}`, cloudModel);
    } catch {
      // The server still supplies its default if storage is unavailable.
    }
  }, [cloudProviderId, cloudModel]);

  useEffect(() => {
    try {
      window.localStorage.setItem("hannah.voiceEnabled", String(voiceEnabled));
    } catch {
      // Voice preference remains available for this session if storage is disabled.
    }
  }, [voiceEnabled]);

  const refreshNativeStatus = useCallback(async () => {
    if (!isNative) {
      setNativeStatus("unavailable");
      return;
    }
    try {
      setNativeStatus(await getOfflineModelStatus());
    } catch {
      setNativeStatus("unavailable");
    }
  }, [isNative]);

  useEffect(() => {
    void refreshNativeStatus();
  }, [isOnline, refreshNativeStatus]);

  useEffect(() => {
    if (isNative) void getMobileAgentStatus().then(setNativeAgentStatus);
  }, [isNative]);

  useEffect(() => () => {
    voiceInputEnabledRef.current = false;
    const stop = voiceSessionRef.current;
    voiceSessionRef.current = null;
    void stop?.();
  }, []);

  useEffect(() => {
    const target = isVirtualCallActive ? callLogRef.current : scrollRef.current;
    target?.scrollTo({ top: target.scrollHeight, behavior: "smooth" });
  }, [messages, isLoading, error, isVirtualCallActive, approvals.length]);

  useEffect(() => {
    if (!isVirtualCallActive || callStartedAt === null) return;
    const updateDuration = () => setCallDuration(Math.floor((Date.now() - callStartedAt) / 1000));
    updateDuration();
    const timer = window.setInterval(updateDuration, 1000);
    return () => window.clearInterval(timer);
  }, [callStartedAt, isVirtualCallActive]);

  const handlePrepareNative = async () => {
    setIsPreparingNative(true);
    setError("");
    setNativeStatus("notready");
    setModelDownloadProgress(0);
    try {
      await prepareOfflineModel(setModelDownloadProgress);
      await refreshNativeStatus();
    } catch (prepareError) {
      setError(prepareError instanceof Error ? prepareError.message : "Could not download the on-device model.");
      await refreshNativeStatus();
    } finally {
      setIsPreparingNative(false);
    }
  };

  const submitMessage = async (event?: FormEvent<HTMLFormElement>, transcript?: string, speakReply = voiceEnabled) => {
    event?.preventDefault();
    const content = (transcript ?? input).trim();
    if (!content || isLoading || isSubmittingTurnRef.current || (voiceTurnPendingRef.current && transcript === undefined)) return false;
    if (effectiveMode === "webllm" && localLLM.status !== "ready") {
      setError(localLLM.status === "unsupported" ? "WebGPU is unavailable. Reconnect or use the native app for offline AI." : "The browser model is still preparing or could not load.");
      return false;
    }
    if (effectiveMode === "native" && nativeStatus !== "available") {
      setError(nativeStatus === "downloadable" ? "Prepare the offline model while online, then try again." : "This device does not have a supported on-device AI model.");
      return false;
    }


    isSubmittingTurnRef.current = true;
    const activeVoiceSession = voiceSessionRef.current;
    if (activeVoiceSession) {
      voiceSessionRef.current = null;
      voiceTurnPendingRef.current = true;
      setIsListening(false);
      try {
        await activeVoiceSession();
      } catch {
        // Continue the user-requested turn if recognition already stopped.
      }
    }

    const nextMessages = [...messages, { id: createMessageId(), role: "user" as const, content }];
    CognitiveReadinessEngine.recordInteraction();
    const guardedContent = screenIncomingPrompt(content);
    setMessages(nextMessages);
    setInput("");
    setError("");
    setIsLoading(true);
    setAgentActivity({ phase: "thinking", message: "HANNAH is thinking…" });
    if (inputRef.current) inputRef.current.style.height = "auto";

    let spokenReply: Promise<void> | null = null;
    const turnStartedAt = performance.now();
    try {
      let result: { reply: string; emotion: Emotion; meta?: { provider?: string; model?: string; inputTokens?: number; outputTokens?: number } };
      const publishActivity = (message: string, acting = false) => {
        setAgentActivity({ phase: acting ? "acting" : "thinking", message });
        if (!acting && message && !message.toLowerCase().includes("thinking") && !message.toLowerCase().includes("examining") && !message.toLowerCase().includes("screenshot")) {
          setMessages((current) => [...current, { role: "system", content: message }]);
        }
      };

      if (effectiveMode === "desktop") {
        const reply = await runDesktopAgentTurn(guardedContent, publishActivity);
        result = parseAIResponse(reply);
      } else if (effectiveMode === "mobileclaw" && isNative && isOnline && nativeAgentStatus.hasApiKey) {
        const response = await runMobileAgentTurn(content, publishActivity);
        result = parseAIResponse(response);
      } else {
        result = await runAgentTurn({
          mode: effectiveMode,
          providerId: cloudProviderId,
          model: cloudModel || undefined,
          groqApiKey,
          messages: nextMessages,
          generateLocal: async (prompt, routeMode, cause) => {
            if (routeMode === "webllm") {
              // A cloud hiccup while online must not silently start a ~1 GB
              // model download. Fall back only when the browser model is
              // already loaded, the user chose it, or the device is offline.
              const browserOnline = typeof navigator === "undefined" || navigator.onLine;
              if (effectiveMode === "cloud" && browserOnline && localLLMRef.current.status !== "ready" && !ChaosEngine.isEnabled()) {
                ChaosEngine.clearDegraded();
                const reason = cause instanceof Error && cause.message ? cause.message : "HANNAH’s cloud AI is busy or unavailable right now.";
                throw new Error(`${reason} Try again in a moment, or choose WebLLM Local in chat settings to run AI in this browser.`);
              }
              setPrepareWebFallback(true);
              const messages = [{ role: "system" as const, content: agentRules }, { role: "user" as const, content: prompt }];
              const deadline = Date.now() + 180_000;
              while (Date.now() < deadline) {
                const local = localLLMRef.current;
                if (local.status === "ready") return local.generate(messages);
                if (local.status === "unsupported") throw new Error("This browser does not support WebGPU local AI. Prepare the native model in the mobile app or reconnect to Groq.");
                if (local.status === "error") throw new Error("The local WebLLM model could not load. Reconnect once to download it, then retry offline.");
                setAgentActivity({ phase: "thinking", message: local.status === "loading" ? `Preparing local AI · ${Math.round(local.progress * 100)}%` : "Starting local AI…" });
                await new Promise((resolve) => window.setTimeout(resolve, 300));
              }
              throw new Error("Local WebLLM took too long to prepare. Check WebGPU support and model download access.");
            }
            if (routeMode === "native") return generateOfflineReply([{ role: "user", content: prompt }]);
            throw new Error("The selected agent mode is unavailable.");
          },
          onActivity: (activity) => {
            setAgentActivity(activity);
            if (activity.phase === "tool-result") setMessages((current) => [...current, { role: "system", content: activity.message }]);
          },
        });
      }

      UsageStats.record({
        latencyMs: Math.round(performance.now() - turnStartedAt),
        ok: true,
        mode: effectiveMode,
        provider: result.meta?.provider || (effectiveMode === "cloud" ? cloudProvider : modeDetails[effectiveMode].label),
        model: result.meta?.model || (effectiveMode === "cloud" ? cloudModel || undefined : undefined),
        inputTokens: result.meta?.inputTokens,
        outputTokens: result.meta?.outputTokens,
        voice: transcript !== undefined,
      });
      const userTurns = messages.filter((message) => message.role === "user").length + 1;
      if (userTurns === 1) trackEvent("first_message_sent");
      if (userTurns === 3) trackEvent("third_message_sent");
      if (transcript !== undefined) trackEvent("voice_used");
      setMessages((current) => [...current, { id: createMessageId(), role: "assistant", content: result.reply }]);
      onEmotionChange(result.emotion);
      if (speakReply) {
        setVoiceStatus("HANNAH is speaking…");
        setIsSpeaking(true);
        spokenReply = SpeechService.speak(result.reply, speechLanguage)
          .then((voiceName) => setVoiceStatus(`Speaking with ${voiceName}`))
          .catch((speechError) => setVoiceStatus(speechError instanceof Error ? speechError.message : "Offline voice unavailable."))
          .finally(() => setIsSpeaking(false));
      }
    } catch (requestError) {
      UsageStats.record({ latencyMs: Math.round(performance.now() - turnStartedAt), ok: false, mode: effectiveMode, voice: transcript !== undefined });
      if (requestError instanceof AgentApiError && requestError.status === 401) {
        setApiStatus("unauthorized");
        setError("Your access token is no longer accepted. Reconnect with a valid token to keep chatting.");
      } else {
        setError(requestError instanceof Error ? requestError.message : "Something went wrong. Please try again.");
      }
    } finally {
      setIsLoading(false);
      setAgentActivity(null);
      isSubmittingTurnRef.current = false;
      inputRef.current?.focus();
      const canResumeVoice = voiceInputEnabledRef.current && (!callActiveRef.current || callMicEnabledRef.current);
      const resumeListening = () => {
        voiceTurnPendingRef.current = false;
        if (voiceInputEnabledRef.current && (!callActiveRef.current || callMicEnabledRef.current)) {
          startCallListeningRef.current();
        }
      };
      if (canResumeVoice) {
        if (spokenReply) void spokenReply.then(() => window.setTimeout(resumeListening, 350));
        else window.setTimeout(resumeListening, 350);
      } else {
        voiceTurnPendingRef.current = false;
      }
    }
    return true;
  };

  const saveMobileAgentKey = async () => {
    setIsSavingMobileApiKey(true);
    setError("");
    try {
      await setMobileAgentApiKey(mobileApiKey);
      setMobileApiKey("");
      setNativeAgentStatus({ available: true, initialized: true, hasApiKey: true });
      setVoiceStatus("MobileClaw connected. Select it in inference settings; Groq stays the default.");
    } catch (keyError) {
      setError(keyError instanceof Error ? keyError.message : "Could not save the native agent key.");
    } finally {
      setIsSavingMobileApiKey(false);
    }
  };

  const removeMobileAgentKey = async () => {
    setIsRemovingMobileApiKey(true);
    setError("");
    try {
      await removeMobileAgentApiKey();
      setNativeAgentStatus({ available: true, initialized: true, hasApiKey: false });
      setVoiceStatus("Saved Anthropic key removed from this device.");
    } catch (keyError) {
      setError(keyError instanceof Error ? keyError.message : "Could not remove the saved agent key.");
    } finally {
      setIsRemovingMobileApiKey(false);
    }
  };

  const startVirtualCall = async () => {
    if (isVirtualCallActive) return;
    const stop = voiceSessionRef.current;
    voiceSessionRef.current = null;
    try {
      if (stop) await stop();
    } catch {
      // Starting the virtual call should recover from an already-ended mic session.
    }
    setIsListening(false);
    setError("");
    callActiveRef.current = true;
    callMicEnabledRef.current = true;
    voiceInputEnabledRef.current = true;
    setIsVirtualCallActive(true);
    setIsCallMicEnabled(true);
    setCallStartedAt(Date.now());
    setCallDuration(0);
    callSpeakerRef.current = true;
    setIsCallSpeakerOn(true);
    setVoiceStatus("Virtual call connected · your microphone is live");
    startCallListeningRef.current();
  };

  const endVirtualCall = async () => {
    callActiveRef.current = false;
    callMicEnabledRef.current = false;
    voiceInputEnabledRef.current = false;
    const stop = voiceSessionRef.current;
    voiceSessionRef.current = null;
    try {
      if (stop) await stop();
    } catch {
      // The conversation still ends if the browser has already stopped recognition.
    }
    setIsListening(false);
    setIsCallMicEnabled(false);
    setIsSpeaking(false);
    setIsVirtualCallActive(false);
    setCallStartedAt(null);
    setCallDuration(0);
    callSpeakerRef.current = true;
    setIsCallSpeakerOn(true);
    void SpeechService.cancel().catch(() => undefined);
    setVoiceStatus("Virtual call ended");
  };

  const toggleCallSpeaker = () => {
    const enabled = !callSpeakerRef.current;
    callSpeakerRef.current = enabled;
    setIsCallSpeakerOn(enabled);
    setVoiceStatus(enabled ? "Call speaker on" : "Call speaker muted");
    if (!enabled) {
      setIsSpeaking(false);
      void SpeechService.cancel().catch(() => undefined);
    }
  };

  const startVoiceInputSession = async () => {
    if (voiceSessionRef.current || voiceStartPendingRef.current || voiceTurnPendingRef.current || !voiceInputEnabledRef.current || isLoading || isSpeaking) return;
    voiceStartPendingRef.current = true;
    setError("");
    try {
      const stop = await VoiceService.startSession(speechLanguage, (transcript, isFinal) => {
        if (voiceTurnPendingRef.current) return;
        setInput(transcript);
        if (!isFinal) return;

        // Stop the microphone before HANNAH responds so speech recognition
        // cannot mistake the synthesized reply for the next user turn.
        voiceTurnPendingRef.current = true;
        const activeSession = voiceSessionRef.current;
        voiceSessionRef.current = null;
        setIsListening(false);
        void (async () => {
          try {
            await activeSession?.();
          } catch {
            // Recognition may have ended itself after returning the final result.
          }
          if (!voiceInputEnabledRef.current || (callActiveRef.current && !callMicEnabledRef.current)) {
            voiceTurnPendingRef.current = false;
            return;
          }
          const shouldSpeakReply = callActiveRef.current ? callSpeakerRef.current : voiceEnabledRef.current;
          const accepted = await submitMessage(undefined, transcript, shouldSpeakReply);
          if (!accepted) {
            voiceTurnPendingRef.current = false;
            if (voiceInputEnabledRef.current && (!callActiveRef.current || callMicEnabledRef.current)) {
              startCallListeningRef.current();
            }
          }
        })();
      }, (message) => {
        setError(message);
        voiceInputEnabledRef.current = false;
        const stop = voiceSessionRef.current;
        voiceSessionRef.current = null;
        setIsListening(false);
        void stop?.();
        if (callActiveRef.current) {
          callMicEnabledRef.current = false;
          setIsCallMicEnabled(false);
        }
      });
      if (!voiceInputEnabledRef.current || voiceTurnPendingRef.current) {
        await stop();
        return;
      }
      voiceSessionRef.current = stop;
      setIsListening(true);
      setVoiceStatus(`Listening in ${speechLanguage} · speak to send`);
    } catch (voiceError) {
      voiceSessionRef.current = null;
      voiceInputEnabledRef.current = false;
      setIsListening(false);
      setError(voiceError instanceof Error ? voiceError.message : "Could not start voice input.");
      if (callActiveRef.current) {
        callMicEnabledRef.current = false;
        setIsCallMicEnabled(false);
      }
    } finally {
      voiceStartPendingRef.current = false;
    }
  };

  startCallListeningRef.current = () => { void startVoiceInputSession(); };

  useEffect(() => {
    if (
      voiceInputEnabledRef.current
      && !voiceSessionRef.current
      && !voiceStartPendingRef.current
      && !voiceTurnPendingRef.current
      && !isLoading
      && !isSpeaking
      && (!callActiveRef.current || callMicEnabledRef.current)
    ) {
      startCallListeningRef.current();
    }
  }, [isCallMicEnabled, isLoading, isListening, isSpeaking, isVirtualCallActive]);

  const toggleVoiceInput = async () => {
    if (!isListening) {
      voiceInputEnabledRef.current = true;
      await startVoiceInputSession();
      return;
    }
    voiceInputEnabledRef.current = false;
    try {
      await voiceSessionRef.current?.();
    } finally {
      voiceSessionRef.current = null;
      setIsListening(false);
      setVoiceStatus("Voice input stopped");
    }
  };

  const toggleCallMicrophone = () => {
    const enabled = !callMicEnabledRef.current;
    callMicEnabledRef.current = enabled;
    voiceInputEnabledRef.current = enabled;
    setIsCallMicEnabled(enabled);
    if (enabled) {
      if (!isLoading && !isSpeaking) startCallListeningRef.current();
      return;
    }

    const stop = voiceSessionRef.current;
    voiceSessionRef.current = null;
    setIsListening(false);
    setVoiceStatus("Call microphone muted");
    void Promise.resolve(stop?.()).catch(() => undefined);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submitMessage();
    }
  };

  const resetConversation = () => {
    if (isLoading) return;
    setMessages([welcomeMessage]);
    setRememberedIds({});
    ChatHistory.clear();
    setError("");
    setInput("");
    setVoiceStatus("");
    onEmotionChange("neutral");
    void clearMobileAgentConversation().catch(() => undefined);
  };

  const nativeStatusLabel = nativeStatus === "available"
    ? "GGUF model ready on this device"
    : nativeStatus === "downloadable"
      ? "Model needs a one-time download"
      : nativeStatus === "notready" || isPreparingNative
        ? "Preparing the on-device model…"
        : nativeStatus === "checking"
          ? "Checking device support…"
          : import.meta.env.VITE_OFFLINE_MODEL_URL
            ? "llama.cpp is available in the iOS and Android app"
            : "Set VITE_OFFLINE_MODEL_URL to enable model download";
  const webStatusLabel = localLLM.status === "loading"
    ? `Preparing browser model · ${Math.round(localLLM.progress * 100)}%`
    : localLLM.status === "ready"
      ? "Browser model ready"
      : localLLM.status === "unsupported"
        ? "WebGPU is unavailable in this browser"
        : localLLM.status === "error"
          ? "Could not load the browser model"
          : "Model loads when selected";
  const canSend = effectiveMode === "webllm"
    ? localLLM.status === "ready"
    : effectiveMode === "native"
      ? nativeStatus === "available"
      : true;
  const settingsPosition = panel
    ? "absolute inset-x-2 top-14 bottom-[7.5rem] z-40 overflow-y-auto rounded-2xl border border-slate-200 bg-white/95 p-4 shadow-xl backdrop-blur-2xl"
    : "absolute bottom-[calc(100%+0.5rem)] right-3 z-40 max-h-[min(75dvh,42rem)] w-[min(380px,calc(100vw-1.5rem))] overflow-y-auto rounded-2xl border border-slate-200 bg-white/95 p-4 shadow-xl backdrop-blur-2xl md:right-[max(calc((100vw-42rem)/2),1rem)]";

  return (
    <section className={panel
      ? "relative mx-auto flex h-full min-h-0 w-full max-w-none flex-col overflow-hidden rounded-[1.75rem] border border-white/80 bg-white/75 shadow-[0_24px_60px_-30px_rgba(38,44,74,0.45)] backdrop-blur-xl"
      : "relative mx-auto flex max-h-[48dvh] w-full max-w-2xl flex-col overflow-hidden rounded-[26px] border border-slate-200 bg-white shadow-soft-lg"}>
      <header className="flex shrink-0 items-center justify-between border-b border-slate-200/70 bg-white/40 px-4 py-3 md:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-brand-100 bg-brand-50 text-brand-600">
            <Bot size={17} />
            <span className={`absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-white ${isOnline && (effectiveMode !== "cloud" || apiStatus === "connected") ? "bg-emerald-500" : "bg-amber-500"}`} />
          </div>
          <div className="min-w-0">
            <h1 className="truncate font-['Manrope'] text-sm font-bold text-ink">HANNAH</h1>
            <p className="truncate text-xs text-slate-500">
              {!isOnline
                ? `Offline · ${selectedMode.label}`
                : effectiveMode === "cloud" && apiStatus === "unauthorized"
                  ? "Access token not accepted"
                : effectiveMode === "cloud" && apiStatus === "offline"
                  ? "API server unavailable"
                  : effectiveMode === "cloud" && apiStatus === "misconfigured"
                    ? "Add a provider key or configure one on the server"
                    : effectiveMode === "cloud" && apiStatus === "checking"
                      ? "Connecting to the API…"
                      : selectedMode.label}
              {isVirtualCallActive ? ` · virtual call ${formatDuration(callDuration)}` : ""}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => setIsFeedbackOpen(true)}
            aria-label="Send feedback"
            title="Send feedback"
            className="rounded-xl border border-slate-200 bg-white p-2.5 text-slate-600 transition hover:bg-slate-50"
          >
            <MessageSquarePlus size={15} />
          </button>
          <button
            type="button"
            onClick={() => setIsSettingsOpen((open) => !open)}
            aria-expanded={isSettingsOpen}
            aria-label="Inference and privacy settings"
            className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white p-2.5 text-slate-600 transition hover:bg-slate-50"
          >
            {isSettingsOpen ? <X size={15} /> : <Settings2 size={15} />}
            {panel && <span className="hidden text-xs font-medium sm:inline">{isSettingsOpen ? "Close" : "Settings"}</span>}
          </button>
          <button
            type="button"
            onClick={resetConversation}
            disabled={isLoading}
            aria-label="Start a new conversation"
            className="rounded-xl border border-slate-200 bg-white p-2.5 text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
          >
            <RotateCcw size={15} />
          </button>
        </div>

        {isSettingsOpen && (
          <div className={settingsPosition}>
            <div className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.15em] text-slate-500">
              <Cpu size={14} className="text-violet-300" /> Inference mode
            </div>
            <div className="space-y-2">
              {(Object.keys(modeDetails) as InferenceMode[]).filter((option) =>
                (option !== "desktop" || desktopAvailable) && (option !== "mobileclaw" || isNative)
              ).map((option) => {
                const detail = option === "cloud" ? selectedMode : modeDetails[option];
                const Icon = detail.icon;
                const unavailableNativeOption = option === "native" && !isNative;
                const unavailableMobileClaw = option === "mobileclaw" && !nativeAgentStatus.hasApiKey;
                return (
                  <button
                    key={option}
                    type="button"
                    disabled={isLoading || unavailableNativeOption || unavailableMobileClaw}
                    onClick={() => {
                      setMode(option);
                      setError("");
                      setIsSettingsOpen(false);
                    }}
                    className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition disabled:cursor-not-allowed disabled:opacity-40 ${mode === option ? "border-brand-200 bg-brand-50" : "border-slate-100 bg-white hover:border-slate-200"}`}
                  >
                    <Icon size={16} className={mode === option ? "text-brand-600" : "text-slate-500"} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-ink">{detail.label}</span>
                      <span className="mt-0.5 block text-xs text-slate-500">
                        {unavailableNativeOption
                          ? "Available in the Capacitor app"
                          : unavailableMobileClaw
                            ? "Add an Anthropic key below to enable"
                            : detail.description}
                      </span>
                    </span>
                    {mode === option && <span className="h-1.5 w-1.5 rounded-full bg-brand-500" />}
                  </button>
                );
              })}
            </div>

            {effectiveMode === "cloud" && (
              <div className="mt-3 rounded-xl border border-brand-100 bg-brand-50 p-3">
                <label htmlFor="cloud-provider" className="mb-1.5 block text-xs font-semibold text-slate-700">Model provider</label>
                <select
                  id="cloud-provider"
                  value={cloudProviderId}
                  onChange={(event) => {
                    const nextProvider = event.target.value;
                    setCloudProviderId(nextProvider);
                    setCloudProvider(cloudProviders.find((provider) => provider.id === nextProvider)?.label || "AI provider");
                    setCloudModel("");
                  }}
                  disabled={isLoading || cloudProviders.length === 0}
                  className="mb-3 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs text-ink outline-none focus:border-brand-300 disabled:opacity-50"
                >
                  {cloudProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}{provider.id === "groq" ? " · default" : ""}</option>)}
                </select>
                <label htmlFor="cloud-model" className="mb-1.5 block text-xs font-semibold text-slate-700">{cloudProvider} model</label>
                <select
                  id="cloud-model"
                  value={cloudModel}
                  onChange={(event) => setCloudModel(event.target.value)}
                  disabled={isLoading || cloudModels.length === 0}
                  className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs text-ink outline-none focus:border-brand-300 disabled:opacity-50"
                >
                  {cloudModels.length === 0
                    ? <option value="">Waiting for server model settings…</option>
                    : cloudModels.map((model) => <option key={model} value={model}>{modelLabel(model)}</option>)}
                </select>
                <p className="mt-1.5 text-xs leading-relaxed text-slate-500">Groq is the default. Other providers appear after their server-side credentials are configured. Model names load from the selected provider when its API supports model discovery.</p>
              </div>
            )}

            {effectiveMode === "native" && (
              <div className="mt-3 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                {nativeStatusLabel}
                {isOnline && nativeStatus === "downloadable" && (
                  <button
                    type="button"
                    onClick={() => void handlePrepareNative()}
                    disabled={isPreparingNative}
                    className="mt-2 block w-full rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 font-medium text-violet-700 transition hover:bg-violet-100 disabled:opacity-50"
                  >
                    {isPreparingNative ? `Downloading · ${Math.round(modelDownloadProgress)}%` : "Download offline model"}
                  </button>
                )}
              </div>
            )}
            {effectiveMode === "webllm" && (
              <p className="mt-3 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                {webStatusLabel}. Download once while online; the browser can then use its local cache offline.
              </p>
            )}
            {effectiveMode === "ollama" && (
              <p className="mt-3 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-600">
                Configure <code className="text-violet-700">OLLAMA_BASE_URL</code> and <code className="text-violet-700">OLLAMA_MODEL</code> in <code className="text-violet-700">server/.env</code>.
              </p>
            )}

            {isNative && (
              <div className="mt-3 rounded-xl border border-brand-100 bg-brand-50 p-3">
                <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-slate-700">
                  <KeyRound size={13} className="text-violet-600" /> Native agent runtime
                  <span className={`ml-auto h-1.5 w-1.5 rounded-full ${nativeAgentStatus.hasApiKey ? "bg-emerald-400" : "bg-slate-600"}`} />
                </div>
                {nativeAgentStatus.hasApiKey ? (
                  <>
                    <p className="text-[13px] leading-relaxed text-slate-600">MobileClaw is ready. Its Anthropic key is stored by the native plugin on this device. Select MobileClaw · Anthropic above to use it; Groq remains the default cloud model.</p>
                    <button type="button" onClick={() => void removeMobileAgentKey()} disabled={isRemovingMobileApiKey} className="mt-2 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-700 transition hover:bg-slate-50 disabled:opacity-50">{isRemovingMobileApiKey ? "Removing…" : "Remove saved Anthropic key"}</button>
                  </>
                ) : (
                  <>
                    <p className="mb-2 text-[13px] leading-relaxed text-slate-500">Add an Anthropic API key to use the native Rust agent and its on-device LanceDB memory. The key is stored by the native agent plugin.</p>
                    <div className="flex gap-2">
                      <input type="password" value={mobileApiKey} onChange={(event) => setMobileApiKey(event.target.value)} placeholder="Anthropic API key" aria-label="Anthropic API key" autoComplete="off" className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs text-ink outline-none placeholder:text-slate-400 focus:border-violet-300" />
                      <button type="button" onClick={() => void saveMobileAgentKey()} disabled={!mobileApiKey.trim() || isSavingMobileApiKey} className="rounded-lg bg-brand-100 px-3 text-xs font-medium text-brand-600 disabled:opacity-40">{isSavingMobileApiKey ? "Saving…" : "Connect"}</button>
                    </div>
                  </>
                )}
              </div>
            )}

            {isNative && <MemoryControls />}

            {effectiveMode === "desktop" && (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
                Desktop screenshots and task instructions are sent to the configured Anthropic API. HANNAH asks before each keyboard or mouse action.
              </div>
            )}

            <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50 p-3">
              <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-slate-700">
                <LockKeyhole size={13} className="text-emerald-600" /> Privacy and voice
              </div>
              <p className="text-[13px] leading-relaxed text-slate-600">
                {!isOnline
                  ? "Offline messages use WebLLM in browsers and a downloaded llama.cpp model in the iOS or Android app. Those prompts stay on this device. Speech input uses the platform recognizer, whose offline support varies."
                  : `WebLLM and llama.cpp process prompts locally. Ollama sends prompts to its configured endpoint. ${cloudProvider} Cloud sends prompts and tool requests to its configured provider. MobileClaw sends prompts directly to Anthropic only when selected. If Mithi TTS is configured, reply text is sent to that service; otherwise installed system voices are used. Voice calls use Pinecall over the internet.`}
              </p>
            </div>
          </div>
        )}
      </header>

      {degradedState.degraded && <div role="status" className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900"><strong>Degraded mode</strong> · {degradedState.reason || "Using a fallback model."}<button type="button" onClick={() => ChaosEngine.clearDegraded()} className="ml-2 underline">Dismiss</button></div>}

      {!isOnline && (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs font-medium text-amber-800">
          <LockKeyhole size={12} /> Offline mode · AI requests stay on this device
        </div>
      )}

      {effectiveMode === "cloud" && apiStatus === "unauthorized" && (
        <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-rose-200 bg-rose-50 px-4 py-2.5 text-xs leading-relaxed text-rose-700">
          <span className="flex-1">The server did not accept your access token. Reconnect with a valid token to continue.</span>
          {onSessionExpired && <button type="button" onClick={onSessionExpired} className="rounded-lg border border-rose-200 bg-white px-3 py-1.5 font-semibold text-rose-700 transition hover:bg-rose-100">Reconnect</button>}
        </div>
      )}
      {effectiveMode === "cloud" && apiStatus === "offline" && (
        <div role="alert" className="shrink-0 border-b border-rose-200 bg-rose-50 px-4 py-2.5 text-xs leading-relaxed text-rose-700">
          {isLocalDevelopmentHost()
            ? <>HANNAH’s API server is not reachable. From the project root, run <code className="text-rose-800">npm run dev</code> to start the API and client together. Retrying automatically.</>
            : "Can’t reach the HANNAH server right now. Retrying automatically."}
        </div>
      )}
      {effectiveMode === "cloud" && apiStatus === "misconfigured" && (
        <div role="alert" className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-xs leading-relaxed text-amber-800">
          {apiError || "No AI model is available yet."}{" "}
          {isLocalDevelopmentHost()
            ? <>Add <code className="text-amber-900">GROQ_API_KEY</code> to <code className="text-amber-900">server/.env</code>, or enter your own Groq key when connecting.</>
            : "Reconnect and add your own Groq API key, or ask the server operator to configure one."}
        </div>
      )}

      <div ref={scrollRef} className="chat-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div className="mx-auto flex max-w-[720px] flex-col gap-3">
          <FirstSessionCoach
            messageCount={messages.filter((message) => message.role === "user").length}
            onSuggestion={(suggestion) => { setInput(suggestion); inputRef.current?.focus(); }}
          />
          <TaskPanel />
          <HITLApprovalCard />
          {messages.map((message, index) => {
            const isUser = message.role === "user";
            const key = message.id || `${index}-${message.role}`;
            if (message.role === "system") {
              return <div key={key} role="status" className="mx-2 rounded-xl border border-emerald-100 bg-emerald-50 px-3 py-2 text-xs leading-relaxed text-emerald-700 sm:mx-8">{message.content}</div>;
            }
            const precedingPrompt = () => messages.slice(0, index).reverse().find((item) => item.role === "user")?.content || "";
            const rate = (feedback: "liked" | "accepted" | "rejected") => {
              PersonalizationEngine.record({ id: message.id!, prompt: precedingPrompt(), response: message.content, feedback });
              setStyleFeedback((current) => ({ ...current, [message.id!]: feedback === "rejected" ? "Noted — this reply won’t be used as a style example" : "Saved as a style example" }));
            };
            const remembered = Boolean(message.id && rememberedIds[message.id]);
            return (
              <div key={key} className="group flex flex-col gap-1">
                <div className={`flex items-end gap-2 ${isUser ? "justify-end" : "justify-start"}`}>
                  {!isUser && <div className="mb-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-brand-100 bg-brand-50 text-brand-600"><Bot size={13} /></div>}
                  <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed text-ink ${isUser ? "whitespace-pre-wrap break-words rounded-br-md border border-brand-100 bg-brand-50" : "rounded-bl-md border border-slate-100 bg-slate-50"}`}>
                    {isUser ? message.content : <MessageContent text={message.content} />}
                  </div>
                </div>
                {isUser && message.id && (
                  <div className="flex justify-end pr-1">
                    <button
                      type="button"
                      disabled={remembered}
                      onClick={() => {
                        MemoryService.add("long_term", message.content.slice(0, 300));
                        notifyMemoryChanged();
                        setRememberedIds((current) => ({ ...current, [message.id!]: true }));
                      }}
                      title={remembered ? "Saved to memory" : "Ask HANNAH to remember this"}
                      className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[13px] transition ${remembered ? "text-emerald-600" : "text-slate-400 opacity-100 hover:bg-slate-100 hover:text-slate-700 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100"}`}
                    >
                      {remembered ? <BookmarkCheck size={12} /> : <Bookmark size={12} />} {remembered ? "Remembered" : "Remember this"}
                    </button>
                  </div>
                )}
                {!isUser && message.id && message.id !== welcomeMessage.id && (
                  <div className="flex flex-wrap items-center gap-1 pl-9">
                    {editingMessageId === message.id ? (
                      <div className="flex w-full max-w-xl gap-2">
                        <textarea value={editedResponse} onChange={(event) => setEditedResponse(event.target.value)} rows={3} className="min-w-0 flex-1 rounded-xl border border-violet-200 bg-white px-3 py-2 text-sm text-ink outline-none focus:border-violet-400" aria-label="Edit HANNAH response" />
                        <div className="flex flex-col gap-1">
                          <button
                            type="button"
                            onClick={() => {
                              PersonalizationEngine.record({ id: message.id!, prompt: precedingPrompt(), response: message.content, editedResponse, feedback: "edited" });
                              setMessages((current) => current.map((item) => item.id === message.id ? { ...item, content: editedResponse } : item));
                              setStyleFeedback((current) => ({ ...current, [message.id!]: "Your edit was saved as a style example" }));
                              setEditingMessageId(null);
                            }}
                            className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-600 text-white"
                            aria-label="Save edited response"
                          ><Save size={14} /></button>
                          <button type="button" onClick={() => setEditingMessageId(null)} className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 text-slate-500" aria-label="Cancel editing"><X size={14} /></button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <button type="button" title="I like this reply" aria-label="Like response" onClick={() => rate("liked")} className="rounded-lg p-1.5 text-slate-400 transition hover:bg-emerald-50 hover:text-emerald-700"><ThumbsUp size={14} /></button>
                        <button type="button" title="Good as-is" aria-label="Accept response as-is" onClick={() => rate("accepted")} className="rounded-lg p-1.5 text-slate-400 transition hover:bg-sky-50 hover:text-sky-700"><Check size={14} /></button>
                        <button type="button" title="Edit to show how you’d prefer it" aria-label="Edit response" onClick={() => { setEditingMessageId(message.id!); setEditedResponse(message.content); }} className="rounded-lg p-1.5 text-slate-400 transition hover:bg-violet-50 hover:text-violet-700"><Pencil size={14} /></button>
                        <button type="button" title="This reply missed the mark" aria-label="Reject response" onClick={() => rate("rejected")} className="rounded-lg p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-700"><ThumbsDown size={14} /></button>
                        <ReportButton messageId={message.id} inferenceMode={effectiveMode} />
                        {styleFeedback[message.id] && <span role="status" className="ml-1 text-[13px] text-slate-500">{styleFeedback[message.id]}</span>}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {approvals.map((request) => (
            <div key={request.id} role="alertdialog" aria-labelledby={`approval-${request.id}`} className="mx-1 rounded-2xl border border-amber-200 bg-gradient-to-br from-amber-50 to-orange-50 p-4 shadow-[0_12px_30px_-20px_rgba(180,83,9,0.5)] sm:mx-9">
              <div className="flex items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-amber-200 bg-white text-amber-600"><ShieldAlert size={16} /></span>
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">HANNAH needs your approval · Guardian checked</p>
                  <h3 id={`approval-${request.id}`} className="mt-0.5 text-sm font-semibold text-ink">{request.title}</h3>
                  <p className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-700">{request.message}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button type="button" onClick={() => ApprovalCenter.respond(request.id, true)} className="rounded-xl bg-ink px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800">Approve</button>
                    <button type="button" onClick={() => ApprovalCenter.respond(request.id, false)} className="rounded-xl border border-amber-200 bg-white px-4 py-2 text-sm font-semibold text-amber-800 transition hover:bg-amber-50">Decline</button>
                  </div>
                </div>
              </div>
            </div>
          ))}

          {(isLoading || (effectiveMode === "webllm" && localLLM.status === "loading")) && (
            <div className="flex items-center gap-2 pl-8 text-xs text-slate-500">
              <span className="typing-dot h-1.5 w-1.5 rounded-full bg-violet-300" />
              {effectiveMode === "webllm" && localLLM.status === "loading"
                ? `Loading local model · ${Math.round(localLLM.progress * 100)}%`
                : isLoading ? agentActivity?.message || "HANNAH is thinking…" : ""}
            </div>
          )}

          {effectiveMode === "webllm" && localLLM.status === "unsupported" && (
            <p className="pl-9 text-xs text-amber-700">WebGPU is unavailable. Reconnect or use the Capacitor app for native offline AI.</p>
          )}
          {error && <div role="alert" className="ml-9 rounded-xl border border-rose-100 bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</div>}
        </div>
      </div>

      {isVirtualCallActive && (
        <div className="absolute inset-0 z-50 flex flex-col overflow-hidden bg-white px-4 pb-4 pt-5 sm:px-6 sm:pb-5 shadow-soft-lg">
          <div className="flex shrink-0 items-center justify-between">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-violet-700">HANNAH · virtual call</p>
              <p className="mt-1 text-xs text-slate-500">In-app conversation · no phone network</p>
            </div>
            <span className="rounded-full border border-emerald-100 bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700">CONNECTED</span>
          </div>

          <div className="flex shrink-0 flex-col items-center pb-5 pt-6 text-center sm:pt-8">
            <div className="relative flex h-24 w-24 items-center justify-center rounded-full border border-brand-200 bg-brand-50 shadow-[0_0_70px_rgba(14,165,233,0.22)] sm:h-28 sm:w-28">
              <span className="absolute inset-0 animate-ping rounded-full border border-violet-200/15 [animation-duration:3s]" />
              <span className="absolute inset-2 rounded-full border border-brand-100" />
              <Bot size={38} strokeWidth={1.35} className="text-violet-700 sm:h-11 sm:w-11" />
            </div>
            <h2 className="mt-4 font-['Manrope'] text-xl font-semibold text-ink">HANNAH</h2>
            <p className="mt-1 text-xs text-slate-500">{formatDuration(callDuration)} · {isListening ? "Listening to you" : isLoading ? agentActivity?.message || "Thinking…" : isSpeaking ? "Speaking to you" : isCallMicEnabled ? "Ready to listen" : "Microphone muted"}</p>
          </div>

          <div ref={callLogRef} className="chat-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto rounded-xl border border-slate-100 bg-white p-3 shadow-soft">
            {messages.filter((message) => (message.role === "user" || message.role === "assistant") && message.id !== welcomeMessage.id).slice(-6).map((message, index) => (
              <div key={`${index}-${message.role}`} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
                <p className={`max-w-[88%] rounded-2xl px-3 py-2 text-[13px] leading-relaxed ${message.role === "user" ? "rounded-br-md bg-brand-600 text-white" : "rounded-bl-md border border-slate-100 bg-slate-50 text-ink"}`}>
                  {message.content}
                </p>
              </div>
            ))}
            {!messages.some((message) => (message.role === "user" || message.role === "assistant") && message.id !== welcomeMessage.id) && (
              <p className="py-4 text-center text-[13px] text-slate-500">{isCallMicEnabled ? "Your microphone is live. Say hello when you’re ready." : "Unmute the microphone to start talking."} HANNAH will answer out loud.</p>
            )}
            {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>}
          </div>

          <div className="flex shrink-0 items-center justify-center gap-4 pt-5">
            <button
              type="button"
              onClick={toggleCallMicrophone}
              aria-label={isCallMicEnabled ? "Mute microphone" : "Unmute microphone"}
              className={`flex h-14 w-14 items-center justify-center rounded-full border transition ${isCallMicEnabled ? "border-brand-600 bg-brand-600 text-white shadow-[0_0_28px_rgba(14,165,233,0.25)]" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
            >
              {isCallMicEnabled ? <Mic size={21} /> : <MicOff size={21} />}
            </button>
            <button
              type="button"
              onClick={toggleCallSpeaker}
              aria-label={isCallSpeakerOn ? "Mute HANNAH's voice" : "Enable HANNAH's voice"}
              className={`flex h-12 w-12 items-center justify-center rounded-full border transition ${isCallSpeakerOn ? "border-slate-200 bg-white text-slate-600 hover:bg-slate-50" : "border-amber-200 bg-amber-50 text-amber-700"}`}
            >
              {isCallSpeakerOn ? <Speaker size={18} /> : <VolumeX size={18} />}
            </button>
            <button
              type="button"
              onClick={() => void endVirtualCall()}
              aria-label="End virtual call"
              className="flex h-14 w-14 items-center justify-center rounded-full bg-rose-600 text-white shadow-lg shadow-rose-950/30 transition hover:bg-rose-500"
            >
              <PhoneOff size={21} />
            </button>
          </div>
          <p className="mt-3 shrink-0 text-center text-[11px] text-slate-500">{isListening ? "Listening · speak naturally, then pause" : isLoading ? "HANNAH is replying…" : isSpeaking ? "HANNAH is speaking…" : isCallMicEnabled ? "Speak naturally · the microphone stays on between turns" : "Tap the microphone to unmute"}</p>
        </div>
      )}

      <div className="shrink-0 border-t border-slate-200/70 bg-white/40 p-2.5 md:p-3">
        <div className="mx-auto flex max-w-[720px] items-center justify-between gap-2 px-1 pb-2">
          <div className="flex min-w-0 items-center gap-2">
            <select
              value={speechLanguage}
              onChange={(event) => setSpeechLanguage(event.target.value as SpeechLanguage)}
              aria-label="Voice language"
              className="max-w-32 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-600 outline-none"
            >
              <option value="en-US">English</option>
              <option value="hi-IN">हिन्दी</option>
              <option value="mr-IN">मराठी</option>
            </select>
            <button
              type="button"
              onClick={() => {
                setVoiceEnabled((enabled) => !enabled);
                setVoiceStatus(voiceEnabled ? "Voice replies off" : "Voice replies on · offline device voice preferred");
              }}
              aria-label={voiceEnabled ? "Turn voice replies off" : "Turn voice replies on"}
              className={`flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs transition ${voiceEnabled ? "border-brand-100 bg-brand-50 text-brand-600" : "border-slate-100 bg-white text-slate-600 hover:bg-slate-50"}`}
            >
              {voiceEnabled ? <Speaker size={12} /> : <VolumeX size={12} />}
              <span>Voice</span>
            </button>
            {!isOnline && <span className="hidden truncate text-xs text-slate-500 sm:inline">On-device mode</span>}
          </div>
          <button
            type="button"
            onClick={() => void toggleVoiceInput()}
            aria-label={isListening ? "Stop voice input" : "Start voice input"}
            title={isListening ? "Stop listening" : "Speak to HANNAH"}
            className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition ${isListening ? "border-rose-200 bg-rose-50 text-rose-700" : "border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100"}`}
          >
            <Mic size={12} /> {isListening ? "Listening" : "Speak"}
          </button>
          <button
            type="button"
            onClick={() => void startVirtualCall()}
            disabled={isLoading}
            title="Start an in-app virtual voice call"
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-emerald-100 bg-emerald-50 px-2.5 py-1.5 text-xs font-medium text-emerald-600 transition hover:bg-emerald-100/80 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Phone size={12} /> Call
          </button>
        </div>
        {voiceStatus && <p aria-live="polite" className="mx-auto mb-1 max-w-[720px] px-1 text-xs text-slate-500">{voiceStatus}</p>}
        <form onSubmit={(event) => void submitMessage(event)} className="mx-auto flex max-w-[720px] items-end gap-2 rounded-xl border border-slate-200 bg-white p-1.5 transition focus-within:border-brand-400/60 shadow-soft">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(event) => {
              setInput(event.target.value.slice(0, 4000));
              event.target.style.height = "auto";
              event.target.style.height = `${Math.min(event.target.scrollHeight, 128)}px`;
            }}
            onKeyDown={handleKeyDown}
            placeholder={!isOnline ? "Message HANNAH offline…" : "Message HANNAH…"}
            aria-label="Message HANNAH"
            rows={1}
            maxLength={4000}
            className="max-h-32 min-h-10 flex-1 resize-none bg-transparent px-3 py-2.5 text-base leading-relaxed sm:text-sm text-ink outline-none placeholder:text-slate-400"
          />
          <button
            type="submit"
            disabled={!input.trim() || isLoading || !canSend}
            aria-label="Send message"
            className="mb-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-r from-brand-600 to-violet-600 text-white shadow-lg shadow-brand-950/30 transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-35"
          >
            <ArrowUp size={17} strokeWidth={2.2} />
          </button>
        </form>
        <p className="mt-1.5 truncate text-center text-[13px] text-slate-500">
          {effectiveMode === "cloud"
            ? `${cloudProvider} · ${modelLabel(cloudModel || cloudModels[0] || "")}`
            : effectiveMode === "ollama"
              ? "Ollama · prompts go to your configured endpoint"
              : effectiveMode === "mobileclaw"
                ? "MobileClaw · Anthropic retention policy applies"
              : effectiveMode === "desktop"
                ? "Desktop agent · screenshots go to Anthropic; actions need confirmation"
              : "On-device inference · messages stay on this device"}
        </p>
      </div>

      <FeedbackModal open={isFeedbackOpen} onClose={() => setIsFeedbackOpen(false)} inferenceMode={effectiveMode} />
    </section>
  );
}
