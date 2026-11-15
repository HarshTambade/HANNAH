"use strict";

const TASK_TIERS = {
  emotional_chat: { tier: "low-cost cloud", maxTokens: 900, downgradeTo: "local" },
  code_generation: { tier: "high-capability cloud", maxTokens: 1400, downgradeTo: "low-cost cloud" },
  system_operation: { tier: "low-cost cloud", maxTokens: 700, downgradeTo: "local" },
  web_browsing: { tier: "low-cost cloud", maxTokens: 1000, downgradeTo: "local" },
};

const BUDGET_CAPS = {
  "local": 0.001,
  "low-cost cloud": 0.01,
  "high-capability cloud": 0.05,
};

function routeTask(taskType, estimatedCostUsd = 0) {
  const config = TASK_TIERS[taskType] || TASK_TIERS.emotional_chat;
  let tier = config.tier;
  let downgraded = false;
  if (estimatedCostUsd > BUDGET_CAPS[tier]) {
    tier = config.downgradeTo;
    downgraded = true;
  }
  return {
    taskType,
    tier,
    maxTokens: config.maxTokens,
    downgraded,
    budgetCapUsd: BUDGET_CAPS[tier],
  };
}

module.exports = { TASK_TIERS, BUDGET_CAPS, routeTask };
