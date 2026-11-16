import { TaskPlanner, type TaskDAG } from "./TaskPlanner";
import { GuardianAgent } from "./GuardianAgent";

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

export const AgentOrchestrator = {
  // Execute a full orchestration with adversarial review
  async orchestrate(intent: string): Promise<OrchestrationResult> {
    const start = Date.now();
    const dag = await TaskPlanner.plan(intent);
    dag.status = "executing";

    // Execute subtasks in dependency order
    const completed = new Set<string>();
    const results: Map<string, unknown> = new Map();

    while (completed.size < dag.nodes.length) {
      const ready = dag.nodes.filter(
        (n) => !completed.has(n.id) && n.dependencies.every((d) => completed.has(d)),
      );
      if (ready.length === 0) break; // deadlock or all done

      for (const node of ready) {
        node.status = "running";
        // Epistemic routing: check confidence
        const confidence = TaskPlanner.estimateConfidence(node, intent);
        node.confidence = confidence;

        const needsResearch = TaskPlanner.needsExternalResearch(confidence, 0.7);

        // GuardianAgent gate
        const guard = GuardianAgent.evaluate({
          tool: "agent_delegation",
          args: { agentType: node.agentType, description: node.description },
          intent: "delegation",
        });

        if (!guard.allowed) {
          node.status = "failed";
          node.result = { error: `Blocked by GuardianAgent: ${guard.reason}` };
          completed.add(node.id);
          continue;
        }

        // Simulate execution (in production, this would call the actual agent)
        await new Promise((resolve) => setTimeout(resolve, 50));
        node.result = {
          agentType: node.agentType,
          description: node.description,
          confidence,
          needsExternalResearch: needsResearch,
          epistemicRouting: needsResearch ? "external_research" : "local_handling",
        };
        node.status = "completed";
        completed.add(node.id);
        results.set(node.id, node.result);
      }
    }

    dag.status = "completed";

    // Three-Way Adversarial Review for the final output
    const originalResponse = dag.nodes.map((n) => `${n.agentType}: ${n.description}`).join("\n");
    const review = await this.adversarialReview(originalResponse, intent);

    return {
      intent,
      dag,
      reviews: [review],
      finalResponse: review.synthesis,
      totalDurationMs: Date.now() - start,
    };
  },

  async adversarialReview(response: string, context: string): Promise<AdversarialReview> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    // Skeptic agent: checks for flaws
    const skepticFeedback = this.skepticReview(response);

    // Devil's Advocate: argues against
    const devilAdvocateFeedback = this.devilAdvocateReview(response);

    // Synthesis: produces final validated response
    const synthesis = this.synthesize(response, skepticFeedback, devilAdvocateFeedback);

    const confidence = Math.min(
      0.95,
      0.7 + (skepticFeedback.includes("no issues") ? 0.15 : 0) + (devilAdvocateFeedback.includes("no concerns") ? 0.1 : 0),
    );

    const review: AdversarialReview = {
      id,
      originalResponse: response,
      skepticFeedback,
      devilAdvocateFeedback,
      synthesis,
      confidence: Math.round(confidence * 100) / 100,
      approved: confidence >= 0.7,
      createdAt: now,
    };

    const reviews = readReviews();
    reviews.push(review);
    writeReviews(reviews);

    return review;
  },

  skepticReview(response: string): string {
    const issues: string[] = [];
    if (response.length < 20) issues.push("response too short");
    if (!response.includes("completed")) issues.push("no completion indicator");
    if (response.includes("failed")) issues.push("contains failure indicators");
    if (issues.length === 0) return "no issues found - response appears well-formed";
    return `potential issues: ${issues.join(", ")}`;
  },

  devilAdvocateReview(response: string): string {
    const concerns: string[] = [];
    if (response.includes("general")) concerns.push("general-purpose agent may lack specialization");
    if (response.length > 500) concerns.push("response may be overly verbose");
    if (concerns.length === 0) return "no concerns - response is focused and appropriate";
    return `concerns: ${concerns.join(", ")}`;
  },

  synthesize(response: string, skeptic: string, devilAdvocate: string): string {
    const hasIssues = !skeptic.includes("no issues");
    const hasConcerns = !devilAdvocate.includes("no concerns");
    if (hasIssues || hasConcerns) {
      return `${response}\n\n[Adversarial review noted: ${hasIssues ? skeptic : ""} ${hasConcerns ? devilAdvocate : ""}]`;
    }
    return response;
  },

  getReviews(): AdversarialReview[] {
    return readReviews();
  },
};