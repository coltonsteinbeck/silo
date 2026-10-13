import { describe, expect, test } from 'bun:test';
import { sanitizeMetadata, summarizeTextForTrace } from '../../telemetry/langfuse-client';

describe('Langfuse trace text privacy', () => {
  test('keeps validated commit and prompt hashes intact without allowing arbitrary metadata text', () => {
    const commit = `${'a'.repeat(15)}${'1'.repeat(12)}${'b'.repeat(13)}`;
    const promptHash = `${'c'.repeat(30)}${'2'.repeat(20)}${'d'.repeat(14)}`;
    expect(sanitizeMetadata({ release: commit, releaseCommit: commit, promptHash })).toEqual({
      release: commit,
      releaseCommit: commit,
      promptHash
    });
    expect(sanitizeMetadata({ release: 'person@example.com' })!.release).toBe('[email]');
  });
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

  test('redacts hyphenated provider credentials from free text', () => {
    const openAiKey = ['sk', 'proj', 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef'].join('-');
    const xaiKey = ['xai', 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef'].join('-');
    const anthropicKey = ['sk', 'ant', 'api03', 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef'].join('-');
    const metadata = sanitizeMetadata({
      error: `OpenAI ${openAiKey}; xAI ${xaiKey}; Anthropic ${anthropicKey}`
    });

    expect(metadata?.error).toContain('[redacted]');
    expect(metadata?.error).not.toContain(openAiKey);
    expect(metadata?.error).not.toContain(xaiKey);
    expect(metadata?.error).not.toContain(anthropicKey);
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
