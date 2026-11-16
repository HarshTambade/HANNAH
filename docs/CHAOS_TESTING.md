# Phase 25 chaos checks

Chaos injection is compiled into development and test builds only. The developer settings toggle enables a 10% chance per eligible request; tests can arm a single named fault for deterministic checks. It never skips tool approvals and it never enables itself in production.

| Injected failure | Trigger | Expected fallback |
| --- | --- | --- |
| Network drop | Before a cloud agent request | The cloud request fails immediately, AgentRuntime switches to WebLLM/on-device inference, the turn completes, and the UI reports degraded mode until cloud succeeds or the banner is dismissed. |
| Tool timeout | Before an allow-listed tool executes | No tool side effect occurs; a timeout result is returned to the agent. The circuit breaker records failures and opens after three failures for that tool in the session. |
| Corrupted memory | During memory resolution | MemoryResolutionService returns `abstained`; the caller must continue without retrieved memory. |
| HITL denial | Before tool execution | The tool is not run; AgentRuntime returns a calm cancellation response and stops the multi-step turn. |

Run `npm run test:chaos --prefix client` for deterministic AgentRuntime fallback, timeout, memory-abstention, and approval-denial checks. The tests stub the provider and tools; run a separate staging drill before enabling real infrastructure fault injection.

## Local personalization dataset

`Train My HANNAH` waits for the readiness service to report an idle window, runs `DreamingConsolidator`, and exports only liked, accepted, or edited examples. It prepares training data; it does not update model weights in the browser. To validate/prepare that export:

```sh
python backend/on_device_lora.py --input hannah-personalization.jsonl --output hannah-lora-data.jsonl
```

Optional adapter training requires locally installed `torch`, `transformers`, and `peft`, plus a local Hugging Face source checkpoint:

```sh
python backend/on_device_lora.py --input hannah-personalization.jsonl --train --base-model ./local-source-checkpoint --adapter-output ./hannah-lora-adapter
```

GGUF is an inference format and cannot be fine-tuned directly by PEFT. Convert or merge a trained adapter into a compatible runtime artifact as a separate, model-specific packaging step. The schema saved by the visual builder is currently a pending Task Spine record; this repository does not provide a background workflow executor yet.
