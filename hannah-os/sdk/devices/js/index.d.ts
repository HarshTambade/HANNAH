export type DevicePointType = "boolean" | "number" | "enum" | "text";
export type DevicePoint = {
  id: string; name: string; kind: "sensor" | "actuator"; type: DevicePointType;
  unit?: string; range?: [number, number]; step?: number; choices?: string[];
  access: "read" | "read-write"; risk?: "low" | "elevated" | "high";
  binding?: Record<string, unknown>;
};
export type ConnectionField = {
  id: string; label: string; type: "text" | "number" | "secret" | "toggle" | "choice";
  required?: boolean; help?: string; default?: string | number | boolean; min?: number; max?: number; choices?: string[];
};
export type DeviceProfile = {
  format: 1; id: string; version: string; name: string; author: string;
  manufacturer: string; model: string; revisions?: string[];
  category: string; domain: "iot" | "industrial" | "embedded"; simulated?: boolean;
  protocol: { adapter: string; version?: string };
  connection: { instructions: string[]; fields: ConnectionField[] };
  points: DevicePoint[]; constraints: string[]; permissions: Array<"network-local" | "network-internet">;
  dependencies: unknown[]; tests: { level: "unit" | "simulation" | "hardware-in-the-loop" | "physical"; passed: number; total: number; evidence: string };
  documentation: string; [key: string]: unknown;
};
export type ProfileValidation = { valid: boolean; problems: string[] };
export type ActionStatus = "done" | "waiting-approval" | "denied" | "failed" | "unverified" | "declined" | "expired" | "cancelled" | "suggested" | "running";
export type ActionRecord<Response = Record<string, unknown>> = {
  id: string; action: string; status: ActionStatus; outcome?: string; error: string | null;
  response: Response | null; verification?: { confirmed: boolean; evidence: string } | null;
  permission?: { outcome: "allow" | "ask" | "deny"; reason: string };
};
export type Device = { id: string; name: string; status: string; connection: string; [key: string]: unknown };
export type WorkflowNode = {
  id: string; name: string; type: string; params: Record<string, unknown>;
  position: { x: number; y: number }; settings?: Record<string, unknown>; disabled?: boolean;
};
export type WorkflowConnection = { id?: string; source: string; target: string; sourceOutput: string; targetInput: string };
export type WorkflowDefinition = {
  format: "hannah-workflow"; version: 2; nodes: WorkflowNode[]; connections: WorkflowConnection[];
  settings: { timezone: string; timeoutMs?: number };
};
export type WorkflowValidation = { errors: Array<{ nodeId?: string; field?: string; message: string }>; warnings: Array<{ nodeId?: string; message: string }> };
export type AdapterManifest = {
  format: "hannah-adapter"; version: 1; id: string; name: string; protocol: string;
  connection: { fields: Array<Pick<ConnectionField, "id" | "label" | "type"> & { required?: boolean; help?: string; choices?: string[] }> };
  points: Array<{ id: string; name: string; type: DevicePointType; direction: "read" | "write" | "read-write"; unit?: string; range?: [number, number] }>;
  permissions: Array<"network-local" | "network-internet">; constraints: string[]; documentation: string;
};
export type DevicesOptions = { baseUrl: string; apiKey?: string; fetch?: typeof fetch; timeoutMs?: number; agent?: string };
export type HardwareActionInput = { id: string; name?: string; device: string; point: string; value: boolean | number | string; waitIsOk?: boolean };

export class HannahDevicesError extends Error { status?: number; reason?: string; body?: unknown }
export class HannahDevices {
  constructor(options: DevicesOptions);
  request<T = unknown>(method: string, path: string, body?: unknown, options?: { signal?: AbortSignal; headers?: Record<string, string> }): Promise<T>;
  profiles(filter?: { hub?: string }): Promise<unknown[]>;
  validateProfile(profile: DeviceProfile): Promise<ProfileValidation>;
  saveProfile(profile: DeviceProfile): Promise<DeviceProfile>;
  devices(): Promise<Device[]>;
  device(deviceId: string): Promise<Device>;
  addDevice(input: { hub?: string; profileId: string; name: string; location?: string; settings: Record<string, unknown> }): Promise<Device>;
  setPoint(deviceId: string, point: string, value: boolean | number | string): Promise<ActionRecord>;
  workflows(): Promise<Array<Record<string, unknown>>>;
  workflowCatalog(): Promise<Record<string, unknown>>;
  createWorkflow(name: string, definition?: WorkflowDefinition): Promise<Record<string, unknown>>;
  workflow(workflowId: string): Promise<Record<string, unknown>>;
  saveWorkflow(workflowId: string, body: { baseVersion: number; name?: string; description?: string; definition?: WorkflowDefinition }): Promise<Record<string, unknown>>;
  validateWorkflow(workflowId: string, definition?: WorkflowDefinition): Promise<{ validation: WorkflowValidation; permissions: unknown[] }>;
  publishWorkflow(workflowId: string): Promise<Record<string, unknown>>;
  activateWorkflow(workflowId: string, approvedPermissions: unknown[]): Promise<Record<string, unknown>>;
  deactivateWorkflow(workflowId: string): Promise<Record<string, unknown>>;
  runWorkflow(workflowId: string, options?: { draft?: boolean; triggerData?: unknown; triggerNodeId?: string }): Promise<{ executionId: string }>;
  executions(filter?: { workflowId?: string; status?: string; limit?: number }): Promise<Array<Record<string, unknown>>>;
  execution(executionId: string): Promise<Record<string, unknown>>;
  action<Response = Record<string, unknown>>(action: string, params?: Record<string, unknown>, options?: { request?: string }): Promise<ActionRecord<Response>>;
  actionRecord(actionId: string): Promise<ActionRecord>;
}
export function defineProfile(profile: DeviceProfile): DeviceProfile;
export function defineAdapterManifest(manifest: AdapterManifest): AdapterManifest;
export function workflowNode(id: string, name: string, type: string, params?: Record<string, unknown>, position?: { x: number; y: number }, settings?: Record<string, unknown>): WorkflowNode;
export function manualTriggerNode(id?: string, name?: string): WorkflowNode;
export function scheduledTriggerNode(id?: string, options?: { mode?: "interval" | "daily" | "weekly" | "cron"; minutes?: number; time?: string; days?: number[]; cron?: string; missed?: "run-once" | "skip"; name?: string }): WorkflowNode;
export function hardwareActionNode(input: HardwareActionInput): WorkflowNode;
export function workflowConnection(source: string, target: string, options?: { sourceOutput?: string; targetInput?: string; id?: string }): WorkflowConnection;
export function workflowDefinition(input?: { nodes?: WorkflowNode[]; connections?: WorkflowConnection[]; timezone?: string; timeoutMs?: number }): WorkflowDefinition;
export default HannahDevices;
