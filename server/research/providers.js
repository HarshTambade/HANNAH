"use strict";

/**
 * Search providers for the research engine, behind one shape:
 *
 *   { id, label, kind: "web" | "academic" | "reference", needs, available(context), search(query, options) }
 *   search → [{ title, url, snippet, published?, author?, publisher?, kind? }]
 *
 * Web search (the open internet):
 *   tavily    Tavily's search API           TAVILY_API_KEY
 *   brave     Brave Search API              BRAVE_SEARCH_API_KEY
 *   searxng   a SearXNG instance you run    SEARXNG_URL
 *   groq      Groq's built-in browser search, with the caller's own Groq key
 * No key needed (public, documented APIs):
 *   wikipedia Wikipedia's search API        reference articles
 *   openalex  OpenAlex                      scholarly works with abstracts, dates, authors, DOIs
 *   arxiv     arXiv's API                   preprints
 *
 * Every request goes through the SSRF-safe client. A provider that fails or is
 * rate-limited throws; the engine records that and carries on with the others,
 * and the report says which searches didn't run.
 */
const { safeRequest } = require("../workflows/http");
const { searchWeb } = require("../web");

const AGENT = "HANNAH-research/1.0 (research assistant; respects robots.txt)";
const clip = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
/** A calendar date as YYYY-MM-DD. A date written that way is kept as written (no time-zone shift). */
const isoDate = (value) => { const text = String(value || ""); const plain = /^(\d{4}-\d{2}-\d{2})/.exec(text); if (plain) return plain[1]; const time = Date.parse(text); return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : ""; };
const fail = (message, extra = {}) => Object.assign(new Error(message), extra);

async function getJson(url, { headers = {}, method = "GET", body, timeoutMs = 15_000, request = safeRequest } = {}) {
  const response = await request(url, { method, headers: { Accept: "application/json", "User-Agent": AGENT, ...headers }, body, timeoutMs, maxBytes: 2 * 1024 * 1024 });
  if (response.status === 429) throw fail("rate limited", { status: 429, rateLimited: true, retryAfter: Number(response.headers?.["retry-after"]) || null });
  if (response.status >= 400) throw fail(`answered ${response.status}`, { status: response.status });
  const text = response.body.toString("utf8");
  try { return JSON.parse(text); } catch { return text; }
}

const xmlText = (xml, tag) => clip(String(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1] || "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\""), 2000);

/** What "recent" means to each API. */
const recencyDays = (recency) => ({ day: 1, week: 7, month: 31, year: 366 })[recency] || null;

function createProviders({ env = process.env, request = safeRequest, groqSearch = searchWeb } = {}) {
  const json = (url, options) => getJson(url, { ...options, request });
  return [
    {
      id: "tavily", label: "Tavily", kind: "web", needs: "TAVILY_API_KEY",
      available: () => Boolean(env.TAVILY_API_KEY),
      async search(query, { limit = 8, recency } = {}) {
        const days = recencyDays(recency);
        const data = await json("https://api.tavily.com/search", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.TAVILY_API_KEY}` }, body: JSON.stringify({ query, max_results: limit, search_depth: "basic", ...(days ? { topic: "news", days } : {}) }) });
        return (data?.results || []).map((item) => ({ title: clip(item.title, 300), url: item.url, snippet: clip(item.content, 1200), published: isoDate(item.published_date) }));
      },
    },
    {
      id: "brave", label: "Brave Search", kind: "web", needs: "BRAVE_SEARCH_API_KEY",
      available: () => Boolean(env.BRAVE_SEARCH_API_KEY),
      async search(query, { limit = 8, recency, page = 1 } = {}) {
        const freshness = { day: "pd", week: "pw", month: "pm", year: "py" }[recency];
        const data = await json(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(limit, 20)}${page > 1 ? `&offset=${page - 1}` : ""}${freshness ? `&freshness=${freshness}` : ""}`, { headers: { "X-Subscription-Token": env.BRAVE_SEARCH_API_KEY } });
        return (data?.web?.results || []).map((item) => ({ title: clip(item.title, 300), url: item.url, snippet: clip(String(item.description || "").replace(/<[^>]+>/g, ""), 1200), published: isoDate(item.page_age), publisher: clip(item.profile?.name, 120) }));
      },
    },
    {
      id: "searxng", label: "SearXNG", kind: "web", needs: "SEARXNG_URL",
      available: () => /^https?:\/\//.test(String(env.SEARXNG_URL || "")),
      async search(query, { limit = 8, recency, page = 1 } = {}) {
        const range = { day: "day", week: "week", month: "month", year: "year" }[recency];
        const data = await json(`${String(env.SEARXNG_URL).replace(/\/+$/, "")}/search?q=${encodeURIComponent(query)}&format=json&pageno=${page}${range ? `&time_range=${range}` : ""}`);
        return (data?.results || []).slice(0, limit).map((item) => ({ title: clip(item.title, 300), url: item.url, snippet: clip(item.content, 1200), published: isoDate(item.publishedDate) }));
      },
    },
    {
      id: "groq", label: "Groq browser search", kind: "web", needs: "a Groq key",
      // One model call per search: slower than a search API and counted against the key's per-minute limit.
      serial: true,
      available: (context) => Boolean(context?.groq?.apiKey),
      async search(query, { recency } = {}, context) {
        const hint = recency ? ` (published in the last ${recency})` : "";
        const result = await groqSearch({ baseUrl: context.groq.baseUrl, apiKey: context.groq.apiKey, query: `${query}${hint}`.slice(0, 500) });
        if (!result.ok) throw fail(result.error, { status: result.status, rateLimited: result.status === 429, retryAfter: Number(result.retryAfter) || null });
        const results = result.results?.length ? result.results : result.sources.map((source) => ({ title: source.title, url: source.url, snippet: "" }));
        return results.map((item) => ({ title: clip(item.title, 300), url: item.url, snippet: clip(item.snippet, 1200) }));
      },
    },
    {
      id: "wikipedia", label: "Wikipedia", kind: "reference", needs: null,
      available: () => true,
      async search(query, { limit = 4 } = {}) {
        const data = await json(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${Math.min(limit, 10)}&format=json&utf8=1`);
        return (data?.query?.search || []).map((item) => ({ title: clip(item.title, 300), url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(item.title).replace(/ /g, "_"))}`, snippet: clip(String(item.snippet || "").replace(/<[^>]+>/g, ""), 600), published: isoDate(item.timestamp), publisher: "Wikipedia", kind: "encyclopedia" }));
      },
    },
    {
      id: "openalex", label: "OpenAlex", kind: "academic", needs: null,
      available: () => true,
      async search(query, { limit = 8, recency } = {}) {
        const days = recencyDays(recency);
        const from = days ? `&filter=from_publication_date:${new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)}` : "";
        const data = await json(`https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${Math.min(limit, 25)}${from}&select=id,doi,title,publication_date,type,authorships,primary_location,abstract_inverted_index,cited_by_count`);
        return (data?.results || []).filter((work) => work?.title).map((work) => {
          // OpenAlex stores abstracts as word → positions; put the words back in order.
          const words = [];
          for (const [word, positions] of Object.entries(work.abstract_inverted_index || {})) for (const position of positions) if (position < 400) words[position] = word;
          const venue = work.primary_location?.source?.display_name;
          return {
            title: clip(work.title, 300),
            url: work.doi || work.primary_location?.landing_page_url || work.id,
            snippet: clip(words.filter(Boolean).join(" "), 2400),
            published: isoDate(work.publication_date),
            author: clip((work.authorships || []).slice(0, 4).map((item) => item.author?.display_name).filter(Boolean).join(", ") + ((work.authorships || []).length > 4 ? " et al." : ""), 200),
            publisher: clip(venue, 160),
            kind: work.type === "preprint" ? "preprint" : work.type === "review" ? "review article" : ["article", "book-chapter", "dissertation", "book"].includes(work.type) ? "original research" : String(work.type || "scholarly work"),
            citedBy: Number(work.cited_by_count) || 0,
          };
        });
      },
    },
    {
      id: "arxiv", label: "arXiv", kind: "academic", needs: null,
      available: () => true,
      async search(query, { limit = 6 } = {}) {
        const response = await request(`https://export.arxiv.org/api/query?search_query=${encodeURIComponent(`all:${query}`)}&start=0&max_results=${Math.min(limit, 20)}&sortBy=relevance`, { headers: { "User-Agent": AGENT }, timeoutMs: 20_000, maxBytes: 2 * 1024 * 1024 });
        if (response.status === 429) throw fail("rate limited", { status: 429, rateLimited: true });
        if (response.status >= 400) throw fail(`answered ${response.status}`, { status: response.status });
        return [...response.body.toString("utf8").matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((match) => {
          const entry = match[1];
          const authors = [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((item) => clip(item[1], 80));
          return { title: xmlText(entry, "title").slice(0, 300), url: xmlText(entry, "id").replace(/^http:/, "https:"), snippet: xmlText(entry, "summary"), published: isoDate(xmlText(entry, "published")), author: `${authors.slice(0, 4).join(", ")}${authors.length > 4 ? " et al." : ""}`, publisher: "arXiv", kind: "preprint" };
        }).filter((item) => item.title && item.url);
      },
    },
  ];
}

/** Which providers a mode uses, in order of preference. */
function providersFor(mode, providers, context) {
  const ready = providers.filter((provider) => provider.available(context));
  const web = ready.filter((provider) => provider.kind === "web");
  // One web search provider is enough; the first configured one wins (search APIs before the slower model-run search).
  const mainWeb = web.slice(0, 1);
  const academic = ready.filter((provider) => provider.kind === "academic");
  const reference = ready.filter((provider) => provider.kind === "reference");
  if (mode === "academic") return [...academic, ...mainWeb];
  if (mode === "latest" || mode === "quick") return mainWeb.length ? mainWeb : reference;
  return [...mainWeb, ...reference];
}

module.exports = { AGENT, createProviders, providersFor };
