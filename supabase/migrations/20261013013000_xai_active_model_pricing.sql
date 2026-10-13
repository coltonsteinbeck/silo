-- Add exact-match pricing for the active xAI models used by Silo.
-- Verified 2026-10-12 against xAI's official model and pricing documentation:
-- https://docs.x.ai/developers/models/grok-4.20-non-reasoning
-- https://docs.x.ai/developers/models/grok-imagine-image
--
-- Text rates are standard uncached short-context USD per 1,000 tokens.
-- The alias and documented snapshot are both seeded because requests use the
-- alias while API responses currently report the snapshot identifier.
-- Image generation is priced per output image. The current cost schema does
-- not represent the separate image-input fee for edits.
-- Fixed effective_from values keep direct SQL replay idempotent.
INSERT INTO provider_pricing (
    provider,
    model,
    input_cost_per_1k,
    output_cost_per_1k,
    image_cost,
    effective_from
)
VALUES
    ('xai', 'grok-4.20-non-reasoning', 0.001250, 0.002500, NULL, DATE '2026-10-12'),
    ('xai', 'grok-4.20-0309-non-reasoning', 0.001250, 0.002500, NULL, DATE '2026-10-12'),
    ('xai', 'grok-imagine-image', NULL, NULL, 0.0200, DATE '2026-10-12'),
    ('xai', 'grok-imagine-image-2026-03-02', NULL, NULL, 0.0200, DATE '2026-10-12')
ON CONFLICT (provider, model, effective_from) DO NOTHING;
