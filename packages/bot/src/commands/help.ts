import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { Command } from './types';

const HELP_LINES = [
  '**Core Commands**',
  '/help - Show this command reference.',
  '/thread - Create or manage a thread workflow.',
  '/digest - Summarize recent thread or channel activity.',
  '/feedback - Send quality feedback to maintainers.',
  '',
  '**Memory Commands**',
  '/memory-view - View saved user/server memory entries.',
  '/user-memory-set - Save a personal memory.',
  '/server-memory-set - Save a server-scoped memory.',
  '/memory-clear - Clear memory entries.',
  '',
  '**Media Commands**',
  '/draw - Generate an image.',
  '/video - Generate or transform a video.',
  '/radio - Play YouTube audio or a Spotify track in a voice channel.',
  '/speak - Start voice mode in a voice channel.',
  '/stopspeaking - Stop voice mode.',
  '',
  '**Admin/Mod Commands**',
  '/admin - Admin controls, quota tools, and safety toggles.',
  '/config - Configure server behavior and prompts.',
  '/mod - Moderation controls and policy tooling.',
  '/analytics - Usage and performance metrics.'
].join('\n');

export class HelpCommand implements Command {
  public readonly data = new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show available commands and what they do');

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.reply({
      content: HELP_LINES,
      ephemeral: true
    });
  }
}
