import { describe, expect, test } from 'bun:test';
import { createAgentGraphRuntimeConfig } from '../../agent/config';

describe('agent graph runtime config', () => {
  test('defaults to enabled on-mode for universal mention routing', () => {
    const config = createAgentGraphRuntimeConfig({});

    expect(config.enabled).toBe(true);
    expect(config.mode).toBe('on');
  });

  test('keeps emergency disabled mode available', () => {
    const config = createAgentGraphRuntimeConfig({
      AGENT_GRAPH_ENABLED: 'false'
    });

    expect(config.enabled).toBe(false);
    expect(config.mode).toBe('off');
  });

  test('keeps shadow mode available for debugging without making it active', () => {
    const config = createAgentGraphRuntimeConfig({
      AGENT_GRAPH_MODE: 'shadow'
    });

    expect(config.enabled).toBe(true);
    expect(config.mode).toBe('shadow');
  });
});
