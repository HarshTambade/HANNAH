# Good First Issues for HANNAH

HANNAH welcomes focused, well-scoped contributions. These areas are designed to be approachable without changing core AI behavior.

## Good first issue areas
- Add a new voice language: implement a speech recognition/playback path and update the `SpeechLanguage` type.
- Add a provider adapter: implement an OpenAI-compatible provider preset in `server/providers/catalog.js`.
- Add a tool module: implement a new device tool in `client/src/services/DeviceTools.ts` with confirmation and tests.
- Improve localization: add or refine permission strings and UI copy.
- Add red-team cases: append adversarial prompts to `redteam/attacks.yaml`.
- Improve docs: clarify setup, API usage, or troubleshooting.

## Contribution guidelines
- Keep changes small and testable.
- Do not add core AI features without discussion.
- Add or update tests for behavior changes.
- Preserve the privacy rule: logs describe operations, never conversations.
- Use the existing confirmation flow for sensitive actions.

## Suggested labels
- `good first issue`
- `help wanted`
- `documentation`
- `localization`
- `provider`
- `tooling`
