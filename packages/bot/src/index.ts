// Load encryption libraries FIRST, before any other imports
// Required for @discordjs/voice to detect encryption support
/* eslint-disable @typescript-eslint/no-require-imports */
try {
  require('sodium-native');
  console.log('[Crypto] Loaded sodium-native for voice encryption');
} catch {
  try {
    require('libsodium-wrappers');
    console.log('[Crypto] Loaded libsodium-wrappers for voice encryption');
  } catch {
    try {
      require('tweetnacl');
      console.log('[Crypto] Loaded tweetnacl for voice encryption (fallback)');
    } catch {
      console.error('[Crypto] No encryption library found. Voice features will not work.');
    }
  }
}
/* eslint-enable @typescript-eslint/no-require-imports */

import {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  ButtonInteraction,
  ModalSubmitInteraction
} from 'discord.js';
import { createHash } from 'crypto';
import { ConfigLoader, logger } from '@silo/core';
import { ProviderRegistry } from './providers/registry';
import { PostgresAdapter } from './database/postgres';
import { AdminAdapter } from './database/admin-adapter';
import { PermissionManager } from './permissions/manager';
import { createCommands } from './commands';
import { HealthServer } from './health/server';
import {
  guildManager,
  contentSanitizer,
  inactivityScheduler,
  deploymentDetector,
  systemPromptManager
} from './security';
import { QuotaMiddleware } from './middleware/quota';

/**
 * Handle modal submissions (e.g., system prompt editor)
 */
async function handleModalSubmit(interaction: ModalSubmitInteraction, adminDb: AdminAdapter) {
  try {
    // System prompt modal
    if (interaction.customId.startsWith('system_prompt_modal_')) {
      const forVoice = interaction.customId.endsWith('_voice');
      const prompt = interaction.fields.getTextInputValue('prompt_input').trim();
      const typeLabel = forVoice ? 'Voice' : 'Text';

      if (!interaction.guildId) {
        await interaction.reply({ content: 'This can only be used in a server.', ephemeral: true });
        return;
      }

      // Validate prompt (sanitize for basic injection attempts)
      if (prompt) {
        // Check for suspicious patterns that might try to override behavior
        const suspiciousPatterns = [
          /ignore\s+(all\s+)?previous/i,
          /disregard\s+(all\s+)?instructions/i,
          /you\s+are\s+now\s+(a\s+)?jailbreak/i,
          /system:\s*override/i
        ];

        for (const pattern of suspiciousPatterns) {
          if (pattern.test(prompt)) {
            await interaction.reply({
              content:
                '⚠️ The system prompt contains potentially problematic phrases. Please revise.',
              ephemeral: true
            });
            return;
          }
        }
      }

      // Save the prompt (empty string = null)
      await adminDb.setSystemPrompt(interaction.guildId, prompt || null, {
        forVoice,
        enabled: true
      });

      if (prompt) {
        await interaction.reply({
          content: `✅ ${typeLabel} system prompt saved! (${prompt.length} characters)\n\nThe AI will now use this prompt when responding.`,
          ephemeral: true
        });
      } else {
        await interaction.reply({
          content: `🗑️ ${typeLabel} system prompt cleared.`,
          ephemeral: true
        });
      }
      return;
    }

    // Unknown modal
    await interaction.reply({ content: 'Unknown modal submission.', ephemeral: true });
  } catch (error) {
    logger.error('Error handling modal submit:', error);
    if (!interaction.replied) {
      await interaction.reply({ content: 'An error occurred.', ephemeral: true });
    }
  }
}

async function main() {
  logger.info('Starting Silo Discord Bot...');

  const config = ConfigLoader.load();
  logger.info('Configuration loaded successfully');

  // Initialize database
  const db = new PostgresAdapter(config.database.url);
  await db.connect();

  // Initialize admin database
  const adminDb = new AdminAdapter(db.pool);
  const permissions = new PermissionManager(adminDb);
  const quotaMiddleware = new QuotaMiddleware(adminDb, permissions);

  const providers = new ProviderRegistry(config);
  const available = providers.getAvailableProviders();
  logger.info('Available providers:', available);

  // Create commands
  const commands = createCommands(db, providers, config, adminDb, permissions, quotaMiddleware);
  logger.info(`Loaded ${commands.size} commands`);

  // Initialize security modules and log deployment mode
  logger.info(`Deployment mode: ${deploymentDetector.getModeString()}`);

  guildManager.init(db.pool, {} as Client); // Will set actual client later
  contentSanitizer.init(db.pool);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessageReactions
    ]
  });

  // Initialize health server
  const healthServer = new HealthServer(client, db);
  await healthServer.start();

  client.once(Events.ClientReady, async readyClient => {
    logger.info(`Bot ready! Logged in as ${readyClient.user.tag}`);
    logger.info(`Serving ${readyClient.guilds.cache.size} guilds`);

    // Set client reference for security modules
    guildManager.setClient(client);

    // Start inactivity scheduler (only in hosted mode)
    inactivityScheduler.init(db.pool, client);
    inactivityScheduler.start();

    // Register slash commands
    const rest = new REST().setToken(config.discord.token);
    const commandData = Array.from(commands.values()).map(cmd => cmd.data.toJSON());

    try {
      logger.info(`Registering ${commandData.length} slash commands...`);
      await rest.put(Routes.applicationCommands(readyClient.user.id), { body: commandData });
      logger.info('Slash commands registered successfully');
    } catch (error) {
      logger.error('Failed to register slash commands:', error);
    }
  });

  // Handle slash command interactions
  client.on(Events.InteractionCreate, async interaction => {
    // Handle modal submissions (like system prompt editor)
    if (interaction.isModalSubmit()) {
      await handleModalSubmit(interaction, adminDb);
      return;
    }

    // Handle button interactions for waitlist
    if (interaction.isButton()) {
      await handleButtonInteraction(interaction as ButtonInteraction);
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const command = commands.get(interaction.commandName);
    if (!command) {
      logger.warn(`Unknown command: ${interaction.commandName}`);
      return;
    }

    // Update guild activity on any command
    if (interaction.guildId) {
      guildManager.updateActivity(interaction.guildId).catch(err => {
        logger.error('Failed to update guild activity:', err);
      });
    }

    try {
      await command.execute(interaction);
    } catch (error) {
      logger.error(`Error executing ${interaction.commandName}:`, error);
      const reply = { content: 'An error occurred while executing this command.', ephemeral: true };

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(reply);
      } else {
        await interaction.reply(reply);
      }
    }
  });

  // Handle guild join
  client.on(Events.GuildCreate, async guild => {
    logger.info(`Joined guild: ${guild.name} (${guild.id})`);

    try {
      const result = await guildManager.handleGuildJoin(guild);
      logger.info(`Guild join result for ${guild.name}: ${result.action} - ${result.message}`);
    } catch (error) {
      logger.error(`Error handling guild join for ${guild.name}:`, error);
    }
  });

  // Handle guild leave/kick
  client.on(Events.GuildDelete, async guild => {
    logger.info(`Left guild: ${guild.name} (${guild.id})`);

    try {
      await guildManager.handleGuildLeave(guild.id);
    } catch (error) {
      logger.error(`Error handling guild leave for ${guild.name}:`, error);
    }
  });

  // Handle mentions for conversational AI
  client.on(Events.MessageCreate, async message => {
    if (message.author.bot) return;
    if (!message.mentions.has(client.user!.id)) return;
    if (!message.guildId) return;

    // Update guild activity
    guildManager.updateActivity(message.guildId).catch(err => {
      logger.error('Failed to update guild activity:', err);
    });

    try {
      await message.channel.sendTyping();

      const userContent = message.content.replace(`<@${client.user!.id}>`, '').trim();

      // Content moderation
      const { processedContent, moderation } = await contentSanitizer.processContent(
        userContent,
        message.guildId,
        message.author.id,
        'message'
      );

      if (!moderation.allowed) {
        await message.reply({
          content: '⚠️ Your message was blocked due to content policy violations.',
          allowedMentions: { repliedUser: false }
        });
        return;
      }

      if (moderation.action === 'warned') {
        logger.warn(
          `Content warning for user ${message.author.id}: ${moderation.flaggedCategories.join(', ')}`
        );
      }

      // Check quota before processing (estimate ~500 tokens for a typical request)
      const member = await message.guild!.members.fetch(message.author.id);
      const quotaCheck = await quotaMiddleware.checkQuota(
        message.guildId,
        message.author.id,
        member,
        'text_tokens',
        500
      );

      if (!quotaCheck.allowed) {
        await message.reply({
          content: `⚠️ ${quotaCheck.reason}`,
          allowedMentions: { repliedUser: false }
        });
        return;
      }

      // Get guild's preferred provider (from /config provider command)
      const serverConfig = await adminDb.getServerConfig(message.guildId);
      const preferredProvider = serverConfig?.defaultProvider;
      const textProvider = providers.getTextProvider(preferredProvider || undefined);

      logger.info(
        `Guild ${message.guildId} using provider: ${textProvider.name} (configured: ${preferredProvider || 'default'})`
      );

      // Get the system prompt for this guild
      const { prompt: dbPrompt, enabled: promptEnabled } = await adminDb.getSystemPrompt(
        message.guildId
      );
      const promptConfig = systemPromptManager.getEffectivePrompt(dbPrompt, promptEnabled);

      // Provider-specific default prompts - servers should set their own via /config system-prompt
      const providerPrompts: Record<string, string> = {
        openai:
          'You are a helpful Discord bot assistant. You are powered by OpenAI GPT models. Be helpful, friendly, and conversational. Never claim to be a different AI model than what you actually are.',
        anthropic:
          'You are a helpful Discord bot assistant. You are Claude, made by Anthropic. Be helpful, friendly, and conversational. Never claim to be a different AI model than what you actually are.',
        xai: 'You are a helpful Discord bot assistant. You are Grok, made by xAI. You are NOT GPT, ChatGPT, or any OpenAI model. If asked what model you are, say you are Grok by xAI. Be helpful, friendly, and conversational.',
        google:
          'You are a helpful Discord bot assistant. You are Gemini, made by Google. Be helpful, friendly, and conversational. Never claim to be a different AI model than what you actually are.'
      };
      const defaultPrompt =
        providerPrompts[textProvider.name] ||
        'You are a helpful Discord bot assistant. Be helpful, friendly, and conversational.';
      const systemPrompt = promptConfig.prompt || defaultPrompt;

      // Compute prompt hash for conversation isolation
      // 'default' for provider defaults, SHA256 hash for custom prompts
      const promptHash = promptConfig.prompt
        ? createHash('sha256').update(promptConfig.prompt).digest('hex').substring(0, 16)
        : 'default';

      if (promptConfig.warnings.length > 0) {
        logger.warn(
          `System prompt warnings for guild ${message.guildId}: ${promptConfig.warnings.join(', ')}`
        );
      }

      // Get conversation history scoped to: channel + prompt context
      // This maintains group conversation flow while isolating different prompt personalities
      const history = await db.getConversationHistory(message.channelId, promptHash, 10);
      const messages = history.map(msg => ({
        role: msg.role,
        content: msg.content
      }));

      // Store user message
      await db.storeConversationMessage({
        guildId: message.guildId,
        channelId: message.channelId,
        userId: message.author.id,
        promptHash,
        role: 'user',
        content: processedContent
      });

      const response = await textProvider.generateText([
        {
          role: 'system',
          content: systemPrompt
        },
        ...messages,
        {
          role: 'user',
          content: processedContent
        }
      ]);

      // Store assistant response
      await db.storeConversationMessage({
        guildId: message.guildId,
        channelId: message.channelId,
        userId: message.author.id,
        promptHash,
        role: 'assistant',
        content: response.content
      });

      // Record actual token usage
      const tokensUsed = response.usage?.totalTokens || 500;
      await quotaMiddleware.recordUsage(
        message.guildId,
        message.author.id,
        'text_tokens',
        tokensUsed
      );

      await message.reply({
        content: response.content,
        allowedMentions: { repliedUser: false }
      });
    } catch (error) {
      logger.error('Error handling message:', error);
      await message.reply('Sorry, I encountered an error processing your request.');
    }
  });

  // Handle message reactions for feedback
  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    // Don't respond to bot reactions
    if (user.bot) return;

    // Fetch partial reactions
    if (reaction.partial) {
      try {
        await reaction.fetch();
      } catch (error) {
        logger.error('Failed to fetch reaction:', error);
        return;
      }
    }

    const message = reaction.message;
    if (!message.guildId) return;

    // Only track reactions on bot messages
    if (message.author?.id !== client.user?.id) return;

    const emoji = reaction.emoji.name;
    let feedbackType: 'positive' | 'negative' | 'regenerate' | 'save' | 'delete' | null = null;

    // Map emojis to feedback types
    if (emoji === '👍') feedbackType = 'positive';
    else if (emoji === '👎') feedbackType = 'negative';
    else if (emoji === '🔄') feedbackType = 'regenerate';
    else if (emoji === '💾') feedbackType = 'save';
    else if (emoji === '🗑️') feedbackType = 'delete';

    if (!feedbackType) return;

    try {
      // Log feedback
      await adminDb.logFeedback({
        messageId: message.id,
        channelId: message.channelId,
        guildId: message.guildId,
        userId: user.id,
        feedbackType
      });

      // Handle special actions
      if (feedbackType === 'delete' && message.deletable) {
        // Only allow original requester or mods to delete
        if (message.interaction?.user.id === user.id) {
          await message.delete();
        } else if (message.guild) {
          const member = await message.guild.members.fetch(user.id);
          const canModerate = await permissions.canModerate(message.guildId, user.id, member);
          if (canModerate) {
            await message.delete();
          }
        }
      }

      // TODO: Handle regenerate and save actions in future
    } catch (error) {
      logger.error('Error handling reaction:', error);
    }
  });

  client.on(Events.Error, error => {
    logger.error('Discord client error:', error);
  });

  // Cleanup expired memories periodically
  setInterval(
    async () => {
      try {
        const count = await db.cleanupExpiredMemories();
        if (count > 0) {
          logger.info(`Cleaned up ${count} expired memories`);
        }
      } catch (error) {
        logger.error('Error cleaning up memories:', error);
      }
    },
    60 * 60 * 1000
  ); // Every hour

  await client.login(config.discord.token);
}

/**
 * Handle button interactions (waitlist, etc.)
 */
async function handleButtonInteraction(interaction: ButtonInteraction): Promise<void> {
  const customId = interaction.customId;

  try {
    if (customId === 'waitlist_check_position') {
      if (!interaction.guildId) {
        await interaction.reply({
          content: 'This button only works in a server.',
          ephemeral: true
        });
        return;
      }

      const position = await guildManager.getWaitlistPosition(interaction.guildId);

      if (position === null) {
        await interaction.reply({
          content: "✅ This server is not on the waitlist - you're already active!",
          ephemeral: true
        });
      } else {
        await interaction.reply({
          content: `📊 Your current waitlist position: **#${position}**\n\nWe'll notify you when a spot opens up!`,
          ephemeral: true
        });
      }
    } else if (customId === 'waitlist_activate') {
      if (!interaction.guildId) {
        await interaction.reply({
          content: 'This button only works in a server.',
          ephemeral: true
        });
        return;
      }

      const success = await guildManager.acceptWaitlistPromotion(interaction.guildId);

      if (success) {
        await interaction.reply({
          content: '🎉 **Activated!** Your server is now using Silo. Try `/help` to get started!',
          ephemeral: false
        });
      } else {
        await interaction.reply({
          content: '⚠️ Unable to activate. Your slot may have expired or already been claimed.',
          ephemeral: true
        });
      }
    }
  } catch (error) {
    logger.error('Error handling button interaction:', error);

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: 'An error occurred processing your request.',
        ephemeral: true
      });
    }
  }
}

main().catch(error => {
  logger.error('Fatal error:', error);
  process.exit(1);
});
