---
applyTo: 'packages/bot/src/security/**/*.ts'
---

# Security Instructions

- Treat user input and memory/context as untrusted.
- Keep assistant output stricter than chat input.
- Preserve deterministic fallbacks for moderation outages.
- Add regression fixtures for unsafe persona drift, slur handling, prompt injection, and safe refusals.
- Do not weaken immutable system safety policy without explicit product review.
