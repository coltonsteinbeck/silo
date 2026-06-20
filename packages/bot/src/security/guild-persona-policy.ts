export const JIMB_PERSONA_ID = 'jimbepo';

export interface ManagedGuildPersonaPolicy {
  guildId: string;
  personaId: string;
  prompt: string;
  customPromptsDisabled: boolean;
  assistantOutputBlockedMessage: string;
  allowMildAssistantProfanity: boolean;
}

function getJimbProductionsGuildId(): string {
  return process.env.JIMBEPO_GUILD_ID?.trim() || '';
}

function getJimbProductionsPrompt(): string {
  return (process.env.JIMB_PRODUCTION_PROMPT || '').replace(/\\n/g, '\n');
}

function buildJimbProductionsPolicy(): ManagedGuildPersonaPolicy | null {
  const guildId = getJimbProductionsGuildId();
  const prompt = getJimbProductionsPrompt();

  if (!guildId || !prompt) {
    return null;
  }

  return {
    guildId,
    personaId: JIMB_PERSONA_ID,
    prompt,
    customPromptsDisabled: true,
    assistantOutputBlockedMessage:
      'Nope. That one trips the wires. Rephrase it less cursed and I can help.',
    allowMildAssistantProfanity: true
  };
}

export function resolveManagedGuildPersonaPolicy(
  guildId?: string | null
): ManagedGuildPersonaPolicy | null {
  const policy = buildJimbProductionsPolicy();

  if (policy && guildId === policy.guildId) {
    return policy;
  }

  return null;
}

export function isManagedGuildCustomPromptDisabled(guildId?: string | null): boolean {
  return Boolean(resolveManagedGuildPersonaPolicy(guildId)?.customPromptsDisabled);
}
