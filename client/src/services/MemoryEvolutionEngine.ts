import { MemoryService } from "./MemoryService";
import { TaskSpineService } from "./TaskSpineService";

export const MemoryEvolutionEngine = {
  async schedule(sessionText: string) {
    const task = TaskSpineService.create("Memory evolution", sessionText);
    void this.run(task.id, sessionText);
    return task;
  },
  async run(taskId: string, sessionText: string) {
    TaskSpineService.update(taskId, { status: "running", progress: 0.2 });
    try {
      const insight = `Pattern: ${sessionText.slice(0, 120)}`;
      MemoryService.add("long_term", insight, 2);
      const userModel = MemoryService.list("long_term").map((m) => m.content).slice(0, 10).join("\n");
      window.localStorage.setItem("hannah.userModel", userModel);
      TaskSpineService.update(taskId, { status: "completed", progress: 1, result: { insight } });
    } catch (error) {
      TaskSpineService.update(taskId, { status: "failed", error: error instanceof Error ? error.message : "evolution failed" });
    }
  },
  getUserModel() {
    return window.localStorage.getItem("hannah.userModel") || "";
  },
};