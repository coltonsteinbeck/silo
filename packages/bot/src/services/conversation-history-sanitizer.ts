export interface ConversationHistoryMessage {
  role: string;
  content: string;
}

export interface ConversationHistorySanitizationResult<T extends ConversationHistoryMessage> {
  filtered: T[];
  removedCount: number;
  dominantReply: string | null;
  removedReasons: Record<string, number>;
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

function getUnsafeAssistantHistoryReason(content: string): string | null {
  const normalized = normalizeHistoryContent(content);

  if (!normalized) {
    return 'empty_assistant_reply';
  }

  if (/i can(?:'|’)?t help with that request\. please rephrase/i.test(content)) {
    return 'blocked_safety_fallback';
  }

  if (/the user prompt is empty/i.test(content)) {
    return 'empty_prompt_fallback';
  }

  if (countCustomEmoji(content) >= 4 && removeCustomEmoji(content).length <= 40) {
    return 'custom_emoji_spam';
  }

  if (
    /\b(?:dr\.?|doctor)\s+(?:cock|dick)\b/i.test(content) ||
    /\b(?:sexy mode|seduce me|hush now, big guy|momma'?s got you)\b/i.test(content) ||
    /\bneigh{2,}\b/i.test(content)
  ) {
    return 'unsafe_persona_residue';
  }

  return null;
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
  history: T[]
): ConversationHistorySanitizationResult<T> {
  const removedReasons: Record<string, number> = {};
  let removedUnsafeCount = 0;
  const safetyFiltered = history.filter(msg => {
    if (msg.role !== 'assistant') {
      return true;
    }

    const reason = getUnsafeAssistantHistoryReason(msg.content);
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
