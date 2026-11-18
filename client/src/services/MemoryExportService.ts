import { MemoryService } from "./MemoryService";

export type MemoryProfile = {
  version: string;
  exportedAt: string;
  session: Array<{ id: string; content: string; weight: number; createdAt: string }>;
  longTerm: Array<{ id: string; content: string; weight: number; createdAt: string; updatedAt: string }>;
  persona: Array<{ id: string; content: string; weight: number; createdAt: string; updatedAt: string }>;
};

import { CATEGORY_LABELS, SOURCE_LABELS } from "./MemoryModel";

/** Memories as Markdown, grouped by category, with where each came from and earlier values. */
export function memoriesAsMarkdown(records = MemoryService.list(), at = new Date()) {
  const lines = [`# What HANNAH remembers`, "", `Exported ${at.toISOString().slice(0, 10)}. ${records.length} memories. Passwords, keys and card numbers are never saved.`, ""];
  for (const [category, label] of Object.entries(CATEGORY_LABELS)) {
    const inCategory = records.filter((record) => record.category === category && record.layer !== "session");
    if (!inCategory.length) continue;
    lines.push(`## ${label}`, "");
    for (const record of inCategory) {
      const notes = [SOURCE_LABELS[record.source?.kind] ?? "", record.sensitivity === "sensitive" ? "sensitive" : "", `saved ${record.createdAt.slice(0, 10)}`].filter(Boolean).join(" · ");
      lines.push(`- ${record.content.replace(/\n/g, " ")}  `, `  _${notes}_`);
      for (const earlier of record.previous ?? []) lines.push(`  - Before ${earlier.until.slice(0, 10)}: ${earlier.content.replace(/\n/g, " ")}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export const MemoryExportService = {
  async export(): Promise<MemoryProfile> {
    const session = MemoryService.list("session").map(({ id, content, weight, createdAt }) => ({ id, content, weight, createdAt }));
    const longTerm = MemoryService.list("long_term").map(({ id, content, weight, createdAt, updatedAt }) => ({ id, content, weight, createdAt, updatedAt }));
    const persona = MemoryService.list("persona").map(({ id, content, weight, createdAt, updatedAt }) => ({ id, content, weight, createdAt, updatedAt }));
    const profile: MemoryProfile = {
      version: "1.0.3",
      exportedAt: new Date().toISOString(),
      session,
      longTerm,
      persona,
    };
    // A plain export the person downloads. (It used to add base64 labelled as
    // encryption; base64 isn't encryption, so it's gone. Sync encrypts on its own.)
    return profile;
  },
  async import(profile: MemoryProfile) {
    for (const item of profile.session) MemoryService.add("session", item.content, item.weight);
    for (const item of profile.longTerm) MemoryService.add("long_term", item.content, item.weight);
    for (const item of profile.persona) MemoryService.add("persona", item.content, item.weight);
    return { imported: profile.session.length + profile.longTerm.length + profile.persona.length };
  },
};