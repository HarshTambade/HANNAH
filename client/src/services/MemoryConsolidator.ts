import { MemoryService } from "./MemoryService";
import { TaskSpineService } from "./TaskSpineService";

export const MemoryConsolidator = {
  async schedule(sessionText: string) {
    const task = TaskSpineService.create("Memory consolidation", sessionText);
    // Asynchronous; do not run in request path.
    void this.run(task.id, sessionText);
    return task;
  },
  async run(taskId: string, sessionText: string) {
    TaskSpineService.update(taskId, { status: "running", progress: 0.2 });
    try {
      const facts = sessionText
        .split(/\n|\. /)
        .map((line) => line.trim())
        .filter((line) => line.length > 20)
        .slice(0, 8);
      for (const fact of facts) {
        MemoryService.add("long_term", fact, 1);
      }
      TaskSpineService.update(taskId, { status: "completed", progress: 1, result: { facts } });
    } catch (error) {
      TaskSpineService.update(taskId, { status: "failed", error: error instanceof Error ? error.message : "consolidation failed" });
    }
  },
};