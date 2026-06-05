---
applyTo: 'packages/bot/src/**/*.ts'
---

# Bot Runtime Instructions

- Follow `AGENTS.md`.
- Keep Discord message handling, graph orchestration, safety, quota, and persistence boundaries explicit.
- AI-generated replies should use disabled mention parsing and output safety before persistence.
- Prefer shared services over duplicating `/draw`, `/video`, graph media, and provider logic.
- Use structured logger calls instead of raw console output in production paths.
