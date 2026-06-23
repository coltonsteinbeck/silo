interface AssistantMessageTrigger {
  mentions: {
    has(userId: string): boolean;
  };
  reference?: {
    messageId?: string | null;
  } | null;
  fetchReference(): Promise<{
    author?: {
      id?: string | null;
    } | null;
  } | null>;
}

export async function shouldHandleAssistantMessage(
  message: AssistantMessageTrigger,
  botUserId: string
): Promise<boolean> {
  if (message.mentions.has(botUserId)) {
    return true;
  }

  if (!message.reference?.messageId) {
    return false;
  }

  try {
    const referenced = await message.fetchReference();
    return referenced?.author?.id === botUserId;
  } catch {
    return false;
  }
}
