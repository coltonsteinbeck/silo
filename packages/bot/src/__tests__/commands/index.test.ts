/**
 * Tests for Command Index
 * 
 * Tests that all commands are properly registered and exported.
 */

import { describe, test, expect, mock } from 'bun:test';
import { createCommands } from '../../commands';

describe('createCommands', () => {
  test('returns a Collection of commands', () => {
    // Create minimal mocks
    const mockDb = {
      getUserMemories: mock(async () => []),
      storeUserMemory: mock(async () => ({})),
      deleteUserMemory: mock(async () => {}),
    };
    
    const mockRegistry = {
      getTextProvider: mock(() => ({ name: 'test', isConfigured: () => true })),
      getImageProvider: mock(() => ({ name: 'test', isConfigured: () => true })),
    };
    
    const mockConfig = {
      providers: {},
      features: {},
    };
    
    const mockAdminDb = {
      getServerConfig: mock(async () => null),
      setServerConfig: mock(async () => ({})),
      logAudit: mock(async () => {}),
    };
    
    const mockPermissions = {
      checkPermission: mock(async () => ({ allowed: true })),
    };
    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const commands = createCommands(
      mockDb as any,
      mockRegistry as any,
      mockConfig as any,
      mockAdminDb as any,
      mockPermissions as any
    );
    
    expect(commands).toBeDefined();
    expect(commands.size).toBeGreaterThan(0);
  });

  test('registers all expected commands', () => {
    const mockDb = {
      getUserMemories: mock(async () => []),
      storeUserMemory: mock(async () => ({})),
      deleteUserMemory: mock(async () => {}),
    };
    
    const mockRegistry = {
      getTextProvider: mock(() => ({ name: 'test', isConfigured: () => true })),
      getImageProvider: mock(() => ({ name: 'test', isConfigured: () => true })),
    };
    
    const mockConfig = { providers: {}, features: {} };
    
    const mockAdminDb = {
      getServerConfig: mock(async () => null),
      setServerConfig: mock(async () => ({})),
      logAudit: mock(async () => {}),
    };
    
    const mockPermissions = {
      checkPermission: mock(async () => ({ allowed: true })),
    };
    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const commands = createCommands(
      mockDb as any,
      mockRegistry as any,
      mockConfig as any,
      mockAdminDb as any,
      mockPermissions as any
    );
    
    // Check for expected command names
    const expectedCommands = [
      'memory-view',
      'memory-set',
      'memory-clear',
      'draw',
      'thread',
      'digest',
      'admin',
      'config',
      'mod',
      'analytics',
      'speak',
      'stopspeaking',
      'feedback'
    ];
    
    for (const cmdName of expectedCommands) {
      expect(commands.has(cmdName)).toBe(true);
    }
  });

  test('each command has required properties', () => {
    const mockDb = {
      getUserMemories: mock(async () => []),
      storeUserMemory: mock(async () => ({})),
      deleteUserMemory: mock(async () => {}),
    };
    
    const mockRegistry = {
      getTextProvider: mock(() => ({ name: 'test', isConfigured: () => true })),
      getImageProvider: mock(() => ({ name: 'test', isConfigured: () => true })),
    };
    
    const mockConfig = { providers: {}, features: {} };
    const mockAdminDb = {
      getServerConfig: mock(async () => null),
      setServerConfig: mock(async () => ({})),
      logAudit: mock(async () => {}),
    };
    const mockPermissions = {
      checkPermission: mock(async () => ({ allowed: true })),
    };
    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const commands = createCommands(
      mockDb as any,
      mockRegistry as any,
      mockConfig as any,
      mockAdminDb as any,
      mockPermissions as any
    );
    
    for (const [name, cmd] of commands) {
      expect(cmd.data).toBeDefined();
      expect(cmd.data.name).toBe(name);
      expect(typeof cmd.execute).toBe('function');
    }
  });
});
