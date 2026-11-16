import { TaskSpineService } from "./TaskSpineService";
import { PersonalKnowledgeGraph } from "./PersonalKnowledgeGraph";

export type IntentType = "file_organize" | "summarize" | "search" | "system_status" | "memory_query" | "general";

export type SubTask = {
  id: string;
  type: IntentType;
  description: string;
  priority: number;
  dependencies: string[];
  status: "pending" | "running" | "completed" | "failed";
  result?: unknown;
};

export type IntentDecomposition = {
  id: string;
  rawIntent: string;
  subTasks: SubTask[];
  createdAt: string;
  status: "decomposing" | "executing" | "completed" | "failed";
};

export type IntentTrace = {
  id: string;
  intent: string;
  decomposition: IntentDecomposition;
  routingLog: Array<{ subTaskId: string; service: string; at: number }>;
  completedAt: string | null;
};

const STORAGE_KEY = "hannah.agentkernel.v1";

function readIntents(): IntentTrace[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeIntents(intents: IntentTrace[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(intents.slice(-100)));
  } catch {
    // Best effort.
  }
}

export const AgentKernel = {
  intents: readIntents(),

  classifyIntent(text: string): IntentType {
    const lower = text.toLowerCase();
    if (/organize|sort|move|rename|file/.test(lower)) return "file_organize";
    if (/summarize|summary|recap|digest/.test(lower)) return "summarize";
    if (/search|find|look for|where is/.test(lower)) return "search";
    if (/status|battery|cpu|memory|device/.test(lower)) return "system_status";
    if (/remember|what did|who did|when did|met|project/.test(lower)) return "memory_query";
    return "general";
  },

  async decompose(intent: string): Promise<IntentDecomposition> {
    const id = crypto.randomUUID();
    const type = this.classifyIntent(intent);
    const subTasks: SubTask[] = [];

    // Decompose based on intent type
    if (type === "file_organize") {
      subTasks.push(
        { id: crypto.randomUUID(), type: "search", description: "Find files from last week", priority: 1, dependencies: [], status: "pending" },
        { id: crypto.randomUUID(), type: "file_organize", description: "Organize found files by date", priority: 2, dependencies: [], status: "pending" },
      );
    } else if (type === "summarize") {
      subTasks.push(
        { id: crypto.randomUUID(), type: "search", description: "Find relevant meeting notes", priority: 1, dependencies: [], status: "pending" },
        { id: crypto.randomUUID(), type: "summarize", description: "Generate summary", priority: 2, dependencies: [], status: "pending" },
      );
    } else if (type === "memory_query") {
      subTasks.push(
        { id: crypto.randomUUID(), type: "memory_query", description: "Query personal knowledge graph", priority: 1, dependencies: [], status: "pending" },
      );
    } else {
      subTasks.push(
        { id: crypto.randomUUID(), type: "general", description: intent, priority: 1, dependencies: [], status: "pending" },
      );
    }

    // Enhance sub-tasks with PKG context if available
    const pkq = PersonalKnowledgeGraph.query(intent);
    if (pkq.entities.length > 0) {
      subTasks.forEach((st) => {
        st.description += ` (related: ${pkq.entities.map((e) => e.name).join(", ")})`;
      });
    }

    const decomposition: IntentDecomposition = {
      id,
      rawIntent: intent,
      subTasks,
      createdAt: new Date().toISOString(),
      status: "decomposing",
    };

    return decomposition;
  },

  async execute(intent: string): Promise<IntentTrace> {
    const decomposition = await this.decompose(intent);
    decomposition.status = "executing";

    const routingLog: Array<{ subTaskId: string; service: string; at: number }> = [];

    for (const subTask of decomposition.subTasks) {
      subTask.status = "running";
      routingLog.push({ subTaskId: subTask.id, service: subTask.type, at: Date.now() });

      try {
        // Route through appropriate service
        if (subTask.type === "memory_query") {
          const result = PersonalKnowledgeGraph.query(subTask.description);
          subTask.result = result;
        } else {
          // Create a task in the Task Spine for execution
          const task = TaskSpineService.create(subTask.description, intent);
          subTask.result = task;
        }
        subTask.status = "completed";
      } catch (error) {
        subTask.status = "failed";
        subTask.result = { error: error instanceof Error ? error.message : "Unknown error" };
      }
    }

    decomposition.status = "completed";

    const trace: IntentTrace = {
      id: decomposition.id,
      intent,
      decomposition,
      routingLog,
      completedAt: new Date().toISOString(),
    };

    this.intents.push(trace);
    if (this.intents.length > 100) this.intents.shift();
    writeIntents(this.intents);

    return trace;
  },

  getIntents(): IntentTrace[] {
    return [...this.intents];
  },

  getSuggestedActions(): string[] {
    const recent = this.intents.slice(-5);
    const suggestions = new Set<string>();
    for (const t of recent) {
      if (t.decomposition.subTasks.length > 0) {
        suggestions.add(t.intent);
      }
    }
    // Add context-based suggestions from PKG
    const entities = PersonalKnowledgeGraph.getEntities();
    for (const e of entities.slice(0, 3)) {
      suggestions.add(`Summarize recent activity with ${e.name}`);
    }
    return Array.from(suggestions).slice(0, 8);
  },
};