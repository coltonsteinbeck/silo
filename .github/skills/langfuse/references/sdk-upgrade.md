---
name: langfuse-sdk-upgrade
description: Upgrade Langfuse SDKs and adopt current tracing patterns.
---

# Langfuse SDK Upgrade Guide

Use this when migrating older Langfuse code to current JS/TS patterns.

## Canonical Docs

Fetch the current migration page before editing code:

- JS/TS: `https://langfuse.com/docs/observability/sdk/upgrade-path/js-v4-to-v5`
- Python: `https://langfuse.com/docs/observability/sdk/upgrade-path/python-v3-to-v4`

## Upgrade Checklist

- Update SDK packages first.
- Audit span filtering so important spans are not dropped.
- Replace direct trace mutation patterns with `propagateAttributes` plus observation updates.
- Keep metadata values string-only where the SDK requires it.
- Move release and environment configuration to env vars where supported.
- Re-test trace hierarchy and exported attributes in the UI.

## JS/TS Notes

- Use `propagateAttributes()` for trace-level correlating attributes.
- Wrap the outer execution path so child observations inherit the attributes.
- If custom span filtering is required, compose with `isDefaultExportSpan` instead of replacing defaults blindly.

## Common Pitfalls

- Attributes set outside the propagation callback do not attach where expected.
- Flat migrations lose parent-child structure.
- Metadata with non-string values gets dropped or coerced.
- Sensitive data creeps in when input/output is copied wholesale.
