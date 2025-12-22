/**
 * Tests for Logger
 *
 * Tests logging functionality and level filtering.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Create testable Logger class
class TestableLogger {
  private minLevel: LogLevel = 'info';

  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  getLevel(): LogLevel {
    return this.minLevel;
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    return levels.indexOf(level) >= levels.indexOf(this.minLevel);
  }

  debug(message: string, ...args: unknown[]): void {
    if (this.shouldLog('debug')) {
      console.debug(`[DEBUG] ${message}`, ...args);
    }
  }

  info(message: string, ...args: unknown[]): void {
    if (this.shouldLog('info')) {
      console.info(`[INFO] ${message}`, ...args);
    }
  }

  warn(message: string, ...args: unknown[]): void {
    if (this.shouldLog('warn')) {
      console.warn(`[WARN] ${message}`, ...args);
    }
  }

  error(message: string, ...args: unknown[]): void {
    if (this.shouldLog('error')) {
      console.error(`[ERROR] ${message}`, ...args);
    }
  }

  // Test helper to check if a level would log
  wouldLog(level: LogLevel): boolean {
    return this.shouldLog(level);
  }
}

describe('Logger', () => {
  let logger: TestableLogger;
  let consoleMocks: {
    debug: ReturnType<typeof spyOn>;
    info: ReturnType<typeof spyOn>;
    warn: ReturnType<typeof spyOn>;
    error: ReturnType<typeof spyOn>;
  };

  beforeEach(() => {
    logger = new TestableLogger();
    consoleMocks = {
      debug: spyOn(console, 'debug').mockImplementation(() => {}),
      info: spyOn(console, 'info').mockImplementation(() => {}),
      warn: spyOn(console, 'warn').mockImplementation(() => {}),
      error: spyOn(console, 'error').mockImplementation(() => {})
    };
  });

  afterEach(() => {
    consoleMocks.debug.mockRestore();
    consoleMocks.info.mockRestore();
    consoleMocks.warn.mockRestore();
    consoleMocks.error.mockRestore();
  });

  describe('setLevel', () => {
    test('defaults to info level', () => {
      expect(logger.getLevel()).toBe('info');
    });

    test('can set to debug level', () => {
      logger.setLevel('debug');
      expect(logger.getLevel()).toBe('debug');
    });

    test('can set to warn level', () => {
      logger.setLevel('warn');
      expect(logger.getLevel()).toBe('warn');
    });

    test('can set to error level', () => {
      logger.setLevel('error');
      expect(logger.getLevel()).toBe('error');
    });
  });

  describe('level filtering', () => {
    test('info level logs info, warn, error', () => {
      logger.setLevel('info');

      expect(logger.wouldLog('debug')).toBe(false);
      expect(logger.wouldLog('info')).toBe(true);
      expect(logger.wouldLog('warn')).toBe(true);
      expect(logger.wouldLog('error')).toBe(true);
    });

    test('debug level logs everything', () => {
      logger.setLevel('debug');

      expect(logger.wouldLog('debug')).toBe(true);
      expect(logger.wouldLog('info')).toBe(true);
      expect(logger.wouldLog('warn')).toBe(true);
      expect(logger.wouldLog('error')).toBe(true);
    });

    test('warn level logs warn and error', () => {
      logger.setLevel('warn');

      expect(logger.wouldLog('debug')).toBe(false);
      expect(logger.wouldLog('info')).toBe(false);
      expect(logger.wouldLog('warn')).toBe(true);
      expect(logger.wouldLog('error')).toBe(true);
    });

    test('error level logs only errors', () => {
      logger.setLevel('error');

      expect(logger.wouldLog('debug')).toBe(false);
      expect(logger.wouldLog('info')).toBe(false);
      expect(logger.wouldLog('warn')).toBe(false);
      expect(logger.wouldLog('error')).toBe(true);
    });
  });

  describe('debug', () => {
    test('logs when level is debug', () => {
      logger.setLevel('debug');
      logger.debug('Test debug message');

      expect(consoleMocks.debug).toHaveBeenCalled();
    });

    test('does not log when level is info', () => {
      logger.setLevel('info');
      logger.debug('Test debug message');

      expect(consoleMocks.debug).not.toHaveBeenCalled();
    });

    test('includes message with DEBUG prefix', () => {
      logger.setLevel('debug');
      logger.debug('Test message');

      expect(consoleMocks.debug.mock.calls[0][0]).toContain('[DEBUG]');
      expect(consoleMocks.debug.mock.calls[0][0]).toContain('Test message');
    });
  });

  describe('info', () => {
    test('logs when level is info or lower', () => {
      logger.setLevel('info');
      logger.info('Test info message');

      expect(consoleMocks.info).toHaveBeenCalled();
    });

    test('does not log when level is warn', () => {
      logger.setLevel('warn');
      logger.info('Test info message');

      expect(consoleMocks.info).not.toHaveBeenCalled();
    });

    test('includes message with INFO prefix', () => {
      logger.setLevel('info');
      logger.info('Test message');

      expect(consoleMocks.info.mock.calls[0][0]).toContain('[INFO]');
    });
  });

  describe('warn', () => {
    test('logs when level is warn or lower', () => {
      logger.setLevel('warn');
      logger.warn('Test warn message');

      expect(consoleMocks.warn).toHaveBeenCalled();
    });

    test('does not log when level is error', () => {
      logger.setLevel('error');
      logger.warn('Test warn message');

      expect(consoleMocks.warn).not.toHaveBeenCalled();
    });

    test('includes message with WARN prefix', () => {
      logger.setLevel('info');
      logger.warn('Test message');

      expect(consoleMocks.warn.mock.calls[0][0]).toContain('[WARN]');
    });
  });

  describe('error', () => {
    test('always logs errors', () => {
      logger.setLevel('error');
      logger.error('Test error message');

      expect(consoleMocks.error).toHaveBeenCalled();
    });

    test('includes message with ERROR prefix', () => {
      logger.setLevel('info');
      logger.error('Test message');

      expect(consoleMocks.error.mock.calls[0][0]).toContain('[ERROR]');
    });
  });

  describe('additional arguments', () => {
    test('passes additional arguments to console', () => {
      logger.setLevel('debug');
      const extraArg = { key: 'value' };
      logger.debug('Test message', extraArg);

      expect(consoleMocks.debug.mock.calls[0][1]).toBe(extraArg);
    });

    test('handles multiple additional arguments', () => {
      logger.setLevel('info');
      logger.info('Test', 'arg1', 'arg2', 'arg3');

      expect(consoleMocks.info.mock.calls[0]).toHaveLength(4);
    });
  });
});
