import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { GuildMember } from 'discord.js';
import { SearchCommand, formatSearchAnswer } from '../../commands/search';
import { createCommands } from '../../commands';
import * as moderation from '../../security/command-prompt-moderation';
import * as safety from '../../security/safety-decision';

const savedEnv = { ...process.env };
const answer = {
  content: 'A factual answer.',
  citations: [{ url: 'https://example.org/source' }],
  usage: { promptTokens: 20, completionTokens: 50, totalTokens: 70 },
  searchCalls: 1
};

test('release-note searches disclose overview-only sources without publishing unverified details', () => {
  const content = formatSearchAnswer(
    {
      ...answer,
      content: 'The latest release is v9999, published tomorrow. See its release notes.',
      citations: [
        { url: 'https://example.org/project/releases/' },
        { url: 'https://example.org/blog' }
      ]
    },
    'What is the latest stable release? Use the official release notes.'
  );
  expect(content).toContain('no direct release-notes page');
  expect(content).not.toContain('v9999');
  expect(content).not.toContain('tomorrow');
  expect(content).toContain('https://example.org/project/releases/');
});

test.each([
  'https://example.org/blog%5C?utm_source=openai',
  'https://example.org/release-notes%5c',
  'https://example.org/page%5Cdetails'
])('rejects provider citations with encoded backslashes: %s', url => {
  expect(
    formatSearchAnswer({ ...answer, citations: [{ url }] }, 'Find the release notes.')
  ).toBeNull();
});

test('rejecting a malformed citation retains other valid specific sources', () => {
  const content = formatSearchAnswer(
    {
      ...answer,
      citations: [
        { url: 'https://example.org/blog%5C?utm_source=openai' },
        { url: 'https://example.org/blog/release%20notes' }
      ]
    },
    'Find the release notes.'
  );
  expect(content).toContain('A factual answer.');
  expect(content).not.toContain('blog%5C');
  expect(content).toContain('https://example.org/blog/release%20notes');
});

test.each([
  'https://example.org/?utm_source=openai',
  'https://example.org/project/releases?utm_source=openai',
  'https://example.org/blog?trk=article&utm_source=openai',
  'https://example.org/release-notes?utm_campaign=release&utm_medium=web'
])('tracking parameters do not make an overview a release source: %s', url => {
  const content = formatSearchAnswer(
    { ...answer, citations: [{ url }] },
    'Find the release notes.'
  );
  expect(content).toContain('no direct release-notes page');
  expect(content).not.toContain('A factual answer.');
  expect(content).toContain(url);
});

test.each([
  'https://example.org/project/releases/tag/v1.2.3',
  'https://example.org/blog/release-1-2-3',
  'https://example.org/releases?version=1.2.3',
  'https://example.org/releases?version=1.2.3&utm_source=openai',
  'https://example.org/releases#v1.2.3'
])('retains a retrieved specific release source: %s', url => {
  expect(
    formatSearchAnswer({ ...answer, citations: [{ url }] }, 'Find the release notes.')
  ).toContain('A factual answer.');
});

test('overview citations remain valid for other search questions', () => {
  expect(
    formatSearchAnswer(
      { ...answer, citations: [{ url: 'https://example.org/' }] },
      'Where is the project website?'
    )
  ).toContain('A factual answer.');
});
let moderate: ReturnType<typeof spyOn>;
let evaluate: ReturnType<typeof spyOn>;
beforeEach(() => {
  process.env.AGENT_SEARCH_ENABLED = 'true';
  process.env.AGENT_SEARCH_FALLBACK_PROVIDER = 'xai';
  moderate = spyOn(moderation, 'moderateCommandPrompt').mockResolvedValue({
    allowed: true,
    processedPrompt: 'A factual question'
  });
  evaluate = spyOn(safety, 'evaluateSafetyDecision').mockResolvedValue({
    action: 'allow',
    failed: false
  } as any);
});
afterEach(() => {
  mock.restore();
  for (const key of [
    'AGENT_SEARCH_ENABLED',
    'AGENT_SEARCH_FALLBACK_PROVIDER',
    'AGENT_GRAPH_MODE'
  ]) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});
function setup() {
  const primary = {
    name: 'openai',
    searchWeb: mock(async (_query: string, _options?: any) => answer)
  };
  const fallback = {
    name: 'xai',
    searchWeb: mock(async (_query: string, _options?: any) => answer)
  };
  const registry = {
    getWebSearchProvider: (name: string) => (name === 'openai' ? primary : fallback)
  };
  let charged = 0;
  let admitted = true;
  const quota = {
    executeReserved: mock(async (params: any) => {
      if (!admitted) return { allowed: false, reason: 'Duplicate or unavailable quota.' };
      await params.beforeAttempt();
      const value = await params.execute(params.requestedAmount);
      charged = params.getActualAmount(value);
      return { allowed: true, value };
    })
  };
  const permissions = { getRateLimits: mock(async () => ({ search: 3 })) };
  const member = Object.assign(Object.create(GuildMember.prototype), {
    user: { id: 'user' },
    guild: { id: 'guild' }
  });
  const interaction = {
    id: 'interaction',
    guildId: 'guild',
    user: { id: 'user' },
    member,
    options: { getString: mock(() => 'A factual question') },
    deferReply: mock(async () => undefined),
    editReply: mock(async (_payload: any) => undefined),
    followUp: mock(async (_payload: any) => undefined),
    deleteReply: mock(async () => undefined)
  };
  const shutdown = new AbortController();
  const command = new SearchCommand(
    registry as any,
    quota as any,
    permissions as any,
    shutdown.signal
  );
  return {
    primary,
    fallback,
    registry,
    quota,
    permissions,
    interaction,
    shutdown,
    command,
    deny: () => {
      admitted = false;
    },
    charged: () => charged,
    run: () => command.execute(interaction as any)
  };
}

test('publishes one sourced, mention-safe response only after exact final-content safety', async () => {
  const f = setup();
  f.primary.searchWeb.mockResolvedValue({ ...answer, content: '@everyone A factual answer.' });
  await f.run();
  const payload = f.interaction.followUp.mock.calls[0]?.[0] as any;
  expect(payload.content).toContain('https://example.org/source');
  expect(payload.content).not.toContain('@everyone');
  expect(payload.allowedMentions).toEqual({ parse: [] });
  expect(payload.ephemeral).toBe(false);
  expect(evaluate.mock.calls[0]?.[0]).toBe(payload.content);
  expect(f.interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
  expect(f.interaction.followUp).toHaveBeenCalledTimes(1);
  expect(f.interaction.deleteReply).toHaveBeenCalledTimes(1);
  expect(f.fallback.searchWeb).not.toHaveBeenCalled();
  expect(f.charged()).toBe(50);
});

test('deferred private reply cannot swallow and delete the public answer', async () => {
  const f = setup();
  let deferred = true;
  let original: unknown;
  const publicMessages: unknown[] = [];
  f.interaction.editReply.mockImplementation(async (payload: any) => {
    deferred = false;
    original = payload;
  });
  f.interaction.followUp.mockImplementation(async (payload: any) => {
    // Discord treats the first follow-up to a deferred reply as an edit.
    if (deferred) {
      deferred = false;
      original = payload;
    } else if (!payload.ephemeral) publicMessages.push(payload);
  });
  f.interaction.deleteReply.mockImplementation(async () => {
    original = undefined;
  });
  await f.run();
  expect(original).toBeUndefined();
  expect(publicMessages).toHaveLength(1);
  expect(publicMessages[0]).toMatchObject({
    content: 'A factual answer.\n\nSources:\nhttps://example.org/source',
    allowedMentions: { parse: [] }
  });
});

test('source limitation still uses one attempt, final safety and persistent mention-safe delivery', async () => {
  const f = setup();
  const query = 'Find the official release notes.';
  f.interaction.options.getString.mockReturnValue(query);
  moderate.mockResolvedValue({ allowed: true, processedPrompt: query });
  f.primary.searchWeb.mockResolvedValue({
    ...answer,
    content: 'Unverified release details.',
    citations: [{ url: 'https://example.org/releases?utm_source=openai' }]
  });
  await f.run();
  const payload = f.interaction.followUp.mock.calls[0]?.[0] as any;
  expect(payload.content).toContain('no direct release-notes page');
  expect(payload.content).not.toContain('Unverified release details');
  expect(payload.allowedMentions).toEqual({ parse: [] });
  expect(payload.ephemeral).toBe(false);
  expect(evaluate.mock.calls[0]?.[0]).toBe(payload.content);
  expect(f.primary.searchWeb).toHaveBeenCalledTimes(1);
  expect(f.fallback.searchWeb).not.toHaveBeenCalled();
  expect(f.interaction.deleteReply).toHaveBeenCalledTimes(1);
  expect(f.charged()).toBe(50);
});

test('a lone malformed citation ends privately without another provider when fallback is disabled', async () => {
  process.env.AGENT_SEARCH_FALLBACK_PROVIDER = 'disabled';
  const f = setup();
  moderate.mockResolvedValue({ allowed: true, processedPrompt: 'Find the release notes.' });
  f.primary.searchWeb.mockResolvedValue({
    ...answer,
    citations: [{ url: 'https://example.org/blog%5C?utm_source=openai' }]
  });
  await f.run();
  expect(f.primary.searchWeb).toHaveBeenCalledTimes(1);
  expect(f.fallback.searchWeb).not.toHaveBeenCalled();
  expect(f.interaction.followUp).not.toHaveBeenCalled();
  expect(evaluate).not.toHaveBeenCalled();
  expect(f.interaction.editReply).toHaveBeenCalledWith(
    'I couldn’t find a supported answer. Try a more specific search.'
  );
  expect(f.charged()).toBe(50);
});

test.each(['', ' '.repeat(10), 'x'.repeat(2001)])(
  'rejects invalid query before quota or moderation',
  async query => {
    const f = setup();
    f.interaction.options.getString.mockReturnValue(query);
    await f.run();
    expect(f.quota.executeReserved).not.toHaveBeenCalled();
    expect(moderate).not.toHaveBeenCalled();
    expect(f.interaction.followUp).not.toHaveBeenCalled();
  }
);

test('disabled stale command fails privately before paid work', async () => {
  process.env.AGENT_SEARCH_ENABLED = 'false';
  const f = setup();
  await f.run();
  expect(f.quota.executeReserved).not.toHaveBeenCalled();
  expect(moderate).not.toHaveBeenCalled();
  expect(f.interaction.followUp).not.toHaveBeenCalled();
  expect(f.interaction.editReply).toHaveBeenCalledTimes(1);
});

test.each(['guild', 'member', 'identity', 'permission', 'quota'])(
  'denies %s without paid work',
  async kind => {
    const f = setup();
    if (kind === 'guild') f.interaction.guildId = '';
    if (kind === 'member') f.interaction.member = {};
    if (kind === 'identity') f.interaction.user.id = 'another-user';
    if (kind === 'permission') f.permissions.getRateLimits.mockResolvedValue({ search: 0 });
    if (kind === 'quota') f.deny();
    await f.run();
    expect(moderate).not.toHaveBeenCalled();
    expect(f.primary.searchWeb).not.toHaveBeenCalled();
    expect(f.interaction.followUp).not.toHaveBeenCalled();
  }
);

test('blocked input cannot enter either search provider', async () => {
  moderate.mockResolvedValue({ allowed: false, processedPrompt: '' });
  const f = setup();
  await f.run();
  expect(f.primary.searchWeb).not.toHaveBeenCalled();
  expect(f.fallback.searchWeb).not.toHaveBeenCalled();
});

test('a transient error allows exactly one configured fallback and reserves uncertain usage', async () => {
  const f = setup();
  f.primary.searchWeb.mockRejectedValue(Object.assign(new Error('unavailable'), { status: 503 }));
  await f.run();
  expect(f.primary.searchWeb).toHaveBeenCalledTimes(1);
  expect(f.fallback.searchWeb).toHaveBeenCalledTimes(1);
  expect(Number.isNaN(f.charged())).toBe(true);
  expect(f.interaction.followUp).toHaveBeenCalledTimes(1);
});

test('missing evidence permits one fallback and accounts both known usages', async () => {
  const f = setup();
  f.primary.searchWeb.mockResolvedValue({ ...answer, citations: [] });
  await f.run();
  expect(f.fallback.searchWeb).toHaveBeenCalledTimes(1);
  expect(f.charged()).toBe(100);
});

test.each(['refusal', 'text-refusal', 'auth', 'validation'])(
  'does not provider-hop after %s',
  async kind => {
    const f = setup();
    if (kind === 'refusal')
      f.primary.searchWeb.mockResolvedValue({ ...answer, refused: true } as any);
    else if (kind === 'text-refusal')
      f.primary.searchWeb.mockResolvedValue({
        ...answer,
        content: 'I cannot help with that request.'
      });
    else
      f.primary.searchWeb.mockRejectedValue(
        Object.assign(new Error('rejected'), { status: kind === 'auth' ? 401 : 400 })
      );
    await f.run();
    expect(f.fallback.searchWeb).not.toHaveBeenCalled();
    expect(f.interaction.followUp).not.toHaveBeenCalled();
  }
);

test('shutdown cancels in-flight search and suppresses fallback and public delivery', async () => {
  const f = setup();
  f.primary.searchWeb.mockImplementation(async (_query: any, options: any) => {
    const pending = new Promise<never>((_, reject) =>
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    );
    f.shutdown.abort();
    return pending;
  });
  await f.run();
  expect(f.fallback.searchWeb).not.toHaveBeenCalled();
  expect(f.interaction.followUp).not.toHaveBeenCalled();
  expect(f.interaction.editReply).toHaveBeenCalledWith(
    'Search was interrupted. Please try again shortly.'
  );
});

test('unsafe final output stays private without another provider call', async () => {
  evaluate.mockResolvedValue({ action: 'block', failed: false });
  const f = setup();
  await f.run();
  expect(f.interaction.followUp).not.toHaveBeenCalled();
  expect(f.fallback.searchWeb).not.toHaveBeenCalled();
});

test('uncertain Discord delivery is never retried', async () => {
  const f = setup();
  f.interaction.followUp.mockRejectedValue(new Error('connection lost'));
  await f.run();
  expect(f.interaction.followUp).toHaveBeenCalledTimes(1);
  expect(f.interaction.editReply).toHaveBeenCalledTimes(1);
  expect(f.interaction.deleteReply).not.toHaveBeenCalled();
  expect(f.fallback.searchWeb).not.toHaveBeenCalled();
});

test('citations are unique HTTPS URLs, bounded with final text', () => {
  const authenticatedUrl = new URL('https://example.org');
  authenticatedUrl.username = 'user';
  authenticatedUrl.password = 'pass';
  const content = formatSearchAnswer({
    ...answer,
    content: 'x'.repeat(5000),
    citations: [
      { url: 'javascript:alert(1)' },
      { url: 'http://example.org' },
      { url: authenticatedUrl.href },
      ...Array.from({ length: 5 }, (_, index) => ({ url: `https://example.org/${index}` }))
    ]
  });
  expect(content!.length).toBeLessThanOrEqual(2000);
  expect(content).not.toContain('pass');
  expect(content).toContain('/2');
  expect(content).not.toContain('/3');
});

test('search registration is independent of graph mode and requires quota plus provider', () => {
  process.env.AGENT_GRAPH_MODE = 'off';
  const f = setup();
  const registered = createCommands(
    {} as any,
    f.registry as any,
    {} as any,
    {} as any,
    f.permissions as any,
    f.quota as any
  );
  expect(registered.has('search')).toBe(true);
  expect(
    createCommands(
      {} as any,
      { getWebSearchProvider: () => null } as any,
      {} as any,
      {} as any,
      {} as any,
      f.quota as any
    ).has('search')
  ).toBe(false);
  process.env.AGENT_SEARCH_ENABLED = 'false';
  expect(
    createCommands(
      {} as any,
      f.registry as any,
      {} as any,
      {} as any,
      {} as any,
      f.quota as any
    ).has('search')
  ).toBe(false);
});

test.each([10_000, 20_000, 30_000])(
  'deadline %d aborts provider work with bounded fallback',
  async deadline => {
    const controllers = new Map<number, AbortController>();
    spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController();
      controllers.set(ms, controller);
      return controller.signal;
    });
    const f = setup();
    f.primary.searchWeb.mockImplementation(async (_query, options) => {
      const pending = new Promise<never>((_, reject) =>
        options.signal.addEventListener('abort', () => reject(options.signal.reason), {
          once: true
        })
      );
      controllers
        .get(deadline)!
        .abort(new globalThis.DOMException('Deadline reached', 'TimeoutError'));
      return pending;
    });
    await f.run();
    expect([...controllers.keys()]).toEqual([30_000, 20_000, 10_000]);
    expect(f.primary.searchWeb).toHaveBeenCalledTimes(1);
    expect(f.fallback.searchWeb).toHaveBeenCalledTimes(deadline === 10_000 ? 1 : 0);
    expect(f.interaction.followUp).toHaveBeenCalledTimes(deadline === 10_000 ? 1 : 0);
  }
);

test('command deadline replies even while permission I/O is stalled and prevents late paid work', async () => {
  const controller = new AbortController();
  spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
  const f = setup();
  let release!: (value: { search: number }) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => {
    entered = resolve;
  });
  f.permissions.getRateLimits.mockImplementation(
    () =>
      new Promise(resolve => {
        release = resolve;
        entered();
      })
  );
  const pending = f.run();
  await started;
  controller.abort(new globalThis.DOMException('Deadline reached', 'TimeoutError'));
  await Promise.resolve();
  expect(f.interaction.editReply).toHaveBeenCalledWith('Search took too long. Please try again.');
  release({ search: 3 });
  await pending;
  expect(f.interaction.editReply).toHaveBeenCalledTimes(1);
  expect(f.quota.executeReserved).not.toHaveBeenCalled();
  expect(f.primary.searchWeb).not.toHaveBeenCalled();
});
