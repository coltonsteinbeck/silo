---
name: langfuse-error-analysis
description: Use Langfuse traces to build a failure taxonomy and prioritize fixes.
---

# Error Analysis

Use this when the system is producing poor outputs and the next step is to inspect Langfuse traces systematically.

## Primary Process

Start from the Langfuse cookbook guide:

`https://langfuse.com/guides/cookbook/error-analysis-llm-applications.md`

Then work through the same sequence with the user:

1. Sample traces
2. Open-code what is happening
3. Cluster repeated failure patterns
4. Label the clusters
5. Decide what to fix first

## Langfuse-Specific Rules

- Use the Langfuse CLI wherever it can do the work.
- In OTEL-based apps, annotate the relevant `generation` observation, not the top-level trace, when detailed content lives on the observation.
- Create score configs before creating annotation queues that depend on them.
- Share direct Langfuse UI links whenever the user needs to continue work in the browser.

## Common Gotchas

- Queue objects targeting traces when the useful content is on an observation
- Creating queues before score configs exist
- Over-paginating past API limits
- Creating low-quality labels instead of behavior-first open coding
