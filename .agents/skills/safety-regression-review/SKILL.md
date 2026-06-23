# Safety Regression Review

Use this skill when changing prompts, guardrails, graph output safety, Discord reply delivery, media generation, web search, or memory/context handling.

## Required Coverage

- Unsafe assistant output blocked before Discord delivery and persistence.
- User input that is passable today remains passable unless product policy changes.
- Safe refusals and benign medical/educational context are allowed.
- Mass mentions are neutralized in generated output and stored assistant/reference context.
- Graph traces include safety state and outcome metadata.
- Media and web-search tools fail closed when unsupported.

## Suggested Commands

```bash
bun test packages/bot/src/__tests__/security
bun test packages/bot/src/__tests__/agent
bun test
bun run type-check
bun run lint
```
