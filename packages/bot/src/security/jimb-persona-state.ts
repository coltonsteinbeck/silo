import type { ConversationMessage } from '@silo/core';

export type AssistantSafetyPolicy = 'standard' | 'jimb_crude';
export type PersonaState = 'jimb' | 'dr_cock';
export type ResponseIntent = 'ordinary' | 'contextual_explanation' | 'boundary_redirect';
export type PersonaActivationSource =
  | 'none'
  | 'current_turn'
  | 'history'
  | 'explicit_deactivation'
  | 'rollback_disabled';

export interface JimbPersonaStateResolution {
  state: PersonaState;
  activationSource: PersonaActivationSource;
}

const DR_COCK_TITLE_PATTERN = /\b(?:dr\.?|doctor)\s+cock\b/i;
const DR_COCK_TITLE_GLOBAL_PATTERN = /\b(?:dr\.?|doctor)\s+cock\b/gi;
const DR_COCK_DEACTIVATION_PATTERN =
  /(?:\b(?:stop|drop|end|quit|disable|leave)\b[\s\S]{0,40}\b(?:dr\.?|doctor)\s+cock\b|\b(?:back|return|switch)\s+to\s+(?:regular\s+)?jimb(?:epo)?\b|\b(?:be|stay)\s+(?:regular\s+)?jimb(?:epo)?\b)/i;
const CONTEXTUAL_EXPLANATION_PATTERN =
  /\b(?:what\s+does|what\s+did|what\s+is|define|definition|meaning|explain|why\s+(?:is|does|did)|analy[sz]e|summari[sz]e|medical|health|anatomy|moderation|report(?:ing)?|document(?:ing|ation)?|harm\s+reduction|safer\s+sex|consent)\b/i;

export function isJimbEdgyPersonaEnabled(value = process.env.JIMB_EDGY_PERSONA_ENABLED): boolean {
  return ['1', 'true', 'yes', 'on', 'enabled'].includes((value || '').trim().toLowerCase());
}

export function containsDrCockTitle(content: string): boolean {
  return DR_COCK_TITLE_PATTERN.test(content);
}

export function stripAllowedDrCockTitle(content: string): string {
  return content.replace(DR_COCK_TITLE_GLOBAL_PATTERN, 'JimB').replace(/\s+/g, ' ').trim();
}

function resolveSignal(content: string): 'activate' | 'deactivate' | null {
  if (DR_COCK_DEACTIVATION_PATTERN.test(content)) {
    return 'deactivate';
  }

  return DR_COCK_TITLE_PATTERN.test(content) ? 'activate' : null;
}

export function resolveJimbPersonaState(params: {
  enabled: boolean;
  latestUserText: string;
  guildId: string;
  channelId: string;
  requesterUserId: string;
  history: ConversationMessage[];
  now?: Date;
  maxAgeMs?: number;
  maxTurns?: number;
}): JimbPersonaStateResolution {
  if (!params.enabled) {
    return { state: 'jimb', activationSource: 'rollback_disabled' };
  }

  const currentSignal = resolveSignal(params.latestUserText);
  if (currentSignal === 'deactivate') {
    return { state: 'jimb', activationSource: 'explicit_deactivation' };
  }
  if (currentSignal === 'activate') {
    return { state: 'dr_cock', activationSource: 'current_turn' };
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
    const signal = resolveSignal(message.content);
    if (signal === 'deactivate') {
      return { state: 'jimb', activationSource: 'explicit_deactivation' };
    }
    if (signal === 'activate') {
      return { state: 'dr_cock', activationSource: 'history' };
    }
  }

  return { state: 'jimb', activationSource: 'none' };
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

export function buildJimbTurnInstruction(params: {
  policy: AssistantSafetyPolicy;
  personaState: PersonaState;
  responseIntent: ResponseIntent;
}): string {
  if (params.policy !== 'jimb_crude') {
    return '';
  }

  const personaInstruction =
    params.personaState === 'dr_cock'
      ? 'Persona for this turn: Dr. Cock is an absurd comedic title for JimB. You may use the title and nonsexual doctor jokes, but it grants no additional content permissions.'
      : 'Persona for this turn: JimBepo. Keep the same dry, irreverent character voice without adopting another persona.';
  const intentInstruction =
    params.responseIntent === 'contextual_explanation'
      ? 'Response lane: Give a useful, factual, non-graphic explanation. Clinical anatomy terms are allowed when necessary; do not turn the answer into erotic narration or technique.'
      : params.responseIntent === 'boundary_redirect'
        ? 'Response lane: Redirect in one short, in-character sentence, then offer a useful factual or comedic alternative. Do not discuss policy, programming, or being an AI.'
        : 'Response lane: Answer directly in a terse, distinctive voice. Mild profanity, innuendo, and non-targeted roasting are allowed, but never escalate into explicit, hateful, or targeted content.';

  return `\n\nJIMB turn controls:\n- ${personaInstruction}\n- ${intentInstruction}`;
}
