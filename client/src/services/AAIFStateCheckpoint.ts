export type AAIFStateCheckpoint = {
  version: string;
  agentId: string;
  aaifDocumentId: string;
  timestamp: string;
  conversationState: {
    messages: Array<{ role: string; content: string }>;
    currentTask?: string;
  };
  taskSpineState: Array<{
    id: string;
    title: string;
    status: string;
    progress: number;
  }>;
  memoryPointers: {
    sessionIds: string[];
    longTermIds: string[];
    personaIds: string[];
  };
  runtimeState: {
    strictness: string;
    activeTools: string[];
    pendingApprovals: number;
  };
};

export const AAIFStateCheckpointService = {
  createCheckpoint(
    agentId: string,
    aaifDocumentId: string,
    conversationState: AAIFStateCheckpoint["conversationState"],
    taskSpineState: AAIFStateCheckpoint["taskSpineState"],
    memoryPointers: AAIFStateCheckpoint["memoryPointers"],
    runtimeState: AAIFStateCheckpoint["runtimeState"],
  ): AAIFStateCheckpoint {
    return {
      version: "1.0",
      agentId,
      aaifDocumentId,
      timestamp: new Date().toISOString(),
      conversationState,
      taskSpineState,
      memoryPointers,
      runtimeState,
    };
  },

  serialize(checkpoint: AAIFStateCheckpoint): string {
    return JSON.stringify(checkpoint, null, 2);
  },

  deserialize(json: string): AAIFStateCheckpoint | null {
    try {
      return JSON.parse(json) as AAIFStateCheckpoint;
    } catch {
      return null;
    }
  },
};