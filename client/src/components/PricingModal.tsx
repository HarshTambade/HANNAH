import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check, Crown, Loader2, ShieldCheck, Sparkles, X, Zap,
} from "lucide-react";
import {
  PREMIUM_PLAN,
  FREE_PLAN,
  type SubscriptionPlan,
  type SubscriptionQuota,
  type SubscriptionTier,
} from "../services/SubscriptionService";

type PricingModalProps = {
  open: boolean;
  onClose: () => void;
  quota: SubscriptionQuota;
  /** Shown above the plans when a turn was blocked by the free tier. */
  reason?: string;
  /**
   * Placeholder hook for RevenueCat, Stripe, or native store billing. Until it
   * is wired, the modal explains that checkout is not connected instead of
   * pretending a purchase succeeded.
   */
  onCheckout?: (tier: SubscriptionTier) => void | Promise<void>;
  /** Local-only QA shortcut. Never pass this in a production build. */
  onPreviewPremium?: () => void;
};

const planIcons = {
  free: ShieldCheck,
  premium: Crown,
} as const;

function PlanCard({
  plan,
  currentTier,
  busy,
  onChoose,
}: {
  plan: SubscriptionPlan;
  currentTier: SubscriptionTier;
  busy: boolean;
  onChoose: () => void;
}) {
  const isPremium = plan.tier === "premium";
  const isCurrent = currentTier === plan.tier;
  const Icon = planIcons[plan.tier];

  return (
    <article
      className={`relative flex h-full flex-col overflow-hidden rounded-2xl border p-4 sm:p-5 shadow-soft ${isPremium ? "border-brand-200 bg-brand-50" : "border-slate-100 bg-white"}`}
    >
      {isPremium && (
        <span className="absolute right-3 top-3 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[8px] font-bold uppercase tracking-[0.14em] text-amber-600">
          Most capable
        </span>
      )}
      <span className={`flex h-10 w-10 items-center justify-center rounded-xl border ${isPremium ? "border-amber-200 bg-amber-50 text-amber-600" : "border-cyan-200 bg-cyan-50 text-cyan-600"}`}>
        <Icon size={17} />
      </span>
      <h3 className="mt-3 font-['Manrope'] text-base font-semibold text-ink">{plan.name}</h3>
      <p className="mt-1 flex items-baseline gap-1">
        <span className="font-['Manrope'] text-2xl font-bold tracking-[-0.04em] text-ink">{plan.priceLabel}</span>
        <span className="text-[10px] text-slate-500">{plan.cadence}</span>
      </p>
      <p className="mt-2 text-[10px] leading-5 text-slate-500">
        {isPremium
          ? "Unlimited cloud and local conversations with priority Groq routing."
          : "Local, private conversations with a generous daily allowance."}
      </p>

      <ul className="mt-4 flex-1 space-y-2">
        {plan.features.map((feature) => (
          <li key={feature} className="flex items-start gap-2 text-[10px] leading-5 text-slate-300">
            <Check size={11} className={`mt-1 shrink-0 ${isPremium ? "text-amber-200" : "text-emerald-300"}`} />
            <span>{feature}</span>
          </li>
        ))}
      </ul>

      <button
        type="button"
        onClick={onChoose}
        disabled={isCurrent || busy}
        className={`mt-4 flex w-full items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-[11px] font-semibold transition disabled:cursor-default ${isCurrent ? "border border-slate-200 bg-white text-slate-500 hover:bg-slate-50" : isPremium ? "bg-gradient-to-r from-brand-600 to-violet-600 text-white shadow-soft hover:brightness-105" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
      >
        {busy && <Loader2 size={13} className="animate-spin" />}
        {isCurrent ? "Current plan" : plan.cta}
      </button>
    </article>
  );
}

export default function PricingModal({
  open,
  onClose,
  quota,
  reason,
  onCheckout,
  onPreviewPremium,
}: PricingModalProps) {
  const [busyTier, setBusyTier] = useState<SubscriptionTier | null>(null);
  const [notice, setNotice] = useState("");
  const noticeRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    setNotice("");
    setBusyTier(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  useEffect(() => {
    if (notice) noticeRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [notice]);

  if (!open) return null;

  const choose = async (tier: SubscriptionTier) => {
    if (tier === quota.tier) return;
    setNotice("");
    if (!onCheckout) {
      setNotice(
        "Checkout is a placeholder in this build. Connect RevenueCat, Stripe, or native store billing before charging for Premium, then validate the entitlement on the Shanaya API.",
      );
      return;
    }
    setBusyTier(tier);
    try {
      await onCheckout(tier);
    } catch (checkoutError) {
      setNotice(checkoutError instanceof Error ? checkoutError.message : "Checkout could not be started.");
    } finally {
      setBusyTier(null);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[85] flex items-center justify-center overflow-y-auto bg-ink/60 p-4 backdrop-blur-md"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="pricing-title"
        className="relative my-auto w-full max-w-2xl overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-soft-lg"
      >
        <div className="pointer-events-none absolute -right-24 -top-28 h-64 w-64 rounded-full bg-brand-100/30 blur-[90px]" />
        <div className="pointer-events-none absolute -bottom-32 -left-20 h-56 w-56 rounded-full bg-cyan-100/30 blur-[90px]" />
        <div className="relative p-5 sm:p-7">
          <button
            type="button"
            aria-label="Close pricing"
            onClick={onClose}
            className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 text-slate-500 transition hover:bg-slate-50 hover:text-ink"
          >
            <X size={15} />
          </button>

          <span className="flex h-11 w-11 items-center justify-center rounded-2xl border border-amber-100 bg-amber-50 text-amber-600">
            <Sparkles size={18} />
          </span>
          <p className="mt-5 text-[9px] font-bold uppercase tracking-[0.2em] text-amber-600">Shanaya plans</p>
          <h2 id="pricing-title" className="mt-2 font-['Manrope'] text-2xl font-semibold tracking-[-0.04em] text-ink">
            Keep the conversation going.
          </h2>
          <p className="mt-2 max-w-lg text-[11px] leading-6 text-slate-500">
            Free keeps every private, on-device path available. Premium adds unlimited messages, cloud models, and the cloud-backed agents.
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-2 text-[10px]">
            <span className={`rounded-full border px-2.5 py-1 font-medium ${
              quota.tier === "premium"
                ? "border-amber-200/20 bg-amber-200/[0.08] text-amber-100"
                : "border-white/[0.08] bg-white/[0.03] text-slate-300"
            }`}>
              {quota.tier === "premium"
                ? "Premium active"
                : `${quota.remaining ?? 0} of ${quota.limit ?? 25} free messages left today`}
            </span>
            <span className="rounded-full border border-emerald-100 bg-emerald-50 px-2.5 py-1 text-emerald-600">
              Cancel anytime
            </span>
            <span className="rounded-full border border-cyan-100 bg-cyan-50 px-2.5 py-1 text-cyan-600">
              Local models stay local
            </span>
          </div>

          {reason && (
            <div className="mt-4 rounded-xl border border-amber-100 bg-amber-50 px-3 py-2.5 text-[10px] leading-5 text-amber-700">
              {reason}
            </div>
          )}

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <PlanCard plan={FREE_PLAN} currentTier={quota.tier} busy={busyTier === "free"} onChoose={() => void choose("free")} />
            <PlanCard plan={PREMIUM_PLAN} currentTier={quota.tier} busy={busyTier === "premium"} onChoose={() => void choose("premium")} />
          </div>

          {notice && (
            <div ref={noticeRef} role="status" className="mt-4 rounded-xl border border-cyan-100 bg-cyan-50 px-3 py-2.5 text-[10px] leading-5 text-cyan-700">
              {notice}
            </div>
          )}

          <div className="mt-5 flex flex-col gap-2 border-t border-slate-200 pt-4 text-[9px] leading-5 text-slate-500 sm:flex-row sm:items-center sm:justify-between">
            <p className="flex items-center gap-1.5">
              <Zap size={11} className="text-brand-600" />
              Billing is a placeholder until store or Stripe checkout is connected.
            </p>
            {onPreviewPremium && quota.tier === "free" && (
              <button
                type="button"
                onClick={onPreviewPremium}
                className="self-start rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[9px] font-semibold text-slate-600 transition hover:bg-slate-50 sm:self-auto"
              >
                Preview Premium locally
              </button>
            )}
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
