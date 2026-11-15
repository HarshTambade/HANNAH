import { PersonaKernel } from "./PersonaKernel";

export const PersonaDriftDetector = {
  check(response: string) {
    const conflicts = PersonaKernel.relationalAnchors.filter((anchor: string) => {
      const keyword = anchor.split(" ").slice(-1)[0].toLowerCase();
      return response.toLowerCase().includes("not") && response.toLowerCase().includes(keyword);
    });
    return { drift: conflicts.length > 0, conflicts };
  },
};