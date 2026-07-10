import { Pool, PoolClient } from 'pg';
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import {
  DatabaseAdapter,
  UserMemory,
  ServerMemory,
  UserPreference,
  ConversationMessage,
  ConversationTurn,
  PromptContextQuery,
  PromptContextResult,
  logger
} from '@silo/core';

// Type for database rows returned from queries
interface UserMemoryRow {
  id: string;
  user_id: string;
  memory_content: string;
  context_type: string;
  metadata: Record<string, unknown>;
  similarity?: number;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ServerMemoryRow {
  id: string;
  server_id: string;
  user_id: string;
  memory_content: string;
  title: string;
  context_type: string;
  metadata: Record<string, unknown>;
  similarity?: number;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ConversationMessageRow {
  id: string;
  guild_id: string;
  channel_id: string;
  user_id: string;
  discord_message_id: string | null;
  prompt_hash: string;
  role: string; // Note: This comes from DB, may be any string
  content: string;
  reply_to_message_id: string | null;
  reply_to_user_id: string | null;
  referenced_content: string | null;
  image_summary: string | null;
  turn_id: string | null;
  turn_sequence: number | null;
  requester_user_id: string | null;
  prompt_eligible: boolean;
  safety_state: string;
  safety_categories: unknown;
  created_at: string;
}

interface PromptContextAggregateRow {
  messages: unknown;
  selected_turn_count: number | string;
  excluded_turn_count: number | string;
  exclusion_reasons: unknown;
}

interface ReplyPromptContextRow extends ConversationMessageRow {
  reply_ancestor_excluded_count: number | string | null;
  reply_ancestor_exclusion_reason: string | null;
}

type MigrationSummary = {
  totalFiles: number;
  applied: number;
  skipped: number;
  baselineMarked: number;
  succeeded: boolean;
};

export class PostgresAdapter implements DatabaseAdapter {
  public readonly pool: Pool;

  private static readonly MIGRATION_LOCK_ID = 830245913;
  private lastMigrationSummary: MigrationSummary | null = null;

  getLastMigrationSummary(): MigrationSummary | null {
    return this.lastMigrationSummary;
  }

  private getBaselineVersion(): number {
    const rawValue = process.env.MIGRATION_BASELINE_VERSION || '14';
    const parsed = Number.parseInt(rawValue, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 14;
  }

  private parseMigrationVersion(fileName: string): number | null {
    const match = fileName.match(/^(\d+)/);
    if (!match || !match[1]) {
      return null;
    }

    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private async hasLegacySchema(client: PoolClient): Promise<boolean> {
    const result = await client.query<{ user_memory: string | null; server_memory: string | null }>(
      `SELECT to_regclass('public.user_memory')::text AS user_memory,
              to_regclass('public.server_memory')::text AS server_memory`
    );

    const row = result.rows[0];
    if (!row) {
      return false;
    }

    return Boolean(row.user_memory && row.server_memory);
  }

  /**
   * Validates and converts embedding array to a valid PostgreSQL vector string
   * Ensures the embedding is a non-empty array of finite numbers
   * @param embedding - The embedding array to validate
   * @returns A valid vector string like "[0.1,0.2,0.3]" or null if invalid
   */
  private validateAndBuildVectorStr(embedding: unknown): string | null {
    // Type guard: ensure it's an array
    if (!Array.isArray(embedding)) {
      logger.warn('Invalid embedding: not an array', { type: typeof embedding });
      return null;
    }

    // Ensure non-empty
    if (embedding.length === 0) {
      logger.warn('Invalid embedding: empty array');
      return null;
    }

    // Validate and coerce each element to a number
    const validatedNumbers: number[] = [];
    for (const value of embedding) {
      // Try to coerce to number
      const num = typeof value === 'number' ? value : Number(value);

      // Check if it's a valid finite number
      if (!Number.isFinite(num)) {
        logger.warn('Invalid embedding: contains non-finite number', { value, coercedTo: num });
        return null;
      }

      validatedNumbers.push(num);
    }

    // Build the vector string from validated numbers
    return `[${validatedNumbers.join(',')}]`;
  }

  private mapConversationMessageRow(row: ConversationMessageRow): ConversationMessage {
    return {
      id: row.id,
      guildId: row.guild_id,
      channelId: row.channel_id,
      userId: row.user_id,
      discordMessageId: row.discord_message_id,
      promptHash: row.prompt_hash,
      role: row.role as ConversationMessage['role'],
      content: row.content,
      replyToMessageId: row.reply_to_message_id,
      replyToUserId: row.reply_to_user_id,
      referencedContent: row.referenced_content,
      imageSummary: row.image_summary,
      turnId: row.turn_id,
      turnSequence: row.turn_sequence,
      requesterUserId: row.requester_user_id,
      promptEligible: row.prompt_eligible ?? false,
      safetyState: row.safety_state || 'legacy',
      safetyCategories: Array.isArray(row.safety_categories)
        ? row.safety_categories.map(String)
        : [],
      createdAt: new Date(row.created_at)
    };
  }

  private parseConversationMessageRows(value: unknown): ConversationMessageRow[] {
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? (parsed as ConversationMessageRow[]) : [];
  }

  private parseExclusionReasons(value: unknown): Record<string, number> {
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    const reasons: Record<string, number> = {};
    for (const [reason, count] of Object.entries(parsed)) {
      const normalizedCount = Number(count);
      if (Number.isFinite(normalizedCount) && normalizedCount > 0) {
        reasons[reason] = normalizedCount;
      }
    }
    return reasons;
  }

  constructor(connectionUrl: string, options?: { ssl?: boolean; maxConnections?: number }) {
    this.pool = new Pool({
      connectionString: connectionUrl,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
      max: options?.maxConnections ?? 10,
      ...(options?.ssl ? { ssl: { rejectUnauthorized: false } } : {})
    });

    // Ensure search_path includes public schema on every new connection
    // This is critical for Supabase pooled connections which may reset schema context
    this.pool.on('connect', async client => {
      try {
        await client.query('SET search_path TO public');
      } catch (err) {
        logger.warn('Failed to set search_path on connection:', err);
      }
    });

    // Handle unexpected pool errors (e.g. idle client disconnections)
    // Without this handler, pool errors become uncaught exceptions that crash the process
    this.pool.on('error', err => {
      logger.error('Unexpected database pool error:', err);
    });
  }

  async connect(): Promise<void> {
    try {
      const client = await this.pool.connect();
      client.release();
      logger.info('Database connected');

      // Run migrations on connect
      await this.runMigrations();
    } catch (error) {
      logger.error('Failed to connect to database', error);
      throw error;
    }
  }

  private async runMigrations(): Promise<void> {
    let client: PoolClient | undefined;

    try {
      const migrationsDir = this.resolveMigrationsDir();
      const migrationFiles = readdirSync(migrationsDir)
        .filter(file => file.endsWith('.sql'))
        .sort();

      logger.info(`Found ${migrationFiles.length} migration files`);

      if (migrationFiles.length === 0) {
        this.lastMigrationSummary = {
          totalFiles: 0,
          applied: 0,
          skipped: 0,
          baselineMarked: 0,
          succeeded: true
        };
        logger.info('No migration files found, skipping migration step');
        return;
      }

      client = await this.pool.connect();
      // Set a higher statement timeout for migrations (120 seconds)
      await client.query('SET statement_timeout TO 120000');
      await client.query('SELECT pg_advisory_lock($1)', [PostgresAdapter.MIGRATION_LOCK_ID]);

      await client.query(`
        CREATE TABLE IF NOT EXISTS public.schema_migrations (
          filename TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      const appliedResult = await client.query<{ filename: string }>(
        'SELECT filename FROM public.schema_migrations'
      );
      const appliedMigrations = new Set(appliedResult.rows.map(row => row.filename));

      let appliedCount = 0;
      let skippedCount = 0;
      let baselineMarkedCount = 0;

      if (appliedMigrations.size === 0 && (await this.hasLegacySchema(client))) {
        const baselineVersion = this.getBaselineVersion();
        const filesToBaseline = migrationFiles.filter(file => {
          const version = this.parseMigrationVersion(file);
          return version !== null && version < baselineVersion;
        });

        for (const file of filesToBaseline) {
          await client.query(
            'INSERT INTO public.schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING',
            [file]
          );
          appliedMigrations.add(file);
          baselineMarkedCount += 1;
        }

        if (baselineMarkedCount > 0) {
          logger.info('Legacy database baseline applied for migration tracking', {
            baselineVersion,
            markedApplied: baselineMarkedCount
          });
        }
      }

      for (const file of migrationFiles) {
        if (appliedMigrations.has(file)) {
          skippedCount += 1;
          logger.info(`↷ Migration already tracked, skipping: ${file}`);
          continue;
        }

        const filePath = join(migrationsDir, file);
        const sql = readFileSync(filePath, 'utf-8');

        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO public.schema_migrations (filename) VALUES ($1)', [file]);
          await client.query('COMMIT');
          appliedMigrations.add(file);
          appliedCount += 1;
          logger.info(`✓ Migration applied and tracked: ${file}`);
        } catch (error) {
          try {
            await client.query('ROLLBACK');
          } catch (rollbackError) {
            logger.error(`Failed to roll back migration ${file}`, rollbackError);
          }
          throw error;
        }
      }

      logger.info('Migration step completed', {
        totalFiles: migrationFiles.length,
        applied: appliedCount,
        skipped: skippedCount,
        baselineMarked: baselineMarkedCount
      });

      this.lastMigrationSummary = {
        totalFiles: migrationFiles.length,
        applied: appliedCount,
        skipped: skippedCount,
        baselineMarked: baselineMarkedCount,
        succeeded: true
      };
    } catch (error) {
      logger.error('Failed to run migrations:', error);
      this.lastMigrationSummary = {
        totalFiles: 0,
        applied: 0,
        skipped: 0,
        baselineMarked: 0,
        succeeded: false
      };
      throw error;
    } finally {
      if (client) {
        try {
          await client.query('SELECT pg_advisory_unlock($1)', [PostgresAdapter.MIGRATION_LOCK_ID]);
        } catch (unlockError) {
          logger.warn('Failed to release migration advisory lock', unlockError);
        }

        client.release();
      }
    }
  }

  private resolveMigrationsDir(): string {
    let current = resolve(process.cwd());

    while (true) {
      const candidate = join(current, 'supabase', 'migrations');
      if (existsSync(candidate)) {
        const stats = statSync(candidate);
        if (stats.isDirectory()) {
          return candidate;
        }
      }

      const parent = dirname(current);
      if (parent === current) {
        break;
      }

      current = parent;
    }

    // Fall back to cwd-relative path so original behavior remains predictable in logs.
    return join(process.cwd(), 'supabase', 'migrations');
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
  async getUserMemoryCount(userId: string): Promise<number> {
    const result = await this.pool.query(
      'SELECT COUNT(*)::int AS count FROM user_memory WHERE user_id = $1',
      [userId]
    );
    return result.rows[0]?.count ?? 0;
  }

  async getAllMemoryCount(): Promise<number> {
    const result = await this.pool.query('SELECT COUNT(*)::int AS count FROM user_memory');
    return result.rows[0]?.count ?? 0;
  }

  async getUserMemories(userId: string, contextType?: string, limit = 50): Promise<UserMemory[]> {
    const query = contextType
      ? 'SELECT * FROM user_memory WHERE user_id = $1 AND context_type = $2 ORDER BY created_at DESC LIMIT $3'
      : 'SELECT * FROM user_memory WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2';

    const params = contextType ? [userId, contextType, limit] : [userId, limit];
    const result = await this.pool.query<UserMemoryRow>(query, params);

    return result.rows.map(row => ({
      id: row.id,
      userId: row.user_id,
      memoryContent: row.memory_content,
      contextType: row.context_type as UserMemory['contextType'],
      metadata: row.metadata,
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    }));
  }

  async getAllMemories(contextType?: string, limit = 50): Promise<UserMemory[]> {
    const query = contextType
      ? 'SELECT * FROM user_memory WHERE context_type = $1 ORDER BY created_at DESC LIMIT $2'
      : 'SELECT * FROM user_memory ORDER BY created_at DESC LIMIT $1';

    const params = contextType ? [contextType, limit] : [limit];
    const result = await this.pool.query<UserMemoryRow>(query, params);

    return result.rows.map(row => ({
      id: row.id,
      userId: row.user_id,
      memoryContent: row.memory_content,
      contextType: row.context_type as UserMemory['contextType'],
      metadata: row.metadata,
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    }));
  }

  async storeUserMemory(
    memory: Omit<UserMemory, 'id' | 'createdAt' | 'updatedAt'>,
    embedding?: number[]
  ): Promise<UserMemory> {
    const result = await this.pool.query(
      `INSERT INTO user_memory (user_id, memory_content, context_type, metadata, expires_at, embedding)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        memory.userId,
        memory.memoryContent,
        memory.contextType,
        memory.metadata || {},
        memory.expiresAt,
        embedding ? `[${embedding.join(',')}]` : null
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

  async updateUserMemory(
    id: string,
    updates: Partial<UserMemory>,
    embedding?: number[]
  ): Promise<UserMemory> {
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
    if (embedding !== undefined) {
      fields.push(`embedding = $${paramIndex++}`);
      values.push(embedding ? `[${embedding.join(',')}]` : null);
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

  async findUserMemoryByIdPrefix(userId: string, idPrefix: string): Promise<UserMemory | null> {
    const result = await this.pool.query<UserMemoryRow>(
      `SELECT * FROM user_memory 
       WHERE user_id = $1 AND id::text LIKE $2
       LIMIT 1`,
      [userId, `${idPrefix}%`]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0]!;
    return {
      id: row.id,
      userId: row.user_id,
      memoryContent: row.memory_content,
      contextType: row.context_type as UserMemory['contextType'],
      metadata: row.metadata,
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }

  async searchUserMemories(userId: string, query: string, limit = 20): Promise<UserMemory[]> {
    const result = await this.pool.query<UserMemoryRow>(
      `SELECT * FROM user_memory 
       WHERE user_id = $1 AND memory_content ILIKE $2 
       ORDER BY created_at DESC LIMIT $3`,
      [userId, `%${query}%`, limit]
    );

    return result.rows.map(row => ({
      id: row.id,
      userId: row.user_id,
      memoryContent: row.memory_content,
      contextType: row.context_type as UserMemory['contextType'],
      metadata: row.metadata,
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    }));
  }

  /**
   * Search user memories using semantic vector similarity (RAG)
   * Finds memories most relevant to the query based on embedding similarity
   * Returns results with similarity scores for ranking
   */
  async searchUserMemoriesByEmbedding(
    userId: string,
    embedding: number[],
    contextType?: string,
    limit = 10
  ): Promise<(UserMemory & { similarity: number })[]> {
    try {
      // Validate and build vector string from embedding
      const vectorStr = this.validateAndBuildVectorStr(embedding);
      if (!vectorStr) {
        logger.warn('Embedding validation failed, returning empty results');
        return [];
      }

      const query = contextType
        ? `SELECT *, (1 - (embedding <=> $3::vector)) as similarity 
           FROM user_memory 
           WHERE user_id = $1 AND context_type = $2 AND embedding IS NOT NULL 
           ORDER BY embedding <=> $3::vector 
           LIMIT $4`
        : `SELECT *, (1 - (embedding <=> $2::vector)) as similarity 
           FROM user_memory 
           WHERE user_id = $1 AND embedding IS NOT NULL 
           ORDER BY embedding <=> $2::vector 
           LIMIT $3`;

      const params = contextType
        ? [userId, contextType, vectorStr, limit]
        : [userId, vectorStr, limit];

      const result = await this.pool.query<UserMemoryRow>(query, params);

      return result.rows.map(row => ({
        id: row.id,
        userId: row.user_id,
        memoryContent: row.memory_content,
        contextType: row.context_type as UserMemory['contextType'],
        metadata: row.metadata,
        similarity: row.similarity ?? 0,
        expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at)
      }));
    } catch (error) {
      logger.error('Failed to search user memories by embedding', error);
      // Gracefully fall back to empty results if vector search fails
      return [];
    }
  }

  /**
   * Get relevant memories for conversation context
   * Combines vector similarity search with recency weighting
   * Filters expired memories and enforces access control
   */
  async getRelevantUserMemoriesForContext(
    userId: string,
    embedding: number[],
    contextType?: string,
    limit = 5
  ): Promise<UserMemory[]> {
    const relevantMemories = await this.searchUserMemoriesByEmbedding(
      userId,
      embedding,
      contextType,
      limit
    );

    // Filter out expired memories
    const now = new Date();
    return relevantMemories
      .filter(m => !m.expiresAt || m.expiresAt > now)
      .map(({ similarity: _unused, ...rest }) => rest);
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
      ? 'SELECT * FROM server_memory WHERE server_id = $1 AND context_type = $2 AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY created_at DESC LIMIT $3'
      : 'SELECT * FROM server_memory WHERE server_id = $1 AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY created_at DESC LIMIT $2';

    const params = contextType ? [serverId, contextType, limit] : [serverId, limit];
    const result = await this.pool.query<ServerMemoryRow>(query, params);

    return result.rows.map(row => ({
      id: row.id,
      serverId: row.server_id,
      userId: row.user_id,
      memoryContent: row.memory_content,
      title: row.title,
      contextType: row.context_type as ServerMemory['contextType'],
      metadata: row.metadata,
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    }));
  }

  async searchServerMemories(serverId: string, query: string, limit = 20): Promise<ServerMemory[]> {
    const result = await this.pool.query<ServerMemoryRow>(
      `SELECT * FROM server_memory
       WHERE server_id = $1
         AND memory_content ILIKE $2
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY created_at DESC
       LIMIT $3`,
      [serverId, `%${query}%`, limit]
    );

    return result.rows.map(row => ({
      id: row.id,
      serverId: row.server_id,
      userId: row.user_id,
      memoryContent: row.memory_content,
      title: row.title,
      contextType: row.context_type as ServerMemory['contextType'],
      metadata: row.metadata,
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    }));
  }

  async searchServerMemoriesByEmbedding(
    serverId: string,
    embedding: number[],
    contextType?: string,
    limit = 10
  ): Promise<(ServerMemory & { similarity: number })[]> {
    try {
      const vectorStr = this.validateAndBuildVectorStr(embedding);
      if (!vectorStr) {
        logger.warn('Server memory embedding validation failed, returning empty results');
        return [];
      }

      const query = contextType
        ? `SELECT *, (1 - (embedding <=> $3::vector)) as similarity
           FROM server_memory
           WHERE server_id = $1
             AND context_type = $2
             AND embedding IS NOT NULL
             AND (expires_at IS NULL OR expires_at > NOW())
           ORDER BY embedding <=> $3::vector
           LIMIT $4`
        : `SELECT *, (1 - (embedding <=> $2::vector)) as similarity
           FROM server_memory
           WHERE server_id = $1
             AND embedding IS NOT NULL
             AND (expires_at IS NULL OR expires_at > NOW())
           ORDER BY embedding <=> $2::vector
           LIMIT $3`;

      const params = contextType
        ? [serverId, contextType, vectorStr, limit]
        : [serverId, vectorStr, limit];

      const result = await this.pool.query<ServerMemoryRow>(query, params);

      return result.rows.map(row => ({
        id: row.id,
        serverId: row.server_id,
        userId: row.user_id,
        memoryContent: row.memory_content,
        title: row.title,
        contextType: row.context_type as ServerMemory['contextType'],
        metadata: row.metadata,
        similarity: row.similarity ?? 0,
        expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at)
      }));
    } catch (error) {
      logger.error('Failed to search server memories by embedding', error);
      return [];
    }
  }

  async getRelevantServerMemoriesForContext(
    serverId: string,
    embedding: number[],
    contextType?: string,
    limit = 5
  ): Promise<ServerMemory[]> {
    const relevant = await this.searchServerMemoriesByEmbedding(
      serverId,
      embedding,
      contextType,
      limit
    );

    return relevant.map(({ similarity: _unused, ...rest }) => rest);
  }

  async storeServerMemory(
    memory: Omit<ServerMemory, 'id' | 'createdAt' | 'updatedAt'>,
    embedding?: number[]
  ): Promise<ServerMemory> {
    const vectorStr = embedding ? this.validateAndBuildVectorStr(embedding) : null;
    const result = await this.pool.query(
      `INSERT INTO server_memory (server_id, user_id, memory_content, title, context_type, metadata, expires_at, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        memory.serverId,
        memory.userId,
        memory.memoryContent,
        memory.title,
        memory.contextType,
        memory.metadata || {},
        memory.expiresAt,
        vectorStr
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

  async updateServerMemory(
    id: string,
    updates: Partial<Omit<ServerMemory, 'id' | 'createdAt' | 'updatedAt'>>,
    embedding?: number[]
  ): Promise<ServerMemory> {
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
    if (embedding !== undefined) {
      fields.push(`embedding = $${paramIndex++}`);
      values.push(embedding ? this.validateAndBuildVectorStr(embedding) : null);
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
  // Legacy audit/command path. Model prompt assembly must use getPromptContext.
  async getConversationHistory(
    channelId: string,
    promptHash: string,
    limit = 20
  ): Promise<ConversationMessage[]> {
    const result = await this.pool.query<ConversationMessageRow>(
      `SELECT *
       FROM (
         SELECT *
         FROM conversation_messages
         WHERE channel_id = $1 AND prompt_hash = $2
         ORDER BY created_at DESC
         LIMIT $3
       ) AS recent
       ORDER BY created_at ASC,
         CASE role
           WHEN 'user' THEN 0
           WHEN 'assistant' THEN 1
           ELSE 2
         END`,
      [channelId, promptHash, limit]
    );

    return result.rows.map(row => this.mapConversationMessageRow(row));
  }

  async getPromptContext(query: PromptContextQuery): Promise<PromptContextResult> {
    const requestedMaxTurns =
      typeof query.maxTurns === 'number' && Number.isFinite(query.maxTurns)
        ? Math.trunc(query.maxTurns)
        : 3;
    const maxTurns = Math.min(Math.max(requestedMaxTurns, 1), 3);

    if (query.replyToMessageId) {
      const replyResult = await this.pool.query<ReplyPromptContextRow>(
        `WITH RECURSIVE eligible_turns AS (
           SELECT turn_id
           FROM conversation_messages
           WHERE guild_id = $2
             AND channel_id = $3
             AND prompt_hash = $4
             AND prompt_eligible = TRUE
             AND turn_id IS NOT NULL
           GROUP BY turn_id
           HAVING COUNT(*) FILTER (WHERE turn_sequence = 0 AND role = 'user') = 1
              AND COUNT(*) FILTER (WHERE turn_sequence = 1 AND role = 'assistant') = 1
              AND COUNT(*) = 2
              AND COUNT(DISTINCT requester_user_id) = 1
         ),
         reply_turns AS (
           SELECT seed.turn_id, 1 AS depth
           FROM (
             SELECT message.turn_id
             FROM conversation_messages message
             JOIN eligible_turns eligible ON eligible.turn_id = message.turn_id
             WHERE message.discord_message_id = $1
             ORDER BY message.turn_sequence DESC NULLS LAST
             LIMIT 1
           ) AS seed

           UNION ALL

           SELECT previous.turn_id, reply_turns.depth + 1
           FROM reply_turns
           JOIN conversation_messages current_user_message
             ON current_user_message.turn_id = reply_turns.turn_id
            AND current_user_message.turn_sequence = 0
           JOIN LATERAL (
             SELECT candidate.turn_id
             FROM conversation_messages candidate
             JOIN eligible_turns eligible ON eligible.turn_id = candidate.turn_id
             WHERE candidate.discord_message_id = current_user_message.reply_to_message_id
             ORDER BY candidate.turn_sequence DESC NULLS LAST
             LIMIT 1
           ) AS previous ON TRUE
           WHERE reply_turns.depth < $5
         ),
         selected_turns AS (
           SELECT turn_id, MAX(depth) AS depth
           FROM reply_turns
           GROUP BY turn_id
         ),
         oldest_selected_turn AS (
           SELECT turn_id, depth
           FROM reply_turns
           ORDER BY depth DESC, turn_id
           LIMIT 1
         ),
         blocked_reply_ancestor AS (
           SELECT 1 AS excluded_count
           FROM oldest_selected_turn oldest
           JOIN conversation_messages oldest_user
             ON oldest_user.turn_id = oldest.turn_id
            AND oldest_user.turn_sequence = 0
           JOIN conversation_messages candidate
             ON candidate.guild_id = $2
            AND candidate.channel_id = $3
            AND candidate.prompt_hash = $4
            AND candidate.discord_message_id = oldest_user.reply_to_message_id
           WHERE oldest.depth < $5
             AND oldest_user.reply_to_message_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1
               FROM eligible_turns eligible
               WHERE eligible.turn_id = candidate.turn_id
             )
           LIMIT 1
         )
         SELECT
           message.*,
           CASE
             WHEN EXISTS (SELECT 1 FROM blocked_reply_ancestor) THEN 1
             ELSE 0
           END AS reply_ancestor_excluded_count,
           CASE
             WHEN EXISTS (SELECT 1 FROM blocked_reply_ancestor)
               THEN 'reply_ancestor_ineligible'
             ELSE NULL
           END AS reply_ancestor_exclusion_reason
         FROM selected_turns
         JOIN conversation_messages message ON message.turn_id = selected_turns.turn_id
         WHERE message.prompt_eligible = TRUE
         ORDER BY selected_turns.depth DESC, message.turn_sequence ASC`,
        [query.replyToMessageId, query.guildId, query.channelId, query.promptHash, maxTurns]
      );

      if (replyResult.rows.length === 0) {
        return {
          messages: [],
          scope: 'none',
          selectedTurnCount: 0,
          excludedTurnCount: 1,
          exclusionReasons: { reply_target_ineligible: 1 }
        };
      }

      const turnIds = new Set(replyResult.rows.map(row => row.turn_id).filter(Boolean));
      const firstReplyRow = replyResult.rows[0];
      const excludedTurnCount = Math.max(
        0,
        Number(firstReplyRow?.reply_ancestor_excluded_count) || 0
      );
      const exclusionReason =
        firstReplyRow?.reply_ancestor_exclusion_reason || 'reply_ancestor_ineligible';
      return {
        messages: replyResult.rows.map(row => this.mapConversationMessageRow(row)),
        scope: 'reply_chain',
        selectedTurnCount: turnIds.size,
        excludedTurnCount,
        exclusionReasons: excludedTurnCount > 0 ? { [exclusionReason]: excludedTurnCount } : {}
      };
    }

    const requestedMaxAgeMs =
      typeof query.maxAgeMs === 'number' && Number.isFinite(query.maxAgeMs)
        ? Math.trunc(query.maxAgeMs)
        : 30 * 60 * 1000;
    const maxAgeMs = Math.min(Math.max(requestedMaxAgeMs, 60_000), 86_400_000);
    const sameUserResult = await this.pool.query<PromptContextAggregateRow>(
      `WITH scoped_rows AS (
         SELECT message.*
         FROM conversation_messages message
         WHERE message.guild_id = $1
           AND message.channel_id = $2
           AND message.prompt_hash = $3
           AND message.requester_user_id = $4
           AND message.created_at >= NOW() - ($5 * INTERVAL '1 millisecond')

         UNION ALL

         SELECT legacy.*
         FROM conversation_messages legacy
         WHERE legacy.guild_id = $1
           AND legacy.channel_id = $2
           AND legacy.prompt_hash = $3
           AND legacy.turn_id IS NULL
           AND legacy.requester_user_id IS NULL
           AND legacy.role = 'user'
           AND legacy.user_id = $4
           AND legacy.created_at >= NOW() - ($5 * INTERVAL '1 millisecond')
       ),
       candidate_turns AS (
         SELECT
           COALESCE(turn_id::text, 'legacy-row:' || id::text) AS context_key,
           MIN(turn_id::text)::uuid AS turn_id,
           MAX(created_at) AS turn_created_at,
           BOOL_OR(turn_id IS NULL OR safety_state = 'legacy') AS is_legacy,
           BOOL_AND(prompt_eligible) AS all_prompt_eligible,
           BOOL_AND(safety_state IN ('allowed', 'output_repaired', 'quality_repaired'))
             AS all_safety_states_eligible,
           COUNT(*) AS row_count,
           COUNT(*) FILTER (WHERE turn_sequence = 0 AND role = 'user') AS user_row_count,
           COUNT(*) FILTER (WHERE turn_sequence = 1 AND role = 'assistant')
             AS assistant_row_count,
           COUNT(DISTINCT requester_user_id) AS requester_count
         FROM scoped_rows
         GROUP BY COALESCE(turn_id::text, 'legacy-row:' || id::text)
       ),
       classified_turns AS (
         SELECT
           context_key,
           turn_id,
           turn_created_at,
           CASE
             WHEN is_legacy THEN 'legacy'
             WHEN row_count <> 2
               OR user_row_count <> 1
               OR assistant_row_count <> 1
               OR requester_count <> 1
               THEN 'incomplete_or_unpaired'
             WHEN NOT all_prompt_eligible OR NOT all_safety_states_eligible
               THEN 'unsafe_or_ineligible'
             ELSE NULL
           END AS exclusion_reason
         FROM candidate_turns
       ),
       ranked_safe_turns AS (
         SELECT
           context_key,
           turn_id,
           turn_created_at,
           ROW_NUMBER() OVER (ORDER BY turn_created_at DESC, context_key DESC) AS safe_rank
         FROM classified_turns
         WHERE exclusion_reason IS NULL
       ),
       final_classification AS (
         SELECT context_key, turn_id, turn_created_at, exclusion_reason
         FROM classified_turns
         WHERE exclusion_reason IS NOT NULL

         UNION ALL

         SELECT
           context_key,
           turn_id,
           turn_created_at,
           CASE WHEN safe_rank > $6 THEN 'over_limit' ELSE NULL END AS exclusion_reason
         FROM ranked_safe_turns
       ),
       selected_turns AS (
         SELECT context_key, turn_id, turn_created_at
         FROM final_classification
         WHERE exclusion_reason IS NULL
       ),
       selected_messages AS (
         SELECT COALESCE(
           jsonb_agg(
             to_jsonb(message)
             ORDER BY selected.turn_created_at ASC, selected.context_key ASC,
               message.turn_sequence ASC
           ),
           '[]'::jsonb
         ) AS messages
         FROM selected_turns selected
         JOIN conversation_messages message ON message.turn_id = selected.turn_id
       ),
       exclusion_counts AS (
         SELECT exclusion_reason, COUNT(*)::int AS reason_count
         FROM final_classification
         WHERE exclusion_reason IS NOT NULL
         GROUP BY exclusion_reason
       )
       SELECT
         selected_messages.messages,
         (SELECT COUNT(*)::int FROM selected_turns) AS selected_turn_count,
         COALESCE((SELECT SUM(reason_count)::int FROM exclusion_counts), 0)
           AS excluded_turn_count,
         COALESCE(
           (SELECT jsonb_object_agg(exclusion_reason, reason_count) FROM exclusion_counts),
           '{}'::jsonb
         ) AS exclusion_reasons
       FROM selected_messages`,
      [query.guildId, query.channelId, query.promptHash, query.requesterUserId, maxAgeMs, maxTurns]
    );

    const aggregate = sameUserResult.rows[0];
    const rows = this.parseConversationMessageRows(aggregate?.messages);
    const selectedTurnCount = Math.max(0, Number(aggregate?.selected_turn_count) || 0);
    return {
      messages: rows.map(row => this.mapConversationMessageRow(row)),
      scope: selectedTurnCount > 0 ? 'same_user' : 'none',
      selectedTurnCount,
      excludedTurnCount: Math.max(0, Number(aggregate?.excluded_turn_count) || 0),
      exclusionReasons: this.parseExclusionReasons(aggregate?.exclusion_reasons)
    };
  }

  async storeConversationMessage(
    message: Omit<ConversationMessage, 'id' | 'createdAt'>
  ): Promise<ConversationMessage> {
    const result = await this.pool.query(
      `INSERT INTO conversation_messages (
         guild_id,
         channel_id,
         user_id,
         discord_message_id,
         prompt_hash,
         role,
         content,
         reply_to_message_id,
         reply_to_user_id,
         referenced_content,
         image_summary
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        message.guildId,
        message.channelId,
        message.userId,
        message.discordMessageId ?? null,
        message.promptHash,
        message.role,
        message.content,
        message.replyToMessageId ?? null,
        message.replyToUserId ?? null,
        message.referencedContent ?? null,
        message.imageSummary ?? null
      ]
    );

    const row = result.rows[0] as ConversationMessageRow;
    return this.mapConversationMessageRow(row);
  }

  async storeConversationTurn(turn: ConversationTurn): Promise<ConversationMessage[]> {
    if (turn.userMessage.role !== 'user' || turn.assistantMessage.role !== 'assistant') {
      throw new Error('Conversation turns require one user row followed by one assistant row');
    }
    if (turn.requesterUserId !== turn.userMessage.userId) {
      throw new Error('Conversation turn requester must match the user row author');
    }
    if (
      turn.userMessage.guildId !== turn.assistantMessage.guildId ||
      turn.userMessage.channelId !== turn.assistantMessage.channelId ||
      turn.userMessage.promptHash !== turn.assistantMessage.promptHash
    ) {
      throw new Error('Conversation turn rows must share guild, channel, and prompt scope');
    }
    if (
      turn.promptEligible &&
      !['allowed', 'output_repaired', 'quality_repaired'].includes(turn.safetyState)
    ) {
      throw new Error(`Conversation turn safety state ${turn.safetyState} is not prompt eligible`);
    }

    const client = await this.pool.connect();
    const rows = [
      { ...turn.userMessage, turnSequence: 0 },
      { ...turn.assistantMessage, turnSequence: 1 }
    ];

    let transactionStarted = false;
    try {
      await client.query('BEGIN');
      transactionStarted = true;
      const stored: ConversationMessageRow[] = [];

      for (const message of rows) {
        const result = await client.query<ConversationMessageRow>(
          `INSERT INTO conversation_messages (
             guild_id,
             channel_id,
             user_id,
             discord_message_id,
             prompt_hash,
             role,
             content,
             reply_to_message_id,
             reply_to_user_id,
             referenced_content,
             image_summary,
             turn_id,
             turn_sequence,
             requester_user_id,
             prompt_eligible,
             safety_state,
             safety_categories,
             created_at
           )
           VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
             $12, $13, $14, $15, $16, $17::jsonb, transaction_timestamp()
           )
           RETURNING *`,
          [
            message.guildId,
            message.channelId,
            message.userId,
            message.discordMessageId ?? null,
            message.promptHash,
            message.role,
            message.content,
            message.replyToMessageId ?? null,
            message.replyToUserId ?? null,
            message.referencedContent ?? null,
            message.imageSummary ?? null,
            turn.turnId,
            message.turnSequence,
            turn.requesterUserId,
            turn.promptEligible,
            turn.safetyState,
            JSON.stringify(turn.safetyCategories)
          ]
        );

        const row = result.rows[0];
        if (!row) {
          throw new Error(`Failed to store conversation turn sequence ${message.turnSequence}`);
        }
        stored.push(row);
      }

      await client.query('COMMIT');
      return stored.map(row => this.mapConversationMessageRow(row));
    } catch (error) {
      if (transactionStarted) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
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
