import { beforeEach, describe, expect, it } from "vitest";
import { DynamicFewShotInjector } from "../services/DynamicFewShotInjector";
import { PersonalizationEngine } from "../services/PersonalizationEngine";
import { TaskSpineService } from "../services/TaskSpineService";
import { sampleWorkflow } from "../services/WorkflowSchema";

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe("Phase 25 personalization and workflow persistence", () => {
  beforeEach(() => {
    const localStorage = createStorage();
    (globalThis as { window?: unknown }).window = { localStorage };
    PersonalizationEngine.clear();
  });

  it("selects high-rated style examples and excludes rejected responses", () => {
    PersonalizationEngine.record({ id: "like", prompt: "Summarize this", response: "- First\n- Second", feedback: "liked" });
    PersonalizationEngine.record({ id: "accepted", prompt: "Explain", response: "A clear answer.", feedback: "accepted" });
    PersonalizationEngine.record({ id: "rejected", prompt: "Wrong", response: "Do not use this", feedback: "rejected" });

    const context = DynamicFewShotInjector.context(3);
    expect(context?.examples.map((item) => item.prompt)).toEqual(["Summarize this", "Explain"]);
    expect(context?.summary).toContain("bullets");
    expect(DynamicFewShotInjector.promptBlock(context)).toContain("User Communication Style");
    expect(DynamicFewShotInjector.promptBlock(context)).not.toContain("Do not use this");
  });

  it("saves the versioned visual graph as a pending Task Spine workflow", () => {
    const task = TaskSpineService.createWorkflow(sampleWorkflow);
    expect(task.kind).toBe("workflow");
    expect(task.status).toBe("pending");
    expect(task.workflow?.version).toBe(1);
    expect(TaskSpineService.get(sampleWorkflow.id)?.workflow?.edges).toHaveLength(2);
  });
});
