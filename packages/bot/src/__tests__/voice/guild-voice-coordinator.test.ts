import { describe, expect, test } from 'bun:test';
import { GuildVoiceCoordinator } from '../../voice/guild-voice-coordinator';

describe('GuildVoiceCoordinator', () => {
  test('atomically excludes radio and speech startup in one guild', () => {
    const coordinator = new GuildVoiceCoordinator();
    const radio = coordinator.reserveExclusive('guild', 'radio', 'music');
    expect(radio.acquired).toBe(true);

    const speech = coordinator.reserveExclusive('guild', 'speech', 'voice');
    expect(speech).toEqual({
      acquired: false,
      conflictType: 'radio',
      channelId: 'music',
      reserved: true
    });
  });

  test('allows independent guilds to hold voice activities', () => {
    const coordinator = new GuildVoiceCoordinator();
    expect(coordinator.reserveExclusive('guild-a', 'radio', 'music').acquired).toBe(true);
    expect(coordinator.reserveExclusive('guild-b', 'speech', 'voice').acquired).toBe(true);
  });

  test('commits, exposes, and releases only to the owning token', () => {
    const coordinator = new GuildVoiceCoordinator();
    const reservation = coordinator.reserveExclusive('guild', 'speech', 'voice');
    if (!reservation.acquired) throw new Error('reservation failed');
    const data = { session: true };

    expect(coordinator.commit('guild', reservation.token, data)).toBe(true);
    expect(coordinator.getActiveActivity('guild')).toMatchObject({
      type: 'speech',
      channelId: 'voice',
      data,
      reserved: false
    });
    expect(coordinator.release('guild', Symbol('wrong'))).toBe(false);
    expect(coordinator.release('guild', reservation.token)).toBe(true);
    expect(coordinator.getActiveActivity('guild')).toBeNull();
  });

  test('supports multi-speaker reuse only for committed speech in the same channel', () => {
    const coordinator = new GuildVoiceCoordinator();
    const reservation = coordinator.reserveExclusive('guild', 'speech', 'voice');
    if (!reservation.acquired) throw new Error('reservation failed');

    expect(coordinator.canJoinActive('guild', 'speech', 'voice')).toBe(false);
    expect(coordinator.commit('guild', reservation.token, {})).toBe(true);
    expect(coordinator.canJoinActive('guild', 'speech', 'voice')).toBe(true);
    expect(coordinator.canJoinActive('guild', 'speech', 'other')).toBe(false);
    expect(coordinator.canJoinActive('guild', 'radio', 'voice')).toBe(false);
  });

  test('failed startup release immediately permits the other activity', () => {
    const coordinator = new GuildVoiceCoordinator();
    const radio = coordinator.reserveExclusive('guild', 'radio', 'music');
    if (!radio.acquired) throw new Error('reservation failed');

    expect(coordinator.release('guild', radio.token)).toBe(true);
    expect(coordinator.reserveExclusive('guild', 'speech', 'voice').acquired).toBe(true);
  });

  test('expires abandoned reservations after the startup TTL', () => {
    let now = 1_000;
    const coordinator = new GuildVoiceCoordinator(() => now, 30_000);
    expect(coordinator.reserveExclusive('guild', 'radio', 'music').acquired).toBe(true);

    now += 30_001;
    expect(coordinator.reserveExclusive('guild', 'speech', 'voice').acquired).toBe(true);
    expect(coordinator.getActiveActivity('guild')?.type).toBe('speech');
  });

  test('cannot stop a replacement activity with stale expected data', () => {
    const coordinator = new GuildVoiceCoordinator();
    const reservation = coordinator.reserveExclusive('guild', 'radio', 'music');
    if (!reservation.acquired) throw new Error('reservation failed');
    const current = { queue: 2 };
    expect(coordinator.commit('guild', reservation.token, current)).toBe(true);

    expect(coordinator.stop('guild', 'radio', { queue: 1 })).toBe(false);
    expect(coordinator.stop('guild', 'radio', current)).toBe(true);
  });
});
