import { Pool, PoolClient } from 'pg';
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import {
  DatabaseAdapter,
  UserMemory,
  ServerMemory,
  UserPreference,
  ConversationMessage,
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
  created_at: string;
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

        try {
          await client.query(sql);
          await client.query('INSERT INTO public.schema_migrations (filename) VALUES ($1)', [file]);
          appliedMigrations.add(file);
          appliedCount += 1;
          logger.info(`✓ Migration applied and tracked: ${file}`);
        } catch (error: any) {
          if (this.isAlreadyAppliedMigrationError(error)) {
            await client.query(
              'INSERT INTO public.schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING',
              [file]
            );
            appliedMigrations.add(file);
            skippedCount += 1;
            logger.info(
              `⚠ Migration appears already applied, marked as tracked and skipped: ${file}`,
              { reason: error.message }
            );
            continue;
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
      // Don't throw - continue with app startup
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

  private isAlreadyAppliedMigrationError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const maybePgError = error as { message?: string; code?: string };
    const message = (maybePgError.message || '').toLowerCase();

    return message.includes('already exists') || maybePgError.code === 'EEXIST';
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
  // Retrieves conversation history scoped to: channel + prompt context
  // This maintains natural group conversation flow while isolating different prompt personalities
  async getConversationHistory(
    channelId: string,
    promptHash: string,
    limit = 20
  ): Promise<ConversationMessage[]> {
    const result = await this.pool.query<ConversationMessageRow>(
      `SELECT * FROM conversation_messages 
       WHERE channel_id = $1 AND prompt_hash = $2 
       ORDER BY created_at DESC LIMIT $3`,
      [channelId, promptHash, limit]
    );

    return result.rows.reverse().map(row => ({
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
      createdAt: new Date(row.created_at)
    }));
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

    const row = result.rows[0];
    return {
      id: row.id,
      guildId: row.guild_id,
      channelId: row.channel_id,
      userId: row.user_id,
      discordMessageId: row.discord_message_id,
      promptHash: row.prompt_hash,
      role: row.role,
      content: row.content,
      replyToMessageId: row.reply_to_message_id,
      replyToUserId: row.reply_to_user_id,
      referencedContent: row.referenced_content,
      imageSummary: row.image_summary,
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
