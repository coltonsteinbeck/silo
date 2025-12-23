import { Collection } from 'discord.js';
import { Command } from './types';
import { ViewMemoryCommand } from './memory/view';
import { SetMemoryCommand } from './memory/set';
import { ClearMemoryCommand } from './memory/clear';
import { DrawCommand } from './draw';
import { ThreadCommand } from './thread';
import { DigestCommand } from './digest';
import { AdminCommand } from './admin';
import { ConfigCommand } from './config';
import { ModCommand } from './mod';
import { AnalyticsCommand } from './analytics';
import { SpeakCommand } from './speak';
import { StopSpeakingCommand } from './stopspeaking';
import { FeedbackCommand } from './feedback';
import { DatabaseAdapter, Config } from '@silo/core';
import { ProviderRegistry } from '../providers/registry';
import { AdminAdapter } from '../database/admin-adapter';
import { PermissionManager } from '../permissions/manager';
import { QuotaMiddleware } from '../middleware/quota';

export function createCommands(
  db: DatabaseAdapter,
  registry: ProviderRegistry,
  _config: Config, // Reserved for future use
  adminDb: AdminAdapter,
  permissions: PermissionManager,
  quotaMiddleware?: QuotaMiddleware
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
  const draw = new DrawCommand(registry, quotaMiddleware);
  commands.set(draw.data.name, draw);

  // Collaboration features
  const thread = new ThreadCommand(db, registry, adminDb);
  commands.set(thread.data.name, thread);

  const digest = new DigestCommand(registry, adminDb);
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

  // Voice commands
  const speak = new SpeakCommand(adminDb, quotaMiddleware);
  commands.set(speak.data.name, speak);
  commands.set(StopSpeakingCommand.data.name, StopSpeakingCommand);

  // Feedback command
  const feedback = new FeedbackCommand(adminDb);
  commands.set(feedback.data.name, feedback);

  return commands;
}
