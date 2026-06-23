---
name: langfuse-prompt-migration
description: Move hardcoded prompts into Langfuse prompt management.
---

# Langfuse Prompt Migration

Use this when prompts should move out of code and into Langfuse-managed versions.

## Prerequisites

Confirm Langfuse credentials exist in the environment or project config. Do not ask users to paste keys into chat.

## Migration Flow

1. Inventory every prompt in the codebase.
2. Check templating compatibility.
3. Propose a prompt structure and naming scheme.
4. Get approval.
5. Create prompts in Langfuse.
6. Refactor code to fetch and compile them.
7. Link prompts to traces if tracing is already enabled.
8. Verify the application still behaves correctly.

## Compatibility Rules

Langfuse natively supports simple `{{variable}}` substitution. Complex control flow belongs in application code.

- Convert single-brace or template-literal variables into `{{var}}` form.
- Move loops, conditionals, and filters out of the prompt when possible.

## Verification

- Prompts load with the intended label, usually `production`
- Variables compile without errors
- Behavior matches the old hardcoded version
- Traces show the linked prompt version when tracing is present
