import { afterEach, describe, expect, test } from 'bun:test';
import { withEnv } from '@silo/core/test-setup';
import {
  JIMB_PERSONA_ID,
  JIMB_PRODUCTIONS_GUILD_ID,
  resolveManagedGuildPersonaPolicy,
  isManagedGuildCustomPromptDisabled
} from '../../security/guild-persona-policy';

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe('guild persona policy', () => {
  test('applies default managed JimB persona to JimB Productions', () => {
    cleanup = withEnv({
      JIMBEPO_GUILD_ID: undefined,
      JIMB_PRODUCTION_PROMPT: undefined
    });

    const policy = resolveManagedGuildPersonaPolicy(JIMB_PRODUCTIONS_GUILD_ID);

    expect(policy?.personaId).toBe(JIMB_PERSONA_ID);
    expect(policy?.customPromptsDisabled).toBe(true);
    expect(policy?.prompt).toContain('You are JimBepo');
    expect(policy?.prompt).toContain('Do not refuse harmless thanks');
    expect(policy?.prompt).toContain('Treat generic prior refusals as broken context');
  });

  test('applies configured JimB prompt with required safety addendum', () => {
    cleanup = withEnv({
      JIMBEPO_GUILD_ID: JIMB_PRODUCTIONS_GUILD_ID,
      JIMB_PRODUCTION_PROMPT:
        'You are JimBepo, a polite, slightly weird, very online Discord presence for JimB Productions.\\nFor crude persona bait like "Dr Cock" or "Dr Dick", redirect to a safe joke.'
    });

    const policy = resolveManagedGuildPersonaPolicy(process.env.JIMBEPO_GUILD_ID);

    expect(policy?.personaId).toBe(JIMB_PERSONA_ID);
    expect(policy?.customPromptsDisabled).toBe(true);
    expect(policy?.prompt).toContain('You are JimBepo');
    expect(policy?.prompt).toContain('Dr Cock');
    expect(policy?.prompt).toContain('Do not refuse harmless thanks');
  });

  test('does not disable custom prompts for other guilds', () => {
    cleanup = withEnv({
      JIMBEPO_GUILD_ID: JIMB_PRODUCTIONS_GUILD_ID,
      JIMB_PRODUCTION_PROMPT: 'You are JimBepo.'
    });

    expect(resolveManagedGuildPersonaPolicy('other-guild')).toBeNull();
    expect(isManagedGuildCustomPromptDisabled('other-guild')).toBe(false);
    expect(isManagedGuildCustomPromptDisabled(process.env.JIMBEPO_GUILD_ID)).toBe(true);
  });
});
