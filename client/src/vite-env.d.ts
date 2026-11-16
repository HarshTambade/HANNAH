/// <reference types="vite/client" />

declare module "virtual:pwa-register/react" {
  export function useRegisterSW(options?: any): {
    needRefresh: [boolean, (value: boolean) => void];
    offlineReady: [boolean, (value: boolean) => void];
    updateServiceWorker: (reloadPage?: boolean) => Promise<void>;
  };
}

declare module "posthog-js" {
  const client: {
    init: (key: string, options: any) => void;
    capture: (event: string, properties?: any) => void;
  };
  export default client;
}

declare module "@capawesome/capacitor-live-update" {
  export const LiveUpdate: {
    sync: () => Promise<{ nextBundleId?: string }>;
    reload: () => Promise<void>;
  };
}

declare const __SHANAYA_APP_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_PYTHON_FALLBACK_URL?: string;
  readonly VITE_PINECALL_AGENT_ID?: string;
  readonly VITE_OFFLINE_MODEL_URL?: string;
  readonly VITE_AVATAR_MODEL_URL?: string;
  readonly VITE_SHANAYA_ANTHROPIC_MODEL?: string;
  readonly VITE_ANDROID_DOWNLOAD_URL?: string;
  readonly VITE_IOS_DOWNLOAD_URL?: string;
  readonly VITE_MACOS_DOWNLOAD_URL?: string;
  readonly VITE_WINDOWS_DOWNLOAD_URL?: string;
  readonly VITE_LINUX_DOWNLOAD_URL?: string;
  readonly VITE_APP_VERSION?: string;
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_SENTRY_ENVIRONMENT?: string;
  readonly VITE_SENTRY_RELEASE?: string;
  readonly VITE_SENTRY_TRACES_SAMPLE_RATE?: string;
}
