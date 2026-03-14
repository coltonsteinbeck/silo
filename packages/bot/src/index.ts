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
import dns from 'node:dns';
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
  systemPromptManager,
  composeSystemPromptWithSafety,
  resolvePromptPolicy,
  safetyMonitor
} from './security';
import { sanitizeAssistantOutput } from './security/output-sanitizer';
import { QuotaMiddleware } from './middleware/quota';
import { CostAggregator } from './services/cost-aggregator';
import { selectMemoryContext } from './services/memory-selector';
import {
  assembleConversationContext,
  buildImageSummaryBlock
} from './services/conversation-context';
import { resolveReplyContext } from './services/reply-context';
import { decideVisionRouting, enforceVisionRoutingPrecheck } from './services/vision-routing';

// Global error handlers to prevent silent crashes
process.on('uncaughtException', error => {
  console.error('[FATAL] Uncaught exception:', error);
  // Give time for logs to flush before exiting
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', reason => {
  console.error('[FATAL] Unhandled promise rejection:', reason);
  // Don't exit — log and let the process continue
});
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

  if (process.env.DB_PREFER_IPV4 === 'true') {
    try {
      dns.setDefaultResultOrder?.('ipv4first');
      logger.info('DB_PREFER_IPV4 enabled (DNS result order: ipv4first)');
    } catch (error) {
      logger.warn('DB_PREFER_IPV4 enabled but could not set DNS result order', error);
    }
  }

  const config = ConfigLoader.load();
  logger.info('Configuration loaded successfully');
  try {
    const dbUrl = new URL(config.database.url);
    logger.info(
      `Database target resolved: ${dbUrl.hostname}${dbUrl.port ? `:${dbUrl.port}` : ''}/${dbUrl.pathname.replace(/^\//, '') || 'postgres'}`
    );
  } catch {
    logger.warn('Database target could not be parsed from configuration URL');
  }

  // Initialize database
  const db = new PostgresAdapter(config.database.url, {
    ssl: config.database.ssl,
    maxConnections: config.database.maxConnections
  });
  await db.connect();

  const migrationSummary = db.getLastMigrationSummary();
  if (migrationSummary) {
    logger.info(
      `Migration summary: applied=${migrationSummary.applied}, skipped=${migrationSummary.skipped}, baselineMarked=${migrationSummary.baselineMarked}, total=${migrationSummary.totalFiles}, succeeded=${migrationSummary.succeeded}`
    );
  }

  // Initialize admin database
  const adminDb = new AdminAdapter(db.pool);
  const permissions = new PermissionManager(adminDb);
  const quotaMiddleware = new QuotaMiddleware(adminDb, permissions);
  const costAggregator = new CostAggregator(adminDb);

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

  const notifySafetyAlert = async (guildId: string, messageContent: string): Promise<void> => {
    try {
      const alertChannelId = await adminDb.getAlertsChannel(guildId);
      if (!alertChannelId) {
        return;
      }

      const guild = client.guilds.cache.get(guildId);
      if (!guild) {
        return;
      }

      const channel = await guild.channels.fetch(alertChannelId);
      if (!channel || !channel.isTextBased()) {
        return;
      }

      await channel.send({ content: messageContent });
    } catch (error) {
      logger.error(`Failed to send safety alert for guild ${guildId}:`, error);
    }
  };

  // Start periodic cost aggregation
  costAggregator.start();

  client.once(Events.ClientReady, async readyClient => {
    logger.info(`Bot ready! Logged in as ${readyClient.user.tag}`);
    logger.info(`Serving ${readyClient.guilds.cache.size} guilds`);

    // Set client reference for security modules
    guildManager.setClient(client);

    // Ensure all guilds the bot is in are registered in guild_registry.
    // This prevents the inactivity scheduler from evicting guilds that were
    // never registered (e.g. after a database reset or migration issue).
    try {
      const syncResult = await guildManager.ensureGuildsRegistered();
      if (syncResult.synced > 0) {
        logger.info(
          `Guild sync: registered ${syncResult.synced} missing guild(s), ${syncResult.skipped} already registered`
        );
      } else {
        logger.info(`Guild sync: all ${syncResult.skipped} guild(s) already registered`);
      }
    } catch (error) {
      logger.error('Guild sync failed:', error);
    }

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

    if (safetyMonitor.isKillSwitchActive(message.guildId)) {
      logger.warn(
        `Safety kill switch active for guild ${message.guildId}; blocked request from user ${message.author.id}`
      );
      await message.reply({
        content:
          '⚠️ Safety mode is temporarily active due to repeated policy violations. Please try again in a few minutes.',
        allowedMentions: { repliedUser: false }
      });
      return;
    }

    // Update guild activity
    guildManager.updateActivity(message.guildId).catch(err => {
      logger.error('Failed to update guild activity:', err);
    });

    try {
      const requestStart = Date.now();
      await message.channel.sendTyping();

      const userContent = message.content.replace(`<@${client.user!.id}>`, '').trim();
      const imageAttachments = message.attachments.filter(
        att => att.contentType?.startsWith('image/') && att.size <= 20 * 1024 * 1024
      );
      const currentImageUrls = imageAttachments.map(att => att.url);
      const replyContext = await resolveReplyContext(message, 2);

      // === Phase 1: Gates (moderation + quota — can early-exit) ===
      // Run content moderation and member fetch in parallel (independent operations)
      const [moderationResult, member] = await Promise.all([
        contentSanitizer.processContent(userContent, message.guildId, message.author.id, 'message'),
        message.guild!.members.fetch(message.author.id)
      ]);

      const { processedContent, moderation } = moderationResult;

      if (!moderation.allowed) {
        const decision = safetyMonitor.recordIncident({
          guildId: message.guildId,
          incidentType: 'input_blocked',
          categories: moderation.flaggedCategories
        });

        if (decision.shouldAlert) {
          const config = safetyMonitor.getConfig();
          const killSwitchMessage = decision.killSwitchActivated
            ? ` Kill switch activated until ${decision.killSwitchUntil?.toISOString()}.`
            : '';
          void notifySafetyAlert(
            message.guildId,
            `[SAFETY] Block-rate threshold reached (${decision.blockedCountInWindow}/${config.blockThreshold} within ${Math.floor(config.windowMs / 60000)}m).${killSwitchMessage}`
          );
        }

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

      const conversationContext = assembleConversationContext({
        processedContent,
        currentImageUrls,
        replyContext,
        maxVisionTargets: 2
      });

      logger.info(`[Perf] Gates completed in ${Date.now() - requestStart}ms`);

      // === Phase 2: Config lookups (parallel — both are independent DB reads) ===
      const configStart = Date.now();
      const [serverConfig, systemPromptResult] = await Promise.all([
        adminDb.getServerConfig(message.guildId),
        adminDb.getSystemPrompt(message.guildId)
      ]);

      const preferredProvider = serverConfig?.defaultProvider;
      const textProvider = providers.getTextProvider(preferredProvider || undefined);
      const visionProvider = providers.getVisionProvider(preferredProvider || undefined);
      const visionRouting = decideVisionRouting(conversationContext, visionProvider);
      const useVision = visionRouting.useVision;

      const blockedByVisionPrecheck = await enforceVisionRoutingPrecheck(message, visionRouting);
      if (blockedByVisionPrecheck) {
        return;
      }

      let estimatedTokens = 0;
      let visionUserLimit: number | undefined;
      let textUserLimit: number | undefined;

      if (useVision) {
        const estimatedVisionTokens = visionRouting.estimatedVisionTokens;
        const visionQuotaCheck = await quotaMiddleware.checkQuota(
          message.guildId,
          message.author.id,
          member,
          'vision_tokens',
          estimatedVisionTokens
        );

        if (!visionQuotaCheck.allowed) {
          await quotaMiddleware.markForResetNotification(
            message.guildId,
            message.author.id,
            message.channelId
          );
          await message.reply({
            content: `⚠️ ${visionQuotaCheck.reason}`,
            allowedMentions: { repliedUser: false }
          });
          return;
        }

        visionUserLimit = visionQuotaCheck.max;
      } else {
        estimatedTokens = await quotaMiddleware.estimateResponseTokens(processedContent.length);
        const quotaCheck = await quotaMiddleware.checkQuota(
          message.guildId,
          message.author.id,
          member,
          'text_tokens',
          estimatedTokens
        );

        if (!quotaCheck.allowed) {
          await quotaMiddleware.markForResetNotification(
            message.guildId,
            message.author.id,
            message.channelId
          );
          await message.reply({
            content: `⚠️ ${quotaCheck.reason}`,
            allowedMentions: { repliedUser: false }
          });
          return;
        }

        textUserLimit = quotaCheck.max;
      }

      logger.info(
        `Guild ${message.guildId} using provider: ${textProvider.name} (configured: ${preferredProvider || 'default'})`
      );

      const { prompt: dbPrompt, enabled: promptEnabled } = systemPromptResult;
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
      const promptPolicy = resolvePromptPolicy({
        customPrompt: promptConfig.prompt,
        defaultPrompt,
        allowedPromptHashesRaw: process.env.SAFETY_ALLOWED_PROMPT_HASHES
      });
      const systemPrompt = composeSystemPromptWithSafety(promptPolicy.effectivePrompt);
      const conciseResponseInstruction =
        '\n\nResponse style rule: Keep responses concise and clear by default (2-4 sentences). Only provide longer responses when the user explicitly asks for detail.';
      const userUsedEmoji = /\p{Extended_Pictographic}/u.test(processedContent);
      const userRequestedRichFormatting =
        /\b(markdown|format|formatted|bullet|bulleted|list|table|code\s*block|bold|italic|emoji|emojis|styled|style)\b/i.test(
          processedContent
        );
      const plainStyleInstruction = userRequestedRichFormatting
        ? ''
        : '\n\nFormatting rule: Use plain text by default. Avoid markdown styling (bold/italics/lists) and avoid emojis unless the user explicitly asks for them.';

      const promptHash = promptPolicy.promptHash;

      logger.info(
        `Prompt context for guild ${message.guildId}: promptHash=${promptHash}, source=${promptPolicy.usedCustomPrompt ? 'custom' : 'default'}, customPromptHash=${promptPolicy.customPromptHash || 'none'}`
      );

      if (promptPolicy.rejectedCustomPrompt) {
        logger.warn(
          `Rejected custom prompt hash for guild ${message.guildId}: ${promptPolicy.customPromptHash}. Falling back to default prompt policy.`
        );
      }

      if (promptConfig.warnings.length > 0) {
        logger.warn(
          `System prompt warnings for guild ${message.guildId}: ${promptConfig.warnings.join(', ')}`
        );
      }

      logger.info(`[Perf] Config loaded in ${Date.now() - configStart}ms`);

      // === Phase 3: Data fetch (parallel — history, memory, store user msg) ===
      const dataStart = Date.now();
      const guildId = message.guildId;

      // Build memory retrieval as a parallel task
      const memoryPromise = (async () => {
        try {
          const selection = await selectMemoryContext({
            db,
            registry: providers,
            config,
            serverId: guildId,
            userId: message.author.id,
            content: conversationContext.mergedUserContent
          });

          if (selection.selected.length > 0) {
            if (selection.usedFallback) {
              logger.info(
                `Retrieved ${selection.selected.length} fallback memories for user ${message.author.id}`
              );
            } else {
              logger.info(
                `Retrieved ${selection.selected.length} lore-triggered memories for user ${message.author.id} (mentionConfidence=${selection.mentionConfidence.toFixed(2)})`
              );
            }
          }

          return selection;
        } catch (error) {
          logger.warn('Failed to retrieve memories:', error);
          return {
            context: '',
            selected: [],
            shouldMention: false,
            mentionConfidence: 0,
            usedFallback: false
          };
        }
      })();

      // Run history fetch and memory retrieval in parallel
      const [history, memorySelection] = await Promise.all([
        db.getConversationHistory(message.channelId, promptHash, 10),
        memoryPromise
      ]);

      const messages = history.map(msg => ({
        role: msg.role,
        content: [
          msg.role === 'user' ? `[User: ${msg.userId}] ${msg.content}` : msg.content,
          msg.imageSummary ? `[Image context]\n${msg.imageSummary}` : ''
        ]
          .filter(Boolean)
          .join('\n\n')
      }));

      const memoryContext = memorySelection.context;
      const hasLoreMemorySelected = memorySelection.selected.some(
        memory => memory.contextType === 'lore'
      );
      const memoryMentionInstruction = memorySelection.shouldMention
        ? hasLoreMemorySelected
          ? '\n\nMemory usage rule: If lore memory context is relevant, prioritize it as canonical and answer consistently with it. Do not contradict the provided lore.'
          : '\n\nMemory usage rule: If memory context strongly matches the user request, you may reference it briefly and naturally.'
        : '\n\nMemory usage rule: Use memory context silently when helpful. Do not explicitly say you are recalling memory unless the user directly asks.';
      const memoryConflictInstruction =
        "\n\nMemory conflict rule: If memories conflict with each other or with the user's latest message, state uncertainty and ask a clarifying question instead of guessing.";

      const memoryItemCount = (memoryContext.match(/\n- \[/g) || []).length;
      if (memoryItemCount > 0) {
        const selectedSummary = memorySelection.selected
          .map(memory => {
            const scope = 'serverId' in memory ? 'server' : 'user';
            return `${scope}:${memory.id.slice(0, 8)}:${memory.contextType}`;
          })
          .join(', ');
        logger.info(
          `Injected ${memoryItemCount} memories into prompt for user ${message.author.id} (${memoryContext.length} chars): ${selectedSummary}`
        );
      }

      logger.info(`[Perf] Data fetched in ${Date.now() - dataStart}ms`);

      // === Phase 4: LLM call ===
      const llmStart = Date.now();
      let usedVision = false;
      let visionTokensUsed = 0;
      const MAX_TEXT_RESPONSE_TOKENS = 180;
      const imageSummaries: string[] = [];

      if (useVision && visionProvider?.analyzeImage) {
        for (const [index, target] of conversationContext.visionTargets.entries()) {
          const sourceLabel =
            target.source === 'reply' && target.replyDepth
              ? `reply_level_${target.replyDepth}`
              : 'current_message';
          const visionPrompt = [
            'Summarize this image for downstream conversation grounding.',
            'Keep output factual, concise, and neutral (max 3 sentences).',
            'Include visible text if present.',
            `Source: ${sourceLabel}.`,
            `User request: ${conversationContext.mergedUserContent || 'Describe image context.'}`
          ].join('\n');

          const visionResult = await visionProvider.analyzeImage(target.url, visionPrompt, {
            maxTokens: 140
          });

          const normalizedSummary = visionResult.content.replace(/\s+/g, ' ').trim();
          imageSummaries.push(`[${index + 1}|${sourceLabel}] ${normalizedSummary}`);
          visionTokensUsed +=
            visionResult.usage?.totalTokens ||
            visionResult.usage?.completionTokens ||
            visionResult.usage?.promptTokens ||
            120;
        }

        usedVision = imageSummaries.length > 0;
      }

      const imageSummaryBlock = buildImageSummaryBlock(imageSummaries);
      const mergedUserPrompt = [conversationContext.mergedUserContent, imageSummaryBlock]
        .filter(Boolean)
        .join('\n\n');

      const response = await textProvider.generateText(
        [
          {
            role: 'system',
            content: `${systemPrompt}${conciseResponseInstruction}${plainStyleInstruction}${memoryMentionInstruction}${memoryConflictInstruction}${memoryContext}`
          },
          ...messages,
          {
            role: 'user',
            content: mergedUserPrompt || processedContent
          }
        ],
        {
          maxTokens: MAX_TEXT_RESPONSE_TOKENS
        }
      );

      logger.info(
        `[Perf] LLM responded in ${Date.now() - llmStart}ms (model: ${response.model || 'unknown'}${usedVision ? ', vision' : ''})`
      );

      // === Phase 5: Moderate output, reply, then fire-and-forget post-LLM writes ===
      // Discord has a 2000 character limit for messages
      const MAX_MESSAGE_LENGTH = 2000;
      let responseContent = response.content;

      const assistantModeration = await contentSanitizer.moderateContent(
        response.content,
        message.guildId,
        message.author.id,
        'message',
        { failClosedOnError: true }
      );

      if (!assistantModeration.allowed) {
        const incidentType = assistantModeration.flaggedCategories.includes('api_error_fail_closed')
          ? 'moderation_api_fail_closed'
          : 'output_blocked';
        const decision = safetyMonitor.recordIncident({
          guildId: message.guildId,
          incidentType,
          categories: assistantModeration.flaggedCategories
        });

        if (decision.shouldAlert) {
          const config = safetyMonitor.getConfig();
          const killSwitchMessage = decision.killSwitchActivated
            ? ` Kill switch activated until ${decision.killSwitchUntil?.toISOString()}.`
            : '';
          void notifySafetyAlert(
            message.guildId,
            `[SAFETY] Assistant output blocked (${decision.blockedCountInWindow}/${config.blockThreshold} within ${Math.floor(config.windowMs / 60000)}m).${killSwitchMessage}`
          );
        }

        logger.warn(
          `Assistant output blocked for guild ${message.guildId}, user ${message.author.id}: ${assistantModeration.flaggedCategories.join(', ')}`
        );
        responseContent =
          'I can’t help with that request. Please rephrase and I can provide a safer alternative.';
      } else if (assistantModeration.action === 'warned') {
        safetyMonitor.recordIncident({
          guildId: message.guildId,
          incidentType: 'output_warned',
          categories: assistantModeration.flaggedCategories
        });
        logger.warn(
          `Assistant output warning for guild ${message.guildId}, user ${message.author.id}: ${assistantModeration.flaggedCategories.join(', ')}`
        );
      }

      if (!userRequestedRichFormatting) {
        responseContent = responseContent
          .replace(/(\*\*|__|\*|_|~~|`)/g, '')
          .replace(/^#{1,6}\s+/gm, '')
          .replace(/^\s*[-*+]\s+/gm, '')
          .replace(/\n{3,}/g, '\n\n');

        if (!userUsedEmoji) {
          responseContent = responseContent.replace(/\p{Extended_Pictographic}/gu, '');
        }
      }

      responseContent = sanitizeAssistantOutput(responseContent, {
        stripInternalMetadata: true,
        stripXmlLikeTags: true
      });

      if (!responseContent.trim()) {
        responseContent = 'Sorry, I could not generate a valid response. Please try again.';
      }

      if (responseContent.length > MAX_MESSAGE_LENGTH) {
        // Truncate and add ellipsis
        responseContent = responseContent.substring(0, MAX_MESSAGE_LENGTH - 4) + '...';
        logger.warn(
          `Response truncated for message in guild ${message.guildId}: ${response.content.length} -> ${responseContent.length} characters`
        );
      }

      await message.reply({
        content: responseContent,
        allowedMentions: { repliedUser: false }
      });

      logger.info(
        `Response trace: guild=${message.guildId}, user=${message.author.id}, promptHash=${promptHash}, model=${response.model || 'unknown'}, usedVision=${usedVision}, memoryItems=${memorySelection.selected.length}, memoryMode=${memorySelection.usedFallback ? 'fallback' : 'strong_or_none'}, moderationAction=${assistantModeration.action}`
      );

      logger.info(`[Perf] Total response time: ${Date.now() - requestStart}ms`);

      // Fire-and-forget: post-LLM writes don't block the user-facing response
      const actualTokens = response.usage?.totalTokens || response.usage?.completionTokens || 500;
      const conversationWrites = [
        db.storeConversationMessage({
          guildId: message.guildId,
          channelId: message.channelId,
          userId: message.author.id,
          discordMessageId: message.id,
          promptHash,
          role: 'user',
          content: processedContent,
          replyToMessageId: conversationContext.directReplyMessageId,
          replyToUserId: conversationContext.directReplyUserId,
          referencedContent: conversationContext.referencedContent || null,
          imageSummary: imageSummaryBlock || null
        }),
        db.storeConversationMessage({
          guildId: message.guildId,
          channelId: message.channelId,
          userId: message.author.id,
          promptHash,
          role: 'assistant',
          content: responseContent,
          replyToMessageId: conversationContext.directReplyMessageId,
          replyToUserId: conversationContext.directReplyUserId,
          referencedContent: conversationContext.referencedContent || null,
          imageSummary: imageSummaryBlock || null
        })
      ];

      if (usedVision) {
        const safeVisionUserLimit = Number.isFinite(visionUserLimit) ? visionUserLimit : undefined;
        Promise.all([
          ...conversationWrites,
          quotaMiddleware.recordUsage(
            message.guildId,
            message.author.id,
            'vision_tokens',
            Math.max(visionTokensUsed, actualTokens),
            safeVisionUserLimit
          )
        ]).catch(err => {
          logger.error('Failed to complete post-response writes:', err);
        });
      } else {
        const safeTextUserLimit = Number.isFinite(textUserLimit) ? textUserLimit : undefined;
        Promise.all([
          ...conversationWrites,
          quotaMiddleware.recordUsage(
            message.guildId,
            message.author.id,
            'text_tokens',
            actualTokens,
            safeTextUserLimit
          ),
          quotaMiddleware.logAccuracy(
            message.guildId,
            message.author.id,
            processedContent.length,
            estimatedTokens,
            actualTokens
          )
        ]).catch(err => {
          logger.error('Failed to complete post-response writes:', err);
        });
      }
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
