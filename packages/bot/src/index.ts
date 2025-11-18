import { Client, GatewayIntentBits, Events, REST, Routes } from 'discord.js';
import { ConfigLoader, logger } from '@silo/core';
import { ProviderRegistry } from './providers/registry';
import { PostgresAdapter } from './database/postgres';
import { AdminAdapter } from './database/admin-adapter';
import { PermissionManager } from './permissions/manager';
import { createCommands } from './commands';

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

  const providers = new ProviderRegistry(config);
  const available = providers.getAvailableProviders();
  logger.info('Available providers:', available);

  // Create commands
  const commands = createCommands(db, providers, config, adminDb, permissions);
  logger.info(`Loaded ${commands.size} commands`);

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

  client.once(Events.ClientReady, async readyClient => {
    logger.info(`Bot ready! Logged in as ${readyClient.user.tag}`);
    logger.info(`Serving ${readyClient.guilds.cache.size} guilds`);

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
    if (!interaction.isChatInputCommand()) return;

    const command = commands.get(interaction.commandName);
    if (!command) {
      logger.warn(`Unknown command: ${interaction.commandName}`);
      return;
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

  // Handle mentions for conversational AI
  client.on(Events.MessageCreate, async message => {
    if (message.author.bot) return;
    if (!message.mentions.has(client.user!.id)) return;

    try {
      await message.channel.sendTyping();

      const textProvider = providers.getTextProvider();

      // Get conversation history
      const history = await db.getConversationHistory(message.channelId, 10);
      const messages = history.map(msg => ({
        role: msg.role,
        content: msg.content
      }));

      const userContent = message.content.replace(`<@${client.user!.id}>`, '').trim();

      // Store user message
      await db.storeConversationMessage({
        channelId: message.channelId,
        userId: message.author.id,
        role: 'user',
        content: userContent
      });

      const response = await textProvider.generateText([
        {
          role: 'system',
          content: 'You are a helpful Discord bot assistant.'
        },
        ...messages,
        {
          role: 'user',
          content: userContent
        }
      ]);

      // Store assistant response
      await db.storeConversationMessage({
        channelId: message.channelId,
        userId: message.author.id,
        role: 'assistant',
        content: response.content
      });

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

main().catch(error => {
  logger.error('Fatal error:', error);
  process.exit(1);
});
