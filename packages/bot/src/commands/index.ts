import { Collection } from 'discord.js';
import { Command } from './types';
import { ViewMemoryCommand } from './memory/view';
import { SetMemoryCommand } from './memory/set';
import { ClearMemoryCommand } from './memory/clear';
import { DrawCommand } from './draw';
import { VideoCommand } from './video';
import { ThreadCommand } from './thread';
import { DigestCommand } from './digest';
import { AdminCommand } from './admin';
import { ConfigCommand } from './config';
import { ModCommand } from './mod';
import { AnalyticsCommand } from './analytics';
import { DatabaseAdapter, Config } from '@silo/core';
import { ProviderRegistry } from '../providers/registry';
import { AdminAdapter } from '../database/admin-adapter';
import { PermissionManager } from '../permissions/manager';

export function createCommands(
  db: DatabaseAdapter,
  registry: ProviderRegistry,
  config: Config,
  adminDb: AdminAdapter,
  permissions: PermissionManager
): Collection<string, Command> {
  const commands = new Collection<string, Command>();

  // Memory commands
  const viewMemory = new ViewMemoryCommand(db);
  const setMemory = new SetMemoryCommand(db);
  const clearMemory = new ClearMemoryCommand(db);

  commands.set(viewMemory.data.name, viewMemory);
  commands.set(setMemory.data.name, setMemory);
  commands.set(clearMemory.data.name, clearMemory);

  // Media generation
  const draw = new DrawCommand(registry);
  commands.set(draw.data.name, draw);

  const video = new VideoCommand(config.providers.openai?.apiKey || null);
  commands.set(video.data.name, video);

  // Collaboration features
  const thread = new ThreadCommand(db, registry);
  commands.set(thread.data.name, thread);

  const digest = new DigestCommand(registry);
  commands.set(digest.data.name, digest);

  // Admin commands
  const admin = new AdminCommand(adminDb, permissions);
  commands.set(admin.data.name, admin);

  const configCmd = new ConfigCommand(adminDb, permissions);
  commands.set(configCmd.data.name, configCmd);

  const mod = new ModCommand(adminDb, permissions);
  commands.set(mod.data.name, mod);

  const analytics = new AnalyticsCommand(adminDb, permissions);
  commands.set(analytics.data.name, analytics);

  return commands;
}
