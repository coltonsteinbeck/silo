import { Pool } from 'pg';
import {
  DatabaseAdapter,
  UserMemory,
  ServerMemory,
  UserPreference,
  ConversationMessage,
  logger
} from '@silo/core';

export class PostgresAdapter implements DatabaseAdapter {
  public readonly pool: Pool;

  constructor(connectionUrl: string) {
    this.pool = new Pool({
      connectionString: connectionUrl
    });
  }

  async connect(): Promise<void> {
    try {
      const client = await this.pool.connect();
      client.release();
      logger.info('Database connected');
    } catch (error) {
      logger.error('Failed to connect to database', error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    await this.pool.end();
    logger.info('Database disconnected');
  }

  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.pool.query('SELECT 1');
      return result.rows.length > 0;
    } catch {
      return false;
    }
  }

  // User Memory
  async getUserMemories(userId: string, contextType?: string, limit = 50): Promise<UserMemory[]> {
    const query = contextType
      ? 'SELECT * FROM user_memory WHERE user_id = $1 AND context_type = $2 ORDER BY created_at DESC LIMIT $3'
      : 'SELECT * FROM user_memory WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2';

    const params = contextType ? [userId, contextType, limit] : [userId, limit];
    const result = await this.pool.query(query, params);

    return result.rows.map((row: any) => ({
      id: row.id,
      userId: row.user_id,
      memoryContent: row.memory_content,
      contextType: row.context_type,
      metadata: row.metadata,
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    }));
  }

  async storeUserMemory(
    memory: Omit<UserMemory, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<UserMemory> {
    const result = await this.pool.query(
      `INSERT INTO user_memory (user_id, memory_content, context_type, metadata, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        memory.userId,
        memory.memoryContent,
        memory.contextType,
        memory.metadata || {},
        memory.expiresAt
      ]
    );

    const row = result.rows[0];
    return {
      id: row.id,
      userId: row.user_id,
      memoryContent: row.memory_content,
      contextType: row.context_type,
      metadata: row.metadata,
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }

  async updateUserMemory(id: string, updates: Partial<UserMemory>): Promise<UserMemory> {
    const fields: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (updates.memoryContent !== undefined) {
      fields.push(`memory_content = $${paramIndex++}`);
      values.push(updates.memoryContent);
    }
    if (updates.contextType !== undefined) {
      fields.push(`context_type = $${paramIndex++}`);
      values.push(updates.contextType);
    }
    if (updates.metadata !== undefined) {
      fields.push(`metadata = $${paramIndex++}`);
      values.push(updates.metadata);
    }
    if (updates.expiresAt !== undefined) {
      fields.push(`expires_at = $${paramIndex++}`);
      values.push(updates.expiresAt);
    }

    values.push(id);
    const result = await this.pool.query(
      `UPDATE user_memory SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${paramIndex} RETURNING *`,
      values
    );

    const row = result.rows[0];
    return {
      id: row.id,
      userId: row.user_id,
      memoryContent: row.memory_content,
      contextType: row.context_type,
      metadata: row.metadata,
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }

  async deleteUserMemory(id: string): Promise<void> {
    await this.pool.query('DELETE FROM user_memory WHERE id = $1', [id]);
  }

  async searchUserMemories(userId: string, query: string, limit = 20): Promise<UserMemory[]> {
    const result = await this.pool.query(
      `SELECT * FROM user_memory 
       WHERE user_id = $1 AND memory_content ILIKE $2 
       ORDER BY created_at DESC LIMIT $3`,
      [userId, `%${query}%`, limit]
    );

    return result.rows.map((row: any) => ({
      id: row.id,
      userId: row.user_id,
      memoryContent: row.memory_content,
      contextType: row.context_type,
      metadata: row.metadata,
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    }));
  }

  async cleanupExpiredMemories(): Promise<number> {
    const result = await this.pool.query(
      'DELETE FROM user_memory WHERE expires_at IS NOT NULL AND expires_at < NOW() RETURNING id'
    );
    return result.rowCount || 0;
  }

  // Server Memory
  async getServerMemories(
    serverId: string,
    contextType?: string,
    limit = 50
  ): Promise<ServerMemory[]> {
    const query = contextType
      ? 'SELECT * FROM server_memory WHERE server_id = $1 AND context_type = $2 ORDER BY created_at DESC LIMIT $3'
      : 'SELECT * FROM server_memory WHERE server_id = $1 ORDER BY created_at DESC LIMIT $2';

    const params = contextType ? [serverId, contextType, limit] : [serverId, limit];
    const result = await this.pool.query(query, params);

    return result.rows.map((row: any) => ({
      id: row.id,
      serverId: row.server_id,
      userId: row.user_id,
      memoryContent: row.memory_content,
      title: row.title,
      contextType: row.context_type,
      metadata: row.metadata,
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    }));
  }

  async storeServerMemory(
    memory: Omit<ServerMemory, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<ServerMemory> {
    const result = await this.pool.query(
      `INSERT INTO server_memory (server_id, user_id, memory_content, title, context_type, metadata, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        memory.serverId,
        memory.userId,
        memory.memoryContent,
        memory.title,
        memory.contextType,
        memory.metadata || {},
        memory.expiresAt
      ]
    );

    const row = result.rows[0];
    return {
      id: row.id,
      serverId: row.server_id,
      userId: row.user_id,
      memoryContent: row.memory_content,
      title: row.title,
      contextType: row.context_type,
      metadata: row.metadata,
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }

  async deleteServerMemory(id: string): Promise<void> {
    await this.pool.query('DELETE FROM server_memory WHERE id = $1', [id]);
  }

  async updateServerMemory(id: string, updates: Partial<ServerMemory>): Promise<ServerMemory> {
    const fields: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (updates.memoryContent !== undefined) {
      fields.push(`memory_content = $${paramIndex++}`);
      values.push(updates.memoryContent);
    }
    if (updates.title !== undefined) {
      fields.push(`title = $${paramIndex++}`);
      values.push(updates.title);
    }
    if (updates.contextType !== undefined) {
      fields.push(`context_type = $${paramIndex++}`);
      values.push(updates.contextType);
    }
    if (updates.metadata !== undefined) {
      fields.push(`metadata = $${paramIndex++}`);
      values.push(updates.metadata);
    }
    if (updates.expiresAt !== undefined) {
      fields.push(`expires_at = $${paramIndex++}`);
      values.push(updates.expiresAt);
    }

    values.push(id);
    const result = await this.pool.query(
      `UPDATE server_memory SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${paramIndex} RETURNING *`,
      values
    );

    const row = result.rows[0];
    return {
      id: row.id,
      serverId: row.server_id,
      userId: row.user_id,
      memoryContent: row.memory_content,
      title: row.title,
      contextType: row.context_type,
      metadata: row.metadata,
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }

  // User Preferences
  async getUserPreferences(userId: string): Promise<Record<string, string>> {
    const result = await this.pool.query(
      'SELECT key, value FROM user_preferences WHERE user_id = $1',
      [userId]
    );

    const preferences: Record<string, string> = {};
    for (const row of result.rows) {
      preferences[row.key] = row.value;
    }
    return preferences;
  }

  async getUserPreference(userId: string, key: string): Promise<UserPreference | null> {
    const result = await this.pool.query(
      'SELECT * FROM user_preferences WHERE user_id = $1 AND key = $2',
      [userId, key]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      userId: row.user_id,
      key: row.key,
      value: row.value,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }

  async setUserPreference(userId: string, key: string, value: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO user_preferences (user_id, key, value)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, key) DO UPDATE SET value = $3, updated_at = NOW()`,
      [userId, key, value]
    );
  }

  async deleteUserPreference(userId: string, key: string): Promise<void> {
    await this.pool.query('DELETE FROM user_preferences WHERE user_id = $1 AND key = $2', [
      userId,
      key
    ]);
  }

  // Conversation History
  // Retrieves conversation history scoped to: channel + prompt context
  // This maintains natural group conversation flow while isolating different prompt personalities
  async getConversationHistory(
    channelId: string,
    promptHash: string,
    limit = 20
  ): Promise<ConversationMessage[]> {
    const result = await this.pool.query(
      `SELECT * FROM conversation_messages 
       WHERE channel_id = $1 AND prompt_hash = $2 
       ORDER BY created_at DESC LIMIT $3`,
      [channelId, promptHash, limit]
    );

    return result.rows.reverse().map((row: any) => ({
      id: row.id,
      guildId: row.guild_id,
      channelId: row.channel_id,
      userId: row.user_id,
      promptHash: row.prompt_hash,
      role: row.role,
      content: row.content,
      createdAt: new Date(row.created_at)
    }));
  }

  async storeConversationMessage(
    message: Omit<ConversationMessage, 'id' | 'createdAt'>
  ): Promise<ConversationMessage> {
    const result = await this.pool.query(
      `INSERT INTO conversation_messages (guild_id, channel_id, user_id, prompt_hash, role, content)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        message.guildId,
        message.channelId,
        message.userId,
        message.promptHash,
        message.role,
        message.content
      ]
    );

    const row = result.rows[0];
    return {
      id: row.id,
      guildId: row.guild_id,
      channelId: row.channel_id,
      userId: row.user_id,
      promptHash: row.prompt_hash,
      role: row.role,
      content: row.content,
      createdAt: new Date(row.created_at)
    };
  }

  async clearConversationHistory(channelId: string, promptHash?: string): Promise<void> {
    if (promptHash) {
      // Clear history for a specific prompt context in this channel
      await this.pool.query(
        'DELETE FROM conversation_messages WHERE channel_id = $1 AND prompt_hash = $2',
        [channelId, promptHash]
      );
    } else {
      // Clear all history for this channel
      await this.pool.query('DELETE FROM conversation_messages WHERE channel_id = $1', [channelId]);
    }
  }
}
