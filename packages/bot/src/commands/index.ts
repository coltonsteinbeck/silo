import { Collection } from 'discord.js';
import { Command } from './types';
import { ViewMemoryCommand } from './memory/view';
import { UserMemorySetCommand } from './memory/user-set';
import { ServerMemorySetCommand } from './memory/server-set';
import { ClearMemoryCommand } from './memory/clear';
import { DrawCommand } from './draw';
import { VideoCommand } from './video';
import { ThreadCommand } from './thread';
import { DigestCommand } from './digest';
import { AdminCommand } from './admin';
import { ConfigCommand } from './config';
import { ModCommand } from './mod';
import { AnalyticsCommand } from './analytics';
import { SpeakCommand } from './speak';
import { StopSpeakingCommand } from './stopspeaking';
import { FeedbackCommand } from './feedback';
import { PromptCommand } from './prompt';
import { DatabaseAdapter, Config } from '@silo/core';
import { ProviderRegistry } from '../providers/registry';
import { AdminAdapter } from '../database/admin-adapter';
import { PermissionManager } from '../permissions/manager';
import { QuotaMiddleware } from '../middleware/quota';

export function createCommands(
  db: DatabaseAdapter,
  registry: ProviderRegistry,
  config: Config,
  adminDb: AdminAdapter,
  permissions: PermissionManager,
  quotaMiddleware?: QuotaMiddleware
): Collection<string, Command> {
  const commands = new Collection<string, Command>();

  // Memory commands
  const viewMemory = new ViewMemoryCommand(db, permissions);
  const userSetMemory = new UserMemorySetCommand(db, registry);
  const serverSetMemory = new ServerMemorySetCommand(db, permissions, registry);
  const clearMemory = new ClearMemoryCommand(db, permissions);

  commands.set(viewMemory.data.name, viewMemory);
  commands.set(userSetMemory.data.name, userSetMemory);
  commands.set(serverSetMemory.data.name, serverSetMemory);
  commands.set(clearMemory.data.name, clearMemory);

  const urlSecurity = {
    policy: config.security?.urlPolicy,
    adminDb
  };

  // Media generation
  const draw = new DrawCommand(registry, quotaMiddleware, urlSecurity);
  commands.set(draw.data.name, draw);

  const video = new VideoCommand(registry, quotaMiddleware, urlSecurity);
  commands.set(video.data.name, video);

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
  const stopSpeaking = new StopSpeakingCommand(quotaMiddleware);
  commands.set(stopSpeaking.data.name, stopSpeaking);

  // Feedback command
  const feedback = new FeedbackCommand(adminDb);
  commands.set(feedback.data.name, feedback);

  const prompt = new PromptCommand(adminDb);
  commands.set(prompt.data.name, prompt);

  return commands;
}
