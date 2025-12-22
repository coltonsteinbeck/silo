/**
 * Deployment Detector
 *
 * Determines whether the bot is running in hosted (SaaS) mode or self-hosted mode.
 *
 * For SELF-HOSTERS: Set DEPLOYMENT_MODE=self-hosted in your .env
 * This disables all guild limits, waitlists, and inactivity eviction.
 *
 * Detection priority:
 * 1. DEPLOYMENT_MODE env var ('production' | 'development' | 'self-hosted')
 * 2. NODE_ENV ('production' enables hosted mode limits)
 * 3. PROD_HOSTNAME check (auto-detect production server)
 * 4. HOSTED_DB_IDENTIFIER check (for official hosted service only)
 * 5. Default to 'self-hosted' if no signals (safest for self-hosters)
 *
 * Hosted mode (production): Guild limits, waitlist, inactivity eviction
 * Development mode: No limits (for testing with hosted DB)
 * Self-hosted: No limits (default for self-hosters)
 */

import { hostname } from 'os';

// Maximum concurrent guilds for hosted mode (configurable)
const MAX_HOSTED_GUILDS = parseInt(process.env.MAX_HOSTED_GUILDS || '5', 10);

export type DeploymentMode = 'hosted' | 'self-hosted';
export type EnvironmentType = 'production' | 'development' | 'self-hosted';

export interface DeploymentConfig {
  mode: DeploymentMode;
  environment: EnvironmentType;
  maxGuilds: number;
  isHosted: boolean;
  isSelfHosted: boolean;
  isDevelopment: boolean;
  isProduction: boolean;
  databaseHost: string | null;
  machineHostname: string;
}

/**
 * Detects the environment type based on multiple signals
 */
export function detectEnvironment(): EnvironmentType {
  // 1. Explicit DEPLOYMENT_MODE takes priority (recommended for self-hosters)
  const deploymentMode = process.env.DEPLOYMENT_MODE?.toLowerCase();
  if (deploymentMode === 'production') return 'production';
  if (deploymentMode === 'development') return 'development';
  if (deploymentMode === 'self-hosted') return 'self-hosted';

  // 2. Check NODE_ENV
  const nodeEnv = process.env.NODE_ENV?.toLowerCase();
  if (nodeEnv === 'production') return 'production';
  if (nodeEnv === 'development') return 'development';

  // 3. Check hostname (auto-detect production server)
  // Read at runtime to allow tests to modify env vars
  const prodHostname = process.env.PROD_HOSTNAME;
  const host = hostname().toLowerCase();
  if (prodHostname && host.includes(prodHostname.toLowerCase())) return 'production';

  // 4. Check if using a hosted database identifier (for official hosted service)
  // Read at runtime to allow tests to modify env vars
  const hostedDbIdentifier = process.env.HOSTED_DB_IDENTIFIER || '';
  const databaseUrl = process.env.DATABASE_URL || '';
  if (hostedDbIdentifier && databaseUrl.includes(hostedDbIdentifier)) {
    return 'development'; // On hosted DB but no prod signals = dev mode
  }

  // 5. Default to self-hosted (safest default for self-hosters)
  return 'self-hosted';
}

/**
 * Detects the deployment mode (for guild limits)
 * Only 'production' environment enforces hosted limits
 */
export function detectDeploymentMode(): DeploymentMode {
  const env = detectEnvironment();
  return env === 'production' ? 'hosted' : 'self-hosted';
}

/**
 * Check if running in hosted (SaaS) mode with limits
 */
export function isHostedMode(): boolean {
  return detectDeploymentMode() === 'hosted';
}

/**
 * Check if running in self-hosted mode (no limits)
 */
export function isSelfHostedMode(): boolean {
  return detectDeploymentMode() === 'self-hosted';
}

/**
 * Get the maximum number of guilds allowed for the current deployment
 * Production: 5 guilds max
 * Development/Self-hosted: Unlimited
 */
export function getMaxGuilds(): number {
  return isHostedMode() ? MAX_HOSTED_GUILDS : Number.MAX_SAFE_INTEGER;
}

/**
 * Get full deployment configuration
 */
export function getDeploymentConfig(): DeploymentConfig {
  const databaseUrl = process.env.DATABASE_URL || '';
  const environment = detectEnvironment();
  const mode = detectDeploymentMode();

  // Extract host from database URL
  let databaseHost: string | null = null;
  try {
    const url = new URL(databaseUrl.replace('postgresql://', 'http://'));
    databaseHost = url.host;
  } catch {
    // Invalid URL, host remains null
  }

  return {
    mode,
    environment,
    maxGuilds: mode === 'hosted' ? MAX_HOSTED_GUILDS : Number.MAX_SAFE_INTEGER,
    isHosted: mode === 'hosted',
    isSelfHosted: mode === 'self-hosted',
    isDevelopment: environment === 'development',
    isProduction: environment === 'production',
    databaseHost,
    machineHostname: hostname()
  };
}

/**
 * Deployment detector singleton with caching
 */
class DeploymentDetector {
  private cachedConfig: DeploymentConfig | null = null;

  /**
   * Get deployment config (cached after first call)
   */
  getConfig(): DeploymentConfig {
    if (!this.cachedConfig) {
      this.cachedConfig = getDeploymentConfig();
    }
    return this.cachedConfig;
  }

  /**
   * Check if a new guild can be added based on current capacity
   * For self-hosted, always returns true
   * For hosted, checks against MAX_HOSTED_GUILDS
   */
  async canAddGuild(currentActiveGuilds: number): Promise<boolean> {
    const config = this.getConfig();
    if (config.isSelfHosted) {
      return true;
    }
    return currentActiveGuilds < config.maxGuilds;
  }

  /**
   * Get capacity info for display
   */
  getCapacityInfo(currentActiveGuilds: number): {
    current: number;
    max: number;
    available: number;
    atCapacity: boolean;
    displayString: string;
  } {
    const config = this.getConfig();
    const max = config.maxGuilds;
    const available = Math.max(0, max - currentActiveGuilds);
    const atCapacity = config.isHosted && currentActiveGuilds >= max;

    return {
      current: currentActiveGuilds,
      max,
      available,
      atCapacity,
      displayString: config.isHosted
        ? `${currentActiveGuilds}/${max} guilds`
        : `${currentActiveGuilds} guilds (unlimited)`
    };
  }

  /**
   * Get deployment mode string for logging
   */
  getModeString(): string {
    const config = this.getConfig();
    if (config.isHosted) {
      return `hosted (max ${config.maxGuilds} guilds)`;
    } else if (config.isDevelopment) {
      return 'development (no limits)';
    } else {
      return 'self-hosted (unlimited)';
    }
  }

  /**
   * Clear cached config (useful for testing)
   */
  clearCache(): void {
    this.cachedConfig = null;
  }
}

// Export singleton instance
export const deploymentDetector = new DeploymentDetector();

// Export constants for external use
export const CONSTANTS = {
  get HOSTED_DB_IDENTIFIER() {
    return process.env.HOSTED_DB_IDENTIFIER || '';
  },
  MAX_HOSTED_GUILDS
} as const;
