import { describe, expect, test } from 'bun:test';
import {
  filterRequestedAgentTools,
  shouldClarifyDisabledMediaIntent
} from '../../agent/tool-gates';
import type { AgentToolRequest } from '../../agent/types';

const requestedTools: AgentToolRequest[] = [
  { name: 'web_search', input: { query: 'newest Street Fighter patch notes' } },
  { name: 'image_generation', input: { prompt: 'draw a banner' } },
  { name: 'video_generation', input: { prompt: 'make a clip' } }
];

describe('agent tool gates', () => {
  test('keeps search and media tools only when their feature flags are enabled', () => {
    expect(
      filterRequestedAgentTools(requestedTools, {
        searchEnabled: true,
        mediaNaturalLanguageEnabled: true
      }).map(tool => tool.name)
    ).toEqual(['web_search', 'image_generation', 'video_generation']);

    expect(
      filterRequestedAgentTools(requestedTools, {
        searchEnabled: true,
        mediaNaturalLanguageEnabled: false
      }).map(tool => tool.name)
    ).toEqual(['web_search']);

    expect(
      filterRequestedAgentTools(requestedTools, {
        searchEnabled: false,
        mediaNaturalLanguageEnabled: true
      }).map(tool => tool.name)
    ).toEqual(['image_generation', 'video_generation']);
  });

  test('clarifies explicit media prompts when natural-language media tools are disabled', () => {
    expect(
      shouldClarifyDisabledMediaIntent({
        originalToolCount: 1,
        enabledToolCount: 0,
        intent: 'image_generate'
      })
    ).toBe(true);

    expect(
      shouldClarifyDisabledMediaIntent({
        originalToolCount: 1,
        enabledToolCount: 0,
        intent: 'video_generate'
      })
    ).toBe(true);

    expect(
      shouldClarifyDisabledMediaIntent({
        originalToolCount: 1,
        enabledToolCount: 0,
        intent: 'search'
      })
    ).toBe(false);
  });
});
