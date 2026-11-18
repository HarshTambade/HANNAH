import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import { CAPABILITIES, FAQS } from "../src/content/landing";

/**
 * Search and sharing for HANNAH's public pages.
 *
 * - Every public page gets its own title, description, canonical URL, Open
 *   Graph and X card (PNG image), and schema.org data built from the same
 *   words the page shows (src/content/landing.ts), so the FAQ rich result
 *   always matches the visible FAQ.
 * - The public pages (/, /integrations, /marketplace) are rendered to HTML at
 *   build time, so crawlers, link previews and the first paint get the real
 *   headings and text without running JavaScript. The app then renders over it.
 * - robots.txt, sitemap.xml and llms.txt (a plain summary for AI search tools).
 * - Only production deployments are indexable; previews say noindex.
 */

const brandName = "HANNAH";
const DEFAULT_SITE = "https://hannah.eliteforums.in";
const REPOSITORY_URL = "https://github.com/HarshTambade/HANNAH";

type PublicPage = {
  path: string;
  /** Built file, relative to dist. */
  file: string;
  title: string;
  description: string;
  /** Name in breadcrumbs. */
  name: string;
  /** Rendered at build time from this component. */
  component?: string;
  props?: Record<string, unknown>;
};

export const PUBLIC_PAGES: PublicPage[] = [
  {
    path: "/",
    file: "index.html",
    name: "Home",
    title: "HANNAH: AI Companion with Voice, AI Agents & a 3D Avatar",
    description: "Free AI companion with voice chat, AI agents, visual workflow automation, memory you control and a live 3D avatar. Use any cloud or local model; approve every action.",
    component: "/src/components/LandingPage.tsx",
    props: { onStart() {}, onIntegrations() {}, onMarketplace() {} },
  },
  {
    path: "/about/",
    file: "about/index.html",
    name: "About",
    title: "About HANNAH: AI Companion, Voice Chat and Privacy",
    description: "What HANNAH does, where your data goes, the AI models it supports and how to build on it: voice chat, a 3D avatar, cloud or on-device AI, and an API.",
  },
  {
    path: "/integrations",
    file: "integrations/index.html",
    name: "Integrations",
    title: "HANNAH API, MCP Server and Webhooks: Integration Guide",
    description: "Connect your apps to HANNAH: a REST and OpenAI-compatible API, an MCP server for Claude Desktop, Cursor and VS Code, agent-to-agent (A2A) messaging and signed webhooks.",
    component: "/src/components/IntegrationsPage.tsx",
    props: { onBack() {} },
  },
  {
    path: "/marketplace",
    file: "marketplace/index.html",
    name: "Marketplace",
    title: "HANNAH Marketplace: Connectors, Agents and Skills",
    description: "Connect GitHub, Linear, Notion, Stripe, Figma and 25 more services with your own sign-in, or add agents and skills. HANNAH asks before every action.",
    component: "/src/components/MarketplacePage.tsx",
    props: { onBack() {} },
  },
];

type SeoOptions = { mode: string };

function escapeAttribute(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function resolveSiteOrigin(raw: string) {
  if (!raw.trim()) return "";
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(candidate);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new Error("VITE_SITE_URL must use HTTPS outside local development.");
  }
  return url.origin;
}

function appVersion() {
  try {
    return String(JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf8")).version);
  } catch {
    return undefined;
  }
}

/** schema.org data for one page. Exported for tests. */
export function structuredData(siteOrigin: string, page: PublicPage) {
  const at = (path: string) => new URL(path, siteOrigin).toString();
  const home = at("/");
  const canonical = at(page.path);
  const graph: Array<Record<string, unknown>> = [
    {
      "@type": "Organization",
      "@id": `${home}#organization`,
      name: brandName,
      url: home,
      logo: { "@type": "ImageObject", url: at("/icon-512.png"), width: 512, height: 512 },
      sameAs: [REPOSITORY_URL],
    },
    {
      "@type": "WebSite",
      "@id": `${home}#website`,
      url: home,
      name: brandName,
      alternateName: "HANNAH AI Companion",
      description: PUBLIC_PAGES[0].description,
      inLanguage: "en",
      publisher: { "@id": `${home}#organization` },
    },
    {
      "@type": "SoftwareApplication",
      "@id": `${home}#application`,
      name: brandName,
      alternateName: "HANNAH AI Companion",
      url: home,
      applicationCategory: "LifestyleApplication",
      applicationSubCategory: "AI companion and personal assistant",
      operatingSystem: "Web browser, Windows, macOS, Linux, Android",
      description: PUBLIC_PAGES[0].description,
      image: at("/social-card.png"),
      screenshot: ["chat", "models", "automations", "agents", "integrations"].map((name) => at(`/screens/${name}.webp`)),
      softwareVersion: appVersion(),
      downloadUrl: `${REPOSITORY_URL}/releases/latest`,
      installUrl: home,
      isAccessibleForFree: true,
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD", availability: "https://schema.org/InStock" },
      featureList: CAPABILITIES.map((item) => `${item.title}: ${item.description}`),
      publisher: { "@id": `${home}#organization` },
      author: { "@type": "Person", name: "Harsh Tambade", url: "https://github.com/HarshTambade" },
    },
    {
      "@type": "WebPage",
      "@id": `${canonical}#webpage`,
      url: canonical,
      name: page.title,
      description: page.description,
      isPartOf: { "@id": `${home}#website` },
      about: { "@id": `${home}#application` },
      primaryImageOfPage: at("/social-card.png"),
      inLanguage: "en",
    },
  ];
  if (page.path === "/") {
    graph.push({
      "@type": "FAQPage",
      "@id": `${canonical}#faq`,
      mainEntity: FAQS.map((item) => ({ "@type": "Question", name: item.q, acceptedAnswer: { "@type": "Answer", text: item.a } })),
    });
  } else {
    graph.push({
      "@type": "BreadcrumbList",
      "@id": `${canonical}#breadcrumbs`,
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "HANNAH", item: home },
        { "@type": "ListItem", position: 2, name: page.name, item: canonical },
      ],
    });
  }
  return JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replaceAll("<", "\\u003c");
}

/** Everything in <head> that depends on the page. Exported for tests. */
export function headTags(page: PublicPage, { siteOrigin, indexable }: { siteOrigin: string; indexable: boolean }) {
  const absolute = (path: string) => (siteOrigin ? new URL(path, siteOrigin).toString() : path);
  const canonical = indexable ? absolute(page.path) : "";
  const google = process.env.VITE_GOOGLE_SITE_VERIFICATION?.trim();
  const bing = process.env.VITE_BING_SITE_VERIFICATION?.trim();
  const tags = [
    `<title>${escapeAttribute(page.title)}</title>`,
    `<meta name="description" content="${escapeAttribute(page.description)}" />`,
    `<meta name="robots" content="${indexable ? "index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1" : "noindex,nofollow"}" />`,
    `<meta name="author" content="Harsh Tambade" />`,
    `<meta name="referrer" content="strict-origin-when-cross-origin" />`,
    `<meta name="color-scheme" content="light" />`,
    google ? `<meta name="google-site-verification" content="${escapeAttribute(google)}" />` : "",
    bing ? `<meta name="msvalidate.01" content="${escapeAttribute(bing)}" />` : "",
    canonical ? `<link rel="canonical" href="${escapeAttribute(canonical)}" />` : "",
    canonical ? `<link rel="alternate" hreflang="en" href="${escapeAttribute(canonical)}" />` : "",
    canonical ? `<link rel="alternate" hreflang="x-default" href="${escapeAttribute(canonical)}" />` : "",
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${brandName}" />`,
    `<meta property="og:locale" content="en_US" />`,
    `<meta property="og:title" content="${escapeAttribute(page.title)}" />`,
    `<meta property="og:description" content="${escapeAttribute(page.description)}" />`,
    canonical ? `<meta property="og:url" content="${escapeAttribute(canonical)}" />` : "",
    `<meta property="og:image" content="${escapeAttribute(absolute("/social-card.png"))}" />`,
    `<meta property="og:image:type" content="image/png" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="HANNAH, an AI companion with voice, AI agents and a 3D avatar" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escapeAttribute(page.title)}" />`,
    `<meta name="twitter:description" content="${escapeAttribute(page.description)}" />`,
    `<meta name="twitter:image" content="${escapeAttribute(absolute("/social-card.png"))}" />`,
    `<meta name="twitter:image:alt" content="HANNAH, an AI companion with voice, AI agents and a 3D avatar" />`,
    indexable ? `<script type="application/ld+json">${structuredData(siteOrigin, page)}</script>` : "",
  ].filter(Boolean);
  return `<!-- seo:start -->\n    ${tags.join("\n    ")}\n    <!-- seo:end -->`;
}

/** sitemap.xml for the public pages. Exported for tests. */
export function sitemap(siteOrigin: string, lastmod: string) {
  const urls = PUBLIC_PAGES.map((page) => `  <url><loc>${new URL(page.path, siteOrigin).toString()}</loc><lastmod>${lastmod}</lastmod></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

/** robots.txt. Exported for tests. */
export function robots(siteOrigin: string, indexable: boolean) {
  return [
    "User-agent: *",
    ...(indexable ? ["Allow: /"] : ["Disallow: /"]),
    "Disallow: /api/",
    "Disallow: /v1/",
    "Disallow: /mcp",
    "Disallow: /download/",
    ...(indexable ? ["", `Sitemap: ${new URL("/sitemap.xml", siteOrigin).toString()}`] : []),
    "",
  ].join("\n");
}

/** llms.txt: a plain-text guide for AI assistants and AI search. Exported for tests. */
export function llmsTxt(siteOrigin: string) {
  const at = (path: string) => new URL(path, siteOrigin).toString();
  return [
    "# HANNAH",
    "",
    `> ${PUBLIC_PAGES[0].description}`,
    "",
    "HANNAH runs in the browser, as a desktop app for macOS, Windows and Linux, and on Android. It's free to use; you bring a key for the AI provider you choose (a free Groq key is enough), or run models locally. The source code is public under a source-available, non-commercial license.",
    "",
    "## What it does",
    "",
    ...CAPABILITIES.map((item) => `- ${item.title}: ${item.description}`),
    "",
    "## Pages",
    "",
    ...PUBLIC_PAGES.map((page) => `- [${page.name}](${at(page.path)}): ${page.description}`),
    `- [Source code and documentation](${REPOSITORY_URL})`,
    `- [Downloads and release notes](${REPOSITORY_URL}/releases)`,
    "",
    "## FAQ",
    "",
    ...FAQS.flatMap((item) => [`### ${item.q}`, "", item.a, ""]),
  ].join("\n");
}

/** Put a page's head tags in place of the ones the template carries. */
export function withHead(html: string, head: string) {
  return html.replace(/<!-- seo:start -->[\s\S]*?<!-- seo:end -->/, head);
}

export function hannahSeoPlugin({ mode }: SeoOptions): Plugin {
  const explicitSiteUrl = process.env.VITE_SITE_URL?.trim() ?? "";
  const isVercelProduction = process.env.VERCEL_ENV === "production";
  const siteOrigin = resolveSiteOrigin(explicitSiteUrl || (isVercelProduction ? DEFAULT_SITE : ""));
  const isProductionDeployment = process.env.VERCEL_ENV ? isVercelProduction : mode === "production";
  const indexable = isProductionDeployment && Boolean(siteOrigin);
  let root = process.cwd();
  let outDir = resolve(root, "dist");
  let define: Record<string, string> = {};

  return {
    name: "hannah-seo",
    configResolved(config) {
      root = config.root;
      outDir = resolve(config.root, config.build.outDir);
      define = Object.fromEntries(Object.entries(config.define ?? {}).map(([key, value]) => [key, String(value)]));
    },
    transformIndexHtml(html, context) {
      const requestPath = context.path.split("?")[0];
      const normalized = requestPath.endsWith("index.html") ? requestPath.slice(0, -"index.html".length) : requestPath;
      const page = PUBLIC_PAGES.find((item) => item.path === normalized || item.path === `${normalized}/`) ?? PUBLIC_PAGES[0];
      return html.replace("<!-- HANNAH_SEO_TAGS -->", headTags(page, { siteOrigin, indexable }));
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "robots.txt", source: robots(siteOrigin, indexable) });
      if (indexable) {
        this.emitFile({ type: "asset", fileName: "sitemap.xml", source: sitemap(siteOrigin, new Date().toISOString().slice(0, 10)) });
        this.emitFile({ type: "asset", fileName: "llms.txt", source: llmsTxt(siteOrigin) });
      }
    },
    // After every file is written (including each route's index.html), render
    // the public pages to HTML and give Integrations and Marketplace their own head.
    async writeBundle() {
      const template = resolve(outDir, "index.html");
      if (!existsSync(template)) return;
      const baseHtml = readFileSync(template, "utf8");
      const rendered = await renderPublicPages(root, define).catch((error: unknown) => {
        this.warn(`Public pages weren't pre-rendered: ${error instanceof Error ? error.message : String(error)}`);
        return {} as Record<string, string>;
      });
      for (const page of PUBLIC_PAGES) {
        if (!page.component) continue;
        const file = resolve(outDir, page.file);
        let html = page.path === "/" ? baseHtml : withHead(baseHtml, headTags(page, { siteOrigin, indexable }));
        const body = rendered[page.path];
        if (body) html = html.replace('<div id="root"></div>', `<div id="root">${body}</div>`);
        else this.warn(`${page.path} wasn't pre-rendered; it still works, rendered in the browser.`);
        writeFileSync(file, html);
      }
    },
  };
}

/** Render the public pages with React on the server (Vite's SSR loader). */
async function renderPublicPages(root: string, define: Record<string, string>) {
  const [{ createServer }, { renderToString }, React] = await Promise.all([import("vite"), import("react-dom/server"), import("react")]);
  const server = await createServer({
    root,
    configFile: false,
    logLevel: "error",
    appType: "custom",
    define,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, ws: false },
  });
  const output: Record<string, string> = {};
  try {
    for (const page of PUBLIC_PAGES) {
      if (!page.component) continue;
      // One page failing doesn't stop the others; it's rendered in the browser instead.
      try {
        const module = await server.ssrLoadModule(page.component);
        output[page.path] = renderToString(React.createElement(module.default, page.props));
      } catch (error) {
        console.warn(`[hannah-seo] ${page.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await server.close();
  }
  return output;
}
