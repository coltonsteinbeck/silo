---
name: langfuse-user-feedback
description: Capture end-user feedback as Langfuse scores.
---

# User Feedback

Tracing should already exist before wiring feedback, because feedback attaches to traces.

Docs: `https://langfuse.com/docs/observability/features/user-feedback`

## Workflow

1. Decide which feedback signal the product should capture.
2. Choose stable score names.
3. Create the score at the right runtime boundary.
4. Verify it appears in Langfuse.

## Common UX Patterns

- Thumbs up/down
- Star rating
- Helpful / not helpful banner
- Implicit signals like regenerate, copy, or escalation
- Optional free-text comment

## Score Naming Rules

- Lowercase, hyphenated names
- One consistent name per signal
- Name the signal source, not the hoped-for metric

## Implementation Notes

- Server-side feedback can create scores where the event already happens.
- Frontend feedback should use the public-key browser client only.
- If feedback is explicit in the UI, the trace ID must reach the frontend.

## Common Mistakes

- Using the secret key in browser code
- Omitting the score data type on boolean-style scores
- Reusing inconsistent score names across the app
