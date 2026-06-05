---
applyTo: 'packages/bot/src/agent/**/*.ts'
---

# Agent Graph Instructions

- The graph must remain bounded and acyclic unless a plan explicitly changes that architecture.
- Preserve explicit recursion and tool budgets.
- Do not add autonomous ReAct-style loops.
- Unsupported tools should return deterministic unsupported results.
- Langfuse metadata should include intent, tool plan, budget, safety state, and outcome.
