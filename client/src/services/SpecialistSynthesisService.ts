export const SpecialistSynthesisService = {
  cap: 10,
  specialists: [] as Array<{ id: string; name: string; prompt: string; modelTier: string; active: boolean }>,
  propose(name: string, prompt: string) {
    if (this.specialists.filter((s) => s.active).length >= this.cap) throw new Error("Specialist cap reached.");
    const entry = { id: crypto.randomUUID(), name, prompt, modelTier: "low-cost cloud", active: false };
    this.specialists.push(entry);
    return entry;
  },
  approve(id: string) {
    const entry = this.specialists.find((s) => s.id === id);
    if (entry) entry.active = true;
  },
  retire(id: string) {
    const entry = this.specialists.find((s) => s.id === id);
    if (entry) entry.active = false;
  },
};