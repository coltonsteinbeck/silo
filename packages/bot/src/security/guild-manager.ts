/**
 * Guild Manager
 *
 * Handles guild onboarding, waitlist management, and eviction logic.
 * Respects deployment mode (hosted vs self-hosted) for guild limits.
 */

import {
  Client,
  Guild,
  TextChannel,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} from 'discord.js';
import { Pool } from 'pg';
import { deploymentDetector } from './deployment';

export interface GuildInfo {
  guildId: string;
  guildName: string;
  ownerId: string;
  memberCount: number;
  warningChannelId: string | null;
}

export interface WaitlistEntry {
  guildId: string;
  guildName: string;
  ownerId: string;
  memberCount: number;
  position: number;
}

export interface JoinResult {
  success: boolean;
  action: 'joined' | 'waitlisted' | 'self-hosted' | 'error';
  message: string;
  waitlistPosition?: number;
}

class GuildManager {
  private client: Client | null = null;
  private pool: Pool | null = null;

  /**
   * Initialize with database pool and Discord client
   */
  init(pool: Pool, client: Client): void {
    this.pool = pool;
    this.client = client;
  }

  /**
   * Set the Discord client reference
   */
  setClient(client: Client): void {
    this.client = client;
  }

  /**
   * Set the database pool
   */
  setPool(pool: Pool): void {
    this.pool = pool;
  }

  /**
   * Execute a query with type safety
   */
  private async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (!this.pool) {
      throw new Error('GuildManager not initialized - call init() first');
    }
    const result = await this.pool.query(sql, params);
    return result.rows as T[];
  }

  /**
   * Find the best channel to send warnings to
   * Priority: System channel > First text channel (by position)
   */
  async findWarningChannel(guild: Guild): Promise<TextChannel | null> {
    // Try system channel first
    if (guild.systemChannel && guild.systemChannel.type === ChannelType.GuildText) {
      const perms = guild.systemChannel.permissionsFor(guild.members.me!);
      if (perms?.has(['SendMessages', 'ViewChannel'])) {
        return guild.systemChannel;
      }
    }

    // Fall back to first text channel by position
    const textChannels = guild.channels.cache
      .filter(c => c.type === ChannelType.GuildText)
      .sort((a, b) => a.position - b.position);

    for (const [, channel] of textChannels) {
      const textChannel = channel as TextChannel;
      const perms = textChannel.permissionsFor(guild.members.me!);
      if (perms?.has(['SendMessages', 'ViewChannel'])) {
        return textChannel;
      }
    }

    return null;
  }

  /**
   * Get the count of active hosted guilds from database
   */
  async getActiveGuildCount(): Promise<number> {
    const result = await this.query<{ count: number }>(
      `SELECT get_active_hosted_guild_count() as count`
    );
    return result[0]?.count ?? 0;
  }

  /**
   * Check if a new guild can join (hosted mode capacity check)
   */
  async canJoinGuild(): Promise<boolean> {
    const config = deploymentDetector.getConfig();
    if (config.isSelfHosted) {
      return true;
    }

    const activeCount = await this.getActiveGuildCount();
    return activeCount < config.maxGuilds;
  }

  /**
   * Main entry point for guild join handling
   */
  async handleGuildJoin(guild: Guild): Promise<JoinResult> {
    const config = deploymentDetector.getConfig();
    const guildInfo = await this.extractGuildInfo(guild);

    // Non-production: Always allow (development or self-hosted)
    if (config.isSelfHosted) {
      await this.registerGuild(guildInfo, 'self-hosted');
      const modeLabel = config.isDevelopment ? 'development' : 'self-hosted';
      return {
        success: true,
        action: 'self-hosted',
        message: `Guild registered (${modeLabel} mode - unlimited guilds)`
      };
    }

    // Hosted mode: Check capacity
    const canJoin = await this.canJoinGuild();

    if (canJoin) {
      await this.registerGuild(guildInfo, 'hosted');
      return {
        success: true,
        action: 'joined',
        message: 'Guild registered successfully!'
      };
    }

    // At capacity: Add to waitlist
    const position = await this.addToWaitlist(guildInfo);

    // Send waitlist notification to the guild
    await this.sendWaitlistNotification(guild, position);

    return {
      success: false,
      action: 'waitlisted',
      message: `Added to waitlist at position #${position}`,
      waitlistPosition: position
    };
  }

  /**
   * Extract guild info from Discord guild object
   */
  private async extractGuildInfo(guild: Guild): Promise<GuildInfo> {
    const warningChannel = await this.findWarningChannel(guild);
    return {
      guildId: guild.id,
      guildName: guild.name,
      ownerId: guild.ownerId,
      memberCount: guild.memberCount,
      warningChannelId: warningChannel?.id ?? null
    };
  }

  /**
   * Register a guild in the database
   */
  async registerGuild(info: GuildInfo, mode: 'hosted' | 'self-hosted'): Promise<void> {
    await this.query(
      `INSERT INTO guild_registry (guild_id, guild_name, owner_id, member_count, warning_channel_id, deployment_mode)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (guild_id) DO UPDATE SET
                guild_name = EXCLUDED.guild_name,
                owner_id = EXCLUDED.owner_id,
                member_count = EXCLUDED.member_count,
                warning_channel_id = EXCLUDED.warning_channel_id,
                is_active = true,
                last_activity_at = NOW(),
                deactivated_at = NULL,
                scheduled_deletion_at = NULL,
                deactivation_reason = NULL`,
      [info.guildId, info.guildName, info.ownerId, info.memberCount, info.warningChannelId, mode]
    );
  }

  /**
   * Add guild to FIFO waitlist
   */
  async addToWaitlist(info: GuildInfo): Promise<number> {
    await this.query(
      `INSERT INTO guild_waitlist (guild_id, guild_name, owner_id, member_count)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (guild_id) DO UPDATE SET
                guild_name = EXCLUDED.guild_name,
                owner_id = EXCLUDED.owner_id,
                member_count = EXCLUDED.member_count,
                status = 'waiting'`,
      [info.guildId, info.guildName, info.ownerId, info.memberCount]
    );

    // Get position
    const result = await this.query<{ position: number }>(
      `SELECT get_waitlist_position($1) as position`,
      [info.guildId]
    );

    return result[0]?.position ?? 1;
  }

  /**
   * Send waitlist notification to guild with self-host option
   */
  private async sendWaitlistNotification(guild: Guild, position: number): Promise<void> {
    const channel = await this.findWarningChannel(guild);
    if (!channel) return;

    const embed = new EmbedBuilder()
      .setTitle('⏳ Added to Waitlist')
      .setColor(0xffa500) // Orange
      .setDescription(
        `Thank you for adding Silo to your server!\n\n` +
          `Due to high demand, we've reached our current capacity of **5 active guilds**. ` +
          `Your server has been added to our waitlist.`
      )
      .addFields(
        { name: 'Your Position', value: `#${position}`, inline: true },
        { name: 'Estimated Wait', value: 'Varies by activity', inline: true },
        { name: '\u200b', value: '\u200b', inline: true },
        {
          name: 'What happens next?',
          value:
            "When a spot opens up, we'll send a notification here. You'll have **48 hours** to activate your slot."
        },
        {
          name: "🖥️ Can't wait?",
          value:
            'You can self-host Silo with your own database for unlimited guilds!\n' +
            'Check the repository README for self-hosting instructions.'
        }
      )
      .setFooter({ text: 'Silo AI Bot • Waitlist System' })
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('waitlist_check_position')
        .setLabel('Check Position')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('📊')
    );

    try {
      await channel.send({ embeds: [embed], components: [row] });
    } catch (error) {
      console.error(`Failed to send waitlist notification to ${guild.name}:`, error);
    }
  }

  /**
   * Handle guild leave/kick
   */
  async handleGuildLeave(guildId: string): Promise<void> {
    await this.query(`SELECT deactivate_guild($1, 'left')`, [guildId]);

    // Remove from waitlist if present
    await this.query(`DELETE FROM guild_waitlist WHERE guild_id = $1`, [guildId]);

    // Try to promote next from waitlist
    await this.promoteFromWaitlist();
  }

  /**
   * Evict a guild due to inactivity
   */
  async evictGuild(guildId: string, sendNotification: boolean = true): Promise<void> {
    if (sendNotification && this.client) {
      try {
        const guild = await this.client.guilds.fetch(guildId);
        const channel = await this.findWarningChannel(guild);

        if (channel) {
          const embed = new EmbedBuilder()
            .setTitle('👋 Silo Deactivated')
            .setColor(0xff0000) // Red
            .setDescription(
              `Due to **30 days of inactivity**, Silo has been deactivated on this server.\n\n` +
                `Your data will be retained for **30 days** in case you want to return.`
            )
            .addFields(
              {
                name: 'Want to return?',
                value:
                  "Simply use any Silo command to rejoin. If we're at capacity, you'll be added to the waitlist."
              },
              {
                name: 'Data retention',
                value:
                  "Your memories and preferences are saved for 30 days. After that, they'll be permanently deleted."
              }
            )
            .setFooter({ text: 'Silo AI Bot • Inactivity Eviction' })
            .setTimestamp();

          await channel.send({ embeds: [embed] });
        }
      } catch (error) {
        console.error(`Failed to send eviction notification to guild ${guildId}:`, error);
      }
    }

    // Mark as inactive in database
    await this.query(`SELECT deactivate_guild($1, 'inactivity')`, [guildId]);

    // Promote next from waitlist
    await this.promoteFromWaitlist();
  }

  /**
   * Promote the next guild from waitlist
   */
  async promoteFromWaitlist(): Promise<WaitlistEntry | null> {
    const result = await this.query<{ guild_id: string; owner_id: string; guild_name: string }>(
      `SELECT * FROM promote_from_waitlist()`
    );

    const promoted = result[0];
    if (!promoted) return null;

    // Send notification to the promoted guild
    if (this.client) {
      try {
        const guild = await this.client.guilds.fetch(promoted.guild_id);
        const channel = await this.findWarningChannel(guild);

        if (channel) {
          const embed = new EmbedBuilder()
            .setTitle('🎉 Your spot is ready!')
            .setColor(0x00ff00) // Green
            .setDescription(
              `Great news! A spot has opened up and **${guild.name}** can now use Silo!\n\n` +
                `You have **48 hours** to activate your slot by using any Silo command.`
            )
            .addFields(
              {
                name: 'How to activate',
                value: 'Simply use any Silo command (like `/ask` or `/chat`) to confirm your spot.'
              },
              {
                name: '⚠️ Important',
                value:
                  "If you don't activate within 48 hours, your spot will go to the next server in line."
              }
            )
            .setFooter({ text: 'Silo AI Bot • Waitlist Promotion' })
            .setTimestamp();

          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId('waitlist_activate')
              .setLabel('Activate Now')
              .setStyle(ButtonStyle.Success)
              .setEmoji('✅')
          );

          await channel.send({
            content: `<@${guild.ownerId}>`,
            embeds: [embed],
            components: [row]
          });
        }
      } catch (error) {
        console.error(`Failed to send promotion notification:`, error);
      }
    }

    return {
      guildId: promoted.guild_id,
      guildName: promoted.guild_name,
      ownerId: promoted.owner_id,
      memberCount: 0,
      position: 0
    };
  }

  /**
   * Update activity timestamp for a guild
   */
  async updateActivity(guildId: string): Promise<void> {
    await this.query(`SELECT update_guild_activity($1)`, [guildId]);
  }

  /**
   * Send inactivity warning to a guild
   */
  async sendInactivityWarning(
    guildId: string,
    daysInactive: number,
    warningChannelId: string | null
  ): Promise<boolean> {
    if (!this.client) return false;

    try {
      const guild = await this.client.guilds.fetch(guildId);
      const channel = warningChannelId
        ? ((await guild.channels.fetch(warningChannelId)) as TextChannel)
        : await this.findWarningChannel(guild);

      if (!channel) return false;

      const daysRemaining = 30 - daysInactive;
      const urgencyColor = daysRemaining <= 2 ? 0xff0000 : daysRemaining <= 3 ? 0xffa500 : 0xffff00;

      const embed = new EmbedBuilder()
        .setTitle('⚠️ Inactivity Warning')
        .setColor(urgencyColor)
        .setDescription(
          `This server hasn't used Silo in **${daysInactive} days**.\n\n` +
            `To keep our limited slots available for active communities, ` +
            `inactive servers are automatically rotated out.`
        )
        .addFields(
          {
            name: 'Days remaining',
            value: `**${daysRemaining}** day${daysRemaining === 1 ? '' : 's'}`,
            inline: true
          },
          {
            name: 'To stay active',
            value: 'Use any Silo command',
            inline: true
          }
        )
        .setFooter({ text: `Warning ${daysInactive - 24}/5 • Silo AI Bot` })
        .setTimestamp();

      if (daysRemaining <= 2) {
        embed.addFields({
          name: '🚨 Final Warning',
          value: 'Your server will be deactivated soon! Use any command now to reset the timer.'
        });
      }

      await channel.send({ embeds: [embed] });

      // Mark warning as sent
      await this.query(`SELECT mark_warning_sent($1)`, [guildId]);

      return true;
    } catch (error) {
      console.error(`Failed to send inactivity warning to guild ${guildId}:`, error);
      return false;
    }
  }

  /**
   * Get waitlist position for a guild
   */
  async getWaitlistPosition(guildId: string): Promise<number | null> {
    const result = await this.query<{ position: number }>(
      `SELECT get_waitlist_position($1) as position`,
      [guildId]
    );
    return result[0]?.position ?? null;
  }

  /**
   * Check if a guild is on the waitlist
   */
  async isOnWaitlist(guildId: string): Promise<boolean> {
    const result = await this.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM guild_waitlist WHERE guild_id = $1 AND status IN ('waiting', 'notified')) as exists`,
      [guildId]
    );
    return result[0]?.exists ?? false;
  }

  /**
   * Accept waitlist promotion (guild confirms they want the spot)
   */
  async acceptWaitlistPromotion(guildId: string): Promise<boolean> {
    const result = await this.query<{ status: string }>(
      `SELECT status FROM guild_waitlist WHERE guild_id = $1`,
      [guildId]
    );

    if (result[0]?.status !== 'notified') {
      return false;
    }

    // Update waitlist status
    await this.query(`UPDATE guild_waitlist SET status = 'joined' WHERE guild_id = $1`, [guildId]);

    // Register as active guild
    if (this.client) {
      try {
        const guild = await this.client.guilds.fetch(guildId);
        const info = await this.extractGuildInfo(guild);
        await this.registerGuild(info, 'hosted');
      } catch (error) {
        console.error(`Failed to register promoted guild ${guildId}:`, error);
        return false;
      }
    }

    return true;
  }
}

// Export singleton instance
export const guildManager = new GuildManager();
