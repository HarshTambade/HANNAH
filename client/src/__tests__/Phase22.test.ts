import { describe, expect, it, beforeEach, vi } from "vitest";
import { EvidenceGroundingEvaluator } from "../services/EvidenceGroundingEvaluator";
import { JudgmentCalibrationHarness } from "../services/JudgmentCalibrationHarness";
import { PhysicalVerificationGate } from "../services/PhysicalVerificationGate";
import { AAIFService } from "../services/AAIFService";
import { AAIFRegistry } from "../services/AAIFRegistry";
import { AAIFStateCheckpointService } from "../services/AAIFStateCheckpoint";
import { MemoryRouter } from "../services/MemoryRouter";
import { TypedRails } from "../services/TypedRails";
import { HardwarePartnershipRegistry } from "../services/HardwarePartnershipRegistry";

describe("Phase 22 services", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
        removeItem: (k: string) => store.delete(k),
        clear: () => store.clear(),
      },
      crypto: { randomUUID: () => `test-uuid-${Math.random().toString(36).slice(2)}` },
    });
    window.localStorage.clear();
  });

  describe("EvidenceGroundingEvaluator", () => {
    it("creates and assesses an evidence trace", () => {
      const trace = EvidenceGroundingEvaluator.createTrace(
        "The meeting is at 3pm",
        [{ id: "s1", title: "Calendar", type: "api", confidence: 0.9, retrievedAt: new Date().toISOString() }],
        0.9,
      );
      expect(trace.id).toBeDefined();
      expect(trace.confidence).toBe(0.9);

      const assessment = EvidenceGroundingEvaluator.assessConclusion(trace.id, "The meeting is at 3pm");
      expect(assessment.evidenceSupported).toBe(true);
      expect(assessment.groundingScore).toBeGreaterThan(0.5);
    });

    it("rejects unsupported conclusions", () => {
      const assessment = EvidenceGroundingEvaluator.assessConclusion("nonexistent", "some claim");
      expect(assessment.evidenceSupported).toBe(false);
      expect(assessment.recommendation).toBe("reject");
    });
  });

  describe("JudgmentCalibrationHarness", () => {
    it("evaluates alignment with expert answers", () => {
      JudgmentCalibrationHarness.addCase({
        id: "case-1",
        claim: "The capital of France is Paris.",
        expertAnswer: "Paris",
        confidence: 0.9,
        domain: "general",
        requiresDataAccess: false,
      });

      const result = JudgmentCalibrationHarness.evaluate("case-1", "The capital is Paris.", 0.9, false);
      expect(result.aligned).toBe(true);
      expect(result.agentConfidence).toBe(0.9);
    });

    it("calculates calibration metrics", () => {
      const metrics = JudgmentCalibrationHarness.calibrationMetrics();
      expect(metrics.total).toBeGreaterThanOrEqual(0);
      expect(metrics.alignmentRate).toBeGreaterThanOrEqual(0);
    });
  });

  describe("PhysicalVerificationGate", () => {
    it("proposes and approves verification", () => {
      PhysicalVerificationGate.registerMethod({
        id: "method-1",
        name: "API Check",
        description: "Check via API",
        type: "api_call",
        estimatedLatencyMs: 500,
      });

      const request = PhysicalVerificationGate.proposeVerification("Check shipment status", "method-1");
      expect(request.status).toBe("pending");
      expect(request.userApproved).toBe(false);

      const approved = PhysicalVerificationGate.approve(request.id);
      expect(approved.status).toBe("approved");
      expect(approved.userApproved).toBe(true);
    });

    it("detects real-world tasks requiring verification", () => {
      expect(PhysicalVerificationGate.requiresVerification("Check my shipment")).toBe(true);
      expect(PhysicalVerificationGate.requiresVerification("What is the weather?")).toBe(false);
    });
  });

  describe("AAIFService", () => {
    it("generates and validates a default document", () => {
      const doc = AAIFService.generateDefaultDocument("Test Agent");
      const { valid, errors } = AAIFService.validate(doc);
      expect(valid).toBe(true);
      expect(errors).toHaveLength(0);
      expect(doc.name).toBe("Test Agent");
    });

    it("serializes and deserializes correctly", () => {
      const doc = AAIFService.generateDefaultDocument("Roundtrip");
      const json = AAIFService.serialize(doc);
      const parsed = AAIFService.deserialize(json);
      expect(parsed).not.toBeNull();
      expect(parsed?.name).toBe("Roundtrip");
    });

    it("rejects invalid documents", () => {
      const parsed = AAIFService.deserialize("{}");
      expect(parsed).toBeNull();
    });
  });

  describe("AAIFRegistry", () => {
    it("registers, retrieves, and versions documents", () => {
      const doc = AAIFService.generateDefaultDocument("Registry Test");
      const registered = AAIFRegistry.register(doc, ["initial"]);
      expect(registered.id).toBe(doc.id);

      const retrieved = AAIFRegistry.get(registered.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.name).toBe("Registry Test");

      const versions = AAIFRegistry.versions(registered.id);
      expect(versions.length).toBe(1);
      expect(versions[0].version).toBe(1);
    });

    it("lists all documents", () => {
      const docs = AAIFRegistry.list();
      const initialCount = docs.length;
      AAIFRegistry.register(AAIFService.generateDefaultDocument("Extra"));
      expect(AAIFRegistry.list().length).toBe(initialCount + 1);
    });
  });

  describe("AAIFStateCheckpoint", () => {
    it("creates and serializes a checkpoint", () => {
      const checkpoint = AAIFStateCheckpointService.createCheckpoint(
        "agent-1",
        "aaif-1",
        { messages: [{ role: "user", content: "hello" }], currentTask: "task-1" },
        [{ id: "t1", title: "Task", status: "pending", progress: 0 }],
        { sessionIds: [], longTermIds: [], personaIds: [] },
        { strictness: "balanced", activeTools: [], pendingApprovals: 0 },
      );
      expect(checkpoint.agentId).toBe("agent-1");
      expect(checkpoint.conversationState.messages.length).toBe(1);

      const json = AAIFStateCheckpointService.serialize(checkpoint);
      const parsed = AAIFStateCheckpointService.deserialize(json);
      expect(parsed).not.toBeNull();
      expect(parsed?.agentId).toBe("agent-1");
    });
  });

  describe("MemoryRouter", () => {
    it("classifies and routes queries", async () => {
      const decision = MemoryRouter.classify("What is the capital of France?");
      expect(decision.queryType).toBe("factual");
      expect(decision.path).toBe("vector");

      const result = await MemoryRouter.route("What is the capital of France?");
      expect(result.routingDecision.queryType).toBe("factual");
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("provides routing metrics", () => {
      const metrics = MemoryRouter.metrics();
      expect(metrics.total).toBeGreaterThanOrEqual(0);
    });
  });

  describe("TypedRails", () => {
    it("enforces tool allow-list rules", () => {
      TypedRails.addRule({
        id: "rail-1",
        name: "Block shell",
        description: "Block shell tool",
        tier: 3,
        appliesTo: ["execute_shell"],
        condition: (ctx) => ctx.tool === "execute_shell",
        action: "deny",
      });

      const result = TypedRails.enforce({ tool: "execute_shell", args: {} });
      expect(result.allowed).toBe(false);
      expect(result.tier).toBe(3);

      const allowed = TypedRails.enforce({ tool: "read_file", args: {} });
      expect(allowed.allowed).toBe(true);
    });

    it("tracks enforcement metrics", () => {
      const metrics = TypedRails.metrics();
      expect(metrics.total).toBeGreaterThanOrEqual(0);
    });
  });

  describe("HardwarePartnershipRegistry", () => {
    it("lists partnered devices", () => {
      const devices = HardwarePartnershipRegistry.list();
      expect(devices.length).toBeGreaterThan(0);
      expect(devices[0].adapter).toBeDefined();
    });

    it("finds devices by modality", () => {
      const audioDevices = HardwarePartnershipRegistry.findByModality("audio");
      expect(audioDevices.length).toBeGreaterThan(0);
    });
  });
});
