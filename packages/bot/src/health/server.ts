/**
 * Health Check Server
 *
 * Lightweight HTTP server for Docker healthchecks and healthchecks.io integration
 */

import { Client, TextChannel } from 'discord.js';
import { PostgresAdapter } from '../database/postgres';
import { AdminAdapter } from '../database/admin-adapter';
import { logger } from '@silo/core';

interface HealthStatus {
  status: 'healthy' | 'unhealthy';
  timestamp: string;
  uptime: number;
  discord: {
    ready: boolean;
    ping: number;
    guilds: number;
    shards?: number;
  };
  database: {
    connected: boolean;
    responseTime?: number;
  };
}

export class HealthServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private healthchecksUrl: string | null = null;
  private pingInterval: Timer | null = null;
  private discordNotifyInterval: Timer | null = null;
  private adminDb: AdminAdapter | null = null;
  private startTime = Date.now();
  private lastHealthStatus: 'healthy' | 'unhealthy' | null = null;

  constructor(
    private client: Client,
    private db: PostgresAdapter,
    private port: number = 3000
  ) {
    // Support both HEALTHCHECKS_URL and HEALTH_CHECK_SECRET for healthcheck.io URL
    this.healthchecksUrl = process.env.HEALTHCHECKS_URL || process.env.HEALTH_CHECK_SECRET || null;
    this.adminDb = new AdminAdapter(db.pool);
  }

  async start(): Promise<void> {
    // Try to start server, with fallback ports if primary is in use
    const ports = [this.port, this.port + 1, this.port + 2, 0]; // 0 = random available port

    for (const port of ports) {
      try {
        this.server = Bun.serve({
          port,
          fetch: async req => {
            const url = new URL(req.url);

            if (url.pathname === '/health') {
              const health = await this.getHealthStatus();
              const status = health.status === 'healthy' ? 200 : 503;

              return new Response(JSON.stringify(health, null, 2), {
                status,
                headers: { 'Content-Type': 'application/json' }
              });
            }

            return new Response('Not Found', { status: 404 });
          }
        });

        this.port = this.server.port ?? port;
        logger.info(`Health server started on port ${this.port}`);
        break;
      } catch (error) {
        if (port === 0) {
          logger.error('Failed to start health server on any port:', error);
          return; // Don't crash the bot, just skip health server
        }
        logger.warn(`Port ${port} in use, trying next...`);
      }
    }

    // Start healthchecks.io pinging if configured
    if (this.healthchecksUrl) {
      this.startHealthchecksPing();
    }

    // Start Discord channel health notifications
    this.startDiscordHealthNotifications();

    // Handle graceful shutdown
    process.on('SIGTERM', () => this.sendFailurePing());
    process.on('SIGINT', () => this.sendFailurePing());
  }

  async stop(): Promise<void> {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }

    if (this.discordNotifyInterval) {
      clearInterval(this.discordNotifyInterval);
    }

    if (this.server) {
      this.server.stop();
      logger.info('Health server stopped');
    }

    // Notify Discord channels of shutdown
    await this.notifyDiscordChannels('shutdown');
    await this.sendFailurePing();
  }

  private async getHealthStatus(): Promise<HealthStatus> {
    const uptime = Date.now() - this.startTime;

    // Check Discord client
    const discordReady = this.client.isReady();
    const ping = discordReady ? this.client.ws.ping : -1;
    const guilds = discordReady ? this.client.guilds.cache.size : 0;

    // Check database
    let dbConnected = false;
    let dbResponseTime: number | undefined;
    try {
      const start = Date.now();
      dbConnected = await this.db.healthCheck();
      dbResponseTime = Date.now() - start;
    } catch (error) {
      logger.error('Database health check failed:', error);
    }

    const isHealthy = discordReady && dbConnected;

    return {
      status: isHealthy ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      uptime: Math.floor(uptime / 1000),
      discord: {
        ready: discordReady,
        ping,
        guilds
      },
      database: {
        connected: dbConnected,
        responseTime: dbResponseTime
      }
    };
  }

  private startHealthchecksPing(): void {
    if (!this.healthchecksUrl) return;

    // Ping every 60 seconds (healthchecks.io best practice)
    this.pingInterval = setInterval(async () => {
      try {
        const health = await this.getHealthStatus();

        if (health.status === 'healthy') {
          await fetch(this.healthchecksUrl!);
          logger.debug('Healthchecks.io ping sent successfully');
        } else {
          // Send failure signal (append /fail to URL)
          await fetch(`${this.healthchecksUrl}/fail`);
          logger.warn('Healthchecks.io failure ping sent');
        }
      } catch (error) {
        logger.error('Failed to ping healthchecks.io:', error);
      }
    }, 60000); // 60 seconds

    logger.info('Healthchecks.io integration enabled');
  }

  private async sendFailurePing(): Promise<void> {
    if (!this.healthchecksUrl) return;

    try {
      await fetch(`${this.healthchecksUrl}/fail`);
      logger.info('Sent failure ping to healthchecks.io');
    } catch (error) {
      logger.error('Failed to send failure ping:', error);
    }
  }

  /**
   * Start periodic health notifications to Discord channels
   * Only sends notifications when health status changes
   */
  private startDiscordHealthNotifications(): void {
    // Check health and notify every 5 minutes, but only on status change
    this.discordNotifyInterval = setInterval(async () => {
      try {
        const health = await this.getHealthStatus();

        // Only notify on status change
        if (this.lastHealthStatus !== health.status) {
          await this.notifyDiscordChannels(health.status);
          this.lastHealthStatus = health.status;
        }
      } catch (error) {
        logger.error('Failed to check health for Discord notifications:', error);
      }
    }, 300000); // 5 minutes

    logger.info('Discord health notifications enabled');
  }

  /**
   * Send health status to all configured alert channels
   */
  private async notifyDiscordChannels(status: 'healthy' | 'unhealthy' | 'shutdown'): Promise<void> {
    if (!this.client.isReady() || !this.adminDb) return;

    const guilds = this.client.guilds.cache;

    for (const [guildId, guild] of guilds) {
      try {
        const alertChannelId = await this.adminDb.getAlertsChannel(guildId);
        if (!alertChannelId) continue;

        const channel = await guild.channels.fetch(alertChannelId);
        if (!channel || !(channel instanceof TextChannel)) continue;

        const health = await this.getHealthStatus();
        const embed = this.createHealthEmbed(status, health);

        await channel.send({ embeds: [embed] });
        logger.debug(`Sent health notification to ${guild.name}`);
      } catch (error) {
        logger.error(`Failed to send health notification to guild ${guildId}:`, error);
      }
    }
  }

  /**
   * Create a Discord embed for health status
   */
  private createHealthEmbed(status: 'healthy' | 'unhealthy' | 'shutdown', health: HealthStatus) {
    const statusEmoji = status === 'healthy' ? '✅' : status === 'unhealthy' ? '⚠️' : '🔴';
    const statusColor =
      status === 'healthy' ? 0x00ff00 : status === 'unhealthy' ? 0xffaa00 : 0xff0000;
    const statusText =
      status === 'shutdown' ? 'Shutting Down' : status === 'healthy' ? 'Healthy' : 'Unhealthy';

    return {
      title: `${statusEmoji} Bot Health Status: ${statusText}`,
      color: statusColor,
      fields: [
        {
          name: '🤖 Discord',
          value: `Ready: ${health.discord.ready ? 'Yes' : 'No'}\nPing: ${health.discord.ping}ms\nGuilds: ${health.discord.guilds}`,
          inline: true
        },
        {
          name: '🗄️ Database',
          value: `Connected: ${health.database.connected ? 'Yes' : 'No'}${health.database.responseTime ? `\nResponse: ${health.database.responseTime}ms` : ''}`,
          inline: true
        },
        {
          name: '⏱️ Uptime',
          value: `${Math.floor(health.uptime / 3600)}h ${Math.floor((health.uptime % 3600) / 60)}m`,
          inline: true
        }
      ],
      timestamp: new Date().toISOString(),
      footer: {
        text: 'Silo Health Monitor'
      }
    };
  }
}
