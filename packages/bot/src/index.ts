import { Client, GatewayIntentBits, Events } from 'discord.js';
import { ConfigLoader, logger } from '@silo/core';
import { ProviderRegistry } from './providers/registry';

async function main() {
  logger.info('Starting Silo Discord Bot...');

  const config = ConfigLoader.load();
  logger.info('Configuration loaded successfully');

  const providers = new ProviderRegistry(config);
  const available = providers.getAvailableProviders();
  logger.info('Available providers:', available);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildVoiceStates
    ]
  });

  client.once(Events.ClientReady, (readyClient) => {
    logger.info(`Bot ready! Logged in as ${readyClient.user.tag}`);
    logger.info(`Serving ${readyClient.guilds.cache.size} guilds`);
  });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (!message.mentions.has(client.user!.id)) return;

    try {
      await message.channel.sendTyping();

      const textProvider = providers.getTextProvider();
      const response = await textProvider.generateText([
        {
          role: 'system',
          content: 'You are a helpful Discord bot assistant.'
        },
        {
          role: 'user',
          content: message.content.replace(`<@${client.user!.id}>`, '').trim()
        }
      ]);

      await message.reply({
        content: response.content,
        allowedMentions: { repliedUser: false }
      });
    } catch (error) {
      logger.error('Error handling message:', error);
      await message.reply('Sorry, I encountered an error processing your request.');
    }
  });

  client.on(Events.Error, (error) => {
    logger.error('Discord client error:', error);
  });

  await client.login(config.discord.token);
}

main().catch((error) => {
  logger.error('Fatal error:', error);
  process.exit(1);
});
