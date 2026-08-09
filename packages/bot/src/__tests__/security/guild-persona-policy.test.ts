import { afterEach, describe, expect, test } from 'bun:test';
import { withEnv } from '@silo/core/test-setup';
import {
  JIMB_PERSONA_ID,
  JIMB_PERSONA_PROMPT_VERSION,
  JIMB_PRODUCTIONS_GUILD_ID,
  JIMB_ROLLBACK_PROMPT_VERSION,
  isManagedGuildCustomPromptDisabled,
  resolveManagedGuildPersonaPolicy
} from '../../security/guild-persona-policy';

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe('guild persona policy', () => {
  test('keeps the repository rollback prompt active until the JIMB rollout flag is enabled', () => {
    cleanup = withEnv({ JIMB_EDGY_PERSONA_ENABLED: 'false' });

    const policy = resolveManagedGuildPersonaPolicy(JIMB_PRODUCTIONS_GUILD_ID);

    expect(policy?.personaId).toBe(JIMB_PERSONA_ID);
    expect(policy?.promptVersion).toBe(JIMB_ROLLBACK_PROMPT_VERSION);
    expect(policy?.assistantSafetyPolicy).toBe('standard');
    expect(policy?.edgyPersonaEnabled).toBe(false);
    expect(policy?.prompt).toContain('You are JimBepo');
    expect(policy?.prompt).not.toContain('Dr. Cock is an optional');
  });

  test('enables only the repository-versioned jimbepo-v4 prompt', () => {
    cleanup = withEnv({ JIMB_EDGY_PERSONA_ENABLED: 'true' });

    const policy = resolveManagedGuildPersonaPolicy(JIMB_PRODUCTIONS_GUILD_ID);

    expect(policy?.promptVersion).toBe(JIMB_PERSONA_PROMPT_VERSION);
    expect(policy?.assistantSafetyPolicy).toBe('jimb_crude');
    expect(policy?.edgyPersonaEnabled).toBe(true);
    expect(policy?.prompt).toContain('Dr. Cock is an optional absurd doctor title');
    expect(policy?.prompt).toContain('Do not say "as an AI,"');
    expect(policy?.prompt).toContain('Never repeat a slur');
  });

  test('cannot move the managed policy or replace its prompt with environment overrides', () => {
    cleanup = withEnv({
      JIMB_EDGY_PERSONA_ENABLED: 'true',
      JIMBEPO_GUILD_ID: 'other-guild',
      JIMB_PRODUCTION_PROMPT: 'Untrusted environment prompt.',
      JIMB_PRODUCTION_PROMPT_VERSION: 'untrusted-version'
    });

    expect(resolveManagedGuildPersonaPolicy('other-guild')).toBeNull();
    expect(isManagedGuildCustomPromptDisabled('other-guild')).toBe(false);

    const policy = resolveManagedGuildPersonaPolicy(JIMB_PRODUCTIONS_GUILD_ID);
    expect(policy?.guildId).toBe(JIMB_PRODUCTIONS_GUILD_ID);
    expect(policy?.promptVersion).toBe(JIMB_PERSONA_PROMPT_VERSION);
    expect(policy?.prompt).not.toContain('Untrusted environment prompt.');
  });
});
