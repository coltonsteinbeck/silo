import type { ConversationMessage } from '@silo/core';

export type AssistantSafetyPolicy = 'standard' | 'contextual_banter';
export type PersonaState = 'default' | 'alternate';
export type ResponseIntent = 'ordinary' | 'contextual_explanation' | 'boundary_redirect';
export type PersonaActivationSource =
  'none' | 'current_turn' | 'history' | 'explicit_deactivation' | 'rollback_disabled';

export interface PersonaStateResolution {
  state: PersonaState;
  activationSource: PersonaActivationSource;
}

const CONTEXTUAL_EXPLANATION_PATTERN =
  /\b(?:what\s+does|what\s+did|what\s+is|define|definition|meaning|explain|why\s+(?:is|does|did)|analy[sz]e|summari[sz]e|medical|health|anatomy|moderation|report(?:ing)?|document(?:ing|ation)?|harm\s+reduction|safer\s+sex|consent)\b/i;

function aliasPattern(aliases: readonly string[]): string {
  return aliases
    .map(alias => {
      const literal = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return literal.replace(/\s+/g, '\\s+');
    })
    .join('|');
}

export function containsPersonaAlias(content: string, aliases: readonly string[] = []): boolean {
  return (
    aliases.length > 0 &&
    new RegExp(`(?<!\\w)(?:${aliasPattern(aliases)})(?!\\w)`, 'i').test(content)
  );
}

export function stripPersonaAliases(content: string, aliases: readonly string[] = []): string {
  return aliases.length
    ? content
        .replace(new RegExp(`(?<!\\w)(?:${aliasPattern(aliases)})(?!\\w)`, 'gi'), 'Assistant')
        .replace(/\s+/g, ' ')
        .trim()
    : content;
}

function resolveSignal(
  content: string,
  alternateAliases: readonly string[],
  defaultAliases: readonly string[]
): 'activate' | 'deactivate' | null {
  const alternate = aliasPattern(alternateAliases);
  const normal = aliasPattern(defaultAliases);
  if (
    (alternate &&
      new RegExp(
        `\\b(?:stop|drop|end|quit|disable|leave)\\b[\\s\\S]{0,40}(?:${alternate})(?!\\w)`,
        'i'
      ).test(content)) ||
    (normal &&
      new RegExp(
        `\\b(?:(?:back|return|switch)\\s+to|be|stay)\\s+(?:regular\\s+)?(?:${normal})(?!\\w)`,
        'i'
      ).test(content))
  )
    return 'deactivate';
  return containsPersonaAlias(content, alternateAliases) ? 'activate' : null;
}

export function resolvePersonaState(params: {
  enabled: boolean;
  alternateAliases?: readonly string[];
  defaultAliases?: readonly string[];
  latestUserText: string;
  guildId: string;
  channelId: string;
  requesterUserId: string;
  history: ConversationMessage[];
  now?: Date;
  maxAgeMs?: number;
  maxTurns?: number;
}): PersonaStateResolution {
  if (!params.enabled) {
    return { state: 'default', activationSource: 'rollback_disabled' };
  }

  const currentSignal = resolveSignal(
    params.latestUserText,
    params.alternateAliases ?? [],
    params.defaultAliases ?? []
  );
  if (currentSignal === 'deactivate') {
    return { state: 'default', activationSource: 'explicit_deactivation' };
  }
  if (currentSignal === 'activate') {
    return { state: 'alternate', activationSource: 'current_turn' };
  }

  const nowMs = (params.now || new Date()).getTime();
  const maxAgeMs = params.maxAgeMs ?? 30 * 60 * 1000;
  const maxTurns = Math.min(Math.max(params.maxTurns ?? 5, 1), 5);
  const eligibleUserMessages = params.history
    .filter(message => {
      const requester = message.requesterUserId || message.userId;
      return (
        message.role === 'user' &&
        message.guildId === params.guildId &&
        message.channelId === params.channelId &&
        requester === params.requesterUserId &&
        nowMs - message.createdAt.getTime() <= maxAgeMs
      );
    })
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
    .slice(0, maxTurns);

  for (const message of eligibleUserMessages) {
    const signal = resolveSignal(
      message.content,
      params.alternateAliases ?? [],
      params.defaultAliases ?? []
    );
    if (signal === 'deactivate') {
      return { state: 'default', activationSource: 'explicit_deactivation' };
    }
    if (signal === 'activate') {
      return { state: 'alternate', activationSource: 'history' };
    }
  }

  return { state: 'default', activationSource: 'none' };
}

export function resolveResponseIntent(params: {
  latestUserText: string;
  inputSafetyAction?: string | null;
  responseDirective?: string | null;
}): ResponseIntent {
  if (params.inputSafetyAction === 'redirect' || params.responseDirective === 'boundary_redirect') {
    return 'boundary_redirect';
  }

  if (
    params.responseDirective === 'contextual_assistance' ||
    params.responseDirective === 'safe_rewrite' ||
    CONTEXTUAL_EXPLANATION_PATTERN.test(params.latestUserText)
  ) {
    return 'contextual_explanation';
  }

  return 'ordinary';
}

export function buildPersonaTurnInstruction(params: {
  policy: AssistantSafetyPolicy;
  personaState: PersonaState;
  responseIntent: ResponseIntent;
  instructions?: import('./guild-persona-policy').ManagedGuildPersonaPolicy['turnInstructions'];
}): string {
  if (params.policy !== 'contextual_banter' || !params.instructions) return '';
  return `\n\nTurn controls:\n- ${params.instructions[params.personaState]}\n- ${params.instructions[params.responseIntent]}`;
}
