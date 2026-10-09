-- Standard uncached short-context token rates verified 2026-10-04:
-- https://developers.openai.com/api/docs/pricing
-- https://developers.openai.com/api/docs/models/gpt-6-luna
-- USD per 1,000 tokens: $0.10 / 1M input and $0.50 / 1M output.
-- The documented current snapshot is the alias itself; no dated snapshot is published.
-- Fixed effective_from makes direct SQL replay idempotent across calendar days.
-- The lookup uses the newest row without date filtering: apply before model activation.
-- Retain this additive row on application rollback; do not rewrite older prices or analytics.
INSERT INTO provider_pricing (
    provider, model, input_cost_per_1k, output_cost_per_1k, effective_from
)
VALUES ('openai', 'gpt-6-luna', 0.000100, 0.000500, DATE '2026-10-04')
ON CONFLICT (provider, model, effective_from) DO NOTHING;
