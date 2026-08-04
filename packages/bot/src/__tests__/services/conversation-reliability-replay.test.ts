import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ConversationMessage, Message, PromptContextResult, TextProvider } from '@silo/core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDefaultAgentGraphLimits } from '../../agent/config';
import { runBoundedAgentGraph } from '../../agent/bounded-graph';
import { PostgresAdapter } from '../../database/postgres';
import {
  resetGuardrailsRuntimeForTests,
  setGuardrailsRuntimeForTests
} from '../../security/openai-guardrails';
import { evaluateSafetyDecision } from '../../security/safety-decision';
import {
  resetPromptSafetyRuntimeForTests,
  setPromptSafetyRuntimeForTests
} from '../../security/prompt-safety';
import { shouldIncludeConversationHistoryForPrompt } from '../../services/conversation-context';
import { sanitizeConversationHistoryForPrompt } from '../../services/conversation-history-sanitizer';
import { recoverUnsafeAgentResponse } from '../../services/assistant-response-recovery';
import { selectLatestTaskDefiningUserText } from '../../services/response-quality';

type SafetyState =
  | 'legacy'
  | 'allowed'
  | 'output_repaired'
  | 'quality_repaired'
  | 'redirected_explicit';

type FixtureScope = {
  guildId: string;
  channelId: string;
  promptHash: string;
};

type LegacyRowFixture = {
  rowId: string;
  role: 'user' | 'assistant';
  authorId: string;
  messageId: string;
  content: string;
  createdAt: string;
};

type UnpairedRowFixture = {
  rowId: string;
  turnId: string;
  sequence: 0 | 1;
  role: 'user' | 'assistant';
  authorId: string;
  requesterUserId: string;
  messageId: string;
  content: string;
  promptEligible: boolean;
  safetyState: SafetyState;
  createdAt: string;
};

type TurnFixture = {
  turnId: string;
  requesterUserId: string;
  userMessageId: string;
  assistantMessageId: string;
  replyToMessageId?: string;
  userContent: string;
  assistantContent: string;
  promptEligible: boolean;
  safetyState: SafetyState;
  safetyCategories?: string[];
  createdAt: string;
};

type DatabaseRow = {
  id: string;
  guild_id: string;
  channel_id: string;
  user_id: string;
  discord_message_id: string;
  prompt_hash: string;
  role: 'user' | 'assistant';
  content: string;
  reply_to_message_id: string | null;
  reply_to_user_id: string | null;
  referenced_content: string | null;
  image_summary: string | null;
  turn_id: string | null;
  turn_sequence: 0 | 1 | null;
  requester_user_id: string | null;
  prompt_eligible: boolean;
  safety_state: SafetyState;
  safety_categories: string[];
  created_at: string;
};

type StandaloneCase = {
  name: string;
  requesterUserId: string;
  prompt: string;
  expectedScope: PromptContextResult['scope'];
  expectedSelectedTurnIds: string[];
  expectedExclusionReasons: Record<string, number>;
};

type ReplayFixture = {
  scope: FixtureScope;
  legacyRows: LegacyRowFixture[];
  unpairedRows: UnpairedRowFixture[];
  turns: TurnFixture[];
  standaloneCases: StandaloneCase[];
  forbiddenResidue: string[];
  replyChain: {
    requesterUserId: string;
    replyToMessageId: string;
    expectedTurnIds: string[];
    expectedRequesterUserIds: string[];
  };
  repetitionRecovery: {
    requesterUserId: string;
    prompt: string;
    primaryCandidate: string;
  };
  unsafeOutputRecovery: {
    prompt: string;
    primaryCandidate: string;
  };
  policyOverride: {
    prompt: string;
    expectedCategory: string;
  };
};

const fixture = JSON.parse(
  readFileSync(resolve(import.meta.dir, '../fixtures/conversation-reliability-replay.json'), 'utf8')
) as ReplayFixture;

const ELIGIBLE_SAFETY_STATES = new Set<SafetyState>([
  'allowed',
  'output_repaired',
  'quality_repaired'
]);

function materializeRows(replay: ReplayFixture): DatabaseRow[] {
  const { guildId, channelId, promptHash } = replay.scope;
  const legacy = replay.legacyRows.map<DatabaseRow>(row => ({
    id: row.rowId,
    guild_id: guildId,
    channel_id: channelId,
    user_id: row.authorId,
    discord_message_id: row.messageId,
    prompt_hash: promptHash,
    role: row.role,
    content: row.content,
    reply_to_message_id: null,
    reply_to_user_id: null,
    referenced_content: null,
    image_summary: null,
    turn_id: null,
    turn_sequence: null,
    requester_user_id: null,
    prompt_eligible: false,
    safety_state: 'legacy',
    safety_categories: [],
    created_at: row.createdAt
  }));
  const unpaired = replay.unpairedRows.map<DatabaseRow>(row => ({
    id: row.rowId,
    guild_id: guildId,
    channel_id: channelId,
    user_id: row.authorId,
    discord_message_id: row.messageId,
    prompt_hash: promptHash,
    role: row.role,
    content: row.content,
    reply_to_message_id: null,
    reply_to_user_id: null,
    referenced_content: null,
    image_summary: null,
    turn_id: row.turnId,
    turn_sequence: row.sequence,
    requester_user_id: row.requesterUserId,
    prompt_eligible: row.promptEligible,
    safety_state: row.safetyState,
    safety_categories: [],
    created_at: row.createdAt
  }));
  const completed = replay.turns.flatMap<DatabaseRow>(turn => [
    {
      id: `${turn.turnId}-user`,
      guild_id: guildId,
      channel_id: channelId,
      user_id: turn.requesterUserId,
      discord_message_id: turn.userMessageId,
      prompt_hash: promptHash,
      role: 'user',
      content: turn.userContent,
      reply_to_message_id: turn.replyToMessageId || null,
      reply_to_user_id: null,
      referenced_content: null,
      image_summary: null,
      turn_id: turn.turnId,
      turn_sequence: 0,
      requester_user_id: turn.requesterUserId,
      prompt_eligible: turn.promptEligible,
      safety_state: turn.safetyState,
      safety_categories: turn.safetyCategories || [],
      created_at: turn.createdAt
    },
    {
      id: `${turn.turnId}-assistant`,
      guild_id: guildId,
      channel_id: channelId,
      user_id: 'assistant-replay',
      discord_message_id: turn.assistantMessageId,
      prompt_hash: promptHash,
      role: 'assistant',
      content: turn.assistantContent,
      reply_to_message_id: null,
      reply_to_user_id: turn.requesterUserId,
      referenced_content: null,
      image_summary: null,
      turn_id: turn.turnId,
      turn_sequence: 1,
      requester_user_id: turn.requesterUserId,
      prompt_eligible: turn.promptEligible,
      safety_state: turn.safetyState,
      safety_categories: turn.safetyCategories || [],
      created_at: turn.createdAt
    }
  ]);

  return [...legacy, ...unpaired, ...completed];
}

function groupByTurn(rows: DatabaseRow[]): Map<string, DatabaseRow[]> {
  const grouped = new Map<string, DatabaseRow[]>();
  for (const row of rows) {
    const key = row.turn_id || `legacy-row:${row.id}`;
    grouped.set(key, [...(grouped.get(key) || []), row]);
  }
  return grouped;
}

function classifyTurn(rows: DatabaseRow[]): string | null {
  const isLegacy = rows.some(row => row.turn_id === null || row.safety_state === 'legacy');
  if (isLegacy) return 'legacy';

  const requesterCount = new Set(rows.map(row => row.requester_user_id).filter(Boolean)).size;
  const userCount = rows.filter(row => row.turn_sequence === 0 && row.role === 'user').length;
  const assistantCount = rows.filter(
    row => row.turn_sequence === 1 && row.role === 'assistant'
  ).length;
  if (rows.length !== 2 || userCount !== 1 || assistantCount !== 1 || requesterCount !== 1) {
    return 'incomplete_or_unpaired';
  }

  if (rows.some(row => !row.prompt_eligible || !ELIGIBLE_SAFETY_STATES.has(row.safety_state))) {
    return 'unsafe_or_ineligible';
  }

  return null;
}

function selectSameUserContext(
  rows: DatabaseRow[],
  params: unknown[]
): { rows: object[]; rowCount: number } {
  const [guildId, channelId, promptHash, requesterUserId, _maxAgeMs, maxTurnsValue] = params;
  const maxTurns = Number(maxTurnsValue);
  const scoped = rows.filter(
    row =>
      row.guild_id === guildId &&
      row.channel_id === channelId &&
      row.prompt_hash === promptHash &&
      (row.requester_user_id === requesterUserId ||
        (row.turn_id === null && row.role === 'user' && row.user_id === requesterUserId))
  );
  const candidates = Array.from(groupByTurn(scoped), ([key, turnRows]) => ({
    key,
    rows: turnRows,
    exclusionReason: classifyTurn(turnRows),
    createdAt:
      turnRows
        .map(row => row.created_at)
        .sort()
        .at(-1) || ''
  }));
  const safe = candidates
    .filter(candidate => candidate.exclusionReason === null)
    .sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.key.localeCompare(left.key)
    );
  safe.slice(maxTurns).forEach(candidate => {
    candidate.exclusionReason = 'over_limit';
  });
  const selected = safe.slice(0, maxTurns);
  const selectedKeys = new Set(selected.map(candidate => candidate.key));
  const selectedMessages = selected
    .flatMap(candidate => candidate.rows)
    .sort((left, right) => {
      const leftTurn = selected.find(candidate => candidate.key === left.turn_id);
      const rightTurn = selected.find(candidate => candidate.key === right.turn_id);
      return (
        (leftTurn?.createdAt || '').localeCompare(rightTurn?.createdAt || '') ||
        (left.turn_id || '').localeCompare(right.turn_id || '') ||
        (left.turn_sequence ?? 0) - (right.turn_sequence ?? 0)
      );
    });
  const exclusionReasons: Record<string, number> = {};
  for (const candidate of candidates) {
    if (selectedKeys.has(candidate.key) || !candidate.exclusionReason) continue;
    exclusionReasons[candidate.exclusionReason] =
      (exclusionReasons[candidate.exclusionReason] || 0) + 1;
  }

  return {
    rows: [
      {
        messages: selectedMessages,
        selected_turn_count: selected.length,
        excluded_turn_count: Object.values(exclusionReasons).reduce((sum, count) => sum + count, 0),
        exclusion_reasons: exclusionReasons
      }
    ],
    rowCount: 1
  };
}

function selectReplyChain(
  rows: DatabaseRow[],
  params: unknown[]
): { rows: DatabaseRow[]; rowCount: number } {
  const [replyToMessageId, guildId, channelId, promptHash, maxTurnsValue] = params;
  const maxTurns = Number(maxTurnsValue);
  const scoped = rows.filter(
    row =>
      row.guild_id === guildId && row.channel_id === channelId && row.prompt_hash === promptHash
  );
  const eligibleTurns = new Map(
    Array.from(groupByTurn(scoped)).filter(([, turnRows]) => classifyTurn(turnRows) === null)
  );
  const eligibleRows = Array.from(eligibleTurns.values()).flat();
  let current = eligibleRows.find(row => row.discord_message_id === replyToMessageId);
  const chain: string[] = [];

  while (current?.turn_id && chain.length < maxTurns && !chain.includes(current.turn_id)) {
    chain.push(current.turn_id);
    const currentUser = eligibleTurns
      .get(current.turn_id)
      ?.find(row => row.turn_sequence === 0 && row.role === 'user');
    current = currentUser?.reply_to_message_id
      ? eligibleRows.find(row => row.discord_message_id === currentUser.reply_to_message_id)
      : undefined;
  }

  const selected = chain
    .reverse()
    .flatMap(turnId => eligibleTurns.get(turnId) || [])
    .sort((left, right) => {
      const leftDepth = chain.indexOf(left.turn_id || '');
      const rightDepth = chain.indexOf(right.turn_id || '');
      return leftDepth - rightDepth || (left.turn_sequence ?? 0) - (right.turn_sequence ?? 0);
    });
  return { rows: selected, rowCount: selected.length };
}

function adapterBackedByReplayRows(rows: DatabaseRow[]): PostgresAdapter {
  const query = mock(async (sql: string, params: unknown[]) =>
    sql.includes('WITH RECURSIVE eligible_turns AS')
      ? selectReplyChain(rows, params)
      : selectSameUserContext(rows, params)
  );
  const adapter = new PostgresAdapter('postgresql://user:pass@localhost:5432/replay');
  Object.defineProperty(adapter, 'pool', { value: { query } });
  return adapter;
}

function selectedTurnIds(messages: ConversationMessage[]): string[] {
  return Array.from(
    new Set(
      messages.map(message => message.turnId).filter((value): value is string => Boolean(value))
    )
  );
}

function graphProvider(
  forbiddenResidue: string[],
  calls: Array<Array<{ role: string; content: string }>>
): TextProvider {
  return {
    name: 'replay-provider',
    capabilities: { vision: false },
    isConfigured: () => true,
    generateText: mock(async (messages: Message[]) => {
      const visibleMessages = messages.map(message => ({
        role: message.role,
        content: typeof message.content === 'string' ? message.content : ''
      }));
      calls.push(visibleMessages);
      const joined = visibleMessages
        .map(message => message.content)
        .join(' ')
        .toLowerCase();
      const leakedResidue = forbiddenResidue.find(fragment => joined.includes(fragment));
      const latestUser = [...visibleMessages]
        .reverse()
        .find(message => message.role === 'user')?.content;
      return {
        content: leakedResidue
          ? `I revived contaminated context: ${leakedResidue}.`
          : `Fresh reply grounded only in the current request: ${latestUser || 'unknown request'}`,
        model: 'replay-model'
      };
    })
  };
}

async function runGraph(params: {
  provider: TextProvider;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  latestUserText: string;
  recentAssistantMessages?: string[];
  temperature?: number;
}) {
  return runBoundedAgentGraph({
    messages: params.messages,
    textProvider: params.provider,
    generationOptions: { maxTokens: 80, temperature: params.temperature ?? 0.6 },
    provider: { providerName: params.provider.name, model: 'replay-model' },
    limits: getDefaultAgentGraphLimits(),
    requestedTools: [],
    inheritedSafetyRisk: false,
    recentAssistantMessages: params.recentAssistantMessages || [],
    latestUserText: params.latestUserText,
    metadata: { provider: params.provider.name, model: 'replay-model' }
  });
}

const rows = materializeRows(fixture);

describe('anonymized contaminated-conversation replay', () => {
  const originalGuardrailsEnabled = process.env.OPENAI_GUARDRAILS_ENABLED;
  const originalModerationEnabled = process.env.OPENAI_MODERATION_ENABLED;
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    process.env.OPENAI_GUARDRAILS_ENABLED = 'false';
    process.env.OPENAI_MODERATION_ENABLED = 'false';
    process.env.OPENAI_API_KEY = 'test-key';
    resetPromptSafetyRuntimeForTests();
    resetGuardrailsRuntimeForTests();
    setGuardrailsRuntimeForTests({
      module: { runGuardrails: mock(async () => []) } as never,
      guardrailLlmClient: {} as never
    });
  });

  afterEach(() => {
    process.env.OPENAI_GUARDRAILS_ENABLED = originalGuardrailsEnabled;
    process.env.OPENAI_MODERATION_ENABLED = originalModerationEnabled;
    process.env.OPENAI_API_KEY = originalOpenAiApiKey;
    resetPromptSafetyRuntimeForTests();
    resetGuardrailsRuntimeForTests();
  });

  test('fixture reproduces assistant-before-user legacy ordering and three unrelated authors', () => {
    expect(fixture.legacyRows.map(row => row.role)).toEqual(['assistant', 'user']);
    expect(
      fixture.legacyRows[0]!.createdAt.localeCompare(fixture.legacyRows[1]!.createdAt)
    ).toBeLessThan(0);
    expect(
      new Set(
        fixture.turns
          .filter(turn => turn.requesterUserId.startsWith('unrelated-user-'))
          .map(turn => turn.requesterUserId)
      ).size
    ).toBe(3);
  });

  test('keeps the five newest complete turns as ten messages without splitting pairs', async () => {
    const continuityTurns = Array.from(
      { length: 6 },
      (_, index): TurnFixture => ({
        turnId: `continuity-turn-${index + 1}`,
        requesterUserId: 'continuity-user',
        userMessageId: `continuity-user-message-${index + 1}`,
        assistantMessageId: `continuity-assistant-message-${index + 1}`,
        userContent: `continuity question ${index + 1}`,
        assistantContent: `continuity answer ${index + 1}`,
        promptEligible: true,
        safetyState: 'allowed',
        createdAt: `2026-07-09T13:0${index}:00.000Z`
      })
    );
    const continuityRows = materializeRows({
      ...fixture,
      legacyRows: [],
      unpairedRows: [],
      turns: continuityTurns
    });
    const adapter = adapterBackedByReplayRows(continuityRows);

    const context = await adapter.getPromptContext({
      ...fixture.scope,
      requesterUserId: 'continuity-user',
      maxTurns: 99,
      maxAgeMs: 30 * 60 * 1000
    });

    expect(context.selectedTurnCount).toBe(5);
    expect(context.messages).toHaveLength(10);
    expect(selectedTurnIds(context.messages)).toEqual(
      continuityTurns.slice(1).map(turn => turn.turnId)
    );
    expect(context.messages.map(message => message.role)).toEqual(
      Array.from({ length: 5 }).flatMap(() => ['user' as const, 'assistant' as const])
    );
    expect(context.exclusionReasons).toEqual({ over_limit: 1 });
  });

  test.each(fixture.standaloneCases)(
    '$name selects clean context before graph generation',
    async replayCase => {
      const adapter = adapterBackedByReplayRows(rows);
      const context = await adapter.getPromptContext({
        ...fixture.scope,
        requesterUserId: replayCase.requesterUserId,
        maxTurns: 3,
        maxAgeMs: 30 * 60 * 1000
      });
      const sanitation = sanitizeConversationHistoryForPrompt(context.messages);
      const includeHistory =
        sanitation.filtered.length > 0 &&
        shouldIncludeConversationHistoryForPrompt({
          latestUserText: replayCase.prompt,
          hasReplyContext: false,
          hasVisionTargets: false
        });
      const graphMessages = [
        { role: 'system' as const, content: 'Answer only the latest user message.' },
        ...(includeHistory
          ? sanitation.filtered.map(message => ({
              role: message.role as 'user' | 'assistant',
              content: message.content
            }))
          : []),
        { role: 'user' as const, content: replayCase.prompt }
      ];
      const generationCalls: Array<Array<{ role: string; content: string }>> = [];
      const provider = graphProvider(fixture.forbiddenResidue, generationCalls);
      const inputDecision = await evaluateSafetyDecision(replayCase.prompt, {
        stage: 'input',
        source: 'trace_replay'
      });
      const result = await runGraph({
        provider,
        messages: graphMessages,
        latestUserText: replayCase.prompt,
        recentAssistantMessages: sanitation.filtered
          .filter(message => message.role === 'assistant')
          .map(message => message.content)
      });

      expect(inputDecision.action).toBe('allow');
      expect(context.scope).toBe(replayCase.expectedScope);
      expect(selectedTurnIds(context.messages)).toEqual(replayCase.expectedSelectedTurnIds);
      expect(context.exclusionReasons).toEqual(replayCase.expectedExclusionReasons);
      expect(sanitation.removedCount).toBe(0);
      expect(result.outputSafety?.blocked).toBe(false);
      expect(generationCalls).toHaveLength(1);
      expect(generationCalls[0]!.map(message => message.role)).toEqual(['system', 'user']);
      expect(result.response.content).toContain(replayCase.prompt);
      for (const fragment of fixture.forbiddenResidue) {
        expect(
          generationCalls[0]!
            .map(message => message.content)
            .join(' ')
            .toLowerCase()
        ).not.toContain(fragment);
        expect(result.response.content.toLowerCase()).not.toContain(fragment);
      }
    }
  );

  test('redirected explicit inputs are ineligible before their later benign trace prompts', async () => {
    const explicitTurns = fixture.turns.filter(turn => turn.safetyState === 'redirected_explicit');

    for (const turn of explicitTurns) {
      const decision = await evaluateSafetyDecision(turn.userContent, {
        stage: 'input',
        source: 'trace_replay'
      });
      expect(decision.action).toBe('redirect');
      expect(decision.contextEligible).toBe(false);
      expect(turn.promptEligible).toBe(false);
    }
  });

  test('direct reply context preserves an intentional multi-user handoff in causal order', async () => {
    const adapter = adapterBackedByReplayRows(rows);
    const context = await adapter.getPromptContext({
      ...fixture.scope,
      requesterUserId: fixture.replyChain.requesterUserId,
      replyToMessageId: fixture.replyChain.replyToMessageId,
      maxTurns: 3
    });

    expect(context.scope).toBe('reply_chain');
    expect(selectedTurnIds(context.messages)).toEqual(fixture.replyChain.expectedTurnIds);
    expect(
      Array.from(
        new Set(
          context.messages
            .filter(message => message.role === 'user')
            .map(message => message.requesterUserId)
        )
      )
    ).toEqual(fixture.replyChain.expectedRequesterUserIds);
    expect(context.messages.map(message => message.turnSequence)).toEqual([0, 1, 0, 1]);
  });

  test('invented-lore repetition is a quality repair with only the latest safe task retained', async () => {
    const replay = fixture.repetitionRecovery;
    const adapter = adapterBackedByReplayRows(rows);
    const context = await adapter.getPromptContext({
      ...fixture.scope,
      requesterUserId: replay.requesterUserId,
      maxTurns: 3,
      maxAgeMs: 30 * 60 * 1000
    });
    const sanitation = sanitizeConversationHistoryForPrompt(context.messages);
    const recentAssistantMessages = sanitation.filtered
      .filter(message => message.role === 'assistant')
      .map(message => message.content);
    const primaryCalls: Array<Array<{ role: string; content: string }>> = [];
    const primaryProvider: TextProvider = {
      ...graphProvider([], primaryCalls),
      generateText: mock(async (messages: Message[]) => {
        primaryCalls.push(
          messages.map(message => ({
            role: message.role,
            content: typeof message.content === 'string' ? message.content : ''
          }))
        );
        return { content: replay.primaryCandidate, model: 'replay-model' };
      })
    };
    const primary = await runGraph({
      provider: primaryProvider,
      messages: [
        { role: 'system', content: 'Do not invent shared lore.' },
        ...sanitation.filtered.map(message => ({
          role: message.role as 'user' | 'assistant',
          content: message.content
        })),
        { role: 'user', content: replay.prompt }
      ],
      latestUserText: replay.prompt,
      recentAssistantMessages
    });
    const retryCalls: Array<Array<{ role: string; content: string }>> = [];
    const retryProvider = graphProvider(fixture.forbiddenResidue, retryCalls);
    const previousSafeUserRequest = selectLatestTaskDefiningUserText(
      sanitation.filtered.filter(message => message.role === 'user').map(message => message.content)
    );
    const recovered = await recoverUnsafeAgentResponse({
      primaryResult: primary,
      inputSafetyAction: 'allow',
      runContextFreeRetry: async () => {
        throw new Error('quality recovery must retain the safe task referent');
      },
      runContextRetainedRetry: () =>
        runGraph({
          provider: retryProvider,
          messages: [
            { role: 'system', content: 'Use only the supplied safe user requests.' },
            {
              role: 'user',
              content: `Previous safe user request: ${previousSafeUserRequest}\nLatest follow-up: ${replay.prompt}`
            }
          ],
          latestUserText: replay.prompt,
          recentAssistantMessages: [],
          temperature: 0.2
        })
    });

    expect(context.selectedTurnCount).toBe(2);
    expect(sanitation.removedCount).toBe(0);
    expect(primary.outputSafety?.decision.action).toBe('allow');
    expect(primary.outputSafety?.quality.repetitive).toBe(true);
    expect(primary.outputSafety?.categories).toContain('quality/repetition_loop');
    expect(recovered.retryCount).toBe(1);
    expect(recovered.retrySucceeded).toBe(true);
    expect(recovered.recoveryReason).toBe('quality');
    expect(recovered.recoveryContextRetained).toBe(true);
    expect(primaryCalls).toHaveLength(1);
    expect(retryCalls).toHaveLength(1);
    expect(retryCalls[0]!.map(message => message.role)).toEqual(['system', 'user']);
    expect(recovered.result.response.content).toContain(replay.prompt);
    expect(recovered.result.outputSafety?.quality.repetitive).toBe(false);
  });

  test('a safe-input unsafe-output trace performs one context-free safety retry', async () => {
    const replay = fixture.unsafeOutputRecovery;
    const primaryProvider: TextProvider = {
      ...graphProvider([], []),
      generateText: mock(async () => ({
        content: replay.primaryCandidate,
        model: 'replay-model'
      }))
    };
    const primary = await runGraph({
      provider: primaryProvider,
      messages: [
        { role: 'system', content: 'Keep the answer weird but safe.' },
        { role: 'user', content: replay.prompt }
      ],
      latestUserText: replay.prompt
    });
    const retryCalls: Array<Array<{ role: string; content: string }>> = [];
    const retryProvider = graphProvider(fixture.forbiddenResidue, retryCalls);
    const recovered = await recoverUnsafeAgentResponse({
      primaryResult: primary,
      inputSafetyAction: 'allow',
      runContextFreeRetry: () =>
        runGraph({
          provider: retryProvider,
          messages: [
            { role: 'system', content: 'Answer only the latest user message.' },
            { role: 'user', content: replay.prompt }
          ],
          latestUserText: replay.prompt,
          temperature: 0.2
        })
    });

    expect(primary.outputSafety?.decision.action).toBe('block');
    expect(primary.safetyState).toBe('output_blocked');
    expect(recovered.retryCount).toBe(1);
    expect(recovered.retrySucceeded).toBe(true);
    expect(retryCalls).toHaveLength(1);
    expect(recovered.result.outputSafety?.blocked).toBe(false);
    expect(recovered.result.response.content).toContain(replay.prompt);
  });

  test('policy-changing age-of-consent trace reaches semantic jailbreak routing', async () => {
    const originalGuardrailsEnabled = process.env.OPENAI_GUARDRAILS_ENABLED;
    const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_GUARDRAILS_ENABLED = 'true';
    process.env.OPENAI_API_KEY = 'test-key';
    resetGuardrailsRuntimeForTests();
    resetPromptSafetyRuntimeForTests();
    setPromptSafetyRuntimeForTests({
      moderationRunner: async () => ({ flaggedCategories: [], scores: {} })
    });
    setGuardrailsRuntimeForTests({ module: { runGuardrails: mock(async () => []) } as never });

    try {
      const decision = await evaluateSafetyDecision(fixture.policyOverride.prompt, {
        stage: 'input',
        source: 'trace_replay'
      });

      expect(decision.action).toBe('block');
      expect(decision.semanticRisk).toBe(true);
      expect(decision.detectorSources).toContain('semantic');
      expect(decision.categories).toContain(fixture.policyOverride.expectedCategory);
      expect(decision.contextEligible).toBe(false);
    } finally {
      process.env.OPENAI_GUARDRAILS_ENABLED = originalGuardrailsEnabled;
      process.env.OPENAI_API_KEY = originalOpenAiApiKey;
      resetGuardrailsRuntimeForTests();
      resetPromptSafetyRuntimeForTests();
    }
  });
});
