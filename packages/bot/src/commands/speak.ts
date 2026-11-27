import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  GuildMember,
  ChannelType,
  PermissionFlagsBits
} from 'discord.js';
import type { Command } from './types';
import { logger } from '@silo/core';
import { voiceSessionManager } from '../voice';
import { areGuildSafeguardsEnabled } from '../security/guild-safeguards';
import { AdminAdapter } from '../database/admin-adapter';
import {
  systemPromptManager,
  resolveManagedGuildPersonaPolicy,
  composeSystemPromptWithSafety,
  deploymentDetector,
  resolvePromptPolicy
} from '../security';
import { QuotaMiddleware } from '../middleware/quota';
import type { QuotaReservationRow } from '../database/admin-adapter';
import type { VoiceQuotaJournal } from '../voice/quota-journal';

const MAX_VOICE_SESSION_MINUTES = 10;

export class SpeakCommand implements Command {
  public readonly data = new SlashCommandBuilder()
    .setName('speak')
    .setDescription('Start a voice conversation with Silo in a voice channel')
    .addChannelOption(option =>
      option
        .setName('channel')
        .setDescription('Voice channel to join (defaults to your current channel)')
        .setRequired(false)
        .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
    )
    .addStringOption(option =>
      option
        .setName('voice')
        .setDescription('Voice to use for responses')
        .setRequired(false)
        .addChoices(
          { name: 'Alloy (neutral)', value: 'alloy' },
          { name: 'Ash (conversational)', value: 'ash' },
          { name: 'Ballad (warm)', value: 'ballad' },
          { name: 'Coral (friendly)', value: 'coral' },
          { name: 'Echo (clear)', value: 'echo' },
          { name: 'Sage (calm)', value: 'sage' },
          { name: 'Shimmer (soft)', value: 'shimmer' },
          { name: 'Verse (expressive)', value: 'verse' }
        )
    );

  constructor(
    private adminDb: AdminAdapter,
    private quotaMiddleware?: QuotaMiddleware,
    private voiceQuotaJournal?: VoiceQuotaJournal
  ) {}

  async execute(interaction: ChatInputCommandInteraction) {
    const member = interaction.member as GuildMember;
    if (!interaction.guildId || !member?.voice) {
      await interaction.reply({
        content: 'This command requires a server voice channel.',
        ephemeral: true
      });
      return;
    }
    const selectedChannel = interaction.options.getChannel('channel');

    // Determine which voice channel to use
    let voiceChannel;
    if (selectedChannel) {
      // User specified a channel - fetch full channel from guild to get voiceAdapterCreator
      const fetchedChannel = await interaction.guild!.channels.fetch(selectedChannel.id);
      if (!fetchedChannel) {
        await interaction.reply({
          content: 'Could not find the specified channel.',
          ephemeral: true
        });
        return;
      }
      voiceChannel = fetchedChannel;
    } else {
      // Default to user's current voice channel
      voiceChannel = member.voice.channel;
    }

    // Check if user is in a voice channel (if no channel specified)
    if (!voiceChannel) {
      await interaction.reply({
        content: 'You need to be in a voice channel or specify a channel to join.',
        ephemeral: true
      });
      return;
    }

    // Check if it's a valid voice channel type
    if (
      voiceChannel.type !== ChannelType.GuildVoice &&
      voiceChannel.type !== ChannelType.GuildStageVoice
    ) {
      await interaction.reply({
        content: 'Please select a regular voice channel.',
        ephemeral: true
      });
      return;
    }

    const hasChannelAccess = () =>
      member.voice.channelId === voiceChannel.id &&
      voiceChannel
        .permissionsFor(interaction.user)
        ?.has([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.Connect,
          PermissionFlagsBits.Speak
        ]);
    if (!hasChannelAccess()) {
      await interaction.reply({
        content: 'Join the voice channel with View Channel, Connect, and Speak permissions first.',
        ephemeral: true
      });
      return;
    }

    const guildId = interaction.guildId!;
    const userId = interaction.user.id;

    // Check if user is already speaking
    if (voiceSessionManager.isUserSpeaking(guildId, userId)) {
      await interaction.reply({
        content: 'You already have an active voice session. Use `/stopspeaking` to end it first.',
        ephemeral: true
      });
      return;
    }

    const quota = this.quotaMiddleware;
    const journal = this.voiceQuotaJournal;
    if (!quota || !journal) {
      await interaction.reply({ content: 'Voice quota is unavailable.', ephemeral: true });
      return;
    }

    try {
      journal.assertReady();
    } catch {
      logger.error('Voice quota journal is unavailable');
      await interaction.reply({ content: 'Voice quota is unavailable.', ephemeral: true });
      return;
    }

    await interaction.deferReply();

    const hadExistingGuildSession = voiceSessionManager.hasSession(guildId);
    let reservation: QuotaReservationRow | undefined;
    let journaledStart = false;
    let providerStarted = false;

    try {
      // Get OpenAI API key from environment
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        await interaction.editReply({
          content: 'Voice features are not configured. Please contact the bot administrator.'
        });
        return;
      }

      // Get the voice system prompt for this guild
      const { prompt: dbPrompt, enabled: promptEnabled } = await this.adminDb.getSystemPrompt(
        guildId,
        true
      );
      const promptConfig = systemPromptManager.getEffectivePrompt(dbPrompt, promptEnabled, true);
      const managedPersona = resolveManagedGuildPersonaPolicy(guildId);
      const safeguardsEnabled = await areGuildSafeguardsEnabled(guildId);
      const managedPrompt = safeguardsEnabled
        ? managedPersona?.prompt
        : managedPersona?.promptWithoutContentSafeguards || managedPersona?.prompt;
      const promptPolicy = resolvePromptPolicy({
        customPrompt:
          managedPrompt || managedPersona?.customPromptsDisabled ? null : promptConfig.prompt,
        defaultPrompt:
          managedPrompt ||
          'You are a helpful AI assistant in a Discord voice channel. Keep responses concise and conversational.',
        allowedPromptHashesRaw: process.env.SAFETY_ALLOWED_PROMPT_HASHES,
        requireCustomPromptAllowlist: deploymentDetector.getConfig().isProduction
      });
      const instructions = composeSystemPromptWithSafety(
        promptPolicy.effectivePrompt,
        safeguardsEnabled
      );

      const admission = await quota.reserveQuota({
        operationKey: `discord:${interaction.id}:speak`,
        guildId,
        userId,
        member,
        usageType: 'voice_minutes',
        requestedAmount: MAX_VOICE_SESSION_MINUTES,
        minimumAmount: 1
      });
      if (!admission.allowed) {
        await interaction.editReply({ content: admission.reason });
        return;
      }
      reservation = admission.reservation;
      const reserved = reservation;
      if (!hasChannelAccess()) throw new Error('The requester lost access to the voice channel.');

      // Join the voice channel if not already connected
      const connection = await voiceSessionManager.joinChannel(voiceChannel);

      // Start the realtime session for this user with custom instructions
      const voice = interaction.options.getString('voice') || 'alloy';
      const session = await voiceSessionManager.startSpeaking(guildId, userId, apiKey, {
        voice,
        assistantSafetyPolicy: managedPersona?.assistantSafetyPolicy,
        instructions,
        maxDurationMs: reserved.reservedAmount * 60_000,
        beforeConnect: async () => {
          if (!hasChannelAccess()) {
            throw new Error('The requester lost access to the voice channel.');
          }
          journal.begin(reserved.idempotencyKey);
          journaledStart = true;
          await quota.markQuotaAttempted(reserved);
        },
        authorizeConnection: () => {
          if (!hasChannelAccess()) {
            throw new Error(
              'The requester lost access to the voice channel before speech started.'
            );
          }
          journal.authorize(reserved.idempotencyKey, reserved.reservedAmount);
          providerStarted = true;
        },
        onEnd: durationMs => {
          const minutes = Math.max(
            1,
            Math.min(reserved.reservedAmount, Math.ceil(durationMs / 60_000))
          );
          journal.record(reserved.idempotencyKey, minutes);
          void journal.flush();
        }
      });

      // Configure voice preference and send greeting
      if (session) {
        session.attachConnection(connection);

        // Send a greeting message when first speaker joins
        const activeSpeakers = voiceSessionManager.getActiveSpeakerCount(guildId);
        if (activeSpeakers === 1) {
          // First speaker - send welcome greeting
          session.sendGreeting();
        }
      }

      const activeSpeakers = voiceSessionManager.getActiveSpeakerCount(guildId);
      const speakerInfo =
        activeSpeakers > 1
          ? `There are now ${activeSpeakers} active speakers in this channel.`
          : '';

      await interaction.editReply({
        content: `Voice session started in **${voiceChannel.name}**. Speak naturally and Silo will respond. ${speakerInfo}\n\nUse \`/stopspeaking\` when you're done.`
      });
    } catch (error) {
      logger.error('[SpeakCommand] Error:', error);

      if (reservation && !providerStarted) {
        if (journaledStart) {
          journal.cancel(reservation.idempotencyKey);
          void journal.flush();
        } else {
          await quota.releaseUnattemptedQuota(reservation, 'voice_start_cancelled').catch(() => {
            logger.warn('Unattempted voice reservation release is pending');
          });
        }
      }

      if (
        !hadExistingGuildSession &&
        voiceSessionManager.hasSession(guildId) &&
        voiceSessionManager.getActiveSpeakerCount(guildId) === 0
      ) {
        await voiceSessionManager.leaveGuild(guildId).catch(cleanupError => {
          logger.warn(
            '[SpeakCommand] Failed to roll back an unused voice connection',
            cleanupError
          );
        });
      }

      await interaction.editReply({
        content: 'Could not start a voice session in this channel. Check access and try again.'
      });
    }
  }
}
