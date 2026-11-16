# HANNAH Cost Dashboard Template

## Cost per completed interaction
Cost per completed interaction = total estimated USD cost / number of completed user-visible interactions.

A completed interaction is one user turn that produced a non-empty assistant reply and did not end in an error.

## Inputs
- `logs/token_usage.jsonl`: per-request token counts and estimated cost.
- `logs/llm_traces.jsonl`: latency, fallbacks, retries.
- Client events: `first_message_sent`, `third_message_sent`, `session_duration`.

## Required calculations
1. Sum `estimatedCostUsd` by model and by day.
2. Count completed interactions from successful `/api/chat` and `/api/agent` responses.
3. Divide total cost by completed interactions.
4. Track cost per active user: total cost / distinct hashed user IDs.
5. Track fallback rate: fallback requests / total requests.

## Automatic downgrade threshold
Trigger an automatic model downgrade when any of the following is true for 24 hours:
- Cost per completed interaction exceeds $0.03.
- Fallback rate exceeds 20%.
- p95 latency exceeds 20 seconds.
- Daily estimated cost exceeds the configured budget.

## Downgrade actions
- Route `emotional_chat` and `system_operation` to local or low-cost cloud.
- Disable high-capability cloud for non-essential turns.
- Reduce tool schema size and prompt length.
- Re-evaluate after 24 hours or on the next release.
