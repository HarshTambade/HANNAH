export type AutonomyTier = 1 | 2 | 3;

export type RailEnforcementResult = {
  allowed: boolean;
  tier: AutonomyTier;
  reason: string;
  evidence: string[]; // traceable evidence for audit
};

export type RailRule = {
  id: string;
  name: string;
  description: string;
  tier: AutonomyTier;
  appliesTo: string[]; // tool names or agent IDs
  condition: (context: { tool: string; args: unknown; agentId?: string }) => boolean;
  action: "allow" | "require_approval" | "deny";
};

export type RailAuditEntry = {
  id: string;
  railId: string;
  context: { tool: string; args: unknown; agentId?: string };
  result: RailEnforcementResult;
  at: number;
};

const KEY = "hannah.typedrails.v1";

function readAudit(): RailAuditEntry[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAudit(entries: RailAuditEntry[]) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(entries.slice(-1000)));
  } catch {
    // Best effort.
  }
}

export const TypedRails = {
  rules: [] as RailRule[],

  defaultTier: 2 as AutonomyTier,

  addRule(rule: RailRule) {
    this.rules.push(rule);
  },

  removeRule(id: string) {
    this.rules = this.rules.filter((r) => r.id !== id);
  },

  getTier(tool: string): AutonomyTier {
    const rule = this.rules.find((r) => r.appliesTo.includes(tool));
    return rule ? rule.tier : this.defaultTier;
  },

  enforce(context: { tool: string; args: unknown; agentId?: string }): RailEnforcementResult {
    const evidence: string[] = [];
    const matchingRules = this.rules.filter((r) => r.condition(context));

    let tier = this.defaultTier;
    let allowed = true;
    let reason = "allowed by default";
    if (matchingRules.length === 0) {
      evidence.push(`no specific rail rule for tool ${context.tool}; default tier ${tier}`);
    } else {
      for (const rule of matchingRules) {
        tier = rule.tier;
        evidence.push(`rail ${rule.id} (${rule.name}) matched; tier ${tier}, action ${rule.action}`);
        if (rule.action === "deny") {
          allowed = false;
          reason = `denied by rail ${rule.name}`;
          break;
        } else if (rule.action === "require_approval") {
          allowed = false;
          reason = `requires HITL approval via rail ${rule.name}`;
          // don't break; a later deny could override
        } else {
          reason = `allowed by rail ${rule.name}`;
        }
      }
    }

    const result: RailEnforcementResult = { allowed, tier, reason, evidence };

    const entry: RailAuditEntry = {
      id: crypto.randomUUID(),
      railId: matchingRules.map((r) => r.id).join(",") || "default",
      context,
      result,
      at: Date.now(),
    };

    const audit = readAudit();
    audit.push(entry);
    writeAudit(audit);

    return result;
  },

  getAudit(): RailAuditEntry[] {
    return readAudit();
  },

  metrics() {
    const audit = readAudit();
    const total = audit.length;
    if (total === 0) return { total, blocked: 0, approvalRequired: 0, allowed: 0, falsePositiveRate: 0 };

    const blocked = audit.filter((e) => !e.result.allowed).length;
    const approvalRequired = audit.filter((e) => e.result.tier === 2).length;
    const allowed = audit.filter((e) => e.result.allowed).length;

    return {
      total,
      blocked,
      approvalRequired,
      allowed,
      blockRate: Math.round((blocked / total) * 100),
      approvalRate: Math.round((approvalRequired / total) * 100),
    };
  },
};