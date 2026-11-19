import { Routes, type REST } from 'discord.js';

export type CommandSyncMode = 'legacy' | 'none' | 'guild-only';

export function resolveCommandSyncMode(
  rawMode: string | undefined,
  appEnvironment: string,
  nodeEnvironment: string | undefined,
  expectedGuildId: string | undefined
): CommandSyncMode {
  if (rawMode === undefined || rawMode === '') return 'legacy';
  if (rawMode !== 'none' && rawMode !== 'guild-only') {
    throw new Error('Invalid Discord command sync mode');
  }
  if (appEnvironment !== 'development' || nodeEnvironment !== 'development' || !expectedGuildId) {
    throw new Error('Scoped Discord command sync requires an explicit development guild');
  }
  return rawMode;
}

export function assertScopedCommandTarget(
  mode: CommandSyncMode,
  configuredApplicationId: string,
  readyApplicationId: string,
  joinedGuildIds: readonly string[],
  expectedGuildId: string | undefined
): void {
  if (configuredApplicationId !== readyApplicationId) {
    throw new Error('Discord application identity mismatch');
  }
  if (
    mode !== 'legacy' &&
    (!expectedGuildId || joinedGuildIds.length !== 1 || joinedGuildIds[0] !== expectedGuildId)
  ) {
    throw new Error('Scoped Discord command sync target mismatch');
  }
}

export function acceptsScopedGuildEvent(
  mode: CommandSyncMode,
  eventGuildId: string | null | undefined,
  expectedGuildId: string | undefined
): boolean {
  return mode === 'legacy' || (Boolean(expectedGuildId) && eventGuildId === expectedGuildId);
}

export async function syncApplicationCommands(options: {
  mode: CommandSyncMode;
  applicationId: string;
  expectedGuildId: string | undefined;
  joinedGuildIds: readonly string[];
  legacyGuildOnly: boolean;
  commandData: unknown[];
  rest: Pick<REST, 'put'> | undefined;
}): Promise<void> {
  const {
    mode,
    applicationId,
    expectedGuildId,
    joinedGuildIds,
    legacyGuildOnly,
    commandData,
    rest
  } = options;
  assertScopedCommandTarget(mode, applicationId, applicationId, joinedGuildIds, expectedGuildId);
  if (mode === 'none') return;
  if (!rest) throw new Error('Discord REST transport is required for command registration');
  if (mode === 'guild-only') {
    await rest.put(Routes.applicationGuildCommands(applicationId, expectedGuildId!), {
      body: commandData
    });
    return;
  }

  if (legacyGuildOnly && expectedGuildId) {
    await rest.put(Routes.applicationGuildCommands(applicationId, expectedGuildId), {
      body: commandData
    });
    await rest.put(Routes.applicationCommands(applicationId), { body: [] });
    await Promise.all(
      joinedGuildIds
        .filter(guildId => guildId !== expectedGuildId)
        .map(guildId =>
          rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body: [] })
        )
    );
    return;
  }

  await rest.put(Routes.applicationCommands(applicationId), { body: commandData });
  await Promise.all(
    joinedGuildIds.map(guildId =>
      rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body: [] })
    )
  );
}
