export type SafetyIncidentType =
  | 'input_blocked'
  | 'output_blocked'
  | 'output_warned'
  | 'moderation_api_fail_closed';

export interface SafetyIncidentRecord {
  guildId: string;
  userId?: string;
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

export interface AssistantSafetyIncidentRecord {
  provider: string;
  model: string;
  promptHash: string;
  categories: string[];
  resolvedByRetry: boolean;
  qualityRepair?: boolean;
}

export interface ModelCircuitDecision {
  failureCountInWindow: number;
  contextDisabled: boolean;
  contextDisabledUntil: Date | null;
  circuitActivated: boolean;
  shouldAlert: boolean;
}

type UserSafetyState = {
  blockedTimestamps: number[];
  killSwitchUntil: number | null;
  lastAlertAt: number | null;
};

type ModelSafetyState = {
  failureTimestamps: number[];
  contextDisabledUntil: number | null;
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
  private readonly state = new Map<string, UserSafetyState>();
  private readonly modelState = new Map<string, ModelSafetyState>();

  constructor(private readonly config: SafetyMonitorConfig = DEFAULT_CONFIG) {}

  getConfig(): SafetyMonitorConfig {
    return { ...this.config };
  }

  isKillSwitchActive(guildId: string, userId?: string, now = Date.now()): boolean {
    if (!this.config.enabled || !this.config.killSwitchEnabled) {
      return false;
    }

    this.pruneStaleUserStates(now);

    if (!userId) {
      return false;
    }

    const userState = this.state.get(this.stateKey(guildId, userId));
    return Boolean(userState?.killSwitchUntil && userState.killSwitchUntil > now);
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

    this.pruneStaleUserStates(now);

    const stateKey = this.stateKey(record.guildId, record.userId);
    const userState = this.getOrCreateUserState(stateKey);
    this.pruneWindow(stateKey, userState, now, false);

    const countsTowardUserCooldown =
      Boolean(record.userId) && this.isBlockedIncident(record.incidentType);

    if (countsTowardUserCooldown) {
      userState.blockedTimestamps.push(now);
      this.pruneWindow(stateKey, userState, now, false);
    }

    const blockedCountInWindow = userState.blockedTimestamps.length;
    const thresholdExceeded = blockedCountInWindow >= this.config.blockThreshold;

    let killSwitchActivated = false;
    if (
      countsTowardUserCooldown &&
      thresholdExceeded &&
      this.config.killSwitchEnabled &&
      (!userState.killSwitchUntil || userState.killSwitchUntil <= now)
    ) {
      userState.killSwitchUntil = now + this.config.killSwitchDurationMs;
      killSwitchActivated = true;
    }

    const killSwitchActive =
      this.config.killSwitchEnabled &&
      !!userState.killSwitchUntil &&
      userState.killSwitchUntil > now;

    const shouldAlert =
      (thresholdExceeded || killSwitchActivated) &&
      (!userState.lastAlertAt || now - userState.lastAlertAt >= this.config.alertCooldownMs);

    if (shouldAlert) {
      userState.lastAlertAt = now;
    }

    this.pruneWindow(stateKey, userState, now);

    return {
      blockedCountInWindow,
      thresholdExceeded,
      killSwitchActivated,
      killSwitchActive,
      killSwitchUntil: userState.killSwitchUntil ? new Date(userState.killSwitchUntil) : null,
      shouldAlert
    };
  }

  isInheritedContextDisabled(
    provider: string,
    model: string,
    promptHash: string,
    now = Date.now()
  ): boolean {
    if (!this.config.enabled) {
      return false;
    }

    this.pruneStaleModelStates(now);
    const state = this.modelState.get(this.modelStateKey(provider, model, promptHash));
    return Boolean(state?.contextDisabledUntil && state.contextDisabledUntil > now);
  }

  recordAssistantIncident(
    record: AssistantSafetyIncidentRecord,
    now = Date.now()
  ): ModelCircuitDecision {
    if (!this.config.enabled) {
      return {
        failureCountInWindow: 0,
        contextDisabled: false,
        contextDisabledUntil: null,
        circuitActivated: false,
        shouldAlert: false
      };
    }

    this.pruneStaleModelStates(now);
    const key = this.modelStateKey(record.provider, record.model, record.promptHash);
    const state = this.getOrCreateModelState(key);
    this.pruneModelWindow(key, state, now, false);

    if (!record.resolvedByRetry) {
      state.failureTimestamps.push(now);
      this.pruneModelWindow(key, state, now, false);
    }

    const failureCountInWindow = state.failureTimestamps.length;
    const thresholdExceeded = failureCountInWindow >= this.config.blockThreshold;
    let circuitActivated = false;
    if (thresholdExceeded && (!state.contextDisabledUntil || state.contextDisabledUntil <= now)) {
      state.contextDisabledUntil = now + this.config.killSwitchDurationMs;
      circuitActivated = true;
    }

    const contextDisabled = Boolean(state.contextDisabledUntil && state.contextDisabledUntil > now);
    const shouldAlert =
      (!record.qualityRepair || !record.resolvedByRetry) &&
      (!state.lastAlertAt || now - state.lastAlertAt >= this.config.alertCooldownMs);
    if (shouldAlert) {
      state.lastAlertAt = now;
    }

    this.pruneModelWindow(key, state, now);
    return {
      failureCountInWindow,
      contextDisabled,
      contextDisabledUntil: state.contextDisabledUntil
        ? new Date(state.contextDisabledUntil)
        : null,
      circuitActivated,
      shouldAlert
    };
  }

  private stateKey(guildId: string, userId?: string): string {
    return `${guildId}:${userId || 'unknown-user'}`;
  }

  private modelStateKey(provider: string, model: string, promptHash: string): string {
    return `${provider}:${model}:${promptHash}`;
  }

  private getOrCreateUserState(stateKey: string): UserSafetyState {
    const existing = this.state.get(stateKey);
    if (existing) {
      return existing;
    }

    const created: UserSafetyState = {
      blockedTimestamps: [],
      killSwitchUntil: null,
      lastAlertAt: null
    };
    this.state.set(stateKey, created);
    return created;
  }

  private getOrCreateModelState(stateKey: string): ModelSafetyState {
    const existing = this.modelState.get(stateKey);
    if (existing) {
      return existing;
    }

    const created: ModelSafetyState = {
      failureTimestamps: [],
      contextDisabledUntil: null,
      lastAlertAt: null
    };
    this.modelState.set(stateKey, created);
    return created;
  }

  private pruneWindow(
    stateKey: string,
    userState: UserSafetyState,
    now: number,
    allowEviction = true
  ): void {
    const windowStart = now - this.config.windowMs;
    userState.blockedTimestamps = userState.blockedTimestamps.filter(ts => ts >= windowStart);

    if (
      allowEviction &&
      userState.blockedTimestamps.length === 0 &&
      (!userState.killSwitchUntil || userState.killSwitchUntil <= now) &&
      (!userState.lastAlertAt || now - userState.lastAlertAt >= this.config.alertCooldownMs)
    ) {
      this.state.delete(stateKey);
    }
  }

  private pruneStaleUserStates(now: number): void {
    for (const [stateKey, userState] of this.state.entries()) {
      this.pruneWindow(stateKey, userState, now);
    }
  }

  private pruneModelWindow(
    stateKey: string,
    state: ModelSafetyState,
    now: number,
    allowEviction = true
  ): void {
    const windowStart = now - this.config.windowMs;
    state.failureTimestamps = state.failureTimestamps.filter(ts => ts >= windowStart);
    if (
      allowEviction &&
      state.failureTimestamps.length === 0 &&
      (!state.contextDisabledUntil || state.contextDisabledUntil <= now) &&
      (!state.lastAlertAt || now - state.lastAlertAt >= this.config.alertCooldownMs)
    ) {
      this.modelState.delete(stateKey);
    }
  }

  private pruneStaleModelStates(now: number): void {
    for (const [stateKey, state] of this.modelState.entries()) {
      this.pruneModelWindow(stateKey, state, now);
    }
  }

  private isBlockedIncident(incidentType: SafetyIncidentType): boolean {
    return incidentType === 'input_blocked';
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
