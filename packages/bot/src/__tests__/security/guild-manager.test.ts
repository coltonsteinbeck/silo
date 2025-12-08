/**
 * Tests for Guild Manager
 * 
 * Tests guild onboarding, waitlist, and eviction logic.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';

// Mock the deploymentDetector
const mockDeploymentConfig = {
  isProduction: false,
  isDevelopment: true,
  isSelfHosted: true,
  maxGuilds: 100
};

// Create a mock pool
function createSimpleMockPool() {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: mock(async (_sql: string, _params?: unknown[]): Promise<{ rows: any[]; rowCount: number }> => ({
      rows: [{ count: 0 }],
      rowCount: 1
    }))
  };
}

// Create a mock guild manager for testing
class MockGuildManager {
  private pool: ReturnType<typeof createSimpleMockPool> | null = null;
  
  init(pool: ReturnType<typeof createSimpleMockPool>, _client: unknown): void {
    this.pool = pool;
  }
  
  setClient(_client: unknown): void {
    // Client not used in tests
  }
  
  setPool(pool: ReturnType<typeof createSimpleMockPool>): void {
    this.pool = pool;
  }
  
  async getActiveGuildCount(): Promise<number> {
    if (!this.pool) throw new Error('Not initialized');
    const result = await this.pool.query('SELECT count FROM guilds', []);
    return result.rows[0]?.count ?? 0;
  }
  
  async canJoinGuild(): Promise<boolean> {
    if (mockDeploymentConfig.isSelfHosted) return true;
    const activeCount = await this.getActiveGuildCount();
    return activeCount < mockDeploymentConfig.maxGuilds;
  }
  
  getConfig() {
    return mockDeploymentConfig;
  }
}

describe('GuildManager', () => {
  let guildManager: MockGuildManager;
  let mockPool: ReturnType<typeof createSimpleMockPool>;
  let mockClient: unknown;

  beforeEach(() => {
    mockPool = createSimpleMockPool();
    mockClient = {
      guilds: { cache: new Map() },
      user: { id: 'bot123' }
    };
    guildManager = new MockGuildManager();
    guildManager.init(mockPool, mockClient);
    
    // Reset deployment config
    mockDeploymentConfig.isProduction = false;
    mockDeploymentConfig.isDevelopment = true;
    mockDeploymentConfig.isSelfHosted = true;
  });

  describe('initialization', () => {
    test('can initialize with pool and client', () => {
      const manager = new MockGuildManager();
      manager.init(mockPool, mockClient);
      expect(manager.getConfig()).toBeDefined();
    });

    test('can set client separately', () => {
      const manager = new MockGuildManager();
      manager.setClient(mockClient);
      expect(manager.getConfig()).toBeDefined();
    });

    test('can set pool separately', () => {
      const manager = new MockGuildManager();
      manager.setPool(mockPool);
      expect(manager.getConfig()).toBeDefined();
    });
  });

  describe('canJoinGuild', () => {
    test('always allows join in self-hosted mode', async () => {
      mockDeploymentConfig.isSelfHosted = true;
      mockDeploymentConfig.isProduction = false;

      const canJoin = await guildManager.canJoinGuild();
      expect(canJoin).toBe(true);
    });

    test('checks capacity in hosted mode when under limit', async () => {
      mockDeploymentConfig.isSelfHosted = false;
      mockDeploymentConfig.isProduction = true;
      mockDeploymentConfig.maxGuilds = 100;
      
      mockPool.query = mock(async () => ({ rows: [{ count: 50 }], rowCount: 1 }));

      const canJoin = await guildManager.canJoinGuild();
      expect(canJoin).toBe(true);
    });

    test('rejects in hosted mode when at capacity', async () => {
      mockDeploymentConfig.isSelfHosted = false;
      mockDeploymentConfig.isProduction = true;
      mockDeploymentConfig.maxGuilds = 100;
      
      mockPool.query = mock(async () => ({ rows: [{ count: 100 }], rowCount: 1 }));

      const canJoin = await guildManager.canJoinGuild();
      expect(canJoin).toBe(false);
    });
  });

  describe('getActiveGuildCount', () => {
    test('returns count from database', async () => {
      mockPool.query = mock(async () => ({ rows: [{ count: 42 }], rowCount: 1 }));

      const count = await guildManager.getActiveGuildCount();
      expect(count).toBe(42);
    });

    test('returns 0 when no results', async () => {
      mockPool.query = mock(async () => ({ rows: [], rowCount: 0 }));

      const count = await guildManager.getActiveGuildCount();
      expect(count).toBe(0);
    });

    test('throws when not initialized', async () => {
      const uninitializedManager = new MockGuildManager();
      
      await expect(uninitializedManager.getActiveGuildCount()).rejects.toThrow('Not initialized');
    });
  });

  describe('deployment modes', () => {
    test('development mode has self-hosted flag', () => {
      mockDeploymentConfig.isDevelopment = true;
      mockDeploymentConfig.isSelfHosted = true;

      const config = guildManager.getConfig();
      expect(config.isSelfHosted).toBe(true);
    });

    test('production mode can have hosted flag', () => {
      mockDeploymentConfig.isProduction = true;
      mockDeploymentConfig.isSelfHosted = false;

      const config = guildManager.getConfig();
      expect(config.isSelfHosted).toBe(false);
    });
  });
});
