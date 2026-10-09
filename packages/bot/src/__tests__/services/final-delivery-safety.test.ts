import { describe, expect, mock, test } from 'bun:test';
import { sanitizeAssistantOutput } from '../../security/output-sanitizer';
import { evaluateExactFinalDeliveryText } from '../../services/final-delivery-safety';
import type { SafetyDecision } from '../../security/safety-decision';

function decision(action: SafetyDecision['action'], categories: string[]): SafetyDecision {
  return {
    action,
    stage: 'assistant_output',
    categories,
    scores: {},
    reasons: categories,
    detectorSources: ['deterministic'],
    contextEligible: action === 'allow',
    failed: false,
    semanticRisk: false
  };
}

describe('exact final delivery safety', () => {
  test('evaluates the post-sanitization text that Discord would receive', async () => {
    const canonical = 'Go k<foo>ill yourself.';
    const delivered = sanitizeAssistantOutput(canonical, { stripXmlLikeTags: true });
    const evaluate = mock(async (content: string) =>
      content === 'Go kill yourself.'
        ? decision('block', ['self_harm/instructions'])
        : decision('allow', [])
    );

    const result = await evaluateExactFinalDeliveryText(
      canonical,
      delivered,
      { userId: 'user' },
      evaluate
    );

    expect(delivered).toBe('Go kill yourself.');
    expect(result?.action).toBe('block');
    expect(evaluate).toHaveBeenCalledWith(
      'Go kill yourself.',
      expect.objectContaining({
        stage: 'assistant_output',
        source: 'final_delivery_exact_text',
        failurePolicy: 'fail_closed'
      })
    );
  });

  test('does not spend another safety call when the exact text is unchanged or empty', async () => {
    const evaluate = mock(async () => decision('allow', []));

    expect(await evaluateExactFinalDeliveryText('same', 'same', {}, evaluate)).toBeNull();
    expect(await evaluateExactFinalDeliveryText('candidate', '   ', {}, evaluate)).toBeNull();
    expect(evaluate).not.toHaveBeenCalled();
  });
});
