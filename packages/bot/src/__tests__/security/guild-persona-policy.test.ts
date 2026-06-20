import { afterEach, describe, expect, test } from 'bun:test';
import { withEnv } from '@silo/core/test-setup';
import {
  MANAGED_PERSONA_ID,
  resolveManagedGuildPersonaPolicy,
  isManagedGuildCustomPromptDisabled
} from '../../security/guild-persona-policy';

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe('guild persona policy', () => {
  test('applies managed Managed persona only to Managed Productions', () => {
    cleanup = withEnv({
      MANAGEDEPO_GUILD_ID: 'unconfigured-guild',
      MANAGED_PRODUCTION_PROMPT:
        'You are Managedepo, a polite, slightly weird, very online Discord presence for Managed Productions.\\nFor crude persona bait like "Dr Cock" or "Dr Dick", redirect to a safe joke.'
    });

    const policy = resolveManagedGuildPersonaPolicy(process.env.MANAGEDEPO_GUILD_ID);

    expect(policy?.personaId).toBe(MANAGED_PERSONA_ID);
    expect(policy?.customPromptsDisabled).toBe(true);
    expect(policy?.prompt).toContain('You are Managedepo');
    expect(policy?.prompt).toContain('Dr Cock');
  });

  test('does not disable custom prompts for other guilds', () => {
    cleanup = withEnv({
      MANAGEDEPO_GUILD_ID: 'unconfigured-guild',
      MANAGED_PRODUCTION_PROMPT: 'You are Managedepo.'
    });

    expect(resolveManagedGuildPersonaPolicy('other-guild')).toBeNull();
    expect(isManagedGuildCustomPromptDisabled('other-guild')).toBe(false);
    expect(isManagedGuildCustomPromptDisabled(process.env.MANAGEDEPO_GUILD_ID)).toBe(true);
  });
});
