import { describe, expect, mock, test } from 'bun:test';
import { VoiceOutputGate } from '../../voice/output-gate';

describe('voice output approval', () => {
  test('buffers complete audio until transcript approval and delivers once', async () => {
    const deliver = mock(() => {});
    const gate = new VoiceOutputGate(async () => true, deliver);
    gate.start('a');
    gate.append('a', Buffer.alloc(4));
    expect(deliver).not.toHaveBeenCalled();
    expect(await gate.finish('a', 'Hello')).toBe(true);
    expect(await gate.finish('a', 'Hello')).toBe(false);
    expect(deliver).toHaveBeenCalledTimes(1);
  });
  test('barge-in invalidates an approval already in flight', async () => {
    let approve!: (value: boolean) => void;
    const deliver = mock(() => {});
    const gate = new VoiceOutputGate(
      () =>
        new Promise(resolve => {
          approve = resolve;
        }),
      deliver
    );
    gate.start('a');
    gate.append('a', Buffer.alloc(4));
    const pending = gate.finish('a', 'Hello');
    gate.cancel();
    gate.start('b');
    approve(true);
    expect(await pending).toBe(false);
    expect(gate.append('a', Buffer.alloc(2))).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });
  test('blocks refusals, missing transcripts, checker failures and oversized audio', async () => {
    const deliver = mock(() => {});
    for (const approve of [
      async () => false,
      async () => {
        throw new Error('Unavailable');
      }
    ]) {
      const gate = new VoiceOutputGate(approve, deliver, 4);
      gate.start('a');
      gate.append('a', Buffer.alloc(4));
      expect(await gate.finish('a', 'Unsafe')).toBe(false);
      gate.start('b');
      gate.append('b', Buffer.alloc(4));
      expect(await gate.finish('b', '')).toBe(false);
      gate.start('c');
      expect(() => gate.append('c', Buffer.alloc(6))).toThrow();
    }
    expect(deliver).not.toHaveBeenCalled();
  });
});
