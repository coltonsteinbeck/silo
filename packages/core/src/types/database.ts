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
  promptHash: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: Date;
}

export interface DatabaseAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  healthCheck(): Promise<boolean>;

  // User Memory
  getUserMemories(userId: string, contextType?: string, limit?: number): Promise<UserMemory[]>;
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

  // Server Memory
  getServerMemories(
    serverId: string,
    contextType?: string,
    limit?: number
  ): Promise<ServerMemory[]>;
  storeServerMemory(
    memory: Omit<ServerMemory, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<ServerMemory>;
  updateServerMemory(id: string, updates: Partial<ServerMemory>): Promise<ServerMemory>;
  deleteServerMemory(id: string): Promise<void>;

  // User Preferences
  getUserPreferences(userId: string): Promise<Record<string, string>>;
  setUserPreference(userId: string, key: string, value: string): Promise<void>;

  // Conversation History
  getConversationHistory(
    channelId: string,
    promptHash: string,
    limit?: number
  ): Promise<ConversationMessage[]>;
  storeConversationMessage(
    message: Omit<ConversationMessage, 'id' | 'createdAt'>
  ): Promise<ConversationMessage>;
  clearConversationHistory(channelId: string, promptHash?: string): Promise<void>;

  // Cleanup
  cleanupExpiredMemories(): Promise<number>;
}
