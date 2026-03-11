import { describe, expect, test } from 'bun:test';
import { SafetyMonitor } from '../../security/safety-monitor';

describe('safety-monitor', () => {
  test('activates kill switch when blocked threshold is reached', () => {
    const monitor = new SafetyMonitor({
      enabled: true,
      blockThreshold: 2,
      windowMs: 60_000,
      killSwitchEnabled: true,
      killSwitchDurationMs: 120_000,
      alertCooldownMs: 30_000
    });

    const first = monitor.recordIncident(
      {
        guildId: 'guild-1',
        incidentType: 'input_blocked',
        categories: ['hate']
      },
      1_000
    );
    const second = monitor.recordIncident(
      {
        guildId: 'guild-1',
        incidentType: 'output_blocked',
        categories: ['sexual/minors']
      },
      2_000
    );

    expect(first.thresholdExceeded).toBe(false);
    expect(second.thresholdExceeded).toBe(true);
    expect(second.killSwitchActivated).toBe(true);
    expect(monitor.isKillSwitchActive('guild-1', 2_001)).toBe(true);
  });

  test('does not count warned incidents toward block threshold', () => {
    const monitor = new SafetyMonitor({
      enabled: true,
      blockThreshold: 1,
      windowMs: 60_000,
      killSwitchEnabled: true,
      killSwitchDurationMs: 120_000,
      alertCooldownMs: 30_000
    });

    const warned = monitor.recordIncident(
      {
        guildId: 'guild-2',
        incidentType: 'output_warned',
        categories: ['harassment']
      },
      5_000
    );

    expect(warned.blockedCountInWindow).toBe(0);
    expect(warned.thresholdExceeded).toBe(false);
    expect(warned.killSwitchActive).toBe(false);
  });

  test('respects alert cooldown after threshold alerts', () => {
    const monitor = new SafetyMonitor({
      enabled: true,
      blockThreshold: 1,
      windowMs: 60_000,
      killSwitchEnabled: true,
      killSwitchDurationMs: 120_000,
      alertCooldownMs: 60_000
    });

    const first = monitor.recordIncident(
      {
        guildId: 'guild-3',
        incidentType: 'input_blocked',
        categories: ['hate']
      },
      10_000
    );
    const second = monitor.recordIncident(
      {
        guildId: 'guild-3',
        incidentType: 'output_blocked',
        categories: ['hate/threatening']
      },
      20_000
    );
    const third = monitor.recordIncident(
      {
        guildId: 'guild-3',
        incidentType: 'output_blocked',
        categories: ['hate/threatening']
      },
      80_001
    );

    expect(first.shouldAlert).toBe(true);
    expect(second.shouldAlert).toBe(false);
    expect(third.shouldAlert).toBe(true);
  });

  test('kill switch expires after configured duration', () => {
    const monitor = new SafetyMonitor({
      enabled: true,
      blockThreshold: 1,
      windowMs: 60_000,
      killSwitchEnabled: true,
      killSwitchDurationMs: 5_000,
      alertCooldownMs: 1_000
    });

    monitor.recordIncident(
      {
        guildId: 'guild-4',
        incidentType: 'moderation_api_fail_closed',
        categories: ['api_error_fail_closed']
      },
      50_000
    );

    expect(monitor.isKillSwitchActive('guild-4', 54_999)).toBe(true);
    expect(monitor.isKillSwitchActive('guild-4', 55_001)).toBe(false);
  });
});
