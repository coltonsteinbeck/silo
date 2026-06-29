import type { ConversationMessage } from '@silo/core';

export function shouldPersistAssistantMessageForPromptHistory(params: {
  outputBlockedBySafety: boolean;
}): boolean {
  return !params.outputBlockedBySafety;
}

export function buildConversationPersistenceMessages(params: {
  userMessage: Omit<ConversationMessage, 'id' | 'createdAt'>;
  assistantMessage: Omit<ConversationMessage, 'id' | 'createdAt'>;
  outputBlockedBySafety: boolean;
}): Array<Omit<ConversationMessage, 'id' | 'createdAt'>> {
  const messages = [params.userMessage];

  if (shouldPersistAssistantMessageForPromptHistory(params)) {
    messages.push(params.assistantMessage);
  }

  return messages;
}
