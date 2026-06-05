# Graph Tooling Review Prompt

Review graph/tooling changes for bounded behavior.

Check:

- no autonomous loops
- recursion/tool budgets enforced
- unsupported tools fail closed
- search/image/video intent routing avoids false positives
- provider capability matrix matches configured providers
- Langfuse captures intent, tools requested, tools called, citations/media metadata, and graph outcome

Return risks, missing tests, and rollout concerns.
