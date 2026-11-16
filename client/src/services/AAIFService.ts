export type AAIFToolAuth = {
  type: "api_key" | "oauth" | "none";
  headerName?: string;
  scopes?: string[];
};

export type AAIFTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  auth: AAIFToolAuth;
  hitlRequired: boolean;
};

export type AAIFMemoryConfig = {
  type: "session" | "long_term" | "persona" | "hybrid";
  maxItems: number;
  retentionDays: number;
  encrypted: boolean;
};

export type AAIFRuntimePolicy = {
  strictness: "permissive" | "balanced" | "strict";
  maxIterations: number;
  timeoutMs: number;
  allowedTools: string[];
  deniedTools: string[];
  dataResidency: string[];
  hitlApprovalRequired: boolean;
};

export type AAIFOrchestrationTopology = {
  type: "solo" | "cast" | "collective";
  members: string[];
  routingRule: string;
};

export type AAIFOpenTelemetry = {
  enabled: boolean;
  exporter: "console" | "otlp" | "none";
  endpoint?: string;
  sampleRate: number;
};

export type AAIFEvaluationCriteria = {
  metric: string;
  threshold: number;
  method: "expert_review" | "automated" | "user_feedback";
};

export type AAIFComplianceControl = {
  dataResidency: string[];
  hitlApproval: boolean;
  auditLogged: boolean;
  retentionDays: number;
};

export type AAIFDocument = {
  version: string;
  id: string;
  name: string;
  description: string;
  identity: {
    name: string;
    role: string;
    version: string;
  };
  goal: string;
  systemInstructions: string;
  llmProvider: {
    preferred: string;
    fallbacks: string[];
    model: string;
  };
  orchestration: AAIFOrchestrationTopology;
  tools: AAIFTool[];
  memory: AAIFMemoryConfig;
  runtimePolicy: AAIFRuntimePolicy;
  observability: AAIFOpenTelemetry;
  evaluation: AAIFEvaluationCriteria[];
  compliance: AAIFComplianceControl;
  createdAt: string;
  updatedAt: string;
};

export const AAIFService = {
  generateDefaultDocument(name = "HANNAH Agent"): AAIFDocument {
    const now = new Date().toISOString();
    const doc: AAIFDocument = {
      version: "1.0",
      id: crypto.randomUUID(),
      name,
      description: "Portable agent definition for HANNAH",
      identity: { name: "HANNAH", role: "AI companion", version: "1.0.3" },
      goal: "Provide helpful, private, governed assistance to the user.",
      systemInstructions: "You are HANNAH, a privacy-first AI companion. Always prioritize user safety and consent.",
      llmProvider: {
        preferred: "groq",
        fallbacks: ["ollama", "webllm"],
        model: "openai/gpt-oss-120b",
      },
      orchestration: { type: "solo", members: ["HANNAH"], routingRule: "intent-based" },
      tools: [],
      memory: { type: "hybrid", maxItems: 500, retentionDays: 90, encrypted: true },
      runtimePolicy: {
        strictness: "balanced",
        maxIterations: 8,
        timeoutMs: 30000,
        allowedTools: [],
        deniedTools: [],
        dataResidency: ["local"],
        hitlApprovalRequired: true,
      },
      observability: { enabled: true, exporter: "otlp", sampleRate: 0.1 },
      evaluation: [{ metric: "task_success_rate", threshold: 0.9, method: "automated" }],
      compliance: {
        dataResidency: ["local"],
        hitlApproval: true,
        auditLogged: true,
        retentionDays: 90,
      },
      createdAt: now,
      updatedAt: now,
    };
    return doc;
  },

  validate(doc: AAIFDocument): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!doc.id || !doc.version) errors.push("Missing id or version");
    if (!doc.identity.name) errors.push("Missing identity name");
    if (!doc.goal) errors.push("Missing goal");
    if (!doc.systemInstructions) errors.push("Missing system instructions");
    if (!doc.llmProvider.preferred) errors.push("Missing preferred LLM provider");
    if (!doc.runtimePolicy) errors.push("Missing runtime policy");
    if (!doc.compliance) errors.push("Missing compliance controls");
    return { valid: errors.length === 0, errors };
  },

  serialize(doc: AAIFDocument): string {
    return JSON.stringify(doc, null, 2);
  },

  deserialize(json: string): AAIFDocument | null {
    try {
      const doc = JSON.parse(json) as AAIFDocument;
      const { valid, errors } = this.validate(doc);
      if (!valid) throw new Error(`Invalid AAIF: ${errors.join(", ")}`);
      return doc;
    } catch {
      return null;
    }
  },
};