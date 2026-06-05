# Silo Agent Contract

This repository is a Bun/TypeScript monorepo for a multi-provider Discord AI bot. Use this file as the canonical instruction source for Codex and GitHub Copilot work in this repo.

## Operating Mode

- Use planning-first for non-trivial work: architecture, safety, graph/tooling, provider behavior, migrations, production readiness, multi-file refactors, and debugging.
- Use the fast path only for trivial edits: typo fixes, obvious one-file changes, formatting, or small test updates.
- Load context progressively: user request, this file, targeted `rg`, relevant code/tests/docs, then broader history only when needed.
- Keep delegation shallow. Specialist agents are for focused review, not broad parallel churn.
- Do not hardcode personal model preferences or unsupported model names in repo-level files. Keep model guidance generic.

## High-Risk Surfaces

- `packages/bot/src/index.ts`: Discord runtime wiring, message flow, graph selection, moderation, quota, persistence, and reply delivery.
- `packages/bot/src/agent/`: bounded graph orchestration, intent routing, tool budgets, and graph trace shape.
- `packages/bot/src/security/`: prompt safety, content sanitization, guardrails, guild limits, safety monitor, and system-prompt policy.
- `packages/bot/src/providers/`: provider adapters for text, vision, image, video, web search, and embeddings.
- `packages/bot/src/telemetry/`: Langfuse trace metadata, redaction, and observation wrappers.
- `packages/core/src/config/`: environment parsing and production configuration validation.
- `supabase/migrations/` and `scripts/`: database migrations, refresh scripts, and production operations.

## Production Standards

- Preserve bounded graph behavior: no autonomous loops, explicit recursion/tool budgets, deterministic unsupported-tool results.
- Preserve Langfuse as the single tracing surface. Do not add parallel tracing stacks.
- Preserve Discord safety: bot-generated output must neutralize `@everyone` and `@here`, and AI replies should disable mention parsing.
- Treat assistant output as stricter than chat input. Unsafe generated personas, explicit sexual continuation, sexualized violence, hate, and harassment should be blocked before delivery and persistence.
- Avoid raw `console.log` in production code; use the repo logger with structured context.
- Do not commit local exports, logs, secrets, `.env`, or production data snapshots.
- Keep slash commands compatible while graph-owned natural-language routing matures behind flags.

## Verification

Run the smallest relevant test first, then broaden based on risk.

Common gates:

```bash
bun test
bun run type-check
bun run lint
git diff --check
```

For production readiness or cleanup work, also consider:

```bash
bun run build
bash scripts/migrate.sh --status
docker build -t silo-bot .
```

## Change Discipline

- Keep unrelated cleanup out of feature/fix diffs.
- Do not revert user changes unless explicitly asked.
- Before deleting code, prove it is unused or superseded through imports, tests, runtime references, and docs.
- Prefer small, reviewable cleanup phases: artifacts, logging, dead paths, extraction, CI hardening, then production rollout docs.
