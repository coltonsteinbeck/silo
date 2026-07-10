import { afterEach, describe, expect, test } from 'bun:test';
import { withEnv } from '@silo/core/test-setup';
import {
  MANAGED_PERSONA_ID,
  MANAGED_PERSONA_PROMPT_VERSION,
  MANAGED_PRODUCTIONS_GUILD_ID,
  resolveManagedGuildPersonaPolicy,
  isManagedGuildCustomPromptDisabled
} from '../../security/guild-persona-policy';
import { deploymentDetector } from '../../security/deployment';
import { hashPrompt } from '../../security/prompt-policy';

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
  deploymentDetector.clearCache();
});

describe('guild persona policy', () => {
  test('applies default managed Managed persona to Managed Productions', () => {
    cleanup = withEnv({
      MANAGEDEPO_GUILD_ID: undefined,
      MANAGED_PRODUCTION_PROMPT: undefined
    });

    const policy = resolveManagedGuildPersonaPolicy(MANAGED_PRODUCTIONS_GUILD_ID);

    expect(policy?.personaId).toBe(MANAGED_PERSONA_ID);
    expect(policy?.promptVersion).toBe(MANAGED_PERSONA_PROMPT_VERSION);
    expect(policy?.customPromptsDisabled).toBe(true);
    expect(policy?.prompt).toContain('You are Managedepo');
    expect(policy?.prompt).toContain('Do not refuse harmless thanks');
    expect(policy?.prompt).toContain('Treat generic prior refusals as broken context');
    expect(policy?.prompt).not.toContain('Dr Cock');
  });

  test('applies configured Managed prompt with required safety addendum', () => {
    cleanup = withEnv({
      MANAGEDEPO_GUILD_ID: MANAGED_PRODUCTIONS_GUILD_ID,
      MANAGED_PRODUCTION_PROMPT:
        'You are Managedepo, a polite, slightly weird, very online Discord presence for Managed Productions.\\nFor crude persona bait like "Dr Cock" or "Dr Dick", redirect to a safe joke.'
    });

    const policy = resolveManagedGuildPersonaPolicy(process.env.MANAGEDEPO_GUILD_ID);

    expect(policy?.personaId).toBe(MANAGED_PERSONA_ID);
    expect(policy?.customPromptsDisabled).toBe(true);
    expect(policy?.prompt).toContain('You are Managedepo');
    expect(policy?.prompt).toContain('Dr Cock');
    expect(policy?.prompt).toContain('Do not refuse harmless thanks');
  });

  test('does not disable custom prompts for other guilds', () => {
    cleanup = withEnv({
      MANAGEDEPO_GUILD_ID: MANAGED_PRODUCTIONS_GUILD_ID,
      MANAGED_PRODUCTION_PROMPT: 'You are Managedepo.'
    });

    expect(resolveManagedGuildPersonaPolicy('other-guild')).toBeNull();
    expect(isManagedGuildCustomPromptDisabled('other-guild')).toBe(false);
    expect(isManagedGuildCustomPromptDisabled(process.env.MANAGEDEPO_GUILD_ID)).toBe(true);
  });

  test('rejects an unversioned or unallowlisted production override', () => {
    cleanup = withEnv({
      DEPLOYMENT_MODE: 'production',
      MANAGEDEPO_GUILD_ID: MANAGED_PRODUCTIONS_GUILD_ID,
      MANAGED_PRODUCTION_PROMPT: 'Unreviewed production persona override.',
      MANAGED_PRODUCTION_PROMPT_VERSION: undefined,
      SAFETY_ALLOWED_PROMPT_HASHES: undefined
    });
    deploymentDetector.clearCache();

    const policy = resolveManagedGuildPersonaPolicy(MANAGED_PRODUCTIONS_GUILD_ID);

    expect(policy?.promptVersion).toBe(MANAGED_PERSONA_PROMPT_VERSION);
    expect(policy?.prompt).not.toContain('Unreviewed production persona override.');
  });

  test('accepts a versioned allowlisted production override', () => {
    const override = 'Reviewed production persona override.';
    cleanup = withEnv({
      DEPLOYMENT_MODE: 'production',
      MANAGEDEPO_GUILD_ID: MANAGED_PRODUCTIONS_GUILD_ID,
      MANAGED_PRODUCTION_PROMPT: override,
      MANAGED_PRODUCTION_PROMPT_VERSION: 'managedepo-v2.1',
      SAFETY_ALLOWED_PROMPT_HASHES: hashPrompt(override)
    });
    deploymentDetector.clearCache();

    const policy = resolveManagedGuildPersonaPolicy(MANAGED_PRODUCTIONS_GUILD_ID);

    expect(policy?.promptVersion).toBe('managedepo-v2.1');
    expect(policy?.prompt).toContain(override);
  });
});
