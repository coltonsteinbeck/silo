import { describe, expect, mock, test } from 'bun:test';
import { Routes, type REST } from 'discord.js';
import {
  assertScopedCommandTarget,
  resolveCommandSyncMode,
  syncApplicationCommands,
  type CommandSyncMode
} from '../../runtime/command-registration';

const appId = 'application-1';
const guildId = 'test-guild';
const otherGuildId = 'other-guild';
const commands = [{ name: 'ping' }];

function transport() {
  const put = mock(async (_route: string, _options: { body: unknown }) => undefined);
  return { put, rest: { put } as unknown as Pick<REST, 'put'> };
}

async function run(mode: CommandSyncMode, legacyGuildOnly = false) {
  const { put, rest } = transport();
  await syncApplicationCommands({
    mode,
    applicationId: appId,
    expectedGuildId: guildId,
    joinedGuildIds: [guildId, otherGuildId],
    legacyGuildOnly,
    commandData: commands,
    rest
  });
  return put.mock.calls;
}

describe('development command sync scope', () => {
  test('requires an explicit development environment and guild', () => {
    expect(resolveCommandSyncMode(undefined, 'production', 'production', undefined)).toBe('legacy');
    expect(resolveCommandSyncMode('none', 'development', 'development', guildId)).toBe('none');
    expect(resolveCommandSyncMode('guild-only', 'development', 'development', guildId)).toBe(
      'guild-only'
    );
    for (const rawMode of ['none', 'guild-only']) {
      expect(() => resolveCommandSyncMode(rawMode, 'production', 'development', guildId)).toThrow();
      expect(() => resolveCommandSyncMode(rawMode, 'development', 'production', guildId)).toThrow();
      expect(() =>
        resolveCommandSyncMode(rawMode, 'development', 'development', undefined)
      ).toThrow();
    }
    expect(() =>
      resolveCommandSyncMode('unknown', 'development', 'development', guildId)
    ).toThrow();
  });

  test('rejects mismatched app, absent guild, and extra joined guild before startup work', () => {
    for (const mode of ['none', 'guild-only'] as const) {
      expect(() =>
        assertScopedCommandTarget(mode, appId, 'wrong-app', [guildId], guildId)
      ).toThrow();
      expect(() => assertScopedCommandTarget(mode, appId, appId, [], guildId)).toThrow();
      expect(() =>
        assertScopedCommandTarget(mode, appId, appId, [guildId, otherGuildId], guildId)
      ).toThrow();
      expect(() =>
        assertScopedCommandTarget(mode, appId, appId, [otherGuildId], guildId)
      ).toThrow();
      expect(() => assertScopedCommandTarget(mode, appId, appId, [guildId], guildId)).not.toThrow();
    }
  });

  test('no-registration mode never constructs or calls REST', async () => {
    await expect(
      syncApplicationCommands({
        mode: 'none',
        applicationId: appId,
        expectedGuildId: guildId,
        joinedGuildIds: [guildId],
        legacyGuildOnly: true,
        commandData: commands,
        rest: undefined
      })
    ).resolves.toBeUndefined();
  });

  test('a mismatched guild cannot reach the REST transport in either scoped mode', async () => {
    for (const mode of ['none', 'guild-only'] as const) {
      const { put, rest } = transport();
      await expect(
        syncApplicationCommands({
          mode,
          applicationId: appId,
          expectedGuildId: guildId,
          joinedGuildIds: [otherGuildId],
          legacyGuildOnly: false,
          commandData: commands,
          rest
        })
      ).rejects.toThrow();
      expect(put).not.toHaveBeenCalled();
    }
  });

  test('guild-only mode overwrites only the expected guild', async () => {
    const { put, rest } = transport();
    await syncApplicationCommands({
      mode: 'guild-only',
      applicationId: appId,
      expectedGuildId: guildId,
      joinedGuildIds: [guildId],
      legacyGuildOnly: false,
      commandData: commands,
      rest
    });
    expect(put.mock.calls).toEqual([
      [Routes.applicationGuildCommands(appId, guildId), { body: commands }]
    ]);
    await expect(run('guild-only')).rejects.toThrow();
  });

  test('legacy guild mode retains global and other-guild cleanup', async () => {
    expect(await run('legacy', true)).toEqual([
      [Routes.applicationGuildCommands(appId, guildId), { body: commands }],
      [Routes.applicationCommands(appId), { body: [] }],
      [Routes.applicationGuildCommands(appId, otherGuildId), { body: [] }]
    ]);
  });

  test('legacy global mode retains guild override cleanup', async () => {
    expect(await run('legacy')).toEqual([
      [Routes.applicationCommands(appId), { body: commands }],
      [Routes.applicationGuildCommands(appId, guildId), { body: [] }],
      [Routes.applicationGuildCommands(appId, otherGuildId), { body: [] }]
    ]);
  });
});
