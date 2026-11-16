import { useState, useEffect } from "react";
import { MemoryService } from "../services/MemoryService";
import { TaskSpineService } from "../services/TaskSpineService";
import { SideEffectLedger } from "../services/SideEffectLedger";
import { TokenBudgetService } from "../services/TokenBudgetService";
import { InterventionTimingEngine } from "../services/InterventionTimingEngine";
import { EdgeTuneService } from "../services/EdgeTuneService";
import { PersonalKnowledgeGraph } from "../services/PersonalKnowledgeGraph";

export interface DashboardMetrics {
  memory: {
    total: number;
    episodic: number;
    persona: number;
    longTerm: number;
    utilizationPct: number;
  };
  tasks: {
    total: number;
    completed: number;
    pending: number;
    failed: number;
    successRate: number;
  };
  tokens: {
    spent: number;
    cap: number;
    utilizationPct: number;
    savedEstimate: number;
  };
  sideEffects: {
    pending: number;
    executed: number;
    undone: number;
  };
  interventions: {
    total: number;
    interveneRate: number;
    theta: number;
  };
  personalization: {
    version: number;
    dataPoints: number;
    gain: number;
    paused: boolean;
  };
  knowledgeGraph: {
    entities: number;
    relationships: number;
  };
}

function computeMetrics(): DashboardMetrics {
  const episodic = MemoryService.list("session").length;
  const persona = MemoryService.list("persona").length;
  const longTerm = MemoryService.list("long_term").length;
  const totalMemory = episodic + persona + longTerm;
  const memoryUtilizationPct = totalMemory > 0 ? Math.round(((persona + longTerm) / totalMemory) * 100) : 0;

  const tasks = TaskSpineService.list();
  const completed = tasks.filter((t) => t.status === "completed").length;
  const pending = tasks.filter((t) => t.status === "pending" || t.status === "running").length;
  const failed = tasks.filter((t) => t.status === "failed").length;
  const successRate = tasks.length > 0 ? Math.round((completed / tasks.length) * 100) : 100;

  const tokenStatus = TokenBudgetService.status();
  const tokenUtilizationPct = tokenStatus.cap > 0 ? Math.round((tokenStatus.spent / tokenStatus.cap) * 100) : 0;
  const savedEstimate = Math.round(((tokenUtilizationPct - 30) / 100) * 40);

  const sideEffects = SideEffectLedger.list();
  const pendingSE = sideEffects.filter((s) => s.status === "pending").length;
  const executedSE = sideEffects.filter((s) => s.status === "executed").length;
  const undoneSE = sideEffects.filter((s) => s.status === "undone").length;

  const interventions = InterventionTimingEngine.getMetrics();
  const health = EdgeTuneService.getHealth();
  const entities = PersonalKnowledgeGraph.getEntities();
  const relationships = PersonalKnowledgeGraph.getRelationships();

  return {
    memory: {
      total: totalMemory,
      episodic,
      persona,
      longTerm,
      utilizationPct: memoryUtilizationPct,
    },
    tasks: {
      total: tasks.length,
      completed,
      pending,
      failed,
      successRate,
    },
    tokens: {
      spent: tokenStatus.spent,
      cap: tokenStatus.cap,
      utilizationPct: tokenUtilizationPct,
      savedEstimate,
    },
    sideEffects: {
      pending: pendingSE,
      executed: executedSE,
      undone: undoneSE,
    },
    interventions: {
      total: interventions.total,
      interveneRate: interventions.interveneRate,
      theta: interventions.theta,
    },
    personalization: {
      version: health.currentVersion,
      dataPoints: health.totalDataPoints,
      gain: health.estimatedGain,
      paused: health.paused,
    },
    knowledgeGraph: {
      entities: entities.length,
      relationships: relationships.length,
    },
  };
}

export function useDashboardMetrics(refreshInterval = 3000): DashboardMetrics {
  const [metrics, setMetrics] = useState<DashboardMetrics>(computeMetrics);

  useEffect(() => {
    const refresh = () => setMetrics(computeMetrics());
    const timer = window.setInterval(refresh, refreshInterval);
    return () => window.clearInterval(timer);
  }, [refreshInterval]);

  return metrics;
}

export { computeMetrics };
