export const CastOrchestrator = {
  mode: "solo" as "solo" | "cast",
  agents: ["HANNAH", "ResearchCompanion", "CodingCompanion", "CasualChatCompanion"],
  route(message: string) {
    if (this.mode === "solo") return "HANNAH";
    if (/code|bug/.test(message.toLowerCase())) return "CodingCompanion";
    if (/research|search/.test(message.toLowerCase())) return "ResearchCompanion";
    return "HANNAH";
  },
  setMode(mode: "solo" | "cast") {
    this.mode = mode;
  },
};