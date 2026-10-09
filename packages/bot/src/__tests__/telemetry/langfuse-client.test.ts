import { describe, expect, test } from 'bun:test';
import { sanitizeMetadata, summarizeTextForTrace } from '../../telemetry/langfuse-client';

describe('Langfuse trace text privacy', () => {
  test('preserves typed correlation metadata while redacting free text and secret fields', () => {
    const id = '1'.repeat(18);
    const timestamp = '2026-08-14T18:00:00.000Z';
    const metadata = sanitizeMetadata({
      discordGuildId: id,
      discordChannelId: id,
      discordMessageId: id,
      discordInteractionId: id,
      modelCircuitContextDisabledUntil: timestamp,
      promptUpdatedAt: timestamp,
      promptPreview: `Contact person@example.com or ${id}`,
      apiKey: 'credential-value',
      nested: { authorization: 'Bearer credential-value', text: 'person@example.com' }
    });
    expect(metadata).toMatchObject({
      discordGuildId: id,
      discordChannelId: id,
      discordMessageId: id,
      discordInteractionId: id,
      modelCircuitContextDisabledUntil: timestamp,
      promptUpdatedAt: timestamp,
      apiKey: '[redacted]',
      nested: { authorization: '[redacted]', text: '[email]' }
    });
    expect(metadata!.promptPreview).not.toContain(id);
    expect(metadata!.promptPreview).not.toContain('person@example.com');
    expect(sanitizeMetadata({ discordGuildId: 'person@example.com' })!.discordGuildId).toBe(
      '[email]'
    );
  });
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
