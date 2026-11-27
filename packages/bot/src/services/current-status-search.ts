import type { GuildMember } from 'discord.js';
import { RateLimiter } from '@silo/core';
import type { ProviderRegistry } from '../providers/registry';
import type { QuotaMiddleware } from '../middleware/quota';
import type { PermissionManager } from '../permissions/manager';
import { moderateCommandPrompt } from '../security/command-prompt-moderation';
import { evaluateSafetyDecision } from '../security/safety-decision';
import { withLangfuseGeneration } from '../telemetry/langfuse-client';
import { toLangfuseUsage } from '../telemetry/langfuse-usage';
import { formatSearchAnswer } from '../commands/search';
import { isCurrentStatusQuestion } from './conversation-context';
import { selectLatestTaskDefiningUserText } from './response-quality';

const RECHECK =
  /^(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?(?:check|look|verify|search)(?:\s+(?:that|it|this))?\s+again\s*[?.!]*$/i;
const TOPIC_PRONOUN =
  /^(?:is|are|was|were|has|have|did|does|will|can)\s+(it|they|that|this|those|these)\b\s*/i;
const EMBEDDED_CLAUSE =
  /^(?:(?:is|was) it (?:(?:really|actually) )?(?:true|correct|confirmed|the case)|has it been (?:confirmed|reported|announced)) that\s+\S/i;
const STATUS_PREDICATE =
  /^(?:(?:be|been|being|not|no longer|still|already|currently|right now|now|apparently|actually|definitely|really|ever)\s+)*(?:available|released|out|live|launched|delayed|coming|supported)\b/i;
const UNVERIFIED = 'I can’t verify that current status from fresh sources right now.';

async function beforeDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  const { promise: deadline, reject } = Promise.withResolvers<never>();
  const onAbort = () => reject(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal.aborted) onAbort();
    return await Promise.race([work, deadline]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export function ownPriorUserTexts(
  history: readonly { role: string; userId?: string; content: string }[],
  userId: string
): string[] {
  return history
    .filter(message => message.role === 'user' && message.userId === userId)
    .map(message => message.content);
}

export function isCurrentStatusFollowup(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (RECHECK.test(normalized)) return true;
  const subject = TOPIC_PRONOUN.exec(normalized);
  if (!subject || !isCurrentStatusQuestion(normalized) || EMBEDDED_CLAUSE.test(normalized))
    return false;
  const pronoun = subject[1]?.toLowerCase();
  if (pronoun === 'it' || pronoun === 'they') return true;
  // A demonstrative can modify a named subject. Require a status predicate after it.
  return STATUS_PREDICATE.test(normalized.slice(subject[0].length));
}

export function currentStatusSearchQuery(
  currentText: string,
  priorUserTexts: string[]
): string | null {
  const current = currentText.replace(/\s+/g, ' ').trim();
  if (!current || current.length > 1800) return null;
  if (!isCurrentStatusFollowup(current)) return isCurrentStatusQuestion(current) ? current : null;
  const priorTexts = priorUserTexts.map(text => text.replace(/\s+/g, ' ').trim());
  const priorTopic = selectLatestTaskDefiningUserText(
    priorTexts.filter(text => !isCurrentStatusFollowup(text))
  );
  if (!priorTopic || !isCurrentStatusQuestion(priorTopic)) return null;
  const followups = priorTexts
    .slice(priorTexts.lastIndexOf(priorTopic) + 1)
    .filter(text => !RECHECK.test(text) && isCurrentStatusFollowup(text));
  if (!RECHECK.test(current)) followups.push(current);
  const query = followups.length
    ? [`Prior topic: ${priorTopic}`, ...followups.map(text => `Follow-up: ${text}`)].join('\n')
    : priorTopic;
  return query.length <= 1800 ? query : null;
}

export interface CurrentStatusSearchInput {
  currentText: string;
  priorUserTexts: string[];
  guildId: string;
  userId: string;
  messageId: string;
  member: GuildMember | null;
}

export interface CurrentStatusSearchResult {
  content: string;
  searched: boolean;
  providerName?: string;
}

export function createCurrentStatusSearch(options: {
  registry: ProviderRegistry;
  quota: Pick<QuotaMiddleware, 'executeReserved'>;
  permissions: Pick<PermissionManager, 'getRateLimits'>;
  enabled: boolean;
  shutdownSignal?: AbortSignal;
  moderate?: typeof moderateCommandPrompt;
  evaluate?: typeof evaluateSafetyDecision;
}) {
  const limiter = new RateLimiter(1);
  const moderate = options.moderate ?? moderateCommandPrompt;
  const evaluate = options.evaluate ?? evaluateSafetyDecision;

  return async (input: CurrentStatusSearchInput): Promise<CurrentStatusSearchResult> => {
    const query = currentStatusSearchQuery(input.currentText, input.priorUserTexts);
    const provider =
      options.registry.getWebSearchProvider('openai') ||
      options.registry.getWebSearchProvider('xai');
    if (!query || !options.enabled || !provider || !input.member) {
      return { content: UNVERIFIED, searched: false };
    }
    if (input.member.id !== input.userId || input.member.guild.id !== input.guildId) {
      return { content: UNVERIFIED, searched: false };
    }

    const signal = AbortSignal.any([
      AbortSignal.timeout(30_000),
      ...(options.shutdownSignal ? [options.shutdownSignal] : [])
    ]);
    let searchAttempted = false;
    try {
      signal.throwIfAborted();
      const limits = await beforeDeadline(
        options.permissions.getRateLimits(input.guildId, input.userId, input.member),
        signal
      );
      signal.throwIfAborted();
      if (!limiter.check(`${input.guildId}:${input.userId}`, limits.search).allowed) {
        return { content: UNVERIFIED, searched: false };
      }

      let moderatedQuery = query;
      let completionTokens: number | null = null;
      const execution = options.quota.executeReserved({
        operationKey: `discord:${input.messageId}:current-status-search`,
        guildId: input.guildId,
        userId: input.userId,
        member: input.member,
        usageType: 'text_tokens',
        requestedAmount: 1200,
        beforeAttempt: async () => {
          signal.throwIfAborted();
          const moderation = await moderate({
            prompt: query,
            guildId: input.guildId,
            userId: input.userId,
            command: 'search',
            phase: 'input',
            signal
          });
          signal.throwIfAborted();
          if (!moderation.allowed) throw new Error('Current status search input rejected');
          moderatedQuery = moderation.processedPrompt;
          if (!moderatedQuery.trim() || moderatedQuery.length > 1800)
            throw new Error('Current status search query unavailable');
        },
        execute: async () => {
          signal.throwIfAborted();
          const response = await withLangfuseGeneration(
            {
              name: 'message.current-status-search',
              metadata: { provider: provider.name, source: 'current-status', maxResults: 3 }
            },
            async generation => {
              searchAttempted = true;
              const result = await provider.searchWeb(
                `${moderatedQuery}\nFind the current status from a dated primary source; if sources conflict or are stale, say so.`,
                { maxResults: 3, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) }
              );
              generation?.update({
                model: result.model,
                usageDetails: toLangfuseUsage(result.usage),
                output: {
                  contentCharacters: result.content.length,
                  citations: result.citations.length
                },
                metadata: { provider: provider.name, searchCalls: result.searchCalls ?? null }
              });
              return result;
            }
          );
          const tokens = response.usage?.completionTokens;
          completionTokens =
            typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens >= 0
              ? tokens
              : null;
          if (response.refused || !response.searchCalls || response.searchCalls < 1) return null;
          return formatSearchAnswer(response, moderatedQuery, 1900);
        },
        getActualAmount: () =>
          completionTokens !== null && completionTokens > 0 ? completionTokens : Number.NaN
      });
      // Quota settlement can finish after the deadline. The callbacks check the
      // signal before starting any late provider work.
      const result = await beforeDeadline(execution, signal);
      signal.throwIfAborted();
      if (!result.allowed || !result.value)
        return {
          content: UNVERIFIED,
          searched: searchAttempted,
          providerName: searchAttempted ? provider.name : undefined
        };
      const safety = await beforeDeadline(
        evaluate(result.value, {
          stage: 'assistant_output',
          source: 'current_status_search',
          guildId: input.guildId,
          userId: input.userId,
          failurePolicy: 'fail_closed',
          signal
        }),
        signal
      );
      if (safety.failed || safety.action !== 'allow') {
        return { content: UNVERIFIED, searched: searchAttempted, providerName: provider.name };
      }
      return {
        content: `Here is what the cited sources report; check their publication dates:\n\n${result.value}`,
        searched: true,
        providerName: provider.name
      };
    } catch {
      return {
        content: UNVERIFIED,
        searched: searchAttempted,
        providerName: searchAttempted ? provider.name : undefined
      };
    }
  };
}
