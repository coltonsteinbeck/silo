# Planning-First Workflow

Use this workflow for ambiguous, risky, multi-file, architectural, safety, or production-readiness work.

## Context Loading

1. Restate the goal and risk level.
2. Read `AGENTS.md`.
3. Search with targeted `rg` or `rg --files`.
4. Read only the files needed to understand the path.
5. Broaden to tests, docs, migrations, or git history when the first pass exposes uncertainty.

## Plan Shape

A useful plan includes:

- Goal and non-goals.
- Current-state findings grounded in file paths.
- Proposed phases with verification gates.
- Risks and rollback strategy.
- Acceptance criteria.

## Fast Path

Skip the full planning artifact for tiny one-file fixes, mechanical formatting, or obvious test updates. Still run the relevant verification command.
