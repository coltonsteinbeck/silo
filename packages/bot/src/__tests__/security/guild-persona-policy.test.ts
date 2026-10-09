import { afterEach, expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { AdminAdapter } from '../../database/admin-adapter';
import {
  initializeManagedGuildPolicyRegistry,
  isManagedGuildCustomPromptDisabled,
  resolveManagedGuildPersonaPolicy
} from '../../security/guild-persona-policy';
import { managedPolicyFixture as policy } from '../fixtures/guild-policy';
const guild = '1'.repeat(18);
const load = (rows: unknown[], providers?: string[]) =>
  initializeManagedGuildPolicyRegistry(
    { query: async () => ({ rows }) } as unknown as Pool,
    providers
  );
afterEach(() => load([]));
test('loads only migrated policies and cannot activate them in another guild', async () => {
  expect(resolveManagedGuildPersonaPolicy(guild)).toBeNull();
  await load([{ guild_id: guild, policy }]);
  expect(resolveManagedGuildPersonaPolicy(guild)?.prompt).toBe(policy.prompt);
  expect(resolveManagedGuildPersonaPolicy('2'.repeat(18))).toBeNull();
  expect(isManagedGuildCustomPromptDisabled(guild)).toBe(true);
  expect(Object.isFrozen(resolveManagedGuildPersonaPolicy(guild)?.alternateAliases)).toBe(true);
  await expect(load([{ guild_id: guild, policy }], ['xai'])).rejects.toThrow(
    'provider is not configured'
  );
  expect(resolveManagedGuildPersonaPolicy(guild)?.textProvider).toBe('openai');
});
test('rejects invalid policy batches atomically without exposing private values', async () => {
  await load([{ guild_id: guild, policy }]);
  for (const invalid of [
    { ...policy, unknown: 'private-value' },
    { ...policy, prompt: '' },
    { ...policy, assistantSafetyPolicy: 'disabled' },
    { ...policy, textProvider: 'untrusted-provider' },
    { ...policy, alternateAliases: ['kill yourself'] },
    { ...policy, alternateAliases: ['Dr Cock describes explicit sex'] }
  ]) {
    await expect(load([{ guild_id: guild, policy: invalid }])).rejects.toThrow(
      'Invalid managed guild policy data'
    );
    expect(resolveManagedGuildPersonaPolicy(guild)?.promptVersion).toBe('v1');
  }
});
test('managed prompts cannot be changed, toggled or read through ordinary admin APIs', async () => {
  await load([{ guild_id: guild, policy }]);
  const adapter = new AdminAdapter({
    query: async () => {
      throw new Error('unexpected database access');
    }
  } as unknown as Pool);
  await expect(adapter.setSystemPrompt(guild, 'replace it')).rejects.toThrow('managed');
  await expect(adapter.toggleSystemPrompt(guild, false)).rejects.toThrow('managed');
  expect(await adapter.getSystemPrompt(guild)).toEqual({ prompt: null, enabled: false });
});

test('permits a standalone configured title without exempting surrounding sexual content', async () => {
  await load([
    {
      guild_id: guild,
      policy: { ...policy, alternateAliases: ['Dr Cock', 'Dr. Cock', 'Doctor Cock'] }
    }
  ]);
  expect(resolveManagedGuildPersonaPolicy(guild)?.alternateAliases).toHaveLength(3);
});
