---
name: langfuse
description: Work with Langfuse for tracing, documentation lookup, prompt migration, error analysis, and feedback instrumentation. Use when adding or auditing Langfuse observability, querying Langfuse resources, or applying Langfuse best practices in code.
---

# Langfuse

This skill packages the Langfuse workflows that matter in this workspace: tracing, prompt migration, error analysis, user feedback, and CLI-driven inspection.

## Core Principles

1. Check current Langfuse docs before changing code. Langfuse moves quickly, and old snippets age badly.
2. Prefer Langfuse integrations when the stack supports them. Manual spans are for cases without a good integration.
3. Use `propagateAttributes` early for `userId`, `sessionId`, tags, and other correlating metadata.
4. Mask or omit sensitive data. Trace useful summaries, not secrets, auth headers, or raw private context.
5. Use descriptive trace and observation names. Generic names make the UI hard to use.

## Reference Guide

- Observability setup and audits: `references/instrumentation.md`
- CLI usage and discovery: `references/cli.md`
- SDK migration notes: `references/sdk-upgrade.md`
- User feedback as scores: `references/user-feedback.md`
- Systematic trace review: `references/error-analysis.md`
- Prompt externalization: `references/prompt-migration.md`
- Feedback on this skill: `references/skill-feedback.md`

## Langfuse CLI

Use the Langfuse CLI when you need to inspect or modify Langfuse resources from the shell.

Credential expectations:

```bash
export LANGFUSE_PUBLIC_KEY=pk-lf-...
export LANGFUSE_SECRET_KEY=sk-lf-...
export LANGFUSE_HOST=https://cloud.langfuse.com
```

Basic discovery flow:

```bash
npx langfuse-cli api __schema
npx langfuse-cli api <resource> --help
npx langfuse-cli api <resource> <action> --help
```

## Documentation Workflow

Preferred order when looking up Langfuse guidance:

1. `https://langfuse.com/llms.txt` to find the relevant docs section.
2. Fetch the specific docs page as markdown.
3. Use docs search when the target page is unclear.

Useful patterns:

```bash
curl -s https://langfuse.com/llms.txt
curl -s "https://langfuse.com/docs/observability/overview.md"
curl -s "https://langfuse.com/api/search-docs?query=langfuse+sessions"
```

## Notes

- For long-running apps, prefer batched export and graceful shutdown.
- For short-lived scripts or serverless handlers, flush before exit.
- When traces are live, inspect a few in the UI before deciding what more context to add.
- In this repo, prefer the typed app/runtime fields (`APP_NAME`, `APP_ENV`, `HOST_NAME`, `PROMPT_VERSION`) over ad hoc environment reads in handlers.
- In this repo, do not send raw Discord user IDs to Langfuse. Use the hashed-user helper backed by `LANGFUSE_USER_HASH_SALT`.
- In this repo, keep `PROMPT_VERSION` distinct from runtime `promptHash` and `customPromptHash`; both are needed for prompt lineage and regressions caused by user prompt changes.
