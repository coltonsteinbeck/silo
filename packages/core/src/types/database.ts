export interface UserMemory {
  id: string;
  userId: string;
  memoryContent: string;
  contextType: 'conversation' | 'preference' | 'summary' | 'temporary' | 'mood';
  metadata?: Record<string, unknown>;
  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ServerMemory {
  id: string;
  serverId: string;
  userId: string;
  memoryContent: string;
  title?: string;
  contextType: string;
  metadata?: Record<string, unknown>;
  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserPreference {
  userId: string;
  key: string;
  value: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationMessage {
  id: string;
  guildId: string;
  channelId: string;
  userId: string;
  discordMessageId?: string | null;
  promptHash: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  replyToMessageId?: string | null;
  replyToUserId?: string | null;
  referencedContent?: string | null;
  imageSummary?: string | null;
  turnId?: string | null;
  turnSequence?: number | null;
  requesterUserId?: string | null;
  promptEligible?: boolean;
  safetyState?: string;
  safetyCategories?: string[];
  createdAt: Date;
}

export interface ConversationTurn {
  turnId: string;
  requesterUserId: string;
  promptEligible: boolean;
  safetyState: string;
  safetyCategories: string[];
  userMessage: Omit<
    ConversationMessage,
    | 'id'
    | 'createdAt'
    | 'role'
    | 'turnId'
    | 'turnSequence'
    | 'requesterUserId'
    | 'promptEligible'
    | 'safetyState'
    | 'safetyCategories'
  > & { role: 'user' };
  assistantMessage: Omit<
    ConversationMessage,
    | 'id'
    | 'createdAt'
    | 'role'
    | 'turnId'
    | 'turnSequence'
    | 'requesterUserId'
    | 'promptEligible'
    | 'safetyState'
    | 'safetyCategories'
  > & { role: 'assistant' };
}

export interface PromptContextQuery {
  guildId: string;
  channelId: string;
  promptHash: string;
  requesterUserId: string;
  replyToMessageId?: string | null;
  maxTurns?: number;
  maxAgeMs?: number;
}

export interface PromptContextResult {
  messages: ConversationMessage[];
  scope: 'reply_chain' | 'same_user' | 'none';
  selectedTurnCount: number;
  excludedTurnCount: number;
  exclusionReasons: Record<string, number>;
}

export interface DatabaseAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  healthCheck(): Promise<boolean>;

  // User Memory
  getUserMemoryCount(userId: string): Promise<number>;
  getAllMemoryCount(): Promise<number>;
  getUserMemories(userId: string, contextType?: string, limit?: number): Promise<UserMemory[]>;
  getAllMemories(contextType?: string, limit?: number): Promise<UserMemory[]>;
  storeUserMemory(
    memory: Omit<UserMemory, 'id' | 'createdAt' | 'updatedAt'>,
    embedding?: number[]
  ): Promise<UserMemory>;
  updateUserMemory(
    id: string,
    updates: Partial<UserMemory>,
    embedding?: number[]
  ): Promise<UserMemory>;
  deleteUserMemory(id: string): Promise<void>;
  findUserMemoryByIdPrefix(userId: string, idPrefix: string): Promise<UserMemory | null>;
  searchUserMemories(userId: string, query: string, limit?: number): Promise<UserMemory[]>;
  searchUserMemoriesByEmbedding(
    userId: string,
    embedding: number[],
    contextType?: string,
    limit?: number
  ): Promise<(UserMemory & { similarity: number })[]>;

  // Server Memory
  getServerMemories(
    serverId: string,
    contextType?: string,
    limit?: number
  ): Promise<ServerMemory[]>;
  searchServerMemories(serverId: string, query: string, limit?: number): Promise<ServerMemory[]>;
  searchServerMemoriesByEmbedding(
    serverId: string,
    embedding: number[],
    contextType?: string,
    limit?: number
  ): Promise<(ServerMemory & { similarity: number })[]>;
  getRelevantServerMemoriesForContext(
    serverId: string,
    embedding: number[],
    contextType?: string,
    limit?: number
  ): Promise<ServerMemory[]>;
  storeServerMemory(
    memory: Omit<ServerMemory, 'id' | 'createdAt' | 'updatedAt'>,
    embedding?: number[]
  ): Promise<ServerMemory>;
  updateServerMemory(
    id: string,
    updates: Partial<ServerMemory>,
    embedding?: number[]
  ): Promise<ServerMemory>;
  deleteServerMemory(id: string): Promise<void>;

  // User Preferences
  getUserPreferences(userId: string): Promise<Record<string, string>>;
  setUserPreference(userId: string, key: string, value: string): Promise<void>;

  // Conversation History
  /** @deprecated Use getPromptContext for model prompt assembly. */
  getConversationHistory(
    channelId: string,
    promptHash: string,
    limit?: number
  ): Promise<ConversationMessage[]>;
  /** @deprecated Use storeConversationTurn so prompt history remains causally ordered. */
  storeConversationMessage(
    message: Omit<ConversationMessage, 'id' | 'createdAt'>
  ): Promise<ConversationMessage>;
  storeConversationTurn(turn: ConversationTurn): Promise<ConversationMessage[]>;
  getPromptContext(query: PromptContextQuery): Promise<PromptContextResult>;
  clearConversationHistory(channelId: string, promptHash?: string): Promise<void>;

  // Cleanup
  cleanupExpiredMemories(): Promise<number>;
}
