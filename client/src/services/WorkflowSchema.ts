export type WorkflowNodeKind = "trigger" | "agent-task" | "tool-action" | "output";
export type WorkflowNode = { id: string; kind: WorkflowNodeKind; label: string; config: Record<string, unknown>; position: { x: number; y: number } };
export type WorkflowEdge = { id: string; source: string; target: string; label?: string };
export type WorkflowSchema = { version: 1; id: string; name: string; nodes: WorkflowNode[]; edges: WorkflowEdge[]; createdAt: string; updatedAt: string };

export const sampleWorkflow: WorkflowSchema = {
  version: 1,
  id: "wf-morning-brief",
  name: "Morning brief",
  nodes: [
    { id: "trigger-1", kind: "trigger", label: "Every day · 8:00 AM", config: { schedule: "0 8 * * *", timezone: "local" }, position: { x: 80, y: 120 } },
    { id: "agent-1", kind: "agent-task", label: "Summarize today's agenda", config: { task: "Summarize today's agenda" }, position: { x: 360, y: 120 } },
    { id: "output-1", kind: "output", label: "Speak the summary", config: { channel: "voice" }, position: { x: 640, y: 120 } },
  ],
  edges: [{ id: "edge-1", source: "trigger-1", target: "agent-1" }, { id: "edge-2", source: "agent-1", target: "output-1" }],
  createdAt: "2026-01-01T08:00:00.000Z",
  updatedAt: "2026-01-01T08:00:00.000Z",
};
