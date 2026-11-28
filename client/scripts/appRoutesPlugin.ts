import type { Plugin } from "vite";
import { APP_ROUTE_PATHS, EXTRA_PAGE_PATHS, ROUTE_TITLES, ROUTE_PATHS, isServerPath, type AppScreen } from "../src/routes";

/**
 * Write an index.html for every app route (/chat/index.html, /models/index.html,
 * …) and a 404.html. Static hosts (Vercel, Netlify, GitHub Pages, nginx),
 * Capacitor's local server and the Electron protocol handler then serve the
 * app at each real path, so refresh and direct links work without any
 * server-side rewrite. App screens sit behind a connection, so their copies
 * are marked noindex and point search engines to the home page.
 */
export function appRoutesPlugin(): Plugin {
  return {
    name: "hannah-app-routes",
    enforce: "post",
    generateBundle(_options, bundle) {
      const entry = bundle["index.html"];
      if (!entry || entry.type !== "asset") return;
      const html = String(entry.source);
      // A page under a server path (/api, /s/ shared conversations, …) would never be served, or would shadow the server.
      const clash = [...APP_ROUTE_PATHS, ...Object.keys(EXTRA_PAGE_PATHS)].find((path) => isServerPath(path));
      if (clash) this.error(`The app route ${clash} is a server path (SERVER_PATH_PREFIXES in src/routes.ts).`);
      const screenFor = Object.fromEntries((Object.entries(ROUTE_PATHS) as Array<[AppScreen, string]>).map(([screen, path]) => [path, screen]));

      const variant = (title: string) => html
        .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
        .replace(/<meta name="robots" content="[^"]*" \/>/, '<meta name="robots" content="noindex,follow" />');

      for (const path of APP_ROUTE_PATHS) {
        this.emitFile({ type: "asset", fileName: `${path.slice(1)}/index.html`, source: variant(ROUTE_TITLES[screenFor[path] as AppScreen]) });
      }
      for (const [path, screen] of Object.entries(EXTRA_PAGE_PATHS)) {
        this.emitFile({ type: "asset", fileName: `${path.slice(1)}/index.html`, source: variant(ROUTE_TITLES[screen]) });
      }
      this.emitFile({ type: "asset", fileName: "404.html", source: variant(ROUTE_TITLES["not-found"]) });
    },
  };
}
