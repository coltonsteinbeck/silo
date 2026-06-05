# Safety Regression Review Prompt

Review this Silo change for safety regressions.

Check:

- generated `@everyone`/`@here` cannot ping
- unsafe assistant personas are blocked
- safe refusals remain allowed
- passable user input is not overblocked unless policy changed
- graph output safety runs before persistence
- command and natural-language media paths share moderation behavior
- Langfuse metadata captures safety state

Return concrete failing examples or missing tests.
