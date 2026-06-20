export const MANAGED_PERSONA_ID = 'managedepo';

export interface ManagedGuildPersonaPolicy {
  guildId: string;
  personaId: string;
  prompt: string;
  customPromptsDisabled: boolean;
  assistantOutputBlockedMessage: string;
  allowMildAssistantProfanity: boolean;
}

function getManagedProductionsGuildId(): string {
  return process.env.MANAGEDEPO_GUILD_ID?.trim() || '';
}

function getManagedProductionsPrompt(): string {
  return (process.env.MANAGED_PRODUCTION_PROMPT || '').replace(/\\n/g, '\n');
}

function buildManagedProductionsPolicy(): ManagedGuildPersonaPolicy | null {
  const guildId = getManagedProductionsGuildId();
  const prompt = getManagedProductionsPrompt();

  if (!guildId || !prompt) {
    return null;
  }

  return {
    guildId,
    personaId: MANAGED_PERSONA_ID,
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
  const policy = buildManagedProductionsPolicy();

  if (policy && guildId === policy.guildId) {
    return policy;
  }

  return null;
}

export function isManagedGuildCustomPromptDisabled(guildId?: string | null): boolean {
  return Boolean(resolveManagedGuildPersonaPolicy(guildId)?.customPromptsDisabled);
}
