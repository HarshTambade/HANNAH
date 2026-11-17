import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { visualizer } from "rollup-plugin-visualizer";
import { mobileClawVitePlugin } from "capacitor-mobile-claw/vite-plugin";
import packageJson from "./package.json";
import { hannahSeoPlugin } from "./scripts/seoPlugin";
import { appRoutesPlugin } from "./scripts/appRoutesPlugin";
import { wakeModelPlugin } from "./scripts/wakeModel";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

// On Vercel the website and its API are one deployment on one domain (see
// vercel.json), so the website always calls its own origin. A leftover
// VITE_API_BASE_URL (for example an old domain) would otherwise send every
// request, download link and sign-in to the wrong place. App builds (CI) keep it.
const sameOriginWebsite = process.env.VERCEL === "1";
if (sameOriginWebsite && process.env.VITE_API_BASE_URL?.trim()) {
  console.warn(`Vercel website build: ignoring VITE_API_BASE_URL (${process.env.VITE_API_BASE_URL.trim()}); the API is on the same domain.`);
}

export default defineConfig(({ mode }) => ({
  define: {
    // Exposed through services/appInfo.ts for feedback and error reports.
    __HANNAH_APP_VERSION__: JSON.stringify(packageJson.version),
    ...(sameOriginWebsite ? { "import.meta.env.VITE_API_BASE_URL": JSON.stringify("") } : {}),
  },
  plugins: [
    react(),
    mobileClawVitePlugin(),
    hannahSeoPlugin({ mode }),
    appRoutesPlugin(),
    wakeModelPlugin(),
    VitePWA({
      registerType: "prompt",
      includeAssets: ["icon.svg", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png", "favicon.ico"],
      manifest: {
        id: "/",
        name: "HANNAH · AI Companion",
        short_name: "HANNAH",
        description: "A multilingual AI companion with a living 3D avatar, voice chat, and optional on-device AI.",
        theme_color: "#f8fafc",
        background_color: "#f8fafc",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          // Full-bleed, with the ring inside the 80 % safe zone, for launchers that crop icons to a shape.
          { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        globPatterns: ["**/*.{js,css,html,svg,wasm}"],
        // The wake-word engine (models/wake) loads only after it's turned on; don't precache it for everyone.
        globIgnores: ["models/**"],
        // These paths belong to the HANNAH server, not the app: let navigations
        // to them reach the network instead of the cached app page. Without this,
        // /download/android showed the app's "Page not found" screen.
        navigateFallbackDenylist: [/^\/download\//, /^\/api\//, /^\/v1\//, /^\/mcp(?:\/|$)/, /^\/\.well-known\//],
        runtimeCaching: [{
          urlPattern: /\/models\/.*\.glb$/,
          handler: "CacheFirst",
          options: {
            cacheName: "hannah-avatar-models",
            expiration: { maxEntries: 2, maxAgeSeconds: 60 * 60 * 24 * 30 },
          },
        }],
      },
    }),
    ...(mode === "analyze" ? [visualizer({
      filename: resolve(projectRoot, "bundle-report.html"),
      open: false,
      gzipSize: true,
      brotliSize: true,
    })] : []),
  ],
  build: {
    chunkSizeWarningLimit: 1100,
    rollupOptions: {
      input: {
        main: resolve(projectRoot, "index.html"),
        about: resolve(projectRoot, "about/index.html"),
      },
      output: {
        // The opt-in wake-word engine sits with its model, outside the app's startup code.
        chunkFileNames: (chunk) => (chunk.name === "vosk" ? "models/wake/[name]-[hash].js" : "assets/[name]-[hash].js"),
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/[\\/]node_modules[\\/]vosk-browser[\\/]/.test(id)) return "vosk";
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler|react-reconciler)[\\/]/.test(id)) return "vendor-react";
          if (/[\\/]node_modules[\\/](@react-three|three|three-stdlib)[\\/]/.test(id)) return "vendor-three";
          if (/[\\/]node_modules[\\/]@capacitor[\\/]/.test(id)) return "vendor-capacitor";
          if (/[\\/]node_modules[\\/]lucide-react[\\/]/.test(id)) return "vendor-icons";
          return undefined;
        },
      },
    },
  },
  server: {
    host: "0.0.0.0",
    proxy: {
      "/api": "http://localhost:3001",
      "/v1": "http://localhost:3001",
    },
  },
}));
