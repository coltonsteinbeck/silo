import { toLangfuseUsage } from '../telemetry/langfuse-usage';
import { GuildMember, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { logger, RateLimiter, type WebSearchResponse } from '@silo/core';
import type { ProviderRegistry } from '../providers/registry';
import type { QuotaMiddleware } from '../middleware/quota';
import type { PermissionManager } from '../permissions/manager';
import { createAgentGraphRuntimeConfig } from '../agent/config';
import { moderateCommandPrompt } from '../security/command-prompt-moderation';
import { evaluateSafetyDecision } from '../security/safety-decision';
import { sanitizeAssistantOutput } from '../security/output-sanitizer';
import { withLangfuseSpan, withLangfuseGeneration } from '../telemetry/langfuse-client';

const REFUSAL_PREFIX = /^(?:sorry\b|i(?:'m| am) sorry\b|i (?:cannot|can't|couldn't|am unable)\b)/i;
const RELEASE_NOTES_LIMITATION =
  'Search found overview pages, but no direct release-notes page. Here are the available sources.';

// Only provider-supplied citations qualify an answer for publication.
export function formatSearchAnswer(response: WebSearchResponse, query = ''): string | null {
  let answer = sanitizeAssistantOutput(response.content);
  if (!answer || REFUSAL_PREFIX.test(answer)) return null;
  const urls = new Set<string>();
  for (const citation of response.citations) {
    try {
      const url = new URL(citation.url);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        /%5c/i.test(url.pathname) ||
        url.href.length > 300
      )
        continue;
      urls.add(url.href);
      if (urls.size === 3) break;
    } catch {
      /* Invalid citations cannot support an answer. */
    }
  }
  if (!urls.size) return null;
  if (
    /\brelease[-\s]+notes?\b/i.test(query) &&
    [...urls].every(value => {
      const url = new URL(value);
      for (const key of [...url.searchParams.keys()]) {
        if (/^(?:utm_.+|trk)$/i.test(key)) url.searchParams.delete(key);
      }
      const path = url.pathname.replace(/\/+$/, '');
      return !url.search && !url.hash && (!path || /\/(?:blog|releases|release-notes)$/.test(path));
    })
  ) {
    answer = RELEASE_NOTES_LIMITATION;
  }
  const sources = `\n\nSources:\n${[...urls].join('\n')}`;
  const room = 2000 - sources.length;
  return sanitizeAssistantOutput(
    `${answer.length > room ? answer.slice(0, room - 1) + '…' : answer}${sources}`
  );
}

function isTransient(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const detail = error as Error & { status?: number; refused?: boolean };
  if (detail.refused) return false;
  return (
    detail.status === 408 ||
    detail.status === 429 ||
    (typeof detail.status === 'number' && detail.status >= 500) ||
    ['TimeoutError', 'AbortError', 'APIConnectionError', 'APIConnectionTimeoutError'].includes(
      error.name
    )
  );
}

type SearchOutcome =
  'success' | 'no_evidence' | 'timed_out' | 'cancelled' | 'blocked' | 'unavailable' | 'failed';
const FAILURE_MESSAGES: Record<Exclude<SearchOutcome, 'success'>, string> = {
  no_evidence: 'I couldn’t find a supported answer. Try a more specific search.',
  timed_out: 'Search took too long. Please try again.',
  cancelled: 'Search was interrupted. Please try again shortly.',
  blocked: 'I can’t help with that search. Try a different topic.',
  unavailable: 'Search is temporarily unavailable. Please try again shortly.',
  failed: 'Search couldn’t finish. Please try again.'
};

export class SearchCommand {
  readonly data = new SlashCommandBuilder()
    .setName('search')
    .setDescription('Search the web for a sourced answer')
    .setDMPermission(false)
    .addStringOption(option =>
      option
        .setName('query')
        .setDescription('What to search for')
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(2000)
    );
  private readonly limiter = new RateLimiter(1);

  constructor(
    private registry: ProviderRegistry,
    private quota: QuotaMiddleware,
    private permissions: PermissionManager,
    private shutdownSignal?: AbortSignal
  ) {}

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    let outcome: SearchOutcome = 'unavailable';
    let attempts = 0;
    let deliveryAttempted = false;
    let searchCalls = 0;
    let searchCallsKnown = true;
    let usageKnown = true;
    let sourceLimitDisclosed = false;
    const startedAt = Date.now();
    const signal = AbortSignal.any([
      AbortSignal.timeout(30_000),
      ...(this.shutdownSignal ? [this.shutdownSignal] : [])
    ]);
    let cancellationReply: Promise<unknown> | undefined;
    const onAbort = () => {
      if (deliveryAttempted) return;
      outcome = this.shutdownSignal?.aborted ? 'cancelled' : 'timed_out';
      deliveryAttempted = true;
      cancellationReply = interaction.editReply(FAILURE_MESSAGES[outcome]).catch(() => undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    await withLangfuseSpan(
      { name: 'command.search', metadata: { command: 'search' } },
      async span => {
        try {
          signal.throwIfAborted();
          const runtime = createAgentGraphRuntimeConfig();
          const primary =
            this.registry.getWebSearchProvider('openai') ||
            this.registry.getWebSearchProvider('xai');
          if (!runtime.searchEnabled || !primary) return;
          const query = interaction.options.getString('query', true).trim();
          if (!query || query.length > 2000) {
            deliveryAttempted = true;
            await interaction.editReply('Enter a search query between 1 and 2,000 characters.');
            return;
          }
          if (
            !interaction.guildId ||
            !(interaction.member instanceof GuildMember) ||
            interaction.member.id !== interaction.user.id ||
            interaction.member.guild.id !== interaction.guildId
          )
            return;
          const limits = await this.permissions.getRateLimits(
            interaction.guildId,
            interaction.user.id,
            interaction.member
          );
          signal.throwIfAborted();
          if (
            !this.limiter.check(`${interaction.guildId}:${interaction.user.id}`, limits.search)
              .allowed
          ) {
            deliveryAttempted = true;
            await interaction.editReply('Search limit reached. Please try again in a minute.');
            return;
          }
          const fallback =
            runtime.searchFallbackProvider !== 'disabled'
              ? this.registry.getWebSearchProvider(runtime.searchFallbackProvider)
              : null;
          const providers = [
            primary,
            ...(fallback && fallback.name !== primary.name ? [fallback] : [])
          ];
          let processedQuery = query;
          let actualTokens = 0;
          const execution = await this.quota.executeReserved({
            operationKey: `discord:${interaction.id}:search`,
            guildId: interaction.guildId,
            userId: interaction.user.id,
            member: interaction.member,
            usageType: 'text_tokens',
            requestedAmount: 1200 * providers.length,
            beforeAttempt: async () => {
              signal.throwIfAborted();
              const moderation = await moderateCommandPrompt({
                prompt: query,
                guildId: interaction.guildId,
                userId: interaction.user.id,
                command: 'search',
                phase: 'input',
                signal
              });
              signal.throwIfAborted();
              if (!moderation.allowed) {
                outcome = moderation.failed ? 'unavailable' : 'blocked';
                throw new Error('Search input rejected');
              }
              processedQuery = moderation.processedPrompt;
            },
            execute: async () => {
              const providerSignal = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
              for (const provider of providers) {
                providerSignal.throwIfAborted();
                attempts++;
                try {
                  const response = await withLangfuseGeneration(
                    {
                      name: 'command.search.provider',
                      metadata: { provider: provider.name, attempt: attempts }
                    },
                    async generation => {
                      const result = await provider.searchWeb(processedQuery, {
                        maxResults: 3,
                        signal: AbortSignal.any([providerSignal, AbortSignal.timeout(10_000)])
                      });
                      generation?.update({
                        model: result.model,
                        usageDetails: toLangfuseUsage(result.usage),
                        output: {
                          contentCharacters: result.content.length,
                          citations: result.citations.length
                        },
                        metadata: {
                          provider: provider.name,
                          attempt: attempts,
                          refused: result.refused ?? false,
                          searchCalls: result.searchCalls,
                          usageKnown: result.usage !== undefined
                        }
                      });
                      return result;
                    }
                  );
                  providerSignal.throwIfAborted();
                  const tokens = response.usage?.completionTokens;
                  if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens < 0)
                    usageKnown = false;
                  else actualTokens += tokens;
                  if (response.searchCalls === undefined) searchCallsKnown = false;
                  else searchCalls += response.searchCalls;
                  if (response.refused) {
                    outcome = 'blocked';
                    return null;
                  }
                  const content = formatSearchAnswer(response, processedQuery);
                  sourceLimitDisclosed = Boolean(content?.startsWith(RELEASE_NOTES_LIMITATION));
                  if (content) return content;
                  outcome = 'no_evidence';
                } catch (error) {
                  usageKnown = false;
                  searchCallsKnown = false;
                  if ((error as { refused?: boolean })?.refused) {
                    outcome = 'blocked';
                    return null;
                  }
                  if (signal.aborted || providerSignal.aborted || !isTransient(error)) throw error;
                  outcome =
                    error instanceof Error && /Timeout|Abort/.test(error.name)
                      ? 'timed_out'
                      : 'unavailable';
                }
              }
              return null;
            },
            getActualAmount: () => (usageKnown && actualTokens > 0 ? actualTokens : Number.NaN)
          });
          signal.throwIfAborted();
          if (!execution.allowed) {
            deliveryAttempted = true;
            await interaction.editReply(execution.reason);
            return;
          }
          if (!execution.value) return;
          signal.throwIfAborted();
          const safety = await evaluateSafetyDecision(execution.value, {
            stage: 'assistant_output',
            source: 'command:search',
            guildId: interaction.guildId,
            userId: interaction.user.id,
            failurePolicy: 'fail_closed',
            signal
          });
          signal.throwIfAborted();
          if (safety.failed || safety.action !== 'allow') {
            outcome = safety.failed ? 'unavailable' : 'blocked';
            return;
          }
          // Do not retry an uncertain Discord delivery: it may already be visible.
          deliveryAttempted = true;
          // Complete the deferred reply so the follow-up creates a separate public message.
          await interaction.editReply({ content: execution.value, allowedMentions: { parse: [] } });
          signal.throwIfAborted();
          await interaction.followUp({
            content: execution.value,
            ephemeral: false,
            allowedMentions: { parse: [] }
          });
          outcome = 'success';
          await interaction.deleteReply().catch(() => undefined);
        } catch (error) {
          if (signal.aborted) outcome = this.shutdownSignal?.aborted ? 'cancelled' : 'timed_out';
          else if (error instanceof Error && /Timeout|Abort/.test(error.name))
            outcome = 'timed_out';
          else if (outcome !== 'blocked' && outcome !== 'unavailable') outcome = 'failed';
          logger.warn('Search command ended without a verified delivery', {
            outcome,
            attempts,
            errorType: error instanceof Error ? error.name : typeof error
          });
        } finally {
          signal.removeEventListener('abort', onAbort);
          await cancellationReply;
          if (!deliveryAttempted) {
            await interaction
              .editReply(FAILURE_MESSAGES[outcome === 'success' ? 'failed' : outcome])
              .catch(() => undefined);
          }
          span?.update({
            metadata: {
              outcome,
              attempts,
              searchCalls,
              searchCallsKnown,
              usageKnown,
              sourceLimitDisclosed,
              elapsedMs: Date.now() - startedAt
            }
          });
        }
      }
    );
  }
}
