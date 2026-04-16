export type SafetyIncidentType =
  | 'input_blocked'
  | 'output_blocked'
  | 'output_warned'
  | 'moderation_api_fail_closed';

export interface SafetyIncidentRecord {
  guildId: string;
  incidentType: SafetyIncidentType;
  categories: string[];
}

export interface SafetyMonitorConfig {
  enabled: boolean;
  blockThreshold: number;
  windowMs: number;
  killSwitchEnabled: boolean;
  killSwitchDurationMs: number;
  alertCooldownMs: number;
}

export interface SafetyMonitorDecision {
  blockedCountInWindow: number;
  thresholdExceeded: boolean;
  killSwitchActivated: boolean;
  killSwitchActive: boolean;
  killSwitchUntil: Date | null;
  shouldAlert: boolean;
}

type GuildSafetyState = {
  blockedTimestamps: number[];
  killSwitchUntil: number | null;
  lastAlertAt: number | null;
};

const DEFAULT_CONFIG: SafetyMonitorConfig = {
  enabled: true,
  blockThreshold: 3,
  windowMs: 5 * 60 * 1000,
  killSwitchEnabled: true,
  killSwitchDurationMs: 10 * 60 * 1000,
  alertCooldownMs: 2 * 60 * 1000
};

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function getRuntimeEnv(): Record<string, string | undefined> {
  const bunGlobal = globalThis as typeof globalThis & {
    Bun?: { env?: Record<string, string | undefined> };
  };

  return bunGlobal.Bun?.env ?? process.env;
}

export class SafetyMonitor {
  private readonly state = new Map<string, GuildSafetyState>();

  constructor(private readonly config: SafetyMonitorConfig = DEFAULT_CONFIG) {}

  getConfig(): SafetyMonitorConfig {
    return { ...this.config };
  }

  isKillSwitchActive(guildId: string, now = Date.now()): boolean {
    if (!this.config.enabled || !this.config.killSwitchEnabled) {
      return false;
    }

    this.pruneStaleGuildStates(now);

    const guildState = this.state.get(guildId);
    if (!guildState?.killSwitchUntil) {
      return false;
    }

    return guildState.killSwitchUntil > now;
  }

  recordIncident(record: SafetyIncidentRecord, now = Date.now()): SafetyMonitorDecision {
    if (!this.config.enabled) {
      return {
        blockedCountInWindow: 0,
        thresholdExceeded: false,
        killSwitchActivated: false,
        killSwitchActive: false,
        killSwitchUntil: null,
        shouldAlert: false
      };
    }

    this.pruneStaleGuildStates(now);

    const guildState = this.getOrCreateGuildState(record.guildId);
    this.pruneWindow(record.guildId, guildState, now, false);

    if (this.isBlockedIncident(record.incidentType)) {
      guildState.blockedTimestamps.push(now);
      this.pruneWindow(record.guildId, guildState, now, false);
    }

    const blockedCountInWindow = guildState.blockedTimestamps.length;
    const thresholdExceeded = blockedCountInWindow >= this.config.blockThreshold;

    let killSwitchActivated = false;
    if (
      thresholdExceeded &&
      this.config.killSwitchEnabled &&
      (!guildState.killSwitchUntil || guildState.killSwitchUntil <= now)
    ) {
      guildState.killSwitchUntil = now + this.config.killSwitchDurationMs;
      killSwitchActivated = true;
    }

    const killSwitchActive =
      this.config.killSwitchEnabled &&
      !!guildState.killSwitchUntil &&
      guildState.killSwitchUntil > now;

    const shouldAlert =
      (thresholdExceeded || killSwitchActivated) &&
      (!guildState.lastAlertAt || now - guildState.lastAlertAt >= this.config.alertCooldownMs);

    if (shouldAlert) {
      guildState.lastAlertAt = now;
    }

    this.pruneWindow(record.guildId, guildState, now);

    return {
      blockedCountInWindow,
      thresholdExceeded,
      killSwitchActivated,
      killSwitchActive,
      killSwitchUntil: guildState.killSwitchUntil ? new Date(guildState.killSwitchUntil) : null,
      shouldAlert
    };
  }

  private getOrCreateGuildState(guildId: string): GuildSafetyState {
    const existing = this.state.get(guildId);
    if (existing) {
      return existing;
    }

    const created: GuildSafetyState = {
      blockedTimestamps: [],
      killSwitchUntil: null,
      lastAlertAt: null
    };
    this.state.set(guildId, created);
    return created;
  }

  private pruneWindow(
    guildId: string,
    guildState: GuildSafetyState,
    now: number,
    allowEviction = true
  ): void {
    const windowStart = now - this.config.windowMs;
    guildState.blockedTimestamps = guildState.blockedTimestamps.filter(ts => ts >= windowStart);

    if (
      allowEviction &&
      guildState.blockedTimestamps.length === 0 &&
      (!guildState.killSwitchUntil || guildState.killSwitchUntil <= now) &&
      (!guildState.lastAlertAt || now - guildState.lastAlertAt >= this.config.alertCooldownMs)
    ) {
      this.state.delete(guildId);
    }
  }

  private pruneStaleGuildStates(now: number): void {
    for (const [guildId, guildState] of this.state.entries()) {
      this.pruneWindow(guildId, guildState, now);
    }
  }

  private isBlockedIncident(incidentType: SafetyIncidentType): boolean {
    return (
      incidentType === 'input_blocked' ||
      incidentType === 'output_blocked' ||
      incidentType === 'moderation_api_fail_closed'
    );
  }
}

export function createSafetyMonitorFromEnv(
  env: Record<string, string | undefined> = getRuntimeEnv()
): SafetyMonitor {
  return new SafetyMonitor({
    enabled: parseBoolean(env.SAFETY_MONITOR_ENABLED, DEFAULT_CONFIG.enabled),
    blockThreshold: parsePositiveInt(env.SAFETY_BLOCK_THRESHOLD, DEFAULT_CONFIG.blockThreshold),
    windowMs: parsePositiveInt(env.SAFETY_WINDOW_MS, DEFAULT_CONFIG.windowMs),
    killSwitchEnabled: parseBoolean(
      env.SAFETY_KILL_SWITCH_ENABLED,
      DEFAULT_CONFIG.killSwitchEnabled
    ),
    killSwitchDurationMs: parsePositiveInt(
      env.SAFETY_KILL_SWITCH_DURATION_MS,
      DEFAULT_CONFIG.killSwitchDurationMs
    ),
    alertCooldownMs: parsePositiveInt(env.SAFETY_ALERT_COOLDOWN_MS, DEFAULT_CONFIG.alertCooldownMs)
  });
}

export const safetyMonitor = createSafetyMonitorFromEnv();
