/**
 * Tests for Deployment Detector
 * 
 * Tests environment detection, deployment mode detection,
 * and capacity management across different configurations.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { withEnv } from '@silo/core/test-setup';
import {
  detectEnvironment,
  detectDeploymentMode,
  isHostedMode,
  isSelfHostedMode,
  getMaxGuilds,
  getDeploymentConfig,
  deploymentDetector
} from '../../security/deployment';

describe('Deployment Detector', () => {
  let cleanup: (() => void) | null = null;

  beforeEach(() => {
    // Clear cached config before each test
    deploymentDetector.clearCache();
  });

  afterEach(() => {
    // Restore environment after each test
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
    deploymentDetector.clearCache();
  });

  describe('detectEnvironment', () => {
    test('returns production when DEPLOYMENT_MODE=production', () => {
      cleanup = withEnv({
        DEPLOYMENT_MODE: 'production',
        NODE_ENV: undefined
      });
      expect(detectEnvironment()).toBe('production');
    });

    test('returns development when DEPLOYMENT_MODE=development', () => {
      cleanup = withEnv({
        DEPLOYMENT_MODE: 'development',
        NODE_ENV: undefined
      });
      expect(detectEnvironment()).toBe('development');
    });

    test('returns self-hosted when DEPLOYMENT_MODE=self-hosted', () => {
      cleanup = withEnv({
        DEPLOYMENT_MODE: 'self-hosted',
        NODE_ENV: undefined
      });
      expect(detectEnvironment()).toBe('self-hosted');
    });

    test('DEPLOYMENT_MODE is case-insensitive', () => {
      cleanup = withEnv({
        DEPLOYMENT_MODE: 'PRODUCTION',
        NODE_ENV: undefined
      });
      expect(detectEnvironment()).toBe('production');
    });

    test('falls back to NODE_ENV when DEPLOYMENT_MODE not set', () => {
      cleanup = withEnv({
        DEPLOYMENT_MODE: undefined,
        NODE_ENV: 'production'
      });
      expect(detectEnvironment()).toBe('production');
    });

    test('NODE_ENV=development returns development', () => {
      cleanup = withEnv({
        DEPLOYMENT_MODE: undefined,
        NODE_ENV: 'development'
      });
      expect(detectEnvironment()).toBe('development');
    });

    test('defaults to self-hosted when no env signals', () => {
      cleanup = withEnv({
        DEPLOYMENT_MODE: undefined,
        NODE_ENV: undefined,
        PROD_HOSTNAME: undefined,
        DATABASE_URL: undefined,
        HOSTED_DB_IDENTIFIER: undefined
      });
      expect(detectEnvironment()).toBe('self-hosted');
    });

    test('DEPLOYMENT_MODE takes priority over NODE_ENV', () => {
      cleanup = withEnv({
        DEPLOYMENT_MODE: 'self-hosted',
        NODE_ENV: 'production'
      });
      expect(detectEnvironment()).toBe('self-hosted');
    });
  });

  describe('detectDeploymentMode', () => {
    test('returns hosted for production environment', () => {
      cleanup = withEnv({
        DEPLOYMENT_MODE: 'production'
      });
      expect(detectDeploymentMode()).toBe('hosted');
    });

    test('returns self-hosted for development environment', () => {
      cleanup = withEnv({
        DEPLOYMENT_MODE: 'development'
      });
      expect(detectDeploymentMode()).toBe('self-hosted');
    });

    test('returns self-hosted for self-hosted environment', () => {
      cleanup = withEnv({
        DEPLOYMENT_MODE: 'self-hosted'
      });
      expect(detectDeploymentMode()).toBe('self-hosted');
    });
  });

  describe('isHostedMode / isSelfHostedMode', () => {
    test('isHostedMode returns true in production', () => {
      cleanup = withEnv({ DEPLOYMENT_MODE: 'production' });
      expect(isHostedMode()).toBe(true);
      expect(isSelfHostedMode()).toBe(false);
    });

    test('isSelfHostedMode returns true in development', () => {
      cleanup = withEnv({ DEPLOYMENT_MODE: 'development' });
      expect(isHostedMode()).toBe(false);
      expect(isSelfHostedMode()).toBe(true);
    });

    test('isSelfHostedMode returns true when self-hosted', () => {
      cleanup = withEnv({ DEPLOYMENT_MODE: 'self-hosted' });
      expect(isHostedMode()).toBe(false);
      expect(isSelfHostedMode()).toBe(true);
    });
  });

  describe('getMaxGuilds', () => {
    test('returns MAX_HOSTED_GUILDS in production', () => {
      cleanup = withEnv({
        DEPLOYMENT_MODE: 'production',
        MAX_HOSTED_GUILDS: '10'
      });
      // Note: MAX_HOSTED_GUILDS is read at module load time
      // so we need to test with the default value
      deploymentDetector.clearCache();
      expect(getMaxGuilds()).toBeLessThan(Number.MAX_SAFE_INTEGER);
    });

    test('returns MAX_SAFE_INTEGER for self-hosted', () => {
      cleanup = withEnv({ DEPLOYMENT_MODE: 'self-hosted' });
      expect(getMaxGuilds()).toBe(Number.MAX_SAFE_INTEGER);
    });

    test('returns MAX_SAFE_INTEGER for development', () => {
      cleanup = withEnv({ DEPLOYMENT_MODE: 'development' });
      expect(getMaxGuilds()).toBe(Number.MAX_SAFE_INTEGER);
    });
  });

  describe('getDeploymentConfig', () => {
    test('returns complete config object', () => {
      cleanup = withEnv({
        DEPLOYMENT_MODE: 'production',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/db'
      });
      
      const config = getDeploymentConfig();
      
      expect(config).toHaveProperty('mode');
      expect(config).toHaveProperty('environment');
      expect(config).toHaveProperty('maxGuilds');
      expect(config).toHaveProperty('isHosted');
      expect(config).toHaveProperty('isSelfHosted');
      expect(config).toHaveProperty('isDevelopment');
      expect(config).toHaveProperty('isProduction');
      expect(config).toHaveProperty('databaseHost');
      expect(config).toHaveProperty('machineHostname');
    });

    test('correctly parses database host from URL', () => {
      cleanup = withEnv({
        DEPLOYMENT_MODE: 'self-hosted',
        DATABASE_URL: 'postgresql://user:pass@mydb.example.com:5432/database'
      });
      
      const config = getDeploymentConfig();
      expect(config.databaseHost).toBe('mydb.example.com:5432');
    });

    test('handles invalid database URL gracefully', () => {
      cleanup = withEnv({
        DEPLOYMENT_MODE: 'self-hosted',
        DATABASE_URL: 'not-a-valid-url'
      });
      
      const config = getDeploymentConfig();
      expect(config.databaseHost).toBeNull();
    });

    test('production config has correct flags', () => {
      cleanup = withEnv({ DEPLOYMENT_MODE: 'production' });
      
      const config = getDeploymentConfig();
      
      expect(config.mode).toBe('hosted');
      expect(config.environment).toBe('production');
      expect(config.isHosted).toBe(true);
      expect(config.isSelfHosted).toBe(false);
      expect(config.isProduction).toBe(true);
      expect(config.isDevelopment).toBe(false);
    });

    test('development config has correct flags', () => {
      cleanup = withEnv({ DEPLOYMENT_MODE: 'development' });
      
      const config = getDeploymentConfig();
      
      expect(config.mode).toBe('self-hosted');
      expect(config.environment).toBe('development');
      expect(config.isHosted).toBe(false);
      expect(config.isSelfHosted).toBe(true);
      expect(config.isProduction).toBe(false);
      expect(config.isDevelopment).toBe(true);
    });

    test('self-hosted config has correct flags', () => {
      cleanup = withEnv({ DEPLOYMENT_MODE: 'self-hosted' });
      
      const config = getDeploymentConfig();
      
      expect(config.mode).toBe('self-hosted');
      expect(config.environment).toBe('self-hosted');
      expect(config.isHosted).toBe(false);
      expect(config.isSelfHosted).toBe(true);
      expect(config.isProduction).toBe(false);
      expect(config.isDevelopment).toBe(false);
    });
  });

  describe('DeploymentDetector singleton', () => {
    test('caches config after first call', () => {
      cleanup = withEnv({ DEPLOYMENT_MODE: 'self-hosted' });
      
      const config1 = deploymentDetector.getConfig();
      const config2 = deploymentDetector.getConfig();
      
      expect(config1).toBe(config2); // Same reference
    });

    test('clearCache resets cached config', () => {
      cleanup = withEnv({ DEPLOYMENT_MODE: 'self-hosted' });
      
      const config1 = deploymentDetector.getConfig();
      deploymentDetector.clearCache();
      const config2 = deploymentDetector.getConfig();
      
      expect(config1).not.toBe(config2); // Different references
      expect(config1).toEqual(config2); // Same values
    });

    describe('canAddGuild', () => {
      test('always returns true for self-hosted', async () => {
        cleanup = withEnv({ DEPLOYMENT_MODE: 'self-hosted' });
        deploymentDetector.clearCache();
        
        expect(await deploymentDetector.canAddGuild(0)).toBe(true);
        expect(await deploymentDetector.canAddGuild(100)).toBe(true);
        expect(await deploymentDetector.canAddGuild(1000000)).toBe(true);
      });

      test('respects limit for hosted mode', async () => {
        cleanup = withEnv({ DEPLOYMENT_MODE: 'production' });
        deploymentDetector.clearCache();
        
        const config = deploymentDetector.getConfig();
        const maxGuilds = config.maxGuilds;
        
        expect(await deploymentDetector.canAddGuild(0)).toBe(true);
        expect(await deploymentDetector.canAddGuild(maxGuilds - 1)).toBe(true);
        expect(await deploymentDetector.canAddGuild(maxGuilds)).toBe(false);
        expect(await deploymentDetector.canAddGuild(maxGuilds + 1)).toBe(false);
      });
    });

    describe('getCapacityInfo', () => {
      test('returns unlimited display for self-hosted', () => {
        cleanup = withEnv({ DEPLOYMENT_MODE: 'self-hosted' });
        deploymentDetector.clearCache();
        
        const info = deploymentDetector.getCapacityInfo(10);
        
        expect(info.current).toBe(10);
        expect(info.max).toBe(Number.MAX_SAFE_INTEGER);
        expect(info.atCapacity).toBe(false);
        expect(info.displayString).toContain('unlimited');
      });

      test('returns correct capacity for hosted mode', () => {
        cleanup = withEnv({ DEPLOYMENT_MODE: 'production' });
        deploymentDetector.clearCache();
        
        const config = deploymentDetector.getConfig();
        const info = deploymentDetector.getCapacityInfo(3);
        
        expect(info.current).toBe(3);
        expect(info.max).toBe(config.maxGuilds);
        expect(info.available).toBe(config.maxGuilds - 3);
        expect(info.atCapacity).toBe(false);
        expect(info.displayString).toContain('/');
      });

      test('shows at capacity when full', () => {
        cleanup = withEnv({ DEPLOYMENT_MODE: 'production' });
        deploymentDetector.clearCache();
        
        const config = deploymentDetector.getConfig();
        const info = deploymentDetector.getCapacityInfo(config.maxGuilds);
        
        expect(info.atCapacity).toBe(true);
        expect(info.available).toBe(0);
      });
    });

    describe('getModeString', () => {
      test('returns hosted string for production', () => {
        cleanup = withEnv({ DEPLOYMENT_MODE: 'production' });
        deploymentDetector.clearCache();
        
        const str = deploymentDetector.getModeString();
        expect(str).toContain('hosted');
        expect(str).toContain('max');
      });

      test('returns development string for development', () => {
        cleanup = withEnv({ DEPLOYMENT_MODE: 'development' });
        deploymentDetector.clearCache();
        
        const str = deploymentDetector.getModeString();
        expect(str).toContain('development');
        expect(str).toContain('no limits');
      });

      test('returns self-hosted string for self-hosted', () => {
        cleanup = withEnv({ DEPLOYMENT_MODE: 'self-hosted' });
        deploymentDetector.clearCache();
        
        const str = deploymentDetector.getModeString();
        expect(str).toContain('self-hosted');
        expect(str).toContain('unlimited');
      });
    });
  });
});
