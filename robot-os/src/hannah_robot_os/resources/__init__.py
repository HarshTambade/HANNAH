"""Edge Resource Manager: real resource metrics, workload classes, warnings and recovery policies."""
from .manager import EdgeResourceManager, manager_from_config
from .metrics import NOT_MEASURABLE, SCHEMA, InferenceLatencyTracker, ResourceProbe
from .policy import PolicyConfig, Thresholds, check_action, decide, evaluate
from .workloads import DEFAULT_SPECS, WorkloadClass, generate_units, validate_specs

__all__ = [
    "DEFAULT_SPECS", "EdgeResourceManager", "InferenceLatencyTracker", "NOT_MEASURABLE", "PolicyConfig", "ResourceProbe", "SCHEMA",
    "Thresholds", "WorkloadClass", "check_action", "decide", "evaluate", "generate_units", "manager_from_config", "validate_specs",
]
