import { getManagedGuildAssistantOutputBlockedMessages } from '../security/guild-persona-policy';
import { classifyAssistantOutputSafetyDeterministic } from '../security/prompt-safety';
import {
  containsDrCockTitle,
  stripAllowedDrCockTitle,
  type AssistantSafetyPolicy,
  type PersonaState
} from '../security/jimb-persona-state';

export interface ConversationHistoryMessage {
  role: string;
  content: string;
  imageSummary?: string | null;
}

export interface ConversationHistorySanitizationResult<T extends ConversationHistoryMessage> {
  filtered: T[];
  removedCount: number;
  dominantReply: string | null;
  removedReasons: Record<string, number>;
}

export interface AssistantContextSanitizationResult {
  content: string;
  changed: boolean;
  reason: string | null;
}

export interface ConversationHistorySanitizationOptions {
  assistantSafetyPolicy?: AssistantSafetyPolicy;
  personaState?: PersonaState;
}

function normalizeHistoryContent(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function isLowInformationAssistantReply(value: string): boolean {
  const normalized = normalizeHistoryContent(value);
  if (!normalized) {
    return true;
  }

  const wordCount = normalized.split(' ').filter(Boolean).length;
  return normalized.length <= 24 && wordCount <= 4;
}

function incrementReason(reasons: Record<string, number>, reason: string): void {
  reasons[reason] = (reasons[reason] || 0) + 1;
}

function countCustomEmoji(value: string): number {
  return value.match(/<a?:[^:\s]+:\d+>/g)?.length || 0;
}

function removeCustomEmoji(value: string): string {
  return value
    .replace(/<a?:[^:\s]+:\d+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isGenericSafetyFallbackContent(content: string): boolean {
  if (/i can(?:'|’)?t help with that request\. please rephrase/i.test(content)) {
    return true;
  }

  const normalized = normalizeHistoryContent(content);
  const wordCount = normalized.split(' ').filter(Boolean).length;
  if (
    wordCount <= 40 &&
    (/(?:i\s+(?:can(?:'|’)?t|don(?:'|’)?t|won(?:'|’)?t)\s+(?:generate|provide|do|continue)\s+(?:explicit\s+)?sexual\s+content)/i.test(
      content
    ) ||
      /\b(?:not|without)\s+repeating\s+(?:that|the)\s+(?:blocked\s+)?term\b/i.test(content) ||
      /\bhard\s+policy\s+line\b/i.test(content) ||
      /\b(?:my\s+)?(?:programming|policy|safety\s+rules?)\b[\s\S]{0,80}\b(?:prevent|won(?:'|’)?t\s+allow|can(?:'|’)?t\s+allow|forbid)/i.test(
        content
      ))
  ) {
    return true;
  }

  return getManagedGuildAssistantOutputBlockedMessages().some(
    message => normalizeHistoryContent(message) === normalized
  );
}

function getUnsafeAssistantHistoryReason(
  content: string,
  imageSummary?: string | null,
  options: ConversationHistorySanitizationOptions = {}
): string | null {
  const normalized = normalizeHistoryContent(content);
  const allowDrCockTitle =
    options.assistantSafetyPolicy === 'jimb_crude' &&
    options.personaState === 'dr_cock' &&
    containsDrCockTitle(content);
  const classificationContent = allowDrCockTitle ? stripAllowedDrCockTitle(content) : content;

  if (!normalized) {
    return 'empty_assistant_reply';
  }

  if (isGenericSafetyFallbackContent(content)) {
    return 'blocked_safety_fallback';
  }

  if (/the user prompt is empty/i.test(content)) {
    return 'empty_prompt_fallback';
  }

  if (countCustomEmoji(content) >= 4 && removeCustomEmoji(content).length <= 40) {
    return 'custom_emoji_spam';
  }

  if (
    (!allowDrCockTitle && /\b(?:dr\.?|doctor)\s+(?:cock|dick)\b/i.test(content)) ||
    /\b(?:sexy mode|seduce me|hush now, big guy|momma'?s got you)\b/i.test(content) ||
    /\bneigh{2,}\b/i.test(content)
  ) {
    return 'unsafe_persona_residue';
  }

  if (
    /\bproceed with extreme prejudice\b/i.test(content) ||
    (/\bban\s+.{1,80}\s+first\b/i.test(content) &&
      /\b(?:final boss|structural integrity|cursed group|extreme prejudice)\b/i.test(content))
  ) {
    return 'unsafe_banter_residue';
  }

  const outputSafety = classifyAssistantOutputSafetyDeterministic(classificationContent);
  if (!outputSafety.allowed) {
    const evasionCategory = outputSafety.reasons.find(reason =>
      ['hate/slur_evasion', 'hate/slur_acronym_evasion'].includes(reason)
    );
    if (evasionCategory) {
      return evasionCategory;
    }
    return 'assistant_output_guardrail';
  }

  if (imageSummary) {
    const imageSummarySafety = classifyAssistantOutputSafetyDeterministic(imageSummary);
    if (!imageSummarySafety.allowed) {
      return 'assistant_image_summary_guardrail';
    }
  }

  return null;
}

export function sanitizeAssistantContextForPrompt(
  content: string
): AssistantContextSanitizationResult {
  const reason = getUnsafeAssistantHistoryReason(content);
  if (reason) {
    return {
      content: '',
      changed: true,
      reason
    };
  }

  return {
    content,
    changed: false,
    reason: null
  };
}

function pruneDominantLowInformationAssistantReplies<T extends ConversationHistoryMessage>(
  history: T[],
  removedReasons: Record<string, number>
): { filtered: T[]; removedCount: number; dominantReply: string | null } {
  const lowInfoAssistantReplies = history.filter(
    msg => msg.role === 'assistant' && isLowInformationAssistantReply(msg.content)
  );

  if (lowInfoAssistantReplies.length < 4) {
    return { filtered: history, removedCount: 0, dominantReply: null };
  }

  const counts = new Map<string, number>();
  for (const msg of lowInfoAssistantReplies) {
    const key = normalizeHistoryContent(msg.content);
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  let dominantReply: string | null = null;
  let dominantCount = 0;
  for (const [key, count] of counts.entries()) {
    if (count > dominantCount) {
      dominantReply = key;
      dominantCount = count;
    }
  }

  if (!dominantReply) {
    return { filtered: history, removedCount: 0, dominantReply: null };
  }

  const dominanceRatio = dominantCount / lowInfoAssistantReplies.length;
  if (dominantCount < 3 || dominanceRatio < 0.6) {
    return { filtered: history, removedCount: 0, dominantReply: null };
  }

  let removedCount = 0;
  const filtered = history.filter(msg => {
    if (msg.role !== 'assistant') {
      return true;
    }

    if (!isLowInformationAssistantReply(msg.content)) {
      return true;
    }

    if (normalizeHistoryContent(msg.content) !== dominantReply) {
      return true;
    }

    removedCount += 1;
    incrementReason(removedReasons, 'dominant_low_information_reply');
    return false;
  });

  if (removedCount === 0) {
    return { filtered: history, removedCount: 0, dominantReply: null };
  }

  return { filtered, removedCount, dominantReply };
}

export function sanitizeConversationHistoryForPrompt<T extends ConversationHistoryMessage>(
  history: T[],
  options: ConversationHistorySanitizationOptions = {}
): ConversationHistorySanitizationResult<T> {
  const removedReasons: Record<string, number> = {};
  let removedUnsafeCount = 0;
  const safetyFiltered = history.filter(msg => {
    if (
      options.assistantSafetyPolicy === 'jimb_crude' &&
      options.personaState === 'jimb' &&
      containsDrCockTitle(msg.content)
    ) {
      removedUnsafeCount += 1;
      incrementReason(removedReasons, 'inactive_persona_residue');
      return false;
    }

    if (msg.role !== 'assistant') {
      return true;
    }

    const reason = getUnsafeAssistantHistoryReason(msg.content, msg.imageSummary, options);
    if (!reason) {
      return true;
    }

    removedUnsafeCount += 1;
    incrementReason(removedReasons, reason);
    return false;
  });

  const pruned = pruneDominantLowInformationAssistantReplies(safetyFiltered, removedReasons);

  return {
    filtered: pruned.filtered,
    removedCount: removedUnsafeCount + pruned.removedCount,
    dominantReply: pruned.dominantReply,
    removedReasons
  };
}
