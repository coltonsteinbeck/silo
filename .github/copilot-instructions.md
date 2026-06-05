# GitHub Copilot Instructions For Silo

Use `AGENTS.md` as the canonical repo contract. Keep suggestions consistent with the Bun/TypeScript monorepo, Discord bot runtime, bounded graph architecture, and production safety requirements.

## Defaults

- Prefer planning-first for multi-file, safety, production, graph/tooling, provider, or migration work.
- Keep implementation diffs narrow and test-backed.
- Do not hardcode personal model preferences in repo files.
- Do not introduce autonomous agent loops.
- Preserve Langfuse as the single tracing surface.
- Preserve Discord mention safety and assistant-output guardrails.

## Verification

Suggest focused tests first, then broader gates:

```bash
bun test
bun run type-check
bun run lint
git diff --check
```
