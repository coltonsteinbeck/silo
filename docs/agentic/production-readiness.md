# Production Readiness Review

Use this checklist when making the repo production-grade.

## Required Checks

- No checked-in logs, local CSV exports, secrets, or data dumps.
- `bun test`, `bun run type-check`, `bun run lint`, and `git diff --check` pass.
- Production entrypoint and Dockerfile are aligned.
- Healthcheck endpoint works in the target deployment mode.
- Migrations have a status or dry-run path before deployment.
- Langfuse metadata is useful, redacted, and consistent across graph and non-graph paths.
- Graph feature flags and budgets are explicit in `.env.example` and docs.

## Review Focus

- Runtime startup and shutdown.
- Discord reply safety and mention handling.
- Provider fallback behavior.
- Database migration compatibility.
- Alert noise policy.
- Long-running voice or media tasks.
- User-facing refusal consistency.
