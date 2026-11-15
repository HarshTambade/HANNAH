export const CastOrchestrator = {
  mode: "solo" as "solo" | "cast",
  agents: ["Shanaya", "ResearchCompanion", "CodingCompanion", "CasualChatCompanion"],
  route(message: string) {
    if (this.mode === "solo") return "Shanaya";
    if (/code|bug/.test(message.toLowerCase())) return "CodingCompanion";
    if (/research|search/.test(message.toLowerCase())) return "ResearchCompanion";
    return "Shanaya";
  },
  setMode(mode: "solo" | "cast") {
    this.mode = mode;
  },
};