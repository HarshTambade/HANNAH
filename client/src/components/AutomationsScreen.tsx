import { lazy, Suspense, useEffect, useState } from "react";
import { Server } from "lucide-react";
import WorkflowBuilder from "./WorkflowBuilder";
import { WorkflowApi } from "../services/WorkflowApi";
import { ACCOUNT_EVENT, getAccountHint } from "../services/api";

const WorkflowsHome = lazy(() => import("./workflows/WorkflowsHome"));

/**
 * The Automations screen. Signed in, on a server with the account database,
 * it's the server workflow engine (visual editor, runs, credentials), with the
 * routines that run on this device one tab away. Otherwise it's the device
 * routines, with a note on what server workflows need.
 */
export default function AutomationsScreen() {
  const [availability, setAvailability] = useState<"checking" | "ready" | "sign-in" | "database-required" | "unreachable">(getAccountHint() ? "checking" : "sign-in");
  useEffect(() => {
    const check = () => {
      if (!getAccountHint()) { setAvailability("sign-in"); return; }
      setAvailability("checking");
      void WorkflowApi.availability().then(setAvailability);
    };
    check();
    window.addEventListener(ACCOUNT_EVENT, check);
    return () => window.removeEventListener(ACCOUNT_EVENT, check);
  }, []);

  if (availability === "ready") {
    return <Suspense fallback={<p className="p-6 text-sm text-slate-500" role="status">Loading workflows…</p>}><WorkflowsHome deviceRoutines={<WorkflowBuilder />} /></Suspense>;
  }
  const reason = {
    checking: "Checking whether this server runs workflows…",
    "sign-in": "Sign in (Settings → Account) to build visual workflows that run on HANNAH's server: webhooks, schedules that run while your devices are off, conditions, integrations and a record of every run.",
    "database-required": "This HANNAH server doesn't have its account database set up, so visual workflows can't run on it yet. The routines below run on this device.",
    unreachable: "The HANNAH server didn't answer, so server workflows aren't available right now. The routines below run on this device.",
  }[availability];
  return (
    <>
      <div className="mx-auto max-w-6xl px-3 pt-5 sm:px-6 sm:pt-8">
        <p className="flex items-start gap-2 rounded-2xl border border-violet-200 bg-violet-50 px-4 py-3 text-sm text-violet-900" role="status"><Server size={16} className="mt-0.5 shrink-0" /> {reason}</p>
      </div>
      <WorkflowBuilder />
    </>
  );
}
