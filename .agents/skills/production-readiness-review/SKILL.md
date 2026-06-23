# Production Readiness Review

Use this skill when auditing Silo for deployment quality, dead code, legacy paths, CI gaps, or operational hardening.

## Checklist

- Repo hygiene: no logs, dumps, secrets, or local exports.
- Runtime: startup, shutdown, process lock, sharding, Docker, and healthcheck.
- Config: required production envs, feature flags, and fail-closed validation.
- Safety: input/output guardrails, mention safety, refusal consistency, and regression fixtures.
- Graph: bounded recursion, one tool round unless explicitly changed, unsupported-tool determinism.
- Observability: Langfuse trace shape, redaction, user hashing, and shutdown flush.
- Data: migration status, rollback notes, and refresh scripts.
- CI: build, test, lint, type-check, Docker, migrations, and artifact hygiene.

## Rule

Do not delete code based only on appearance. Prove it is unreachable or superseded.
