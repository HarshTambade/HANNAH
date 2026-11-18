import { TaskPlanner, type TaskDAG } from "./TaskPlanner";
import { GuardianAgent } from "./GuardianAgent";

/**
 * Plan → run → adversarial review, with real model calls.
 *
 * TaskPlanner splits the request into steps with dependencies. Each step
 * passes GuardianAgent, then runs as one agent turn with no tools (a planning
 * step can't change anything; actions need the normal approved tools), with
 * the results of the steps it depends on. A skeptic and a devil's advocate
 * then review the combined result, and a synthesis turn writes the final
 * answer taking their points into account.
 *
 * `ask` is one model turn; by default it's HANNAH's agent runtime with the
 * model chosen in chat. Tests pass their own.
 */
export type AdversarialReview = {
  id: string;
  originalResponse: string;
  skepticFeedback: string;
  devilAdvocateFeedback: string;
  synthesis: string;
  confidence: number;
  approved: boolean;
  createdAt: string;
};

export type OrchestrationResult = {
  intent: string;
  dag: TaskDAG;
  reviews: AdversarialReview[];
  finalResponse: string;
  totalDurationMs: number;
};

export type Ask = (prompt: string) => Promise<string>;

const STORAGE_KEY = "hannah.orchestration.v1";

function readReviews(): AdversarialReview[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeReviews(reviews: AdversarialReview[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(reviews.slice(-200)));
  } catch {
    // Best effort.
  }
}

/** One agent turn with no tools, on the model chosen in chat. */
async function defaultAsk(prompt: string): Promise<string> {
  const [{ runAgentTurn }, { automationModel }, { getSessionGroqKey }] = await Promise.all([import("./AgentRuntime"), import("./AutomationService"), import("./api")]);
  const { mode, providerId, model } = automationModel();
  const result = await runAgentTurn({
    mode, providerId, model,
    groqApiKey: getSessionGroqKey() || undefined,
    messages: [{ role: "user", content: prompt }],
    toolsOverride: [],
    maxIterations: 1,
    agentLabel: "Orchestrated step",
    signal: AbortSignal.timeout(120_000),
    generateLocal: async (_prompt, _mode, cause) => { throw cause instanceof Error ? cause : new Error("HANNAH's AI didn't answer."); },
  });
  if (result.outcome) throw new Error(result.reply || "The step didn't finish.");
  return result.reply;
}

/** A list of points from a reviewer's answer: JSON {"points": [...]}, or one point per line. */
function pointsOf(text: string): string[] {
  try {
    const match = /\{[\s\S]*\}/.exec(text);
    const parsed = match ? JSON.parse(match[0]) as { points?: unknown } : null;
    if (parsed && Array.isArray(parsed.points)) return parsed.points.map(String).map((point) => point.trim()).filter(Boolean).slice(0, 8);
  } catch {
    // Fall through to lines.
  }
  const lines = text.split("\n").map((line) => line.replace(/^\s*[-*\d.)]+\s*/, "").trim()).filter(Boolean);
  return /^(none|no (issues|concerns))\b/i.test(lines[0] ?? "") ? [] : lines.slice(0, 8);
}

export const AgentOrchestrator = {
  async orchestrate(intent: string, { ask = defaultAsk }: { ask?: Ask } = {}): Promise<OrchestrationResult> {
    const start = Date.now();
    const dag = await TaskPlanner.plan(intent);
    dag.status = "executing";
    const completed = new Set<string>();
    const outputs = new Map<string, string>();

    while (completed.size < dag.nodes.length) {
      const ready = dag.nodes.filter((node) => !completed.has(node.id) && node.dependencies.every((dependency) => completed.has(dependency)));
      if (ready.length === 0) break;
      for (const node of ready) {
        node.status = "running";
        const confidence = TaskPlanner.estimateConfidence(node, intent);
        node.confidence = confidence;
        const needsResearch = TaskPlanner.needsExternalResearch(confidence, 0.7);
        const guard = GuardianAgent.evaluate({ tool: "agent_delegation", args: { agentType: node.agentType, description: node.description }, intent: "delegation" });
        if (!guard.allowed) {
          node.status = "failed";
          node.result = { error: `Blocked by GuardianAgent: ${guard.reason}` };
          completed.add(node.id);
          continue;
        }
        const context = node.dependencies.map((dependency) => outputs.get(dependency)).filter(Boolean).map((text, index) => `Result ${index + 1}:\n${text}`).join("\n\n");
        try {
          const output = await ask(`You are HANNAH's ${node.agentType} specialist working on one step of a larger request.\n\nRequest: ${intent}\nYour step: ${node.description}${needsResearch ? "\nSay plainly what you'd need to look up, if you can't answer from what you know." : ""}${context ? `\n\nWhat earlier steps found:\n${context}` : ""}\n\nAnswer this step only, concisely.`);
          outputs.set(node.id, output);
          node.result = { agentType: node.agentType, description: node.description, confidence, needsExternalResearch: needsResearch, output };
          node.status = "completed";
        } catch (error) {
          node.status = "failed";
          node.result = { error: error instanceof Error ? error.message : String(error) };
        }
        completed.add(node.id);
      }
    }

    const failed = dag.nodes.filter((node) => node.status === "failed");
    dag.status = failed.length === dag.nodes.length ? "failed" : "completed";
    const combined = dag.nodes.map((node) => `## ${node.description}\n${outputs.get(node.id) ?? `(not done: ${String((node.result as { error?: string } | undefined)?.error ?? "skipped")})`}`).join("\n\n");
    const review = await this.adversarialReview(combined, intent, { ask });
    return { intent, dag, reviews: [review], finalResponse: review.synthesis, totalDurationMs: Date.now() - start };
  },

  /** A skeptic and a devil's advocate review the draft; a synthesis turn writes the final answer. */
  async adversarialReview(response: string, context: string, { ask = defaultAsk }: { ask?: Ask } = {}): Promise<AdversarialReview> {
    const [skeptic, devil] = await Promise.all([
      ask(`You are a skeptical reviewer. Find factual errors, gaps and unsupported claims in this draft answer to "${context}". Reply as JSON {"points": ["…"]}, or {"points": []} if there are none.\n\nDraft:\n${response}`),
      ask(`You are a devil's advocate. Argue against this draft answer to "${context}": what would someone who disagrees say, what's missing, what could go wrong? Reply as JSON {"points": ["…"]}, or {"points": []} if there's nothing.\n\nDraft:\n${response}`),
    ]);
    const issues = pointsOf(skeptic);
    const concerns = pointsOf(devil);
    const synthesis = issues.length || concerns.length
      ? await ask(`Write the final answer to "${context}". Start from the draft and fix or address these points; say so where a point can't be resolved.\n\nDraft:\n${response}\n\nReviewer issues:\n${issues.map((point) => `- ${point}`).join("\n") || "- none"}\n\nCounter-arguments:\n${concerns.map((point) => `- ${point}`).join("\n") || "- none"}`)
      : response;
    // Confidence falls with each unresolved point the reviewers raised.
    const confidence = Math.max(0.3, Math.min(0.95, 0.95 - issues.length * 0.1 - concerns.length * 0.05));
    const review: AdversarialReview = {
      id: crypto.randomUUID(),
      originalResponse: response,
      skepticFeedback: issues.length ? issues.join("; ") : "No issues found.",
      devilAdvocateFeedback: concerns.length ? concerns.join("; ") : "No concerns.",
      synthesis,
      confidence: Math.round(confidence * 100) / 100,
      approved: confidence >= 0.7,
      createdAt: new Date().toISOString(),
    };
    const reviews = readReviews();
    reviews.push(review);
    writeReviews(reviews);
    return review;
  },

  getReviews(): AdversarialReview[] {
    return readReviews();
  },
};
