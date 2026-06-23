---
name: langfuse-observability
description: Instrument and audit Langfuse tracing in JS/TS and other LLM applications.
---

# Langfuse Observability

Use this guide when adding new tracing or reviewing an existing Langfuse setup.

## Workflow

1. Assess the current stack.
2. Prefer a first-party integration when one exists.
3. Verify baseline trace quality.
4. Add only the extra context that provides real debugging value.
5. Point the user to the relevant UI views once traces are live.

## Baseline Requirements

Every traced request should capture:

- Model name
- Token usage
- Descriptive trace and span names
- Nested observations for meaningful steps
- Correct observation types, especially `generation`
- Masked or omitted sensitive data
- Explicitly set input/output summaries rather than accidental full argument dumps

## Additional Context To Consider

Infer these from the application where possible:

- `sessionId` for conversations or multi-turn threads
- `userId` when the app is user-aware
- tags for features, customer tiers, or deployment modes
- feedback scores when the application already captures user reactions

Only add extra attributes when they help filtering, debugging, or reporting.

For this workspace specifically:

- Use typed app/runtime metadata (`app`, `environment`, `host`, `release`, `promptVersion`) rather than scattered ad hoc strings.
- Keep Discord guild/channel/message/interaction IDs in metadata, not tags.
- Hash Discord user IDs before sending them to Langfuse.
- Keep `PROMPT_VERSION` separate from runtime prompt hashes so user prompt edits and deployment prompt changes can be distinguished.

## Framework Preference

Prefer official integrations over manual spans when possible.

- OpenAI SDK
- LangChain
- LlamaIndex
- Vercel AI SDK
- LiteLLM

Docs hub: `https://langfuse.com/docs/integrations`

## Common Mistakes

- Flat traces with no step hierarchy
- Generic names like `trace-1`
- Logging raw secrets, auth headers, or private context
- Setting correlating attributes outside the `propagateAttributes` callback
- Importing Langfuse before environment variables are loaded
- Forgetting to flush or shut down exporters in short-lived processes

## After Setup

Tell the user to inspect:

- Traces view for single requests
- Sessions view if `sessionId` is present
- Dashboards for tags or model comparisons
- Scores once feedback or evaluators are added
