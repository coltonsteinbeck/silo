import { afterEach, expect, mock, test } from 'bun:test';
import {
  evaluatePromptSafety,
  resetPromptSafetyRuntimeForTests
} from '../../security/prompt-safety';
import {
  evaluateSemanticAssistantOutputGuardrails,
  resetGuardrailsRuntimeForTests,
  setGuardrailsRuntimeForTests
} from '../../security/openai-guardrails';
import { OpenAIProvider } from '../../providers/openai';
import { XAIProvider } from '../../providers/xai';

const originalFetch = globalThis.fetch;
const savedEnv = { ...process.env };
afterEach(() => {
  globalThis.fetch = originalFetch;
  resetPromptSafetyRuntimeForTests();
  resetGuardrailsRuntimeForTests();
  for (const key of ['OPENAI_API_KEY', 'OPENAI_MODERATION_ENABLED', 'OPENAI_GUARDRAILS_ENABLED']) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

async function assertUnderlyingRequestCancelled(run: (signal: AbortSignal) => Promise<unknown>) {
  const controller = new AbortController();
  let started!: () => void;
  const requestStarted = new Promise<void>(resolve => {
    started = resolve;
  });
  let transportAborted = false;
  const transport = mock(async (_input: unknown, init?: Parameters<typeof fetch>[1]) => {
    const signal = init?.signal;
    expect(signal).toBeDefined();
    return new Promise<Response>((_resolve, reject) => {
      signal!.addEventListener(
        'abort',
        () => {
          transportAborted = true;
          reject(new globalThis.DOMException('Request cancelled', 'AbortError'));
        },
        { once: true }
      );
      started();
    });
  });
  globalThis.fetch = transport as unknown as typeof fetch;
  const pending = run(controller.signal).catch(() => undefined);
  await requestStarted;
  controller.abort();
  await pending;
  expect(transportAborted).toBe(true);
  expect(transport).toHaveBeenCalledTimes(1);
}

test('moderation aborts its underlying request without SDK retry', async () => {
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_MODERATION_ENABLED = 'true';
  await assertUnderlyingRequestCancelled(signal =>
    evaluatePromptSafety('A factual question', {
      profile: 'strict_tool_input',
      source: 'search-cancellation-test',
      signal
    })
  );
});

test('semantic guardrails carry cancellation into their SDK request', async () => {
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_GUARDRAILS_ENABLED = 'true';
  setGuardrailsRuntimeForTests({
    module: {
      runGuardrails: async (_text, _bundle, context) => {
        await (context as any).guardrailLlm.chat.completions.create({
          model: 'fixture',
          messages: [{ role: 'user', content: 'A fixture' }]
        });
        return [];
      }
    }
  });
  await assertUnderlyingRequestCancelled(signal =>
    evaluateSemanticAssistantOutputGuardrails('A fixture', { signal, failClosedOnError: true })
  );
});

test.each(['openai', 'xai'])(
  '%s search aborts the underlying request without retry',
  async name => {
    await assertUnderlyingRequestCancelled(signal => {
      const provider =
        name === 'openai' ? new OpenAIProvider('test-key') : new XAIProvider('test-key');
      return provider.searchWeb('A factual question', { signal });
    });
  }
);

test.each(['openai', 'xai'])(
  '%s search refuses an already cancelled operation before I/O',
  async name => {
    const transport = mock(async () => new Response('{}'));
    globalThis.fetch = transport as unknown as typeof fetch;
    const provider =
      name === 'openai' ? new OpenAIProvider('test-key') : new XAIProvider('test-key');
    await expect(
      provider.searchWeb('A factual question', { signal: AbortSignal.abort() })
    ).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  }
);

test.each(['openai', 'xai'])('%s exposes structured refusal without losing usage', async name => {
  globalThis.fetch = mock(
    async () =>
      new Response(
        JSON.stringify({
          output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'I cannot help.' }] }],
          usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 }
        }),
        { headers: { 'content-type': 'application/json' } }
      )
  ) as unknown as typeof fetch;
  const provider = name === 'openai' ? new OpenAIProvider('test-key') : new XAIProvider('test-key');
  const response = await provider.searchWeb('A factual question');
  expect(response.refused).toBe(true);
  expect(response.usage?.completionTokens).toBe(7);
});
