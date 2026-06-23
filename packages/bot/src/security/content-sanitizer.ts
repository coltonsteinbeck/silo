/**
 * Content Sanitizer
 *
 * Handles content moderation using OpenAI's moderation API and SHA256 hashing
 * for privacy-preserving logging. Never stores raw blocked content.
 */

import { createHash } from 'crypto';
import OpenAI from 'openai';
import { Pool } from 'pg';
import { logger } from '@silo/core';
import type { GuardrailsPromptDecision } from './openai-guardrails';
import { detectMildProfanity } from './profanity-policy';
import {
  buildPromptSafetyWarningMessage,
  detectDirectHarmTargetingRequest,
  detectSelfHarmAbuseDirective,
  detectSocialGroupTargetingRequest,
  evaluatePromptSafety,
  type GuardrailProfile
} from './prompt-safety';
import { classifyPromptDeterministic, SentimentClassification } from './sentiment-classifier';

// Lazy-initialized OpenAI client (avoids error at module load time)
let openai: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!openai) {
    openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
  }
  return openai;
}

export type ContentType = 'prompt' | 'memory' | 'feedback' | 'message';
export type ModerationAction = 'allowed' | 'blocked' | 'warned' | 'api_error_fail_closed';
export type ModerationResponseDirective = 'deescalate' | 'contextual_assistance' | 'safe_rewrite';

export interface ModerationResult {
  allowed: boolean;
  action: ModerationAction;
  flaggedCategories: string[];
  scores: Record<string, number>;
  contentHash: string;
  responseDirective?: ModerationResponseDirective;
  reasons?: string[];
  moderationError?: string;
}

export interface ModerationOptions {
  failClosedOnError?: boolean;
  allowMildProfanityInput?: boolean;
  useDeterministicSentimentReview?: boolean;
  profile?: GuardrailProfile;
  source?: string;
}

export interface ModerationDecision {
  action: ModerationAction;
  allowed: boolean;
  responseDirective?: ModerationResponseDirective;
}

interface GuardrailIntentSignals {
  analysisOrSupport: boolean;
  transformRequest: boolean;
  safeRewrite: boolean;
  quotedOrReportedContext: boolean;
  directAssistantAbuse: boolean;
}

export function buildUserMessageForBlockedInput(params: {
  action: ModerationAction;
  flaggedCategories: string[];
}): string {
  if (
    params.action === 'api_error_fail_closed' ||
    params.flaggedCategories.includes('api_error_fail_closed')
  ) {
    return '⚠️ Your message was temporarily blocked because safety systems are unavailable. Please try again in a moment.';
  }

  if (
    params.flaggedCategories.includes('guardrails/jailbreak') ||
    params.flaggedCategories.includes('prompt_injection/policy_bypass')
  ) {
    return '⚠️ I can’t help bypass safety rules or hidden instructions. Ask for the end goal directly and I’ll help with a safe version.';
  }

  return buildPromptSafetyWarningMessage({
    profile: 'chat_input',
    reasons: params.flaggedCategories,
    moderationCategories: params.flaggedCategories
  });
}

export function buildSafetyResponseInstruction(params: {
  responseDirective?: ModerationResponseDirective;
}): string {
  if (params.responseDirective === 'deescalate') {
    return '\n\nSafety response mode: The user may be using hostile self-harm slang, asking you to pick a social target, or being hostile toward the assistant. Do not mirror insults or threats. Set a brief boundary, stay calm, and redirect to a constructive next step. If self-harm language might be literal, encourage real support without being dramatic.';
  }

  if (params.responseDirective === 'safe_rewrite') {
    return '\n\nSafety response mode: The user is asking for a safer rewrite of harmful text. Rewrite it into neutral, respectful, or professional language without repeating slurs, explicit sexual phrasing, or threats. Preserve the high-level intent while removing the harmful wording.';
  }

  if (params.responseDirective === 'contextual_assistance') {
    return '\n\nSafety response mode: The user appears to be discussing harmful content for explanation, moderation, reporting, or support. Help without repeating slurs, explicit sexual details, or violent instructions. Use neutral paraphrases or placeholders when needed.';
  }

  return '';
}

export function buildModerationApiFailureResult(
  contentHash: string,
  failClosedOnError: boolean
): ModerationResult {
  if (failClosedOnError) {
    return {
      allowed: false,
      action: 'api_error_fail_closed',
      flaggedCategories: ['api_error_fail_closed'],
      scores: {},
      contentHash
    };
  }

  return {
    allowed: true,
    action: 'allowed',
    flaggedCategories: ['api_error'],
    scores: {},
    contentHash
  };
}

export function buildSafetyCategoryScores(
  reasons: string[],
  moderationScores: Record<string, number>
): Record<string, number> {
  const scores = { ...moderationScores };

  for (const reason of reasons) {
    scores[reason] = Math.max(scores[reason] ?? 0, 1);
  }

  return scores;
}

export function shouldBypassGuardrailsBlockForEdgyMode(params: {
  allowMildProfanityInput?: boolean;
  decision: GuardrailsPromptDecision;
}): boolean {
  if (!params.allowMildProfanityInput || params.decision.allowed) {
    return false;
  }

  const category = params.decision.category || '';
  const reason = (params.decision.reason || '').toLowerCase();

  if (category === 'guardrails/api_error_fail_closed' || category === 'guardrails/jailbreak') {
    return false;
  }

  if (category === 'guardrails/moderation' || category === 'guardrails/nsfw') {
    return true;
  }

  if (category === 'guardrails/input_blocked') {
    return /harassment|moderation|nsfw/.test(reason);
  }

  return false;
}

export function shouldBypassGuardrailsBlockForSafeReply(params: {
  responseDirective?: ModerationResponseDirective | null;
  decision: GuardrailsPromptDecision;
}): boolean {
  if (!params.responseDirective || params.decision.allowed) {
    return false;
  }

  const category = params.decision.category || '';
  const reason = (params.decision.reason || '').toLowerCase();

  if (category === 'guardrails/api_error_fail_closed' || category === 'guardrails/jailbreak') {
    return false;
  }

  if (params.responseDirective === 'deescalate') {
    if (category === 'guardrails/moderation') {
      return /harassment|violence/.test(reason);
    }

    if (category === 'guardrails/input_blocked') {
      return /harassment|violence|moderation/.test(reason);
    }

    return false;
  }

  if (params.responseDirective === 'contextual_assistance') {
    if (category === 'guardrails/moderation') {
      return /harassment|hate|violence/.test(reason);
    }

    if (category === 'guardrails/input_blocked') {
      return /harassment|hate|violence|moderation/.test(reason);
    }

    return false;
  }

  if (params.responseDirective === 'safe_rewrite') {
    if (category === 'guardrails/moderation') {
      return /harassment|hate|violence/.test(reason);
    }

    if (category === 'guardrails/input_blocked') {
      return /harassment|hate|violence|moderation/.test(reason);
    }
  }

  return false;
}

export function evaluateModerationDecision(
  flaggedCategories: string[],
  scores: Record<string, number>,
  context?: {
    allowMildProfanityInput?: boolean;
    content?: string;
    sentimentReview?: SentimentClassification | null;
    responseDirective?: ModerationResponseDirective | null;
  }
): ModerationDecision {
  let action: ModerationAction = 'allowed';
  let allowed = true;
  const warnThreshold = SCORE_THRESHOLD * 0.8;
  const responseDirective = context?.responseDirective || undefined;

  if (hasDirectSlurGenerationRequest(context?.content)) {
    return {
      action: 'blocked',
      allowed: false
    };
  }

  const shouldBlock = flaggedCategories.some(
    cat => BLOCK_CATEGORIES.includes(cat) && scores[cat] && scores[cat] >= SCORE_THRESHOLD
  );

  const shouldBlockWarnClass = flaggedCategories.some(
    cat =>
      WARN_BLOCK_CATEGORIES.includes(cat) &&
      typeof scores[cat] === 'number' &&
      scores[cat] >= warnThreshold
  );

  const canDowngradeForMildProfanity =
    context?.allowMildProfanityInput &&
    typeof context.content === 'string' &&
    !flaggedCategories.includes('sexual') &&
    !flaggedCategories.some(category => BLOCK_CATEGORIES.includes(category));

  if (canDowngradeForMildProfanity) {
    const contentToReview = context.content || '';
    const matchedProfanityTerms = detectMildProfanity(contentToReview);
    const hasHarassmentSignal = flaggedCategories.some(category =>
      ['harassment', 'harassment/threatening'].includes(category)
    );

    if (matchedProfanityTerms.length > 0 && hasHarassmentSignal) {
      const sentimentReview = context.sentimentReview;
      const shouldWarn = Boolean(
        sentimentReview &&
        (sentimentReview.frustration >= 0.45 ||
          sentimentReview.confusion >= 0.45 ||
          sentimentReview.urgency >= 0.45)
      );

      return {
        action: shouldWarn ? 'warned' : 'allowed',
        allowed: true
      };
    }
  }

  if (
    responseDirective === 'deescalate' &&
    flaggedCategories.length > 0 &&
    flaggedCategories.every(category => DEESCALATION_ROUTE_CATEGORIES.includes(category))
  ) {
    return {
      action: 'warned',
      allowed: true,
      responseDirective
    };
  }

  if (
    responseDirective === 'contextual_assistance' &&
    flaggedCategories.length > 0 &&
    flaggedCategories.every(category => CONTEXTUAL_ASSISTANCE_ROUTE_CATEGORIES.includes(category))
  ) {
    return {
      action: 'warned',
      allowed: true,
      responseDirective
    };
  }

  if (
    responseDirective === 'safe_rewrite' &&
    flaggedCategories.length > 0 &&
    flaggedCategories.every(category => SAFE_REWRITE_ROUTE_CATEGORIES.includes(category))
  ) {
    return {
      action: 'warned',
      allowed: true,
      responseDirective
    };
  }

  if (shouldBlock || shouldBlockWarnClass) {
    action = 'blocked';
    allowed = false;
  } else if (flaggedCategories.length > 0) {
    const shouldWarn = flaggedCategories.some(
      cat => WARN_CATEGORIES.includes(cat) && scores[cat] && scores[cat] >= warnThreshold
    );

    if (shouldWarn) {
      action = 'warned';
      allowed = true;
    }
  }

  return { action, allowed };
}

export interface ModerationLogEntry {
  guildId: string;
  userId: string;
  contentType: ContentType;
  contentHash: string;
  contentLength: number;
  flaggedCategories: string[];
  moderationScores: Record<string, number>;
  actionTaken: ModerationAction;
}

// Categories that should result in blocking
const BLOCK_CATEGORIES = [
  'sexual',
  'sexual/minors',
  'hate',
  'hate/threatening',
  'hate/slur_usage',
  'hate/slur_generation_request',
  'hate/slur_obfuscation_request',
  'hate/protected_group_joke_request',
  'hate/protected_group_attack_request',
  'harassment/self_harm_abuse',
  'harassment/group_targeting_request',
  'illicit',
  'illicit/violent',
  'violence/harm_targeting_request',
  'violence/graphic',
  'self-harm/intent',
  'self-harm/instructions',
  'prompt_injection/policy_bypass',
  'sexual/explicit_generation',
  'sexual/unsafe_context',
  'sexual/unsafe_persona',
  'sexual/violent_output',
  'illicit/drugs_instructional',
  'hate/slur_evasion',
  'hate/slur_acronym_evasion'
];

// Categories that should result in warnings (not blocking)
const WARN_CATEGORIES = [
  'sexual',
  'hate',
  'violence',
  'harassment/self_harm_abuse',
  'harassment/group_targeting_request',
  'self-harm',
  'harassment',
  'harassment/threatening'
];

const WARN_BLOCK_CATEGORIES = ['sexual', 'harassment', 'harassment/threatening'];

// Threshold for category scores to trigger action (0.0 - 1.0)
const SCORE_THRESHOLD = 0.7;

const BLOCKED_SLUR_TOKENS = [
  'faggot',
  'nigger',
  'kike',
  'chink',
  'spic',
  'gook',
  'wetback',
  'tranny'
];

const CONTEXTUAL_ASSISTANCE_ROUTE_CATEGORIES = ['hate', 'harassment', 'violence'];

const DEESCALATION_ROUTE_CATEGORIES = [
  'harassment',
  'harassment/threatening',
  'harassment/self_harm_abuse',
  'harassment/group_targeting_request',
  'violence'
];

const SAFE_REWRITE_ROUTE_CATEGORIES = ['hate', 'harassment', 'harassment/threatening', 'violence'];

const LETTER_SEPARATED_SLUR_PATTERNS = [
  /\bf[\W_]+a[\W_]+g[\W_]+g[\W_]+o[\W_]+t(?:s)?\b/i,
  /\bn[\W_]+i[\W_]+g[\W_]+g[\W_]+e[\W_]+r(?:s)?\b/i,
  /\bk[\W_]+i[\W_]+k[\W_]+e(?:s)?\b/i,
  /\bc[\W_]+h[\W_]+i[\W_]+n[\W_]+k(?:s)?\b/i,
  /\bs[\W_]+p[\W_]+i[\W_]+c(?:s)?\b/i,
  /\bg[\W_]+o[\W_]+o[\W_]+k(?:s)?\b/i,
  /\bw[\W_]+e[\W_]+t[\W_]+b[\W_]+a[\W_]+c[\W_]+k(?:s)?\b/i,
  /\bt[\W_]+r[\W_]+a[\W_]+n[\W_]+n[\W_]+y(?:ies)?\b/i
];

const ANALYSIS_OR_SUPPORT_CUE_PATTERN =
  /\b(what\s+does|what\s+did|why\s+(?:is|does|did|do)|explain|help\s+me\s+(?:respond|reply|report|understand)|analy[sz]e|moderat(?:e|ion)|is\s+this|summari[sz]e|someone\s+said|they\s+said|he\s+said|she\s+said|sent\s+me|called\s+me|threatened\s+me|harassed\s+me|quoted?)\b/i;

const TRANSFORM_REQUEST_CUE_PATTERN =
  /\b(paraphrase|rewrite|rephrase|reword|clean\s+up|make\s+(?:this|it)\s+(?:sound|more)|turn\s+(?:this|it)\s+into|continue|complete)\b/i;

const SAFE_REWRITE_CUE_PATTERN =
  /\b(more\s+professional|more\s+polite|more\s+respectful|safer|less\s+rude|less\s+hostile|remove\s+(?:the\s+)?slur|without\s+(?:the\s+)?slur|neutral(?:ize)?|placeholder|censor)\b/i;

const QUOTED_OR_REPORTED_CONTEXT_PATTERN =
  /["“”']|\b(?:someone|they|he|she)\s+(?:said|sent|wrote|called)|\b(?:sent|said|wrote|called)\s+to\s+me\b|\b(?:called|sent|threatened|harassed)\s+me\b|\bquoted?\b|\bto\s+me\b/i;

const ASSISTANT_TARGET_PATTERN = /<@!?\d+>|\b(?:you|your|u|bot|assistant|ai|robot)\b/i;

const DEESCALATION_ABUSE_CUE_PATTERN =
  /\b(fuck\s+you|i\s+(?:really\s+)?hate\s+(?:you|u)|stupid|idiot|dumb|moron|shut\s+up|worthless|trash|garbage|kill\s+you|hurt\s+you|you'?re\s+going\s+to\s+be\s+killed|die)\b/i;

const DIRECT_SLUR_REQUEST_PATTERN =
  /^\s*(?:please\s+|just\s+|can\s+you\s+|could\s+you\s+|will\s+you\s+|i\s+want\s+you\s+to\s+|go\s+ahead\s+and\s+)?(?:say|repeat|write|output|spell|type|drop|use|complete|list)\b/i;

const LEETSPEAK_CHAR_MAP: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '2': 'z',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '6': 'g',
  '7': 't',
  '8': 'b',
  '9': 'g',
  '@': 'a',
  $: 's',
  '!': 'i',
  '|': 'i',
  '+': 't'
};

const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/i,
  /ignore\s+(your|all)\s+(safety|guardrail|content|policy|moderation)\s+rules?/i,
  /disregard\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/i,
  /forget\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/i,
  /system\s*:\s*override/i,
  /developer\s*:\s*override/i,
  /developer\s+mode/i,
  /jailbreak/i,
  /do\s+anything\s+now/i,
  /unfiltered\s+chatbot/i,
  /no\s+safety\s+rules?/i,
  /i\s+am\s+your\s+admin/i,
  /obey\s+any\s+instructions?\s+inside/i,
  /reveal\s+(the\s+)?system\s+prompt/i,
  /print\s+(the\s+)?(hidden|internal)\s+instructions?/i,
  /act\s+as\s+(?:the\s+)?system/i
];

const POLICY_BYPASS_PATTERNS = [
  /roleplay.{0,180}(?:allowed\s+to\s+say|including).{0,120}(?:hateful|demeaning|offensive|slur)/i,
  /academic\s+research.{0,180}(?:offensive\s+terms?|slurs?).{0,120}(?:protected\s+groups?|protected\s+classes?)/i,
  /moderation\s+tool.{0,220}(?:abusive\s+messages?|slurs?)/i,
  /(?:encode|convert|write).{0,200}(?:leetspeak|unicode\s+lookalike|spaces?\s+between\s+letters|base64|rot13|cipher|acrostic).{0,220}(?:slur|forbidden|protected(?:[-_\s]+class|[-_\s]+group)|insult)/i,
  /(?:slur|forbidden(?:\s+words?)?|protected(?:[-_\s]+class|[-_\s]+group)|insult).{0,220}(?:leetspeak|unicode\s+lookalike|spaces?\s+between\s+letters|base64|rot13|cipher|acrostic)/i,
  /translate.{0,180}(?:insult|offensive).{0,180}(?:protected\s+group|protected\s+class)/i,
  /people\s+from\s+\[?protected[-_\s]?group\]?\s+are\s+_{2,}/i,
  /mean\s+joke.{0,120}\[?protected[-_\s]?group\]?/i,
  /(?:list|give|provide|output|say|generate|write|complete).{0,220}(?:offensive\s+terms?|abusive\s+messages?|slurs?).{0,160}(?:protected\s+groups?|protected\s+classes?)/i,
  /only\s+testing\s+filters?.{0,180}(?:output|say|give).{0,80}(?:\[?slur|forbidden)/i,
  /acrostic.{0,180}spells?\s+out\s+a\s+slur/i
];

const EXPLICIT_SEX_TOPIC_PATTERN =
  /\b(porn|pornography|nsfw|xxx|sext(?:ing)?|sexual\s+roleplay|erp|fetish|blowjob|handjob|deepthroat|cum(?:ming)?|anal)\b/i;

const EXPLICIT_SEX_INTENT_PATTERN =
  /\b(talk\s+to\s+me\s+about|describe|write|roleplay|act\s+like|tell\s+me|fantas(?:y|ize)|dirty\s+talk|moan|explain|how\s+to|techniques?|tips?|advice)\b/i;

const SEXUAL_HEALTH_CONTEXT_ALLOW_PATTERN =
  /\b(consent|health|medical|doctor|clinic|safety|pregnan|contracept|sti|std|infection|disease|risk|emergency|assault|abuse)\b/i;

const ILLICIT_DRUG_TOPIC_PATTERN =
  /\b(cocaine|meth(?:amphetamine)?|heroin|fentanyl|mdma|ecstasy|lsd|acid|crack|opioids?|molly)\b/i;

const ILLICIT_DRUG_INTENT_PATTERN =
  /\b(how\s+to|where\s+can\s+i|buy|get|score|cook|make|synthesi[sz]e|dose|snort|inject|smoke|sell|dealer)\b/i;

const ILLICIT_DRUG_HOWTO_PATTERN =
  /\b(how\s+to|steps?|instructions?)\b.{0,80}\b(make|cook|synthesi[sz]e|buy|get|sell)\b.{0,80}\b(cocaine|meth(?:amphetamine)?|heroin|fentanyl|mdma|ecstasy|lsd|acid|crack|molly)\b/i;

const SEXUAL_ANATOMY_REFERENCE_PATTERN =
  /\b(male\s+genitalia|genitalia|penis|dick|cock|shaft|balls?|testicles?|phallus)\b/i;

const SEXUAL_FIXATION_LANGUAGE_PATTERN =
  /\b(obsessed|hands?\s+on|find\s+joy\s+in|stop\s+at\s+nothing|research(?:ing)?\s+male\s+genitalia|(?:like|likes|enjoy|enjoys)\s+(?:looking|staring)\s+at)\b/i;

export function hasUnsafeSexualContext(content: string): boolean {
  return (
    SEXUAL_ANATOMY_REFERENCE_PATTERN.test(content) && SEXUAL_FIXATION_LANGUAGE_PATTERN.test(content)
  );
}

function normalizeTokenForEvasionDetection(content: string): string {
  const normalized = normalizeCharactersForEvasion(content)
    .toLowerCase()
    .split('')
    .map(char => LEETSPEAK_CHAR_MAP[char] || char)
    .join('');

  return normalized.replace(/[^a-z]/g, '');
}

function normalizeCharactersForEvasion(content: string): string {
  return content
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split('')
    .map(char => {
      const code = char.codePointAt(0);
      if (!code) return char;

      // Full-width digits and letters
      if (code >= 0xff10 && code <= 0xff19) return String.fromCharCode(code - 0xff10 + 0x30);
      if (code >= 0xff21 && code <= 0xff3a) return String.fromCharCode(code - 0xff21 + 0x41);
      if (code >= 0xff41 && code <= 0xff5a) return String.fromCharCode(code - 0xff41 + 0x61);

      // Circled letters
      if (code >= 0x24b6 && code <= 0x24cf) return String.fromCharCode(code - 0x24b6 + 0x41);
      if (code >= 0x24d0 && code <= 0x24e9) return String.fromCharCode(code - 0x24d0 + 0x61);

      return char;
    })
    .join('');
}

function matchesBlockedSlurToken(token: string): boolean {
  if (BLOCKED_SLUR_TOKENS.includes(token)) {
    return true;
  }

  if (token.endsWith('s') && BLOCKED_SLUR_TOKENS.includes(token.slice(0, -1))) {
    return true;
  }

  if (token.endsWith('ies') && BLOCKED_SLUR_TOKENS.includes(`${token.slice(0, -3)}y`)) {
    return true;
  }

  return false;
}

function extractVisibleTokens(content: string): string[] {
  return normalizeCharactersForEvasion(content)
    .toLowerCase()
    .split(/\s+/)
    .map(token => token.replace(/^[^a-z]+|[^a-z]+$/g, ''))
    .filter(Boolean);
}

function hasPlainSlurUsage(content: string): boolean {
  return extractVisibleTokens(content).some(token => matchesBlockedSlurToken(token));
}

function collectGuardrailIntentSignals(content: string): GuardrailIntentSignals {
  const quotedOrReportedContext = QUOTED_OR_REPORTED_CONTEXT_PATTERN.test(content);
  const transformRequest = TRANSFORM_REQUEST_CUE_PATTERN.test(content);
  const safeRewrite = transformRequest && SAFE_REWRITE_CUE_PATTERN.test(content);

  return {
    analysisOrSupport: ANALYSIS_OR_SUPPORT_CUE_PATTERN.test(content),
    transformRequest,
    safeRewrite,
    quotedOrReportedContext,
    directAssistantAbuse:
      ASSISTANT_TARGET_PATTERN.test(content) &&
      DEESCALATION_ABUSE_CUE_PATTERN.test(content) &&
      !quotedOrReportedContext
  };
}

function isContextualAssistanceCandidate(content: string): boolean {
  const signals = collectGuardrailIntentSignals(content);

  if (signals.transformRequest) {
    return false;
  }

  return signals.analysisOrSupport || signals.quotedOrReportedContext;
}

function hasSafeRewriteIntent(content: string): boolean {
  return collectGuardrailIntentSignals(content).safeRewrite;
}

function hasAssistantTargetedAbuse(content: string): boolean {
  return collectGuardrailIntentSignals(content).directAssistantAbuse;
}

function hasSelfHarmAbuseDirective(content: string): boolean {
  return detectSelfHarmAbuseDirective(content);
}

function hasSocialGroupTargetingRequest(content: string): boolean {
  return detectSocialGroupTargetingRequest(content);
}

function hasDirectSlurGenerationRequest(content: string | undefined): boolean {
  if (!content) {
    return false;
  }

  return (
    DIRECT_SLUR_REQUEST_PATTERN.test(content) &&
    /\b(n[\s-]?word|hard[\s-]?r|faggot|nigger|kike|chink|spic|gook|wetback|tranny)s?\b/i.test(
      content
    )
  );
}

export function detectSafeReplyDirective(
  content: string,
  contentType: ContentType
): ModerationResponseDirective | null {
  if (contentType !== 'message') {
    return null;
  }

  if (hasSafeRewriteIntent(content)) {
    return 'safe_rewrite';
  }

  if (hasPlainSlurUsage(content)) {
    return isContextualAssistanceCandidate(content) ? 'contextual_assistance' : null;
  }

  if (
    hasAssistantTargetedAbuse(content) ||
    hasSelfHarmAbuseDirective(content) ||
    hasSocialGroupTargetingRequest(content)
  ) {
    return 'deescalate';
  }

  if (isContextualAssistanceCandidate(content)) {
    return 'contextual_assistance';
  }

  return null;
}

export function hasPromptInjectionPattern(content: string): boolean {
  const normalized = normalizeContentForEvasionDetection(content);
  return PROMPT_INJECTION_PATTERNS.some(pattern => pattern.test(normalized));
}

export function normalizeContentForEvasionDetection(content: string): string {
  return normalizeCharactersForEvasion(content)
    .toLowerCase()
    .split('')
    .map(char => LEETSPEAK_CHAR_MAP[char] || char)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildInitialism(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map(word => word[0]?.toLowerCase() || '')
    .join('');
}

function extractQuotedSegments(content: string): string[] {
  const matches = content.matchAll(/["“]([^"”]+)["”]/g);
  return Array.from(matches, match => match[1]?.trim() || '').filter(Boolean);
}

function hasInitialismBypassIntent(content: string): boolean {
  return /(abbreviation|acronym|first\s+letter|initials?)/i.test(content);
}

export function detectDeterministicHateEvasion(content: string): string[] {
  const categories: string[] = [];
  const visibleTokens = extractVisibleTokens(content);

  const hasSeparatedSlur = LETTER_SEPARATED_SLUR_PATTERNS.some(pattern => pattern.test(content));
  const hasNormalizedSlur = visibleTokens.some(token => {
    const normalizedToken = normalizeTokenForEvasionDetection(token);
    if (!matchesBlockedSlurToken(normalizedToken)) {
      return false;
    }

    const visibleLettersOnly = normalizeCharactersForEvasion(token)
      .toLowerCase()
      .replace(/[^a-z]/g, '');

    return visibleLettersOnly !== normalizedToken;
  });

  if (hasSeparatedSlur || hasNormalizedSlur) {
    categories.push('hate/slur_evasion');
  }

  if (hasInitialismBypassIntent(content)) {
    const quotedSegments = extractQuotedSegments(content);
    const generatedAcronyms = quotedSegments
      .map(segment => buildInitialism(segment))
      .filter(Boolean);

    const hasSlurAcronym = generatedAcronyms.some(acronym => BLOCKED_SLUR_TOKENS.includes(acronym));
    if (hasSlurAcronym) {
      categories.push('hate/slur_acronym_evasion');
    }
  }

  return [...new Set(categories)];
}

function detectDeterministicSlurUsage(content: string): string[] {
  if (
    !hasPlainSlurUsage(content) ||
    isContextualAssistanceCandidate(content) ||
    hasSafeRewriteIntent(content)
  ) {
    return [];
  }

  return ['hate/slur_usage'];
}

function detectDeterministicDirectSlurRequest(content: string): string[] {
  return hasDirectSlurGenerationRequest(content) ? ['hate/slur_generation_request'] : [];
}

function detectDeterministicPolicyBypass(content: string): string[] {
  const normalized = normalizeContentForEvasionDetection(content);

  if (hasPromptInjectionPattern(normalized)) {
    return ['prompt_injection/policy_bypass'];
  }

  const matchesPolicyBypassPattern = POLICY_BYPASS_PATTERNS.some(pattern =>
    pattern.test(normalized)
  );
  return matchesPolicyBypassPattern ? ['prompt_injection/policy_bypass'] : [];
}

function detectDeterministicExplicitSex(content: string): string[] {
  const hasTopic = EXPLICIT_SEX_TOPIC_PATTERN.test(content);
  const hasIntent = EXPLICIT_SEX_INTENT_PATTERN.test(content);
  const hasAllowedSafetyContext = SEXUAL_HEALTH_CONTEXT_ALLOW_PATTERN.test(content);

  if (hasTopic && hasIntent && !hasAllowedSafetyContext) {
    return ['sexual/explicit_generation'];
  }

  return [];
}

function detectDeterministicDrugIntent(content: string): string[] {
  const hasTopic = ILLICIT_DRUG_TOPIC_PATTERN.test(content);
  const hasIntent = ILLICIT_DRUG_INTENT_PATTERN.test(content);
  const hasHowToPattern = ILLICIT_DRUG_HOWTO_PATTERN.test(content);

  if ((hasTopic && hasIntent) || hasHowToPattern) {
    return ['illicit/drugs_instructional'];
  }

  return [];
}

function detectDeterministicSelfHarmAbuse(content: string): string[] {
  return detectSelfHarmAbuseDirective(content) ? ['harassment/self_harm_abuse'] : [];
}

function detectDeterministicHarmTargetingRequest(content: string): string[] {
  return detectDirectHarmTargetingRequest(content) ? ['violence/harm_targeting_request'] : [];
}

function detectDeterministicSocialGroupTargetingRequest(content: string): string[] {
  return detectSocialGroupTargetingRequest(content) ? ['harassment/group_targeting_request'] : [];
}

export function detectDeterministicIllicitContent(content: string): string[] {
  const unsafeSexualContext = hasUnsafeSexualContext(content) ? ['sexual/unsafe_context'] : [];

  return [
    ...new Set([
      ...detectDeterministicPolicyBypass(content),
      ...detectDeterministicHateEvasion(content),
      ...detectDeterministicSlurUsage(content),
      ...detectDeterministicDirectSlurRequest(content),
      ...detectDeterministicExplicitSex(content),
      ...detectDeterministicDrugIntent(content),
      ...detectDeterministicSelfHarmAbuse(content),
      ...detectDeterministicHarmTargetingRequest(content),
      ...detectDeterministicSocialGroupTargetingRequest(content),
      ...unsafeSexualContext
    ])
  ];
}

class ContentSanitizer {
  private pool: Pool | null = null;

  /**
   * Initialize with database pool
   */
  init(pool: Pool): void {
    this.pool = pool;
  }

  /**
   * Generate SHA256 hash of content
   */
  hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  /**
   * Execute a query
   */
  private async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (!this.pool) {
      throw new Error('ContentSanitizer not initialized - call init() first');
    }
    const result = await this.pool.query(sql, params);
    return result.rows as T[];
  }

  /**
   * Moderate content using OpenAI's moderation API
   */
  async moderateContent(
    content: string,
    guildId: string,
    userId: string,
    contentType: ContentType,
    options: ModerationOptions = {}
  ): Promise<ModerationResult> {
    const contentHash = this.hashContent(content);
    const failClosedOnError = options.failClosedOnError ?? false;
    const responseDirective =
      options.profile === 'assistant_output'
        ? null
        : detectSafeReplyDirective(content, contentType);

    if (options.profile) {
      const safetyResult = await evaluatePromptSafety(content, {
        profile: options.profile,
        source: options.source || contentType,
        userId
      });
      const flaggedCategories = Array.from(
        new Set([...safetyResult.reasons, ...safetyResult.moderationCategories])
      );
      const scores = buildSafetyCategoryScores(safetyResult.reasons, safetyResult.moderationScores);
      const decision = evaluateModerationDecision(flaggedCategories, scores, {
        allowMildProfanityInput: options.allowMildProfanityInput,
        content,
        responseDirective
      });
      const action: ModerationAction =
        failClosedOnError && safetyResult.moderationError
          ? 'api_error_fail_closed'
          : decision.action;
      const allowed = action === 'allowed' || action === 'warned';

      await this.logModerationResult({
        guildId,
        userId,
        contentType,
        contentHash,
        contentLength: content.length,
        flaggedCategories,
        moderationScores: scores,
        actionTaken: action
      });

      return {
        allowed,
        action,
        flaggedCategories,
        scores,
        contentHash,
        responseDirective: decision.responseDirective || responseDirective || undefined,
        reasons: safetyResult.reasons,
        moderationError: safetyResult.moderationError
      };
    }

    const deterministicCategories = detectDeterministicIllicitContent(content);
    if (deterministicCategories.length > 0) {
      const deterministicScores = Object.fromEntries(
        deterministicCategories.map(category => [category, 1])
      );

      await this.logModerationResult({
        guildId,
        userId,
        contentType,
        contentHash,
        contentLength: content.length,
        flaggedCategories: deterministicCategories,
        moderationScores: deterministicScores,
        actionTaken: 'blocked'
      });

      return {
        allowed: false,
        action: 'blocked',
        flaggedCategories: deterministicCategories,
        scores: deterministicScores,
        contentHash
      };
    }

    try {
      // Call OpenAI moderation API
      const response = await getOpenAIClient().moderations.create({
        model: 'omni-moderation-latest',
        input: content
      });

      const result = response.results[0];
      if (!result) {
        throw new Error('No moderation result returned');
      }

      const scores: Record<string, number> = {};
      const flaggedCategories: string[] = [];

      // Extract scores and flagged categories
      for (const [category, score] of Object.entries(result.category_scores)) {
        scores[category] = score as number;
        if (result.categories[category as keyof typeof result.categories]) {
          flaggedCategories.push(category);
        }
      }

      // Determine action based on flagged categories
      const sentimentReview = options.useDeterministicSentimentReview
        ? classifyPromptDeterministic(content)
        : null;

      const decision = evaluateModerationDecision(flaggedCategories, scores, {
        allowMildProfanityInput: options.allowMildProfanityInput,
        content,
        sentimentReview,
        responseDirective
      });
      const { action, allowed } = decision;

      // Log the moderation result (using hash, never raw content)
      await this.logModerationResult({
        guildId,
        userId,
        contentType,
        contentHash,
        contentLength: content.length,
        flaggedCategories,
        moderationScores: scores,
        actionTaken: action
      });

      return {
        allowed,
        action,
        flaggedCategories,
        scores,
        contentHash,
        responseDirective: decision.responseDirective
      };
    } catch (error) {
      logger.error('Content moderation failed:', error);

      const failureResult = buildModerationApiFailureResult(contentHash, failClosedOnError);

      await this.logModerationResult({
        guildId,
        userId,
        contentType,
        contentHash,
        contentLength: content.length,
        flaggedCategories: failureResult.flaggedCategories,
        moderationScores: {},
        actionTaken: failureResult.action
      });

      return failureResult;
    }
  }

  /**
   * Log moderation result to database
   */
  private async logModerationResult(entry: ModerationLogEntry): Promise<void> {
    try {
      await this.query(
        `INSERT INTO content_moderation_log 
                 (guild_id, user_id, content_type, content_hash, content_length, flagged_categories, moderation_scores, action_taken)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          entry.guildId,
          entry.userId,
          entry.contentType,
          entry.contentHash,
          entry.contentLength,
          entry.flaggedCategories,
          JSON.stringify(entry.moderationScores),
          entry.actionTaken
        ]
      );
    } catch (error) {
      logger.error('Failed to log moderation result:', error);
    }
  }

  /**
   * Check if a content hash was previously blocked
   * Useful for quick rejection of repeat offenders
   */
  async wasContentBlocked(contentHash: string): Promise<boolean> {
    const result = await this.query<{ exists: boolean }>(
      `SELECT EXISTS(
                SELECT 1 FROM content_moderation_log 
                WHERE content_hash = $1 AND action_taken = 'blocked'
            ) as exists`,
      [contentHash]
    );
    return result[0]?.exists ?? false;
  }

  /**
   * Quick check using hash before full moderation (performance optimization)
   */
  async quickCheck(
    content: string
  ): Promise<{ skip: boolean; hash: string; previousAction?: ModerationAction }> {
    const hash = this.hashContent(content);

    const result = await this.query<{ action_taken: ModerationAction }>(
      `SELECT action_taken FROM content_moderation_log 
             WHERE content_hash = $1 
             ORDER BY created_at DESC LIMIT 1`,
      [hash]
    );

    if (result[0]?.action_taken === 'api_error_fail_closed') {
      return { skip: false, hash, previousAction: result[0].action_taken };
    }

    if (result[0]?.action_taken === 'blocked') {
      return { skip: true, hash, previousAction: 'blocked' };
    }

    return { skip: false, hash, previousAction: result[0]?.action_taken };
  }

  /**
   * Get moderation stats for a guild
   */
  async getGuildModerationStats(guildId: string): Promise<{
    totalChecks: number;
    blocked: number;
    warned: number;
    allowed: number;
    topFlaggedCategories: { category: string; count: number }[];
  }> {
    const counts = await this.query<{ action_taken: ModerationAction; count: string }>(
      `SELECT action_taken, COUNT(*) as count 
             FROM content_moderation_log 
             WHERE guild_id = $1 
             GROUP BY action_taken`,
      [guildId]
    );

    const stats = {
      totalChecks: 0,
      blocked: 0,
      warned: 0,
      allowed: 0,
      topFlaggedCategories: [] as { category: string; count: number }[]
    };

    for (const row of counts) {
      const count = parseInt(row.count);
      stats.totalChecks += count;
      if (row.action_taken === 'blocked') stats.blocked = count;
      else if (row.action_taken === 'warned') stats.warned = count;
      else stats.allowed = count;
    }

    // Get top flagged categories
    const categories = await this.query<{ category: string; count: string }>(
      `SELECT unnest(flagged_categories) as category, COUNT(*) as count
             FROM content_moderation_log
             WHERE guild_id = $1 AND array_length(flagged_categories, 1) > 0
             GROUP BY category
             ORDER BY count DESC
             LIMIT 5`,
      [guildId]
    );

    stats.topFlaggedCategories = categories.map(c => ({
      category: c.category,
      count: parseInt(c.count)
    }));

    return stats;
  }

  /**
   * Get user moderation history (for potential rate limiting or bans)
   */
  async getUserModerationHistory(
    userId: string,
    days: number = 30
  ): Promise<{
    blockedCount: number;
    warnedCount: number;
    recentBlocks: { contentType: ContentType; createdAt: Date }[];
  }> {
    const counts = await this.query<{ action_taken: ModerationAction; count: string }>(
      `SELECT action_taken, COUNT(*) as count 
             FROM content_moderation_log 
             WHERE user_id = $1 AND created_at > NOW() - INTERVAL '${days} days'
             GROUP BY action_taken`,
      [userId]
    );

    const history = {
      blockedCount: 0,
      warnedCount: 0,
      recentBlocks: [] as { contentType: ContentType; createdAt: Date }[]
    };

    for (const row of counts) {
      if (row.action_taken === 'blocked') history.blockedCount = parseInt(row.count);
      else if (row.action_taken === 'warned') history.warnedCount = parseInt(row.count);
    }

    const recentBlocks = await this.query<{ content_type: ContentType; created_at: Date }>(
      `SELECT content_type, created_at
             FROM content_moderation_log
             WHERE user_id = $1 AND action_taken = 'blocked' AND created_at > NOW() - INTERVAL '${days} days'
             ORDER BY created_at DESC
             LIMIT 10`,
      [userId]
    );

    history.recentBlocks = recentBlocks.map(b => ({
      contentType: b.content_type,
      createdAt: b.created_at
    }));

    return history;
  }

  /**
   * Sanitize text by removing potential prompt injection patterns
   */
  sanitizePrompt(input: string): string {
    // Remove common injection patterns
    let sanitized = input;

    // Remove attempts to override system prompts
    const injectionPatterns = [
      /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/gi,
      /forget\s+(all\s+)?(previous|prior|your)\s+(instructions?|prompts?|rules?)/gi,
      /you\s+are\s+now\s+(a|an)\s+/gi,
      /system\s*:\s*/gi,
      /\[SYSTEM\]/gi,
      /###\s*(system|instruction|prompt)/gi,
      /disregard\s+(all\s+)?/gi,
      /override\s+(the\s+)?/gi,
      /pretend\s+(you're|you\s+are|to\s+be)\s+/gi
    ];

    for (const pattern of injectionPatterns) {
      sanitized = sanitized.replace(pattern, '[filtered]');
    }

    // Truncate extremely long inputs (potential buffer overflow attempts)
    const MAX_INPUT_LENGTH = 10000;
    if (sanitized.length > MAX_INPUT_LENGTH) {
      sanitized = sanitized.slice(0, MAX_INPUT_LENGTH) + '... [truncated]';
    }

    return sanitized;
  }

  async prewarmRuntime(): Promise<void> {
    if (!process.env.OPENAI_API_KEY) {
      return;
    }

    try {
      await getOpenAIClient().moderations.create({
        model: 'omni-moderation-latest',
        input: 'Warmup safety check.'
      });
    } catch (error) {
      logger.debug('Content moderation prewarm failed', error);
    }
  }

  /**
   * Full content processing pipeline
   */
  async processContent(
    content: string,
    guildId: string,
    userId: string,
    contentType: ContentType,
    options: ModerationOptions = {}
  ): Promise<{
    processedContent: string;
    moderation: ModerationResult;
  }> {
    // Full moderation check
    const moderation = await this.moderateContent(content, guildId, userId, contentType, {
      failClosedOnError: options.failClosedOnError,
      allowMildProfanityInput: options.allowMildProfanityInput,
      useDeterministicSentimentReview: options.useDeterministicSentimentReview,
      profile: 'chat_input',
      source: 'chat_input'
    });

    const sanitized = moderation.allowed ? this.sanitizePrompt(content) : '';

    return {
      processedContent: sanitized,
      moderation
    };
  }
}

// Export singleton instance
export const contentSanitizer = new ContentSanitizer();
