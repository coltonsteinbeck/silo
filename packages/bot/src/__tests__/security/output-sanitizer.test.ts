import { describe, expect, test } from 'bun:test';
import {
  sanitizeAssistantOutput,
  sanitizeDiscordMassMentions
} from '../../security/output-sanitizer';

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

  test('strips attached-images metadata', () => {
    const raw = 'Before\n[Attached images: 3]\nAfter';

    const sanitized = sanitizeAssistantOutput(raw);

    expect(sanitized).toBe('Before\nAfter');
  });

  test('normalizes excessive newlines and repeated spaces/tabs', () => {
    const raw = 'A\n\n\n\nB\t\t  C';

    const sanitized = sanitizeAssistantOutput(raw);

    expect(sanitized).toBe('A\n\nB C');
  });

  test('preserves internal metadata when stripInternalMetadata is false', () => {
    const raw = '[Referenced context]\n[Attached images: 2]\ncontent';

    const sanitized = sanitizeAssistantOutput(raw, { stripInternalMetadata: false });

    expect(sanitized).toContain('[Referenced context]');
    expect(sanitized).toContain('[Attached images: 2]');
  });

  test('preserves xml-like tags when stripXmlLikeTags is false', () => {
    const raw = '<tag>hello</tag> <self-closing />';

    const sanitized = sanitizeAssistantOutput(raw, { stripXmlLikeTags: false });

    expect(sanitized).toContain('<tag>');
    expect(sanitized).toContain('</tag>');
    expect(sanitized).toContain('<self-closing />');
  });

  test('returns empty string for empty input', () => {
    expect(sanitizeAssistantOutput('')).toBe('');
  });

  test('returns empty string for whitespace-only input', () => {
    expect(sanitizeAssistantOutput('  \n\t  ')).toBe('');
  });

  test('handles nested xml-like tags', () => {
    const raw = '<outer><inner>payload</inner></outer>';

    const sanitized = sanitizeAssistantOutput(raw);

    expect(sanitized).toBe('payload');
  });

  test('handles self-closing xml-like tags', () => {
    const raw = 'Start <img/> middle <br /> end';

    const sanitized = sanitizeAssistantOutput(raw);

    expect(sanitized).toBe('Start middle end');
  });

  test('strips dangling malformed tag token', () => {
    const raw = 'prefix <parameter suffix';

    const sanitized = sanitizeAssistantOutput(raw);

    expect(sanitized).toBe('prefix suffix');
  });

  test('preserves normal comparison text with angle brackets', () => {
    const raw = 'Use x < 5 and y > 1 when evaluating this condition.';

    const sanitized = sanitizeAssistantOutput(raw);

    expect(sanitized).toContain('x < 5');
    expect(sanitized).toContain('y > 1');
  });

  test('neutralizes Discord mass mentions by default', () => {
    const raw = '@everyone please read this. @HERE too.';

    const sanitized = sanitizeAssistantOutput(raw);

    expect(sanitized).toBe('everyone please read this. here too.');
    expect(sanitized).not.toContain('@everyone');
    expect(sanitized).not.toContain('@HERE');
  });

  test('can preserve mass mention text when explicitly disabled', () => {
    const raw = '@everyone test';

    const sanitized = sanitizeAssistantOutput(raw, { neutralizeMassMentions: false });

    expect(sanitized).toBe('@everyone test');
  });

  test('does not alter normal user or role mentions', () => {
    const raw = '<@1234567890> <@&9876543210> @someone @everywhere';

    expect(sanitizeDiscordMassMentions(raw)).toBe(raw);
  });

  test('neutralizes repeated mass mentions with punctuation', () => {
    const raw = '@everyone, @here! @Everyone? @HeRe.';

    expect(sanitizeDiscordMassMentions(raw)).toBe('everyone, here! everyone? here.');
  });
});
