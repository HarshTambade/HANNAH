/**
 * Chat tools for server workflows: "Hey HANNAH, create an automation that
 * summarizes my new emails every morning" becomes a real, inactive draft.
 *
 * Drafting needs no approval because a draft can't do anything: it runs only
 * after the user tests, publishes and activates it on the Automations screen,
 * where activation shows what it may do. Offered only to signed-in accounts.
 */
import type { HANNAHTool } from "./DeviceTools";
import { getAccountHint } from "./api";
import { WorkflowApi } from "./WorkflowApi";

const tools: HANNAHTool[] = [
  {
    name: "create_workflow_draft",
    description: "Create an automation (a workflow that runs on HANNAH's server) from a plain-language description, such as \"every morning summarize my new emails and notify me\" or \"when a GitHub issue is opened, ask the coding agent to analyze it\". It's saved as an inactive draft; tell the user to open Automations to review, test and activate it, and mention anything the result says they must set up.",
    inputSchema: { type: "object", properties: { description: { type: "string", description: "What the automation should do, including when it runs." } }, required: ["description"] },
    execute: async (args) => {
      const description = typeof args.description === "string" ? args.description : "";
      const result = await WorkflowApi.fromText(description);
      return {
        created: { id: result.workflow.id, name: result.workflow.name, active: false, steps: result.definition.nodes.map((node) => node.name) },
        needsSetup: result.notes || null,
        problems: result.validation.errors.map((problem) => problem.message),
        openAt: "/automations",
      };
    },
  },
  {
    name: "list_workflows",
    description: "List the user's server workflows with whether each is active, its triggers, and its last run's status.",
    inputSchema: { type: "object", properties: {} },
    execute: async () => {
      const { workflows } = await WorkflowApi.list();
      return { workflows: workflows.map((workflow) => ({ name: workflow.name, active: workflow.active, published: workflow.publishedVersion !== null, triggers: workflow.triggers, lastRun: workflow.lastRun ? { status: workflow.lastRun.status, at: new Date(workflow.lastRun.at).toISOString(), error: workflow.lastRun.error } : null, nextRunAt: workflow.nextRunAt ? new Date(workflow.nextRunAt).toISOString() : null })) };
    },
  },
];

export function getWorkflowTools(): HANNAHTool[] {
  return getAccountHint() ? tools : [];
}
