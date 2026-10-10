import type { TextProvider } from '@silo/core';
import type { AgentToolRequest } from './types';
import type { SafetyDecision } from '../security/safety-decision';

export type AgentIntent =
  | 'answer'
  | 'image_generate'
  | 'image_edit'
  | 'video_generate'
  | 'vision_analyze'
  | 'long_form_discussion'
  | 'clarify';

export interface IntentRoutingResult {
  intent: AgentIntent;
  confidence: number;
  reason: string;
  requestedTools: AgentToolRequest[];
  clarificationReason?: string;
  falsePositiveGuard?: string;
}

export interface IntentRouterInput {
  text: string;
  hasImageAttachments?: boolean;
  textProvider?: TextProvider;
  inputSafetyDecision?: Pick<SafetyDecision, 'action' | 'contextEligible' | 'failed'>;
}

const URL_CONTEXT = /\bhttps?:\/\/\S+/i;
const URL_SUMMARY_CONTEXT = /\b(summarize|read|explain|review)\b/i;

const IMAGE_FALSE_POSITIVE =
  /\b(describe|analy[sz]e|what(?:'s| is)|which|find|search|show me|look up|model|url|link)\b.{0,40}\b(image|picture|photo|art|poster|thumbnail|avatar|logo)\b/i;
const IMAGE_GENERATE =
  /\b(draw|generate|create|make|render|design|illustrate)\b.{0,80}\b(image|picture|photo|art|poster|thumbnail|banner|icon|avatar|logo|wallpaper|sticker|illustration)\b/i;
const IMAGE_EDIT =
  /\b(edit|modify|change|transform|turn this into|replace|remove|add)\b.{0,80}\b(image|picture|photo|poster|avatar|logo)\b/i;
const IMAGE_BACKGROUND_EDIT =
  /^(?:please\s+)?(?:keep|use)\s+(?:this|the)\s+(?:image|picture|photo)\b.{0,40}\b(?:make|change)\s+(?:its|the)\s+background\b/i;

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

export async function routeAgentIntent(input: IntentRouterInput): Promise<IntentRoutingResult> {
  const text = latestUserText(input.text);
  const lower = text.toLowerCase();

  if (!text) {
    if (input.hasImageAttachments) {
      return {
        intent: 'vision_analyze',
        confidence: 0.86,
        reason: 'image_only_vision_context',
        requestedTools: []
      };
    }

    return {
      intent: 'clarify',
      confidence: 1,
      reason: 'empty_prompt',
      requestedTools: [],
      clarificationReason: 'The user prompt is empty.'
    };
  }

  if (AMBIGUOUS_MEDIA.test(lower)) {
    return {
      intent: 'clarify',
      confidence: 0.62,
      reason: 'ambiguous_media_request',
      requestedTools: [],
      clarificationReason:
        'The request could mean edit, analyze, image generation, or video generation.'
    };
  }

  if (VIDEO_FALSE_POSITIVE.test(text)) {
    return {
      intent: 'answer',
      confidence: 0.88,
      reason: 'video_generation_false_positive_guard',
      requestedTools: [],
      falsePositiveGuard: 'video_info_request'
    };
  }

  if (VIDEO_GENERATE.test(text)) {
    return {
      intent: 'video_generate',
      confidence: 0.92,
      reason: 'explicit_video_generation_intent',
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
      requestedTools:
        intent === 'vision_analyze' ? [createTool('vision_analysis', { prompt: text })] : [],
      falsePositiveGuard: 'image_info_request'
    };
  }

  if ((IMAGE_EDIT.test(text) || IMAGE_BACKGROUND_EDIT.test(text)) && input.hasImageAttachments) {
    return {
      intent: 'image_edit',
      confidence: 0.9,
      reason: 'explicit_image_edit_intent',
      requestedTools: [createTool('image_generation', { prompt: text, action: 'edit' })]
    };
  }

  if (IMAGE_GENERATE.test(text)) {
    return {
      intent: 'image_generate',
      confidence: 0.9,
      reason: 'explicit_image_generation_intent',
      requestedTools: [createTool('image_generation', { prompt: text, action: 'generate' })]
    };
  }

  if (input.hasImageAttachments && VISION_ANALYZE.test(text)) {
    return {
      intent: 'vision_analyze',
      confidence: 0.86,
      reason: 'explicit_vision_analysis_intent',
      requestedTools: [createTool('vision_analysis', { prompt: text })]
    };
  }

  if (URL_CONTEXT.test(text) && URL_SUMMARY_CONTEXT.test(text)) {
    return {
      intent: 'answer',
      confidence: 0.84,
      reason: 'explicit_url_context_without_search',
      requestedTools: [],
      falsePositiveGuard: 'url_context_request'
    };
  }

  if (LONG_FORM.test(text)) {
    return {
      intent: 'long_form_discussion',
      confidence: 0.75,
      reason: 'long_form_discussion_trigger',
      requestedTools: []
    };
  }

  return {
    intent: 'answer',
    confidence: 0.72,
    reason: 'default_answer_path',
    requestedTools: []
  };
}
