import { describe, expect, it } from "vitest";
import { headTags, llmsTxt, PUBLIC_PAGES, robots, sitemap, structuredData, withHead } from "../../scripts/seoPlugin";
import { CAPABILITIES, FAQS } from "../content/landing";

const site = "https://hannah.eliteforums.in";
const page = (path: string) => PUBLIC_PAGES.find((item) => item.path === path)!;

describe("search metadata", () => {
  it("gives every public page a distinct, well-sized title and description", () => {
    expect(new Set(PUBLIC_PAGES.map((item) => item.title)).size).toBe(PUBLIC_PAGES.length);
    for (const item of PUBLIC_PAGES) {
      expect(item.title.length).toBeLessThanOrEqual(60);
      expect(item.description.length).toBeGreaterThanOrEqual(110);
      expect(item.description.length).toBeLessThanOrEqual(175);
    }
  });

  it("writes canonical, social and structured data for production pages only", () => {
    const head = headTags(page("/integrations"), { siteOrigin: site, indexable: true });
    expect(head).toContain('<link rel="canonical" href="https://hannah.eliteforums.in/integrations" />');
    expect(head).toContain('content="https://hannah.eliteforums.in/social-card.png"');
    expect(head).toContain("index,follow");
    expect(head).toContain("application/ld+json");
    const preview = headTags(page("/"), { siteOrigin: "", indexable: false });
    expect(preview).toContain("noindex,nofollow");
    expect(preview).not.toContain("canonical");
    expect(preview).not.toContain("ld+json");
  });

  it("builds the FAQ rich result from the FAQ the page shows", () => {
    const data = JSON.parse(structuredData(site, page("/")));
    const faq = data["@graph"].find((item: { "@type": string }) => item["@type"] === "FAQPage");
    expect(faq.mainEntity.map((item: { name: string }) => item.name)).toEqual(FAQS.map((item) => item.q));
    const app = data["@graph"].find((item: { "@type": string }) => item["@type"] === "SoftwareApplication");
    expect(app.offers).toMatchObject({ price: "0" });
    expect(app.featureList).toHaveLength(CAPABILITIES.length);
    const sub = JSON.parse(structuredData(site, page("/marketplace")));
    expect(sub["@graph"].some((item: { "@type": string }) => item["@type"] === "BreadcrumbList")).toBe(true);
  });

  it("never claims to be open source", () => {
    const text = [llmsTxt(site), ...FAQS.map((item) => item.a), ...PUBLIC_PAGES.map((item) => item.description)].join(" ");
    expect(text).not.toMatch(/\bis open[- ]source\b|open-source (AI|app|companion)/i);
    expect(llmsTxt(site)).toContain("source-available, non-commercial");
  });

  it("lists the public pages in the sitemap and keeps APIs out of the index", () => {
    const xml = sitemap(site, "2026-11-17");
    expect(xml.match(/<loc>/g)).toHaveLength(PUBLIC_PAGES.length);
    expect(xml).toContain("<loc>https://hannah.eliteforums.in/marketplace</loc>");
    const text = robots(site, true);
    expect(text).toContain("Disallow: /api/");
    expect(text).toContain("Sitemap: https://hannah.eliteforums.in/sitemap.xml");
    expect(robots("", false)).toContain("Disallow: /\n");
  });

  it("swaps one page's head for another's", () => {
    const html = `<head>${headTags(page("/"), { siteOrigin: site, indexable: true })}</head>`;
    const swapped = withHead(html, headTags(page("/marketplace"), { siteOrigin: site, indexable: true }));
    expect(swapped).toContain("<title>HANNAH Marketplace: AI Agents and Skills</title>");
    expect(swapped.match(/<title>/g)).toHaveLength(1);
  });
});
