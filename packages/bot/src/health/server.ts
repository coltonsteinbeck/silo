/**
 * Health Check Server
 *
 * Lightweight HTTP server for Docker healthchecks and healthchecks.io integration
 */

import { Client } from 'discord.js';
import { PostgresAdapter } from '../database/postgres';
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
  private startTime = Date.now();

  constructor(
    private client: Client,
    private db: PostgresAdapter,
    private port: number = 3000
  ) {
    this.healthchecksUrl = process.env.HEALTHCHECKS_URL || null;
  }

  async start(): Promise<void> {
    this.server = Bun.serve({
      port: this.port,
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

    logger.info(`Health server started on port ${this.port}`);

    // Start healthchecks.io pinging if configured
    if (this.healthchecksUrl) {
      this.startHealthchecksPing();
    }

    // Handle graceful shutdown
    process.on('SIGTERM', () => this.sendFailurePing());
    process.on('SIGINT', () => this.sendFailurePing());
  }

  async stop(): Promise<void> {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }

    if (this.server) {
      this.server.stop();
      logger.info('Health server stopped');
    }

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
}
