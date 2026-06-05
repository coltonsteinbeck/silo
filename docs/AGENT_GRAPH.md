# Bounded Agent Graph

The Discord message graph is a feature-flagged LangGraph path for long-term orchestration work. It is designed to improve tracing, safety placement, and future tool routing without introducing autonomous loops into the user-facing bot.

## Status

- Disabled by default: `AGENT_GRAPH_ENABLED=false`.
- The direct provider path remains the default production path.
- `on`, `active`, and `staging` modes use the graph for Discord message generation. Shadow mode keeps the direct response path while rollout wiring is inspected.
- Slash commands for image and video generation remain supported through their existing command handlers.

## Environment

```bash
AGENT_GRAPH_ENABLED=false
AGENT_GRAPH_MODE=off
AGENT_GRAPH_RECURSION_LIMIT=16
AGENT_GRAPH_MAX_TOOL_ROUNDS=1
AGENT_GRAPH_MAX_TOOL_CALLS=3
AGENT_GRAPH_MAX_WEB_SEARCHES=2
AGENT_GRAPH_MAX_PAGES_FETCHED=3
AGENT_GRAPH_MAX_IMAGE_GENERATIONS=1
AGENT_GRAPH_MAX_VIDEO_GENERATIONS=1
AGENT_SEARCH_ENABLED=false
AGENT_MEDIA_NL_ENABLED=false
AGENT_SEARCH_FALLBACK_PROVIDER=disabled
```

`AGENT_GRAPH_MODE` accepts `off`, `shadow`, `staging`, `on`, or the legacy alias `active`. If `AGENT_GRAPH_ENABLED=true` and mode is omitted, the runtime defaults to `on`; keep mode explicit during staged rollout.

`AGENT_SEARCH_FALLBACK_PROVIDER` accepts `disabled`, `openai`, or `xai`. Use a configured OpenAI or xAI fallback during staging/production so current-information prompts can search consistently even when the selected text provider is Anthropic, Google, or local.

## Graph Shape

Graph v1 is intentionally acyclic:

```text
START
  -> ingress
  -> input_safety
  -> context
  -> intent_routing in the message handler
  -> tool_planning
  -> tool_execution
  -> model_generation / synthesis
  -> output_safety
  -> persistence
  -> END
```

There are no conditional edges back to the model and no ReAct-style retry loop. Runtime invocation sets `recursionLimit` from `AGENT_GRAPH_RECURSION_LIMIT`, defaulting to `16`. `GraphRecursionError` is caught and converted into a bounded failure response.

## State Contract

The graph state carries:

- Provider messages, selected text provider, generation options, and provider capability metadata.
- Limits for recursion, tool rounds, total tool calls, web searches, image generations, and video generations.
- Intent, confidence, reason, question type, question counts, requested tools, allowed tools, called tools, tool results, citations, media result, model response, safety state, graph outcome, and current graph step.
- Langfuse metadata inherited from the message handler.

The message handler still owns Discord-specific concerns: mention routing, quota checks, input moderation, context assembly, persistence, and final reply delivery.

## Provider Support

The graph does not replace provider implementations. It calls the existing `ProviderRegistry` text provider for generation, so configured model strings continue through the same OpenAI, Anthropic, xAI, Google, and local OpenAI-compatible adapters as the direct path.

| Capability       | Graph v2 behavior                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------- |
| Text generation  | Supported through the selected text provider                                                 |
| Vision analysis  | Capability-detected and budgeted; current image summaries still use existing message routing |
| Image generation | Executes explicit natural-language image generation when `AGENT_MEDIA_NL_ENABLED=true`       |
| Video generation | Executes explicit natural-language video generation when `AGENT_MEDIA_NL_ENABLED=true`       |
| Web search       | Executes provider-native OpenAI/xAI search when `AGENT_SEARCH_ENABLED=true`                  |

Unsupported tools produce deterministic `unsupported` results. Budget excess produces deterministic `budget_exceeded` results. Graph v2 does not let the model discover and call arbitrary tools.

When `AGENT_SEARCH_FALLBACK_PROVIDER=openai` or `xai`, web search also retries that provider if the preferred provider exposes search but the upstream search call fails. This keeps a configured model/provider choice from making current-information questions silently degrade into plain chat.

Live sports/current-score queries prefer xAI search when xAI is configured, then fall back through the normal provider order. This avoids low-quality schedule-only results from providers that do not reliably return live sports context.

## Intent Routing

Intent routing is deterministic first and fail-closed for media. Search triggers include latest/current/recent/news, patch notes, release notes, changelog, version/update, scores, schedules, prices, and law/regulation questions. The router marks questions as `conversational`, `searchable`, or `mixed` so a turn like "How are you? Who is winning the NBA finals right now?" can preserve the conversational context while searching only the time-sensitive question.

Multi-question search is bounded. The router can split multiple searchable question clauses and plan up to two web-search requests for one user turn, subject to the graph's global tool budgets. This avoids treating search as a single-keyword path while still preventing autonomous search expansion.

Image/video generation only runs when the user explicitly asks to create, generate, draw, render, edit, or animate media. Informational prompts such as "describe this image", "find a video", "what image model do you use", and "search image results" do not generate media.

## Tool Budgets

Defaults:

- `maxToolRounds=1`
- `maxToolCalls=3`
- `maxWebSearches=2`
- `maxPagesFetched=3`
- `maxImageGenerations=1`
- `maxVideoGenerations=1`

Tool planning is deterministic and input-driven. The model does not choose extra tools after seeing tool results, because the graph has no edge from tool execution back to generation planning.

## Safety

Mass mentions are neutralized in bot-generated output:

- `@everyone` becomes `everyone`
- `@here` becomes `here`

Normal user and role mentions are preserved. Generated Discord replies use `allowedMentions: { repliedUser: false, parse: [] }`. Inactivity scheduler pings keep their intentional user-specific mention allowlist.

The same mass-mention neutralizer is applied to generated command embeds and AI-generated thread names. Output safety runs after model generation and before final reply/persistence. If the sanitizer repairs output, the graph records `safetyState=output_repaired`.

Assistant output also runs through the `assistant_output` guardrail profile. This profile is intentionally stricter than normal chat input: it blocks generated unsafe sexual personas, explicit sexual continuations, sexualized violence, hate, harassment, and other moderated assistant text. User prompts that are passable under the current chat-input policy can still be refused or redirected at output time if the model tries to continue the unsafe content. When assistant output is blocked, the graph replaces it with a safe bounded refusal and records `safetyState=output_blocked`.

## Langfuse Trace Shape

The graph uses `packages/bot/src/telemetry/langfuse-client.ts` as the only tracing interface. Node observations are nested under the existing message trace when Langfuse is enabled and sampled.

Graph metadata fields include:

- `graphName`
- `graphVersion`
- `graphNode`
- `graphStep`
- `graphRecursionLimit`
- `toolBudget`
- `toolsAllowed`
- `toolsCalled`
- `intent`
- `intentConfidence`
- `intentReason`
- `questionType`
- `questionCount`
- `searchableQuestionCount`
- `conversationalQuestionCount`
- `requestedTools`
- `searchProvider`
- `searchQuery`
- `searchResultCount`
- `sourceDomains`
- `mediaProvider`
- `mediaModel`
- `falsePositiveGuard`
- `safetyState`
- `graphOutcome`

Expected node observations:

- `agent.ingress`
- `agent.input-safety`
- `agent.context`
- `agent.tool-planning`
- `agent.tool-execution`
- `agent.model-generation`
- `agent.output-safety`
- `agent.persistence`

To verify tracing, enable Langfuse, send one Discord message through a staging guild with `AGENT_GRAPH_ENABLED=true` and `AGENT_GRAPH_MODE=active`, then confirm the root trace contains the node observations above plus a final `graphOutcome`.

## Health Alert Policy

Routine `/health` checks and Healthchecks.io success heartbeats remain active. Discord health alerts are outage-only:

- No Discord message for routine healthy checks.
- No Discord message for transient unhealthy checks below the configured threshold/grace period.
- One Discord outage alert after sustained unhealthy state.
- One recovery alert only after an outage alert was posted.
- Shutdown alerts are still posted.

## Rollout

1. Deploy mention and health fixes immediately; they are active by default.
2. Keep `AGENT_GRAPH_ENABLED=false` in production until staging validation passes.
3. Enable Langfuse in staging.
4. Enable the graph in one staging guild or deployment with `AGENT_GRAPH_ENABLED=true`, `AGENT_GRAPH_MODE=staging`, and `AGENT_SEARCH_ENABLED=true`.
5. Verify no generated `@everyone` or `@here` pings are active.
6. Verify the graph trace includes node spans, guardrails, generation, tool budgets, and `graphOutcome`.
7. Verify one turn terminates within the configured recursion and tool budgets.
8. Roll forward gradually by deployment, keeping graph limits explicit.

Acceptance criteria:

- Bot-generated text never emits active `@everyone` or `@here`.
- Routine Discord health pings are silent.
- Serious outage, shutdown, and post-outage recovery alerts still post.
- Langfuse shows root message trace plus graph node observations.
- The graph always reaches `END` or the bounded failure fallback within the configured recursion limit.
