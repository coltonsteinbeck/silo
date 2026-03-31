import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { Command } from './types';
import { AdminAdapter } from '../database/admin-adapter';

const MAX_PROMPT_PREVIEW_LENGTH = 1500;

function redactPromptSecrets(content: string): { value: string; redactions: number } {
  let redactions = 0;
  let value = content;

  const replaceAll = (pattern: RegExp, replacement: string): void => {
    value = value.replace(pattern, () => {
      redactions += 1;
      return replacement;
    });
  };

  replaceAll(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted-openai-key]');
  replaceAll(/\bxai-[A-Za-z0-9_-]{12,}\b/g, '[redacted-xai-key]');
  replaceAll(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[redacted-google-key]');
  replaceAll(/\bBearer\s+[A-Za-z0-9_.-]+\b/gi, 'Bearer [redacted-token]');
  replaceAll(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted-jwt]');

  value = value.replace(
    /(\b(?:api[_-]?key|token|secret|password|passwd|client[_-]?secret)\b\s*[:=]\s*)([^\s'"`]+)/gi,
    (_match, prefix: string) => {
      redactions += 1;
      return `${prefix}[redacted-value]`;
    }
  );

  value = value.replace(/(https?:\/\/)([^\s:@/]+):([^@\s/]+)@/gi, (_match, protocol, username) => {
    redactions += 1;
    return `${protocol}${username}:[redacted]@`;
  });

  return { value, redactions };
}

export class PromptCommand implements Command {
  data = new SlashCommandBuilder()
    .setName('prompt')
    .setDescription("View this server's configured system prompt")
    .setDMPermission(false)
    .addStringOption(option =>
      option
        .setName('type')
        .setDescription('Prompt type to view')
        .setRequired(false)
        .addChoices({ name: 'Text Chat', value: 'text' }, { name: 'Voice Chat', value: 'voice' })
    );

  constructor(private adminDb: AdminAdapter) {}

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({
        content: 'This command can only be used in a server.',
        ephemeral: true
      });
      return;
    }

    const type = interaction.options.getString('type') || 'text';
    const forVoice = type === 'voice';
    const typeLabel = forVoice ? 'Voice' : 'Text';

    const { prompt, enabled } = await this.adminDb.getSystemPrompt(interaction.guildId, forVoice);

    if (!prompt) {
      await interaction.reply({
        content: `No custom ${type.toLowerCase()} system prompt is configured for this server.`,
        ephemeral: true
      });
      return;
    }

    const redacted = redactPromptSecrets(prompt);
    const truncatedPrompt =
      redacted.value.length > MAX_PROMPT_PREVIEW_LENGTH
        ? `${redacted.value.substring(0, MAX_PROMPT_PREVIEW_LENGTH)}...\n*(truncated)*`
        : redacted.value;
    const status = enabled ? 'Enabled' : 'Disabled';

    const lines = [
      `**${typeLabel} System Prompt** (${status})`,
      '```',
      truncatedPrompt,
      '```',
      `Length: ${prompt.length} characters`
    ];

    if (redacted.redactions > 0) {
      lines.push(`Safety: ${redacted.redactions} secret-like value(s) redacted in this preview.`);
    }

    if (!enabled) {
      lines.push('Note: Prompt is configured but currently disabled for this guild.');
    }

    await interaction.reply({
      content: lines.join('\n'),
      ephemeral: true
    });
  }
}
