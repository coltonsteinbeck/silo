import { describe, expect, test } from 'bun:test';
import { SafetyMonitor } from '../../security/safety-monitor';

const createMonitor = (
  overrides: Partial<ConstructorParameters<typeof SafetyMonitor>[0]> = {}
): SafetyMonitor =>
  new SafetyMonitor({
    enabled: true,
    blockThreshold: 2,
    windowMs: 60_000,
    killSwitchEnabled: true,
    killSwitchDurationMs: 120_000,
    alertCooldownMs: 30_000,
    ...overrides
  });

describe('safety-monitor', () => {
  test('activates a cooldown only after the same user reaches the blocked threshold', () => {
    const monitor = createMonitor();

    const first = monitor.recordIncident(
      {
        guildId: 'guild-1',
        userId: 'user-1',
        incidentType: 'input_blocked',
        categories: ['hate']
      },
      1_000
    );
    const second = monitor.recordIncident(
      {
        guildId: 'guild-1',
        userId: 'user-1',
        incidentType: 'input_blocked',
        categories: ['hate']
      },
      2_000
    );

    expect(first.thresholdExceeded).toBe(false);
    expect(second.thresholdExceeded).toBe(true);
    expect(second.killSwitchActivated).toBe(true);
    expect(monitor.isKillSwitchActive('guild-1', 'user-1', 2_001)).toBe(true);
    expect(monitor.isKillSwitchActive('guild-1', 'user-2', 2_001)).toBe(false);
    expect(monitor.isKillSwitchActive('guild-1', undefined, 2_001)).toBe(false);
  });

  test('does not count assistant output blocks or warnings toward a user cooldown', () => {
    const monitor = createMonitor({ blockThreshold: 1 });

    const blocked = monitor.recordIncident(
      {
        guildId: 'guild-2',
        userId: 'user-1',
        incidentType: 'output_blocked',
        categories: ['sexual']
      },
      5_000
    );
    const warned = monitor.recordIncident(
      {
        guildId: 'guild-2',
        userId: 'user-1',
        incidentType: 'output_warned',
        categories: ['harassment']
      },
      6_000
    );

    expect(blocked.blockedCountInWindow).toBe(0);
    expect(blocked.killSwitchActivated).toBe(false);
    expect(warned.blockedCountInWindow).toBe(0);
    expect(warned.thresholdExceeded).toBe(false);
    expect(monitor.isKillSwitchActive('guild-2', 'user-1', 6_001)).toBe(false);
  });

  test('does not count fail-closed safety service outages as user violations', () => {
    const monitor = createMonitor({ blockThreshold: 1 });

    const failure = monitor.recordIncident(
      {
        guildId: 'guild-service-failure',
        userId: 'user-1',
        incidentType: 'moderation_api_fail_closed',
        categories: ['guardrails/api_error_fail_closed']
      },
      7_000
    );

    expect(failure.blockedCountInWindow).toBe(0);
    expect(failure.thresholdExceeded).toBe(false);
    expect(failure.killSwitchActivated).toBe(false);
    expect(monitor.isKillSwitchActive('guild-service-failure', 'user-1', 7_001)).toBe(false);
  });

  test('assistant incidents cannot reactivate an expired user cooldown', () => {
    const monitor = createMonitor({
      blockThreshold: 1,
      killSwitchDurationMs: 1_000
    });

    const input = monitor.recordIncident(
      {
        guildId: 'guild-3',
        userId: 'user-1',
        incidentType: 'input_blocked',
        categories: ['hate']
      },
      10_000
    );
    expect(input.killSwitchActivated).toBe(true);
    expect(monitor.isKillSwitchActive('guild-3', 'user-1', 11_001)).toBe(false);

    const output = monitor.recordIncident(
      {
        guildId: 'guild-3',
        userId: 'user-1',
        incidentType: 'output_blocked',
        categories: ['sexual']
      },
      12_000
    );

    expect(output.blockedCountInWindow).toBe(1);
    expect(output.killSwitchActivated).toBe(false);
    expect(output.killSwitchActive).toBe(false);
    expect(monitor.isKillSwitchActive('guild-3', 'user-1', 12_001)).toBe(false);
  });

  test('isolates kill switches and alert cooldowns by user', () => {
    const monitor = createMonitor({
      blockThreshold: 1,
      alertCooldownMs: 60_000
    });

    const firstUser = monitor.recordIncident(
      {
        guildId: 'guild-4',
        userId: 'user-1',
        incidentType: 'input_blocked',
        categories: ['hate']
      },
      10_000
    );
    const firstUserAgain = monitor.recordIncident(
      {
        guildId: 'guild-4',
        userId: 'user-1',
        incidentType: 'input_blocked',
        categories: ['hate']
      },
      20_000
    );
    const secondUser = monitor.recordIncident(
      {
        guildId: 'guild-4',
        userId: 'user-2',
        incidentType: 'input_blocked',
        categories: ['hate']
      },
      20_000
    );

    expect(firstUser.shouldAlert).toBe(true);
    expect(firstUserAgain.shouldAlert).toBe(false);
    expect(secondUser.shouldAlert).toBe(true);
    expect(monitor.isKillSwitchActive('guild-4', 'user-1', 20_001)).toBe(true);
    expect(monitor.isKillSwitchActive('guild-4', 'user-2', 20_001)).toBe(true);
  });

  test('does not activate an unscoped cooldown when user identity is missing', () => {
    const monitor = createMonitor({ blockThreshold: 1 });

    const incident = monitor.recordIncident(
      {
        guildId: 'guild-unknown',
        incidentType: 'input_blocked',
        categories: ['hate']
      },
      50_000
    );

    expect(incident.blockedCountInWindow).toBe(0);
    expect(incident.killSwitchActivated).toBe(false);
    expect(incident.killSwitchActive).toBe(false);
  });

  test('expires and evicts stale per-user state', () => {
    const monitor = createMonitor({
      blockThreshold: 1,
      windowMs: 1_000,
      killSwitchDurationMs: 2_000,
      alertCooldownMs: 1_500
    });

    monitor.recordIncident(
      {
        guildId: 'guild-stale',
        userId: 'user-stale',
        incidentType: 'input_blocked',
        categories: ['hate']
      },
      1_000
    );

    const state = (monitor as unknown as { state: Map<string, unknown> }).state;
    expect(state.has('guild-stale:user-stale')).toBe(true);
    expect(monitor.isKillSwitchActive('guild-stale', 'user-stale', 2_999)).toBe(true);

    monitor.recordIncident(
      {
        guildId: 'guild-other',
        userId: 'user-other',
        incidentType: 'output_warned',
        categories: ['harassment']
      },
      4_000
    );

    expect(monitor.isKillSwitchActive('guild-stale', 'user-stale', 4_001)).toBe(false);
    expect(state.has('guild-stale:user-stale')).toBe(false);
  });

  test('trips only the provider-model-prompt context circuit for unresolved assistant failures', () => {
    const monitor = createMonitor({ blockThreshold: 2, killSwitchDurationMs: 5_000 });
    const incident = {
      provider: 'mock-provider',
      model: 'mock-model',
      promptHash: 'prompt-v2',
      categories: ['sexual/explicit_generation'],
      resolvedByRetry: false
    };

    const first = monitor.recordAssistantIncident(incident, 1_000);
    const second = monitor.recordAssistantIncident(incident, 2_000);

    expect(first.circuitActivated).toBe(false);
    expect(second.circuitActivated).toBe(true);
    expect(
      monitor.isInheritedContextDisabled('mock-provider', 'mock-model', 'prompt-v2', 2_001)
    ).toBe(true);
    expect(
      monitor.isInheritedContextDisabled('mock-provider', 'other-model', 'prompt-v2', 2_001)
    ).toBe(false);
    expect(monitor.isKillSwitchActive('guild-any', 'user-any', 2_001)).toBe(false);
  });

  test('retry-resolved repairs neither alert nor count toward the circuit', () => {
    const monitor = createMonitor({ blockThreshold: 1 });
    const resolved = monitor.recordAssistantIncident(
      {
        provider: 'mock-provider',
        model: 'mock-model',
        promptHash: 'prompt-v2',
        categories: ['sexual/explicit_generation'],
        resolvedByRetry: true
      },
      1_000
    );
    const quality = monitor.recordAssistantIncident(
      {
        provider: 'mock-provider',
        model: 'mock-model',
        promptHash: 'prompt-v2',
        categories: ['quality/repetition_loop'],
        resolvedByRetry: true,
        qualityRepair: true
      },
      2_000
    );
    const unresolved = monitor.recordAssistantIncident(
      {
        provider: 'mock-provider',
        model: 'mock-model',
        promptHash: 'prompt-v2',
        categories: ['sexual/explicit_generation'],
        resolvedByRetry: false
      },
      3_000
    );

    expect(resolved.failureCountInWindow).toBe(0);
    expect(resolved.contextDisabled).toBe(false);
    expect(resolved.shouldAlert).toBe(false);
    expect(quality.failureCountInWindow).toBe(0);
    expect(quality.contextDisabled).toBe(false);
    expect(quality.shouldAlert).toBe(false);
    expect(unresolved.failureCountInWindow).toBe(1);
    expect(unresolved.contextDisabled).toBe(true);
    expect(unresolved.shouldAlert).toBe(true);
  });
});
