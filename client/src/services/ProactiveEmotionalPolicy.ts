import { EmotionalStateModel } from "./EmotionalStateModel";

export const ProactiveEmotionalPolicy = {
  shouldOfferSupport() {
    const recent = EmotionalStateModel.trajectory(1);
    if (recent.length === 0) return false;
    const avg = recent.reduce((sum, e) => sum + e.sentiment, 0) / recent.length;
    return avg < -0.3;
  },
  message() {
    return "I noticed you might be feeling down. I'm here if you want to talk.";
  },
};