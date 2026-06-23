---
applyTo: 'packages/**/__tests__/**/*.ts'
---

# Test Instructions

- Match existing Bun test patterns.
- Prefer focused regression tests for changed behavior.
- Stub external providers and moderation/network calls.
- Keep exported production/user data out of fixtures; use minimal representative cases.
- Cover both success and fail-closed paths for safety, graph, provider, and config changes.
