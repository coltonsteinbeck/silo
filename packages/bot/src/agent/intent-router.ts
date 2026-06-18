import type { TextProvider } from '@silo/core';
import type { AgentToolRequest } from './types';

export type AgentIntent =
  | 'answer'
  | 'search'
  | 'image_generate'
  | 'image_edit'
  | 'video_generate'
  | 'vision_analyze'
  | 'long_form_discussion'
  | 'clarify';

export type AgentQuestionType = 'conversational' | 'searchable' | 'mixed';

export interface IntentRoutingResult {
  intent: AgentIntent;
  confidence: number;
  reason: string;
  questionType: AgentQuestionType;
  questionCount: number;
  searchableQuestionCount: number;
  conversationalQuestionCount: number;
  requestedTools: AgentToolRequest[];
  clarificationReason?: string;
  falsePositiveGuard?: string;
}

export interface IntentRouterInput {
  text: string;
  hasImageAttachments?: boolean;
  textProvider?: TextProvider;
}

const SEARCH_TRIGGER =
  /\b(latest|newest|current|recent|today|tonight|right now|rn|live|this week|this month|news|patch notes?|release notes?|changelog|version|update|updated|balance patch|hotfix|price|prices|schedule|scores?|standings|finals?|playoffs?|who(?:'s| is) winning|winning|winner|law|regulation)\b/i;

const QUESTION_START =
  /^(who|what|when|where|why|how|is|are|was|were|did|does|do|can|could|will|would|should|has|have|had)\b/i;
const CONVERSATIONAL_QUESTION =
  /\b(how are you|what do you think|do you think|what's up|what is up|can you help|could you help|tell me a joke|are you able|would you rather)\b/i;
const ONLINE_TOPIC_TRIGGER =
  /\b(nba|nfl|mlb|nhl|wnba|ufc|finals?|playoffs?|score|scores|standings|game|match|team|season|stock|stocks|market|crypto|bitcoin|ethereum|mortgage|rates?|weather|forecast|election|president|governor|mayor|court|lawsuit|trial|law|regulation|release|launch|patch|update|version|outage|incident|status|news)\b/i;

const FICTIONAL_CONTEXT =
  /\b(fictional|imaginary|made[- ]up|invent|write\s+(?:me\s+)?(?:a\s+)?fictional)\b/i;
const URL_CONTEXT = /\bhttps?:\/\/\S+/i;
const URL_SUMMARY_CONTEXT = /\b(summarize|read|explain|review)\b/i;

const IMAGE_FALSE_POSITIVE =
  /\b(describe|analy[sz]e|what(?:'s| is)|which|find|search|show me|look up|model|url|link)\b.{0,40}\b(image|picture|photo|art|poster|thumbnail|avatar|logo)\b/i;
const IMAGE_GENERATE =
  /\b(draw|generate|create|make|render|design|illustrate)\b.{0,80}\b(image|picture|photo|art|poster|thumbnail|banner|icon|avatar|logo|wallpaper|sticker|illustration)\b/i;
const IMAGE_EDIT =
  /\b(edit|modify|change|transform|turn this into|replace|remove|add)\b.{0,80}\b(image|picture|photo|poster|avatar|logo)\b/i;

const VIDEO_FALSE_POSITIVE =
  /\b(find|search|show me|summarize|transcribe|review|watch|link|url)\b.{0,50}\b(video|clip|animation)\b/i;
const VIDEO_GENERATE =
  /\b(generate|create|make|render|produce)\b.{0,80}\b(video|clip|animation)\b|\banimate this\b|\bturn this\b.{0,40}\b(video|clip|animation)\b/i;

const VISION_ANALYZE =
  /\b(describe|analy[sz]e|what(?:'s| is)|read|extract text from)\b.{0,60}\b(image|picture|photo|screenshot|attachment)\b/i;
const LONG_FORM =
  /\b(long[- ]form|deep dive|detailed discussion|comprehensive|thorough|essay|walk me through)\b/i;
const AMBIGUOUS_MEDIA =
  /\b(make this better|improve this|do something with this|can you make this)\b/i;

function latestUserText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function createTool(
  name: AgentToolRequest['name'],
  input: Record<string, unknown>
): AgentToolRequest {
  return { name, input };
}

function splitQuestionClauses(text: string): string[] {
  const normalized = latestUserText(text);
  if (!normalized) {
    return [];
  }

  const questionSentences = normalized.match(/[^?]+\?/g) || [];
  const candidates = questionSentences.length > 0 ? questionSentences : [normalized];

  return candidates
    .flatMap(candidate =>
      candidate
        .replace(/\?+$/g, '')
        .split(
          /\s+(?:and|also|plus)\s+(?=(?:who|what|when|where|why|how|is|are|was|were|did|does|do|can|could|will|would|should|has|have|had)\b)/i
        )
    )
    .map(candidate => candidate.replace(/^[,;\s]+|[,;\s?]+$/g, '').trim())
    .filter(Boolean);
}

function isSearchableQuestion(text: string): boolean {
  if (FICTIONAL_CONTEXT.test(text) || (URL_CONTEXT.test(text) && URL_SUMMARY_CONTEXT.test(text))) {
    return false;
  }

  if (SEARCH_TRIGGER.test(text)) {
    return true;
  }

  return QUESTION_START.test(text) && ONLINE_TOPIC_TRIGGER.test(text);
}

function isConversationalQuestion(text: string): boolean {
  return (
    CONVERSATIONAL_QUESTION.test(text) || (!isSearchableQuestion(text) && QUESTION_START.test(text))
  );
}

function classifyQuestions(text: string): {
  questionType: AgentQuestionType;
  questionCount: number;
  searchableQuestions: string[];
  conversationalQuestions: string[];
} {
  const clauses = splitQuestionClauses(text);
  const searchableQuestions = clauses.filter(isSearchableQuestion);
  const conversationalQuestions = clauses.filter(isConversationalQuestion);

  let questionType: AgentQuestionType = 'conversational';
  if (searchableQuestions.length > 0 && conversationalQuestions.length > 0) {
    questionType = 'mixed';
  } else if (searchableQuestions.length > 0) {
    questionType = 'searchable';
  }

  return {
    questionType,
    questionCount: clauses.length || 1,
    searchableQuestions,
    conversationalQuestions
  };
}

function buildQuestionMetadata(
  classification: ReturnType<typeof classifyQuestions>
): Pick<
  IntentRoutingResult,
  'questionType' | 'questionCount' | 'searchableQuestionCount' | 'conversationalQuestionCount'
> {
  return {
    questionType: classification.questionType,
    questionCount: classification.questionCount,
    searchableQuestionCount: classification.searchableQuestions.length,
    conversationalQuestionCount: classification.conversationalQuestions.length
  };
}

function createSearchTools(
  text: string,
  classification = classifyQuestions(text)
): AgentToolRequest[] {
  const queries =
    classification.searchableQuestions.length > 0 && classification.questionCount > 1
      ? classification.searchableQuestions
      : [text];

  return queries
    .slice(0, 2)
    .map(query => createTool('web_search', { query: latestUserText(query), maxResults: 5 }));
}

function toolsForIntent(intent: AgentIntent, text: string): AgentToolRequest[] {
  switch (intent) {
    case 'search':
      return createSearchTools(text);
    case 'image_generate':
      return [createTool('image_generation', { prompt: text, action: 'generate' })];
    case 'image_edit':
      return [createTool('image_generation', { prompt: text, action: 'edit' })];
    case 'video_generate':
      return [createTool('video_generation', { prompt: text })];
    case 'vision_analyze':
      return [createTool('vision_analysis', { prompt: text })];
    default:
      return [];
  }
}

function parseClassifierJson(content: string): Partial<IntentRoutingResult> | null {
  const jsonText = content.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonText) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonText) as {
      intent?: AgentIntent;
      confidence?: number;
      reason?: string;
      clarificationReason?: string;
    };
    if (!parsed.intent) {
      return null;
    }
    return {
      intent: parsed.intent,
      confidence:
        typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0.5,
      reason: parsed.reason || 'model_assisted_ambiguous_intent',
      clarificationReason: parsed.clarificationReason
    };
  } catch {
    return null;
  }
}

async function classifyAmbiguousIntent(
  input: IntentRouterInput
): Promise<IntentRoutingResult | null> {
  if (!input.textProvider) {
    return null;
  }

  const text = latestUserText(input.text);
  const response = await input.textProvider.generateText(
    [
      {
        role: 'system',
        content:
          'Classify the user intent as JSON only. Allowed intents: answer, search, image_generate, image_edit, video_generate, vision_analyze, long_form_discussion, clarify. Do not choose image/video generation unless the user explicitly asks to create, generate, render, edit, or animate media. Prefer clarify when ambiguous.'
      },
      {
        role: 'user',
        content: `Prompt: ${text}\nHas image attachments: ${Boolean(input.hasImageAttachments)}`
      }
    ],
    { maxTokens: 160, temperature: 0 }
  );

  const parsed = parseClassifierJson(response.content);
  if (!parsed?.intent) {
    return null;
  }

  return {
    intent: parsed.intent,
    confidence: parsed.confidence ?? 0.5,
    reason: parsed.reason || 'model_assisted_ambiguous_intent',
    ...buildQuestionMetadata(classifyQuestions(text)),
    requestedTools: toolsForIntent(parsed.intent, text),
    clarificationReason: parsed.clarificationReason,
    falsePositiveGuard: parsed.intent === 'clarify' ? 'ambiguous_media_classifier' : undefined
  };
}

export async function routeAgentIntent(input: IntentRouterInput): Promise<IntentRoutingResult> {
  const text = latestUserText(input.text);
  const lower = text.toLowerCase();
  const questionClassification = classifyQuestions(text);
  const questionMetadata = buildQuestionMetadata(questionClassification);

  if (!text) {
    if (input.hasImageAttachments) {
      return {
        intent: 'vision_analyze',
        confidence: 0.86,
        reason: 'image_only_vision_context',
        questionType: 'conversational',
        questionCount: 0,
        searchableQuestionCount: 0,
        conversationalQuestionCount: 0,
        requestedTools: []
      };
    }

    return {
      intent: 'clarify',
      confidence: 1,
      reason: 'empty_prompt',
      questionType: 'conversational',
      questionCount: 0,
      searchableQuestionCount: 0,
      conversationalQuestionCount: 0,
      requestedTools: [],
      clarificationReason: 'The user prompt is empty.'
    };
  }

  if (AMBIGUOUS_MEDIA.test(lower)) {
    const classified = await classifyAmbiguousIntent(input);
    if (classified && classified.confidence >= 0.72) {
      return classified;
    }

    return {
      intent: 'clarify',
      confidence: 0.62,
      reason: 'ambiguous_media_request',
      ...questionMetadata,
      requestedTools: [],
      clarificationReason:
        'The request could mean edit, analyze, image generation, or video generation.'
    };
  }

  if (VIDEO_FALSE_POSITIVE.test(text)) {
    return {
      intent: SEARCH_TRIGGER.test(text) ? 'search' : 'answer',
      confidence: 0.88,
      reason: 'video_generation_false_positive_guard',
      ...questionMetadata,
      requestedTools: SEARCH_TRIGGER.test(text)
        ? createSearchTools(text, questionClassification)
        : [],
      falsePositiveGuard: 'video_info_request'
    };
  }

  if (VIDEO_GENERATE.test(text)) {
    return {
      intent: 'video_generate',
      confidence: 0.92,
      reason: 'explicit_video_generation_intent',
      ...questionMetadata,
      requestedTools: [createTool('video_generation', { prompt: text })]
    };
  }

  if (IMAGE_FALSE_POSITIVE.test(text)) {
    const intent =
      input.hasImageAttachments || VISION_ANALYZE.test(text) ? 'vision_analyze' : 'answer';
    return {
      intent,
      confidence: 0.88,
      reason: 'image_generation_false_positive_guard',
      ...questionMetadata,
      requestedTools:
        intent === 'vision_analyze' ? [createTool('vision_analysis', { prompt: text })] : [],
      falsePositiveGuard: 'image_info_request'
    };
  }

  if (IMAGE_EDIT.test(text) && input.hasImageAttachments) {
    return {
      intent: 'image_edit',
      confidence: 0.9,
      reason: 'explicit_image_edit_intent',
      ...questionMetadata,
      requestedTools: [createTool('image_generation', { prompt: text, action: 'edit' })]
    };
  }

  if (IMAGE_GENERATE.test(text)) {
    return {
      intent: 'image_generate',
      confidence: 0.9,
      reason: 'explicit_image_generation_intent',
      ...questionMetadata,
      requestedTools: [createTool('image_generation', { prompt: text, action: 'generate' })]
    };
  }

  if (input.hasImageAttachments && VISION_ANALYZE.test(text)) {
    return {
      intent: 'vision_analyze',
      confidence: 0.86,
      reason: 'explicit_vision_analysis_intent',
      ...questionMetadata,
      requestedTools: [createTool('vision_analysis', { prompt: text })]
    };
  }

  if (URL_CONTEXT.test(text) && URL_SUMMARY_CONTEXT.test(text)) {
    return {
      intent: 'answer',
      confidence: 0.84,
      reason: 'explicit_url_context_without_search',
      ...questionMetadata,
      requestedTools: [],
      falsePositiveGuard: 'url_context_request'
    };
  }

  if (questionClassification.searchableQuestions.length > 0) {
    return {
      intent: 'search',
      confidence: 0.9,
      reason:
        questionClassification.questionType === 'mixed'
          ? 'mixed_conversation_with_searchable_questions'
          : 'searchable_or_current_question_trigger',
      ...questionMetadata,
      requestedTools: createSearchTools(text, questionClassification)
    };
  }

  if (LONG_FORM.test(text)) {
    return {
      intent: 'long_form_discussion',
      confidence: 0.75,
      reason: 'long_form_discussion_trigger',
      ...questionMetadata,
      requestedTools: []
    };
  }

  return {
    intent: 'answer',
    confidence: 0.72,
    reason: 'default_answer_path',
    ...questionMetadata,
    requestedTools: []
  };
}
