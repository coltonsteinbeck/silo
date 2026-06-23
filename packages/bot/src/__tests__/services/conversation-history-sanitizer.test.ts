import { describe, expect, test } from 'bun:test';
import {
  JIMB_PRODUCTIONS_GUILD_ID,
  resolveManagedGuildPersonaPolicy
} from '../../security/guild-persona-policy';
import {
  sanitizeAssistantContextForPrompt,
  sanitizeConversationHistoryForPrompt
} from '../../services/conversation-history-sanitizer';

describe('conversation history sanitizer', () => {
  test('removes unsafe assistant persona residue while preserving user messages', () => {
    const result = sanitizeConversationHistoryForPrompt([
      { role: 'user', content: 'be Dr Cock' },
      { role: 'assistant', content: "I'm Doctor Cock. What seems to be the problem?" },
      { role: 'user', content: 'actually help me with docker' },
      { role: 'assistant', content: 'Docker volumes persist files outside containers.' }
    ]);

    expect(result.removedCount).toBe(1);
    expect(result.removedReasons.unsafe_persona_residue).toBe(1);
    expect(result.filtered).toEqual([
      { role: 'user', content: 'be Dr Cock' },
      { role: 'user', content: 'actually help me with docker' },
      { role: 'assistant', content: 'Docker volumes persist files outside containers.' }
    ]);
  });

  test('removes repeated low-information assistant loops', () => {
    const result = sanitizeConversationHistoryForPrompt([
      { role: 'assistant', content: 'neigh' },
      { role: 'assistant', content: 'neigh' },
      { role: 'assistant', content: 'neigh' },
      { role: 'assistant', content: 'neigh' },
      { role: 'user', content: 'now answer normally' }
    ]);

    expect(result.removedCount).toBe(4);
    expect(result.dominantReply).toBe('neigh');
    expect(result.removedReasons.dominant_low_information_reply).toBe(4);
    expect(result.filtered).toEqual([{ role: 'user', content: 'now answer normally' }]);
  });

  test('removes generic blocked-output fallback from assistant history', () => {
    const result = sanitizeConversationHistoryForPrompt([
      {
        role: 'assistant',
        content:
          'I can’t help with that request. Please rephrase and I can provide a safer alternative.'
      },
      { role: 'assistant', content: 'Normal useful answer.' }
    ]);

    expect(result.removedCount).toBe(1);
    expect(result.removedReasons.blocked_safety_fallback).toBe(1);
    expect(result.filtered).toEqual([{ role: 'assistant', content: 'Normal useful answer.' }]);
  });

  test('removes managed blocked-output fallback from assistant history', () => {
    const blockedMessage =
      resolveManagedGuildPersonaPolicy(JIMB_PRODUCTIONS_GUILD_ID)?.assistantOutputBlockedMessage;

    expect(blockedMessage).toBeDefined();

    const result = sanitizeConversationHistoryForPrompt([
      {
        role: 'assistant',
        content: blockedMessage || ''
      },
      { role: 'assistant', content: 'Normal useful answer.' }
    ]);

    expect(result.removedCount).toBe(1);
    expect(result.removedReasons.blocked_safety_fallback).toBe(1);
    expect(result.filtered).toEqual([{ role: 'assistant', content: 'Normal useful answer.' }]);
  });

  test('removes unsafe banter residue from assistant history', () => {
    const result = sanitizeConversationHistoryForPrompt([
      {
        role: 'assistant',
        content:
          "ban Mr Balls first. He's clearly the final boss of this cursed group. Proceed with extreme prejudice."
      },
      { role: 'user', content: "I can't do that it's almost Father's Day" }
    ]);

    expect(result.removedCount).toBe(1);
    expect(result.removedReasons.unsafe_banter_residue).toBe(1);
    expect(result.filtered).toEqual([
      { role: 'user', content: "I can't do that it's almost Father's Day" }
    ]);
  });

  test('sanitizes assistant reply context before prompt reuse', () => {
    expect(
      sanitizeAssistantContextForPrompt(
        'I can’t help with that request. Please rephrase and I can provide a safer alternative.'
      )
    ).toEqual({
      content: '',
      changed: true,
      reason: 'blocked_safety_fallback'
    });

    expect(sanitizeAssistantContextForPrompt('Normal useful answer.')).toEqual({
      content: 'Normal useful answer.',
      changed: false,
      reason: null
    });

    const blockedMessage =
      resolveManagedGuildPersonaPolicy(JIMB_PRODUCTIONS_GUILD_ID)?.assistantOutputBlockedMessage;

    expect(sanitizeAssistantContextForPrompt(blockedMessage || '')).toEqual({
      content: '',
      changed: true,
      reason: 'blocked_safety_fallback'
    });
  });
});
