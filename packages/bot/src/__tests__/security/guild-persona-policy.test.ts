import { afterEach, describe, expect, test } from 'bun:test';
import { withEnv } from '@silo/core/test-setup';
import {
  MANAGED_PERSONA_ID,
  MANAGED_PERSONA_PROMPT_VERSION,
  MANAGED_PRODUCTIONS_GUILD_ID,
  MANAGED_ROLLBACK_PROMPT_VERSION,
  isManagedGuildCustomPromptDisabled,
  resolveManagedGuildPersonaPolicy
} from '../../security/guild-persona-policy';

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe('guild persona policy', () => {
  test('keeps the repository rollback prompt active until the MANAGED rollout flag is enabled', () => {
    cleanup = withEnv({ MANAGED_EDGY_PERSONA_ENABLED: 'false' });

    const policy = resolveManagedGuildPersonaPolicy(MANAGED_PRODUCTIONS_GUILD_ID);

    expect(policy?.personaId).toBe(MANAGED_PERSONA_ID);
    expect(policy?.promptVersion).toBe(MANAGED_ROLLBACK_PROMPT_VERSION);
    expect(policy?.assistantSafetyPolicy).toBe('standard');
    expect(policy?.edgyPersonaEnabled).toBe(false);
    expect(policy?.prompt).toContain('You are Managedepo');
    expect(policy?.prompt).not.toContain('Dr. Cock is an optional');
  });

  test('enables only the repository-versioned managedepo-v4 prompt', () => {
    cleanup = withEnv({ MANAGED_EDGY_PERSONA_ENABLED: 'true' });

    const policy = resolveManagedGuildPersonaPolicy(MANAGED_PRODUCTIONS_GUILD_ID);

    expect(policy?.promptVersion).toBe(MANAGED_PERSONA_PROMPT_VERSION);
    expect(policy?.assistantSafetyPolicy).toBe('managed_crude');
    expect(policy?.edgyPersonaEnabled).toBe(true);
    expect(policy?.prompt).toContain('Dr. Cock is an optional absurd doctor title');
    expect(policy?.prompt).toContain('Do not say "as an AI,"');
    expect(policy?.prompt).toContain('Never repeat a slur');
  });

  test('cannot move the managed policy or replace its prompt with environment overrides', () => {
    cleanup = withEnv({
      MANAGED_EDGY_PERSONA_ENABLED: 'true',
      MANAGEDEPO_GUILD_ID: 'other-guild',
      MANAGED_PRODUCTION_PROMPT: 'Untrusted environment prompt.',
      MANAGED_PRODUCTION_PROMPT_VERSION: 'untrusted-version'
    });

    expect(resolveManagedGuildPersonaPolicy('other-guild')).toBeNull();
    expect(isManagedGuildCustomPromptDisabled('other-guild')).toBe(false);

    const policy = resolveManagedGuildPersonaPolicy(MANAGED_PRODUCTIONS_GUILD_ID);
    expect(policy?.guildId).toBe(MANAGED_PRODUCTIONS_GUILD_ID);
    expect(policy?.promptVersion).toBe(MANAGED_PERSONA_PROMPT_VERSION);
    expect(policy?.prompt).not.toContain('Untrusted environment prompt.');
  });
});
