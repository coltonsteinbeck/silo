import { describe, expect, test } from 'bun:test';
import { sanitizeAssistantOutput } from '../../security/output-sanitizer';

describe('sanitizeAssistantOutput', () => {
  test('strips internal referenced context labels', () => {
    const raw =
      '[Referenced context]\n[Reply level 1 | user 1403165230783004702]\nsome internal context\n\nFinal answer.';

    const sanitized = sanitizeAssistantOutput(raw);

    expect(sanitized).not.toContain('Referenced context');
    expect(sanitized).not.toContain('Reply level');
    expect(sanitized).toContain('some internal context');
    expect(sanitized).toContain('Final answer.');
  });

  test('strips xml-like tags and dangling parameter tokens', () => {
    const raw = '<parameter\n<tool_use id="abc">payload</tool_use>\nThe response is ready.';

    const sanitized = sanitizeAssistantOutput(raw);

    expect(sanitized).not.toContain('<parameter');
    expect(sanitized).not.toContain('<tool_use');
    expect(sanitized).not.toContain('</tool_use>');
    expect(sanitized).toContain('payload');
    expect(sanitized).toContain('The response is ready.');
  });

  test('preserves normal comparison text with angle brackets', () => {
    const raw = 'Use x < 5 and y > 1 when evaluating this condition.';

    const sanitized = sanitizeAssistantOutput(raw);

    expect(sanitized).toContain('x < 5');
    expect(sanitized).toContain('y > 1');
  });
});
