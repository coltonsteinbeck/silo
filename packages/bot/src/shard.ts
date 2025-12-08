import { ShardingManager } from 'discord.js';
import { ConfigLoader, logger } from '@silo/core';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  logger.info('Starting Silo Discord Bot with Sharding...');

  const config = ConfigLoader.load();

  const manager = new ShardingManager(path.join(__dirname, 'index.ts'), {
    token: config.discord.token,
    totalShards: 'auto',
    respawn: true
  });

  manager.on('shardCreate', shard => {
    logger.info(`Shard ${shard.id} launched`);

    shard.on('ready', () => {
      logger.info(`Shard ${shard.id} ready`);
    });

    shard.on('disconnect', () => {
      logger.warn(`Shard ${shard.id} disconnected`);
    });

    shard.on('reconnecting', () => {
      logger.info(`Shard ${shard.id} reconnecting`);
    });

    shard.on('death', () => {
      logger.error(`Shard ${shard.id} died`);
    });

    shard.on('error', error => {
      logger.error(`Shard ${shard.id} error:`, error);
    });
  });

  try {
    await manager.spawn();
    logger.info(`All shards spawned successfully`);
  } catch (error) {
    logger.error('Failed to spawn shards:', error);
    process.exit(1);
  }
}

main().catch(error => {
  logger.error('Fatal error in shard manager:', error);
  process.exit(1);
});
