import { useEffect, useState } from "react";
import { PerceptionService, type Modality } from "../services/PerceptionService";

export default function PerceptionConsentPanel() {
  const [consent, setConsent] = useState(() => {
    PerceptionService.loadConsent();
    return { ...PerceptionService.consent };
  });

  useEffect(() => {
    PerceptionService.loadConsent();
    setConsent({ ...PerceptionService.consent });
  }, []);

  const toggle = (modality: Modality) => {
    PerceptionService.setConsent(modality, !consent[modality]);
    setConsent({ ...PerceptionService.consent });
  };

  return (
    <div className="rounded-2xl border border-white/[0.08] p-4">
      <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-slate-300">Perception consent</h3>
      {(["image", "audio", "sensor"] as Modality[]).map((modality) => (
        <label key={modality} className="mt-2 flex items-center gap-2 text-[10px] text-slate-200">
          <input type="checkbox" checked={consent[modality]} onChange={() => toggle(modality)} />
          {modality}
        </label>
      ))}
    </div>
  );
}