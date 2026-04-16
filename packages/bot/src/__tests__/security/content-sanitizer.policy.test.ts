import { describe, expect, test } from 'bun:test';
import { evaluateModerationDecision } from '../../security/content-sanitizer';

describe('evaluateModerationDecision profanity policy', () => {
  test('downgrades mild profanity harassment block when edgy mode is enabled', () => {
    const decision = evaluateModerationDecision(
      ['harassment'],
      { harassment: 0.8 },
      {
        allowMildProfanityInput: true,
        content: 'this is fucking annoying',
        sentimentReview: {
          label: 'negative',
          score: -0.4,
          confidence: 0.7,
          urgency: 0.2,
          frustration: 0.5,
          confusion: 0.2,
          source: 'heuristic'
        }
      }
    );

    expect(decision.allowed).toBe(true);
    expect(decision.action).toBe('warned');
  });

  test('keeps harassment block when edgy mode is disabled', () => {
    const decision = evaluateModerationDecision(
      ['harassment'],
      { harassment: 0.8 },
      {
        allowMildProfanityInput: false,
        content: 'this is fucking annoying'
      }
    );

    expect(decision.allowed).toBe(false);
    expect(decision.action).toBe('blocked');
  });
});
