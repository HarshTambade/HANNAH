import type { Plugin } from "vite";

const brandName = "HANNAH";

const pages = {
  home: {
    title: "HANNAH — Your Personal AI. Your Intelligence. Your World.",
    description: "HANNAH is an AI companion with a team of agents, voice chat, memory you own and a live 3D avatar. Use any model, cloud or local, and approve every action. Free with your own Groq key.",
  },
  about: {
    title: "About HANNAH — AI Companion, Voice Chat & Privacy",
    description: "Learn about HANNAH’s conversational features, voice and avatar experience, supported AI modes, privacy boundaries, and integrations.",
  },
} as const;

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

function structuredData(siteOrigin: string, pagePath: string, page: (typeof pages)[keyof typeof pages]) {
  const canonical = new URL(pagePath, siteOrigin).toString();
  const appUrl = new URL("/", siteOrigin).toString();
  const imageUrl = new URL("/social-card.svg", siteOrigin).toString();
  const repositoryUrl = "https://github.com/HarshTambade/Shanaya-Your-AI-companion";
  const faq = [
    {
      "@type": "Question",
      name: "Does HANNAH work offline?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "HANNAH supports optional offline inference with WebLLM in compatible browsers and downloaded GGUF models in supported mobile apps. Initial model downloads require internet access.",
      },
    },
    {
      "@type": "Question",
      name: "Can I talk to HANNAH by voice?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Yes. HANNAH provides multilingual voice input and speech playback where browser or device speech capabilities are available, including English, Hindi, and Marathi options.",
      },
    },
    {
      "@type": "Question",
      name: "Which platforms support HANNAH?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "HANNAH runs in modern browsers and installs as a PWA. Desktop apps are available for macOS, Windows and Linux, and an Android app as an APK. The iOS app builds from source but isn't distributed yet.",
      },
    },
    {
      "@type": "Question",
      name: "Do I need a Groq API key to talk to HANNAH?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "The web app asks visitors to provide their own Groq API key before entering the companion. It stays in page memory for the current visit and is sent through the app API only for Groq requests.",
      },
    },
  ];
  const graph = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${appUrl}#organization`,
        name: brandName,
        url: appUrl,
        sameAs: [repositoryUrl],
        logo: imageUrl,
      },
      {
        "@type": "WebSite",
        "@id": `${appUrl}#website`,
        url: appUrl,
        name: brandName,
        inLanguage: "en",
        publisher: { "@id": `${appUrl}#organization` },
      },
      {
        "@type": "SoftwareApplication",
        "@id": `${appUrl}#application`,
        name: brandName,
        url: appUrl,
        applicationCategory: "CommunicationApplication",
        applicationSubCategory: "AI companion",
        operatingSystem: "Web, Android, iOS, macOS, Windows, Linux",
        description: pages.home.description,
        image: imageUrl,
        browserRequirements: "Requires a modern browser with JavaScript enabled",
        publisher: { "@id": `${appUrl}#organization` },
        softwareVersion: process.env.npm_package_version || undefined,
        featureList: [
          "Works with 20 AI providers and local models (Ollama, LM Studio, llama.cpp, vLLM, WebLLM)",
          "Automatic model routing with Balanced, Best quality, Budget, Fastest and Private modes",
          "Agent team that plans, runs specialist agents and verifies results",
          "Voice chat in English, Hindi and Marathi",
          "Memory you can view, edit, export and delete",
          "Approval required for every action",
          "Live 3D avatar with facial expressions",
        ],
      },
      {
        "@type": "WebPage",
        "@id": `${canonical}#webpage`,
        url: canonical,
        name: page.title,
        description: page.description,
        isPartOf: { "@id": `${appUrl}#website` },
        about: { "@id": `${appUrl}#application` },
        inLanguage: "en",
      },
      ...(pagePath === "/" ? [{
        "@type": "FAQPage",
        "@id": `${canonical}#faq`,
        mainEntity: faq,
      }] : []),
    ],
  };
  return JSON.stringify(graph).replaceAll("<", "\\u003c");
}

export function hannahSeoPlugin({ mode }: SeoOptions): Plugin {
  const explicitSiteUrl = process.env.VITE_SITE_URL?.trim() ?? "";
  const vercelProductionDomain = process.env.VERCEL_ENV === "production"
    ? process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim() ?? ""
    : "";
  const siteOrigin = resolveSiteOrigin(explicitSiteUrl || vercelProductionDomain);
  const isProductionDeployment = process.env.VERCEL_ENV
    ? process.env.VERCEL_ENV === "production"
    : mode === "production";
  const indexable = isProductionDeployment && Boolean(siteOrigin);

  return {
    name: "hannah-seo",
    transformIndexHtml(html, context) {
      const requestPath = context.path.split("?")[0];
      const normalizedPath = requestPath.endsWith("index.html")
        ? requestPath.slice(0, -"index.html".length)
        : requestPath;
      const isAboutPage = normalizedPath === "/about/" || normalizedPath === "/about";
      const pagePath = isAboutPage ? "/about/" : "/";
      const page = isAboutPage ? pages.about : pages.home;
      const image = siteOrigin ? new URL("/social-card.svg", siteOrigin).toString() : "/social-card.svg";
      const canonical = indexable ? new URL(pagePath, siteOrigin).toString() : "";
      const tags = [
        `<meta name="robots" content="${indexable ? "index,follow,max-image-preview:large" : "noindex,nofollow"}" />`,
        `<meta name="author" content="HANNAH" />`,
        `<meta name="publisher" content="HANNAH" />`,
        `<meta name="keywords" content="personal AI, AI companion, AI agents, model router, local AI, offline AI, voice assistant, WebLLM, Ollama, private AI assistant" />`,
        `<meta name="referrer" content="strict-origin-when-cross-origin" />`,
        `<meta name="color-scheme" content="light" />`,
        canonical ? `<link rel="canonical" href="${escapeAttribute(canonical)}" />` : "",
        `<link rel="alternate" hreflang="en" href="${escapeAttribute(canonical || pagePath)}" />`,
        `<link rel="author" href="https://github.com/HarshTambade" />`,
        `<meta property="og:type" content="website" />`,
        `<meta property="og:site_name" content="${brandName}" />`,
        `<meta property="og:title" content="${escapeAttribute(page.title)}" />`,
        `<meta property="og:description" content="${escapeAttribute(page.description)}" />`,
        canonical ? `<meta property="og:url" content="${escapeAttribute(canonical)}" />` : "",
        `<meta property="og:image" content="${escapeAttribute(image)}" />`,
        `<meta property="og:image:width" content="1200" />`,
        `<meta property="og:image:height" content="630" />`,
        `<meta property="og:image:alt" content="HANNAH — Your Personal AI. Your Intelligence. Your World." />`,
        `<meta name="twitter:card" content="summary_large_image" />`,
        `<meta name="twitter:title" content="${escapeAttribute(page.title)}" />`,
        `<meta name="twitter:description" content="${escapeAttribute(page.description)}" />`,
        `<meta name="twitter:image" content="${escapeAttribute(image)}" />`,
        indexable ? `<script type="application/ld+json">${structuredData(siteOrigin, pagePath, page)}</script>` : "",
      ].filter(Boolean).join("\n    ");

      return html
        .replace("__HANNAH_PAGE_TITLE__", escapeAttribute(page.title))
        .replace("__HANNAH_PAGE_DESCRIPTION__", escapeAttribute(page.description))
        .replace("<!-- HANNAH_SEO_TAGS -->", tags);
    },
    generateBundle() {
      const robots = [
        "User-agent: *",
        "Allow: /",
        "Disallow: /api/",
        "Disallow: /mcp",
        ...(indexable ? [`Sitemap: ${new URL("/sitemap.xml", siteOrigin).toString()}`] : []),
        "",
      ].join("\n");
      this.emitFile({ type: "asset", fileName: "robots.txt", source: robots });

      if (indexable) {
        const today = new Date().toISOString().slice(0, 10);
        const sitemapUrls = ["/", "/about/"].map((path) => (
          `  <url><loc>${new URL(path, siteOrigin).toString()}</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>${path === "/" ? "1.0" : "0.7"}</priority></url>`
        )).join("\n");
        this.emitFile({
          type: "asset",
          fileName: "sitemap.xml",
          source: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapUrls}\n</urlset>\n`,
        });
      }
    },
  };
}
