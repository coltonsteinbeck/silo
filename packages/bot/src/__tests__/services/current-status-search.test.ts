import { describe, expect, mock, test } from 'bun:test';
import { GuildMember } from 'discord.js';
import {
  createCurrentStatusSearch,
  currentStatusSearchQuery,
  ownPriorUserTexts
} from '../../services/current-status-search';

const topic = 'Has Sample Game released yet?';
const sourced = {
  content: 'The official release page lists the current status.',
  citations: [{ url: 'https://example.org/releases/sample-game' }],
  searchCalls: 1,
  usage: { promptTokens: 25, completionTokens: 40, totalTokens: 65 }
};

function fixture(
  options: { enabled?: boolean; response?: typeof sourced; providerError?: Error } = {}
) {
  const member = Object.assign(Object.create(GuildMember.prototype), {
    user: { id: 'user' },
    guild: { id: 'guild' }
  }) as GuildMember;
  const searchWeb = mock(
    async (_query: string, _options?: { maxResults?: number; signal?: AbortSignal }) => {
      if (options.providerError) throw options.providerError;
      return options.response ?? sourced;
    }
  );
  const registry = {
    getWebSearchProvider: mock((name: string) =>
      name === 'openai' ? { name: 'openai', searchWeb } : null
    )
  };
  const getRateLimits = mock(async () => ({ search: 3 }));
  const moderate = mock(async ({ prompt }: { prompt: string }) => ({
    allowed: true,
    processedPrompt: prompt
  }));
  const evaluate = mock(async () => ({ failed: false, action: 'allow' }));
  const executeReserved = mock(async (params: any) => {
    await params.beforeAttempt();
    const value = await params.execute();
    params.getActualAmount();
    return { allowed: true, value };
  });
  const lookup = createCurrentStatusSearch({
    registry: registry as any,
    quota: { executeReserved } as any,
    permissions: { getRateLimits } as any,
    enabled: options.enabled ?? true,
    moderate: moderate as any,
    evaluate: evaluate as any
  });
  const input = {
    currentText: topic,
    priorUserTexts: [] as string[],
    guildId: 'guild',
    userId: 'user',
    messageId: 'message-1',
    member
  };
  return { lookup, input, searchWeb, registry, getRateLimits, moderate, evaluate, executeReserved };
}

describe('bounded current-status search', () => {
  test('resolves a repeated recheck from a prior user topic, not an assistant claim', () => {
    expect(currentStatusSearchQuery(topic, [])).toBe(topic);
    expect(currentStatusSearchQuery('Please check again.', [topic, 'Check again.'])).toBe(topic);
    expect(currentStatusSearchQuery('Check again.', ['Tell me about the 2004 launch'])).toBeNull();
    expect(currentStatusSearchQuery('Tell me a story about Sample Game', [topic])).toBeNull();
    expect(currentStatusSearchQuery('Check again.', [])).toBeNull();
    expect(
      currentStatusSearchQuery('Check again.', [topic, 'What is 2 + 2?', 'Check again.'])
    ).toBeNull();
    expect(currentStatusSearchQuery('Is it available yet?', [topic])).toBe(
      `Prior topic: ${topic}\nFollow-up: Is it available yet?`
    );
    expect(currentStatusSearchQuery('Is it available yet?', [])).toBeNull();
    expect(currentStatusSearchQuery('Has Sample Game launched in 2026 yet?', [])).toBe(
      'Has Sample Game launched in 2026 yet?'
    );
    expect(
      currentStatusSearchQuery('What was the latest Sample Game release in 2020?', [])
    ).toBeNull();
    expect(
      ownPriorUserTexts(
        [
          { role: 'user', userId: 'other', content: 'Has Other Game released yet?' },
          { role: 'assistant', userId: 'user', content: 'Has Fake Game released yet?' },
          { role: 'user', userId: 'user', content: topic }
        ],
        'user'
      )
    ).toEqual([topic]);
  });

  test('returns a cited answer only after a bounded provider call, quota and final safety', async () => {
    const f = fixture({
      response: { ...sourced, content: '@everyone The official page lists the current status.' }
    });
    const result = await f.lookup(f.input);
    expect(result.searched).toBe(true);
    expect(result.content).toContain('https://example.org/releases/sample-game');
    expect(result.content).not.toContain('@everyone');
    expect(f.searchWeb).toHaveBeenCalledTimes(1);
    expect(f.searchWeb.mock.calls[0]?.[1]).toMatchObject({ maxResults: 3 });
    expect(f.executeReserved.mock.calls[0]?.[0]).toMatchObject({
      operationKey: 'discord:message-1:current-status-search',
      requestedAmount: 1200,
      usageType: 'text_tokens'
    });
    expect(f.moderate).toHaveBeenCalledTimes(1);
    expect(f.evaluate).toHaveBeenCalledTimes(1);
  });

  test('contextual recheck sends the prior topic as query', async () => {
    const f = fixture();
    await f.lookup({ ...f.input, currentText: 'Please check again.', priorUserTexts: [topic] });
    expect(f.searchWeb.mock.calls[0]?.[0]).toContain(topic);
    expect(f.searchWeb.mock.calls[0]?.[0]).not.toContain('Please check again.');
  });

  test.each([
    { label: 'no fresh tool call', response: { ...sourced, searchCalls: 0 } },
    { label: 'no citation', response: { ...sourced, citations: [] } },
    { label: 'refusal', response: { ...sourced, refused: true } }
  ])('qualifies $label without a fabricated status', async ({ response }) => {
    const f = fixture({ response: response as typeof sourced });
    const result = await f.lookup(f.input);
    expect(result.content).toContain('can’t verify');
    expect(result.content).not.toContain('official release page');
    expect(f.evaluate).not.toHaveBeenCalled();
  });

  test('qualifies a conflicting sourced result instead of resolving it from memory', async () => {
    const f = fixture({
      response: { ...sourced, content: 'Sources conflict about the release status.' }
    });
    const result = await f.lookup(f.input);
    expect(result.content).toContain('Sources conflict');
    expect(result.content).toContain('check their publication dates');
  });

  test('keeps a long sourced reply within Discord limits without dropping citations', async () => {
    const f = fixture({ response: { ...sourced, content: 'A'.repeat(3000) } });
    const result = await f.lookup(f.input);
    expect(result.content.length).toBeLessThanOrEqual(2000);
    expect(result.content).toContain('https://example.org/releases/sample-game');
  });

  test('provider failure and safety denial fail honestly', async () => {
    const failed = fixture({ providerError: new Error('service unavailable') });
    expect((await failed.lookup(failed.input)).content).toContain('can’t verify');
    const denied = fixture();
    denied.evaluate.mockResolvedValue({ failed: true, action: 'block' });
    expect((await denied.lookup(denied.input)).content).toContain('can’t verify');
  });

  test('quota or input denial prevents a provider call and does not claim a search', async () => {
    const quotaDenied = fixture();
    quotaDenied.executeReserved.mockResolvedValue({ allowed: false, value: null });
    expect((await quotaDenied.lookup(quotaDenied.input)).searched).toBe(false);
    expect(quotaDenied.searchWeb).not.toHaveBeenCalled();
    const inputDenied = fixture();
    inputDenied.moderate.mockResolvedValue({ allowed: false, processedPrompt: '' });
    expect((await inputDenied.lookup(inputDenied.input)).searched).toBe(false);
    expect(inputDenied.searchWeb).not.toHaveBeenCalled();
  });

  test('disabled search, normal chat and identity mismatch never reach quota or provider', async () => {
    const disabled = fixture({ enabled: false });
    expect((await disabled.lookup(disabled.input)).searched).toBe(false);
    expect(disabled.executeReserved).not.toHaveBeenCalled();
    const normal = fixture();
    expect(
      (await normal.lookup({ ...normal.input, currentText: 'Tell me a story.' })).searched
    ).toBe(false);
    expect(normal.executeReserved).not.toHaveBeenCalled();
    const wrongGuild = fixture();
    expect(
      (await wrongGuild.lookup({ ...wrongGuild.input, guildId: 'other-guild' })).searched
    ).toBe(false);
    expect(wrongGuild.executeReserved).not.toHaveBeenCalled();
  });
});
