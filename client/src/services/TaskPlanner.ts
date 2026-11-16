export type SubTaskNode = {
  id: string;
  description: string;
  agentType: "research" | "code" | "system" | "memory" | "general";
  confidence: number; // 0..1, estimated confidence that this agent can handle it
  dependencies: string[]; // IDs of subtasks that must complete first
  status: "pending" | "running" | "completed" | "failed";
  result?: unknown;
  priority: number;
};

export type TaskDAG = {
  id: string;
  intent: string;
  nodes: SubTaskNode[];
  edges: Array<{ from: string; to: string }>;
  status: "planning" | "executing" | "completed" | "failed";
  createdAt: string;
};

export const TaskPlanner = {
  async plan(intent: string): Promise<TaskDAG> {
    const id = crypto.randomUUID();
    const lower = intent.toLowerCase();
    const nodes: SubTaskNode[] = [];
    const edges: Array<{ from: string; to: string }> = [];

    // Decompose intent into subtasks based on keywords
    if (/research|search|find|look up/.test(lower)) {
      const researchNode: SubTaskNode = {
        id: crypto.randomUUID(),
        description: "Research the topic and gather relevant information",
        agentType: "research",
        confidence: 0.6,
        dependencies: [],
        status: "pending",
        priority: 1,
      };
      nodes.push(researchNode);

      const synthesizeNode: SubTaskNode = {
        id: crypto.randomUUID(),
        description: "Synthesize research findings into a coherent response",
        agentType: "general",
        confidence: 0.8,
        dependencies: [researchNode.id],
        status: "pending",
        priority: 2,
      };
      nodes.push(synthesizeNode);
      edges.push({ from: researchNode.id, to: synthesizeNode.id });
    }

    if (/code|function|bug|refactor|write|implement/.test(lower)) {
      const codeNode: SubTaskNode = {
        id: crypto.randomUUID(),
        description: "Analyze and generate code",
        agentType: "code",
        confidence: 0.7,
        dependencies: [],
        status: "pending",
        priority: 1,
      };
      nodes.push(codeNode);
    }

    if (/system|device|battery|status|file|open/.test(lower)) {
      const systemNode: SubTaskNode = {
        id: crypto.randomUUID(),
        description: "Check system status or perform device operation",
        agentType: "system",
        confidence: 0.9,
        dependencies: [],
        status: "pending",
        priority: 1,
      };
      nodes.push(systemNode);
    }

    if (/remember|recall|what did|who did|when did/.test(lower)) {
      const memoryNode: SubTaskNode = {
        id: crypto.randomUUID(),
        description: "Query personal knowledge graph",
        agentType: "memory",
        confidence: 0.85,
        dependencies: [],
        status: "pending",
        priority: 1,
      };
      nodes.push(memoryNode);
    }

    // If no specific subtasks, create a general one
    if (nodes.length === 0) {
      nodes.push({
        id: crypto.randomUUID(),
        description: intent,
        agentType: "general",
        confidence: 0.5,
        dependencies: [],
        status: "pending",
        priority: 1,
      });
    }

    const dag: TaskDAG = {
      id,
      intent,
      nodes,
      edges,
      status: "planning",
      createdAt: new Date().toISOString(),
    };

    return dag;
  },

  // Epistemic routing: estimate confidence before delegating
  estimateConfidence(subTask: SubTaskNode, context: string): number {
    const lower = context.toLowerCase();
    const description = subTask.description.toLowerCase();

    // Base confidence from subtask type
    let confidence = subTask.confidence;

    // Adjust based on context overlap
    const words = description.split(/\s+/);
    const contextWords = lower.split(/\s+/);
    const overlap = words.filter((w) => contextWords.includes(w)).length;
    confidence = Math.min(1, confidence + overlap * 0.05);

    // Lower confidence for complex intents
    if (context.includes("complex") || context.includes("detailed") || context.includes("thorough")) {
      confidence = Math.max(0, confidence - 0.15);
    }

    return Math.round(confidence * 100) / 100;
  },

  // Determine if external research is needed
  needsExternalResearch(confidence: number, threshold = 0.7): boolean {
    return confidence < threshold;
  },
};