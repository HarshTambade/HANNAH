// Copied to client/electron/capacitor.electron.config.ts by
// scripts/prepare-electron-release.mjs when the desktop app is packaged.
import { defineConfig } from "@capawesome/capacitor-electron/config";

/**
 * Content Security Policy for the packaged app. The runtime's default blocks
 * three things HANNAH needs, which left the avatar blank and the fonts missing:
 * WebAssembly (Draco avatar decoding, WebLLM) needs 'wasm-unsafe-eval' (not
 * the much broader 'unsafe-eval'); Three.js decodes in blob: workers and loads
 * textures from blob: URLs; and the interface fonts come from Google Fonts.
 * http://localhost is allowed for a HANNAH server running on this computer.
 */
const policy = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "media-src 'self' blob: data:",
  "connect-src 'self' blob: data: https: wss: http://localhost:* http://127.0.0.1:*",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

export default defineConfig({
  window: {
    width: 1280,
    height: 840,
    // Below this the desktop layout would switch to the phone tab bar.
    minWidth: 900,
    minHeight: 620,
    // Matches the app background, so the window never flashes while loading.
    backgroundColor: "#eef0f4",
  },
  csp: { policy },
});
