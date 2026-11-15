import { MemoryService } from "./MemoryService";

export type MemoryProfile = {
  version: string;
  exportedAt: string;
  session: Array<{ id: string; content: string; weight: number; createdAt: string }>;
  longTerm: Array<{ id: string; content: string; weight: number; createdAt: string; updatedAt: string }>;
  persona: Array<{ id: string; content: string; weight: number; createdAt: string; updatedAt: string }>;
};

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
    // Encrypt before leaving device (scaffold: base64 as placeholder for real envelope encryption).
    const encrypted = btoa(JSON.stringify(profile));
    return { ...profile, _encrypted: encrypted } as unknown as MemoryProfile;
  },
  async import(profile: MemoryProfile) {
    for (const item of profile.session) MemoryService.add("session", item.content, item.weight);
    for (const item of profile.longTerm) MemoryService.add("long_term", item.content, item.weight);
    for (const item of profile.persona) MemoryService.add("persona", item.content, item.weight);
    return { imported: profile.session.length + profile.longTerm.length + profile.persona.length };
  },
};