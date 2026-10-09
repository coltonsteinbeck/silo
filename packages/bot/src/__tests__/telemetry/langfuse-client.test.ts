import { describe, expect, test } from 'bun:test';
import { summarizeTextForTrace } from '../../telemetry/langfuse-client';

describe('Langfuse trace text privacy', () => {
  test('redacts common direct identifiers before exporting a preview', () => {
    const preview = summarizeTextForTrace(
      'Email person@example.com, call +1 (212) 555-0199, ping <@123456789012345678>, or use @private.handle from 192.168.1.20.'
    );

    expect(preview).not.toContain('person@example.com');
    expect(preview).not.toContain('212');
    expect(preview).not.toContain('123456789012345678');
    expect(preview).not.toContain('@private.handle');
    expect(preview).not.toContain('192.168.1.20');
    expect(preview).toContain('[email]');
    expect(preview).toContain('[discord-id]');
  });

  test('redacts identifiers before truncation can split them into an unmatchable fragment', () => {
    const preview = summarizeTextForTrace(
      `${'x'.repeat(3900)} contact late.identifier@example.com for the rest`,
      4000
    );

    expect(preview).not.toContain('late.identifier@example.com');
    expect(preview).toContain('[email]');
  });

  test('retains only the hostname for URLs', () => {
    const preview = summarizeTextForTrace(
      'See https://example.com/private/path?email=person@example.com for details.'
    );

    expect(preview).toContain('[url:example.com]');
    expect(preview).not.toContain('/private/path');
    expect(preview).not.toContain('person@example.com');
  });
});
