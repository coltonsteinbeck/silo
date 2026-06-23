# Planning Mode Orchestrator

Use this skill for non-trivial Silo work: production readiness, graph/tooling, guardrails, provider behavior, migrations, multi-file refactors, and debugging.

## Workflow

1. Read `AGENTS.md`.
2. Identify the high-risk surface.
3. Load context progressively with `rg`.
4. Produce a phased plan before editing unless the user explicitly asks for immediate implementation.
5. Define verification commands for each phase.
6. Keep implementation and cleanup diffs separate when possible.

## Output

Include current findings, phased work, risks, verification, and open decisions.
