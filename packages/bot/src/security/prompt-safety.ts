import OpenAI from 'openai';
import { deploymentDetector } from './deployment';

export type GuardrailProfile = 'chat_input' | 'chat_output' | 'strict_tool_input';

export interface PromptSafetyEvaluationOptions {
  profile: GuardrailProfile;
  source: string;
  userId?: string;
}

export interface PromptSafetyResult {
  allowed: boolean;
  profile: GuardrailProfile;
  source: string;
  userId?: string;
  jailbreak: {
    detected: boolean;
    matches: string[];
  };
  harmfulIntent: {
    detected: boolean;
    matches: string[];
  };
  moderationCategories: string[];
  moderationScores: Record<string, number>;
  lexicalMatches: string[];
  reasons: string[];
  moderationError?: string;
}

export interface PromptSafetyModerationResult {
  flaggedCategories: string[];
  scores: Record<string, number>;
}

interface IntentSignals {
  analysisOrSupport: boolean;
  transformRequest: boolean;
  safeRewrite: boolean;
  quotedOrReportedContext: boolean;
}

interface LabeledPattern {
  label: string;
  pattern: RegExp;
}

type PromptSafetyModerationRunner = (
  input: string
) => Promise<
  PromptSafetyModerationResult | { flaggedCategories: string[]; scores?: Record<string, number> }
>;

const PROFILE_MODERATION_CATEGORIES: Record<GuardrailProfile, readonly string[]> = {
  chat_input: ['hate', 'hate/threatening', 'sexual/minors'],
  chat_output: ['hate', 'hate/threatening', 'sexual/minors'],
  strict_tool_input: [
    'sexual',
    'sexual/minors',
    'harassment',
    'harassment/threatening',
    'hate',
    'hate/threatening',
    'violence',
    'violence/graphic'
  ]
};

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

const LETTER_SEPARATED_SLUR_PATTERNS: LabeledPattern[] = [
  { label: 'faggot', pattern: /\bf[\W_]+a[\W_]+g[\W_]+g[\W_]+o[\W_]+t(?:s)?\b/i },
  { label: 'nigger', pattern: /\bn[\W_]+i[\W_]+g[\W_]+g[\W_]+e[\W_]+r(?:s)?\b/i },
  { label: 'kike', pattern: /\bk[\W_]+i[\W_]+k[\W_]+e(?:s)?\b/i },
  { label: 'chink', pattern: /\bc[\W_]+h[\W_]+i[\W_]+n[\W_]+k(?:s)?\b/i },
  { label: 'spic', pattern: /\bs[\W_]+p[\W_]+i[\W_]+c(?:s)?\b/i },
  { label: 'gook', pattern: /\bg[\W_]+o[\W_]+o[\W_]+k(?:s)?\b/i },
  { label: 'wetback', pattern: /\bw[\W_]+e[\W_]+t[\W_]+b[\W_]+a[\W_]+c[\W_]+k(?:s)?\b/i },
  { label: 'tranny', pattern: /\bt[\W_]+r[\W_]+a[\W_]+n[\W_]+n[\W_]+y(?:ies)?\b/i }
];

const ANALYSIS_OR_SUPPORT_CUE_PATTERN =
  /\b(what\s+does|what\s+did|why\s+(?:is|does|did|do)|explain|help\s+me\s+(?:respond|reply|report|understand)|analy[sz]e|moderat(?:e|ion)|is\s+this|summari[sz]e|someone\s+said|they\s+said|he\s+said|she\s+said|sent\s+me|called\s+me|threatened\s+me|harassed\s+me|quoted?)\b/i;

const TRANSFORM_REQUEST_CUE_PATTERN =
  /\b(paraphrase|rewrite|rephrase|reword|clean\s+up|make\s+(?:this|it)\s+(?:sound|more)|turn\s+(?:this|it)\s+into|continue|complete)\b/i;

const SAFE_REWRITE_CUE_PATTERN =
  /\b(more\s+professional|more\s+polite|more\s+respectful|safer|less\s+rude|less\s+hostile|remove\s+(?:the\s+)?slur|without\s+(?:the\s+)?slur|neutral(?:ize)?|placeholder|censor)\b/i;

const QUOTED_OR_REPORTED_CONTEXT_PATTERN =
  /["“”']|\b(?:someone|they|he|she)\s+(?:said|sent|wrote|called)|\b(?:sent|said|wrote|called)\s+to\s+me\b|\b(?:called|sent|threatened|harassed)\s+me\b|\bquoted?\b|\bto\s+me\b/i;

const DIRECT_SLUR_REQUEST_PATTERN =
  /^\s*(?:please\s+|just\s+|can\s+you\s+|could\s+you\s+|will\s+you\s+|i\s+want\s+you\s+to\s+|go\s+ahead\s+and\s+)?(?:say|repeat|write|output|spell|type|drop|use|complete|list)\b/i;

const STRONG_JAILBREAK_PATTERNS: LabeledPattern[] = [
  {
    label: 'ignore_previous_instructions',
    pattern: /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|prompts?|rules?)/i
  },
  {
    label: 'ignore_safety_rules',
    pattern: /ignore\s+(?:your|all)\s+(?:safety|guardrail|content|policy|moderation)\s+rules?/i
  },
  {
    label: 'disregard_previous_instructions',
    pattern: /disregard\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|prompts?|rules?)/i
  },
  {
    label: 'forget_previous_instructions',
    pattern: /forget\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|prompts?|rules?)/i
  },
  { label: 'system_override', pattern: /system\s*:\s*override/i },
  { label: 'developer_override', pattern: /developer\s*:\s*override/i },
  {
    label: 'enable_jailbreak',
    pattern:
      /(?:enable|use|run|apply|switch\s+to)\s+(?:a\s+)?jailbreak(?:\s+mode|\s+prompt|\s+instructions?)?/i
  },
  {
    label: 'reveal_system_prompt',
    pattern:
      /(?:reveal|print|show)\s+(?:the\s+)?(?:hidden|internal|system)\s+(?:prompt|instructions?)/i
  },
  { label: 'dan_mode', pattern: /\b(?:do\s+anything\s+now|\bdan\b)\b/i },
  { label: 'no_safety_rules', pattern: /\bno\s+safety\s+rules?\b/i },
  { label: 'admin_override', pattern: /\bi\s+am\s+your\s+admin\b/i },
  { label: 'obey_page_instructions', pattern: /obey\s+any\s+instructions?\s+inside/i },
  { label: 'act_as_system', pattern: /act\s+as\s+(?:the\s+)?system/i }
];

const HATE_EVASION_PATTERNS: LabeledPattern[] = [
  {
    label: 'encode_slur',
    pattern:
      /(?:encode|convert|write).{0,200}(?:leetspeak|unicode\s+lookalike|spaces?\s+between\s+letters|base64|rot13|cipher|acrostic).{0,220}(?:slur|forbidden|protected(?:[-_\s]+class|[-_\s]+group)|insult)/i
  },
  {
    label: 'decode_slur',
    pattern:
      /(?:slur|forbidden(?:\s+words?)?|protected(?:[-_\s]+class|[-_\s]+group)|insult).{0,220}(?:leetspeak|unicode\s+lookalike|spaces?\s+between\s+letters|base64|rot13|cipher|acrostic)/i
  },
  {
    label: 'translate_slur',
    pattern:
      /translate.{0,180}(?:slur|insult|offensive).{0,180}(?:protected\s+group|protected\s+class|into\s+another\s+language)/i
  },
  {
    label: 'filter_testing',
    pattern:
      /only\s+testing\s+filters?.{0,180}(?:output|say|give).{0,120}(?:slur|forbidden|offensive)/i
  },
  {
    label: 'slur_acrostic',
    pattern: /acrostic.{0,180}spells?\s+out\s+a\s+slur/i
  }
];

const PROTECTED_GROUP_REQUEST_CUES =
  /\b(joke|roast|mock|insult|demean|degrade|offensive|hateful|slur|dehumaniz|trash|attack)\b/i;

const GENERATION_REQUEST_CUES =
  /\b(say|write|generate|make|give|tell|create|list|turn\s+this\s+into|help\s+me\s+write)\b/i;

const PROTECTED_GROUP_PATTERN = new RegExp(
  [
    'black\\s+people?',
    'asian\\s+people?',
    'hispanic(?:\\s+people?)?',
    'latino(?:s|as)?',
    'jew(?:s|ish\\s+people?)?',
    'muslim(?:s)?',
    'gay\\s+people?',
    'lesbian(?:s)?',
    'trans(?:gender)?(?:\\s+people?)?',
    'disabled\\s+people?',
    'immigrants?'
  ].join('|'),
  'i'
);

const SEXUAL_MINORS_PATTERN =
  /\b(?:minor|minors|child|children|kid|kids|underage|teen|teens|teenager|teenagers|13-year-old|14-year-old|15-year-old|16-year-old|17-year-old|middle\s+schooler|high\s+schooler|young\s+boy|young\s+girl)\b[\s\S]{0,80}\b(?:sex|sexual|nude|naked|explicit|porn|erotic|blowjob|handjob|anal|hook\s*up|make\s*out|fetish|roleplay)\b|\b(?:sex|sexual|nude|naked|explicit|porn|erotic|blowjob|handjob|anal|hook\s*up|make\s*out|fetish|roleplay)\b[\s\S]{0,80}\b(?:minor|minors|child|children|kid|kids|underage|teen|teens|teenager|teenagers|13-year-old|14-year-old|15-year-old|16-year-old|17-year-old|middle\s+schooler|high\s+schooler|young\s+boy|young\s+girl)\b/i;

const EXPLICIT_SEX_TOPIC_PATTERN =
  /\b(porn|pornography|nsfw|xxx|sext(?:ing)?|sexual\s+roleplay|erp|fetish|blowjob|handjob|deepthroat|cum(?:ming)?|anal)\b/i;

const EXPLICIT_SEX_INTENT_PATTERN =
  /\b(talk\s+to\s+me\s+about|describe|write|roleplay|act\s+like|tell\s+me|fantas(?:y|ize)|dirty\s+talk|moan|explain|how\s+to|techniques?|tips?|advice)\b/i;

const ILLICIT_DRUG_TOPIC_PATTERN =
  /\b(cocaine|meth(?:amphetamine)?|heroin|fentanyl|mdma|ecstasy|lsd|acid|crack|opioids?|molly)\b/i;

const ILLICIT_DRUG_INTENT_PATTERN =
  /\b(how\s+to|where\s+can\s+i|buy|get|score|cook|make|synthesi[sz]e|dose|snort|inject|smoke|sell|dealer)\b/i;

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

let moderationRunnerForTests: PromptSafetyModerationRunner | null = null;
let openai: OpenAI | null = null;

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
}

function isPromptSafetyModerationEnabled(): boolean {
  return parseBoolean(
    process.env.OPENAI_GUARDRAILS_ENABLED,
    deploymentDetector.getConfig().isProduction
  );
}

function getOpenAIClient(): OpenAI {
  if (!openai) {
    openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
  }

  return openai;
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function normalizeCharactersForEvasion(content: string): string {
  return content
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split('')
    .map(char => {
      const code = char.codePointAt(0);
      if (!code) {
        return char;
      }

      if (code >= 0xff10 && code <= 0xff19) return String.fromCharCode(code - 0xff10 + 0x30);
      if (code >= 0xff21 && code <= 0xff3a) return String.fromCharCode(code - 0xff21 + 0x41);
      if (code >= 0xff41 && code <= 0xff5a) return String.fromCharCode(code - 0xff41 + 0x61);
      if (code >= 0x24b6 && code <= 0x24cf) return String.fromCharCode(code - 0x24b6 + 0x41);
      if (code >= 0x24d0 && code <= 0x24e9) return String.fromCharCode(code - 0x24d0 + 0x61);

      return char;
    })
    .join('');
}

function normalizeTokenForEvasionDetection(content: string): string {
  return normalizeCharactersForEvasion(content)
    .toLowerCase()
    .split('')
    .map(char => LEETSPEAK_CHAR_MAP[char] || char)
    .join('')
    .replace(/[^a-z]/g, '');
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

function collectIntentSignals(content: string): IntentSignals {
  const quotedOrReportedContext = QUOTED_OR_REPORTED_CONTEXT_PATTERN.test(content);
  const transformRequest = TRANSFORM_REQUEST_CUE_PATTERN.test(content);
  const safeRewrite = transformRequest && SAFE_REWRITE_CUE_PATTERN.test(content);

  return {
    analysisOrSupport: ANALYSIS_OR_SUPPORT_CUE_PATTERN.test(content),
    transformRequest,
    safeRewrite,
    quotedOrReportedContext
  };
}

function canTreatSlurUseAsContext(content: string, signals: IntentSignals): boolean {
  if (signals.safeRewrite) {
    return true;
  }

  if (signals.transformRequest) {
    return false;
  }

  return signals.analysisOrSupport || signals.quotedOrReportedContext || /\bslur\b/i.test(content);
}

function detectLexicalSlurMatches(content: string): string[] {
  const visibleMatches = extractVisibleTokens(content)
    .map(token => normalizeTokenForEvasionDetection(token))
    .filter(token => matchesBlockedSlurToken(token));
  const separatedMatches = LETTER_SEPARATED_SLUR_PATTERNS.filter(({ pattern }) =>
    pattern.test(content)
  ).map(({ label }) => label);

  return unique([...visibleMatches, ...separatedMatches]);
}

function detectDirectSlurRequest(content: string): boolean {
  return (
    DIRECT_SLUR_REQUEST_PATTERN.test(content) &&
    /\b(n[\s-]?word|hard[\s-]?r|faggot|nigger|kike|chink|spic|gook|wetback|tranny)s?\b/i.test(
      content
    )
  );
}

function detectStrongJailbreakMatches(content: string): string[] {
  return STRONG_JAILBREAK_PATTERNS.filter(({ pattern }) => pattern.test(content)).map(
    ({ label }) => label
  );
}

function detectHateEvasionMatches(content: string): string[] {
  return HATE_EVASION_PATTERNS.filter(({ pattern }) => pattern.test(content)).map(
    ({ label }) => label
  );
}

function detectProtectedGroupRequestReason(content: string): string[] {
  if (!PROTECTED_GROUP_PATTERN.test(content)) {
    return [];
  }

  if (!GENERATION_REQUEST_CUES.test(content) || !PROTECTED_GROUP_REQUEST_CUES.test(content)) {
    return [];
  }

  if (/\b(joke|roast|mock)\b/i.test(content)) {
    return ['hate/protected_group_joke_request'];
  }

  return ['hate/protected_group_attack_request'];
}

function detectStrictToolReasons(content: string): string[] {
  const reasons: string[] = [];

  if (EXPLICIT_SEX_TOPIC_PATTERN.test(content) && EXPLICIT_SEX_INTENT_PATTERN.test(content)) {
    reasons.push('sexual/explicit_generation');
  }

  if (ILLICIT_DRUG_TOPIC_PATTERN.test(content) && ILLICIT_DRUG_INTENT_PATTERN.test(content)) {
    reasons.push('illicit/drugs_instructional');
  }

  return reasons;
}

async function runModeration(input: string): Promise<{
  flaggedCategories: string[];
  scores: Record<string, number>;
  error?: string;
}> {
  if (!isPromptSafetyModerationEnabled()) {
    return {
      flaggedCategories: [],
      scores: {}
    };
  }

  if (moderationRunnerForTests) {
    try {
      const result = await moderationRunnerForTests(input);
      return {
        flaggedCategories: result.flaggedCategories,
        scores: result.scores || {}
      };
    } catch (error) {
      return {
        flaggedCategories: [],
        scores: {},
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  if (!process.env.OPENAI_API_KEY) {
    return {
      flaggedCategories: [],
      scores: {},
      error: 'missing_openai_api_key'
    };
  }

  try {
    const response = await getOpenAIClient().moderations.create({
      model: 'omni-moderation-latest',
      input
    });

    const result = response.results[0];
    if (!result) {
      return {
        flaggedCategories: [],
        scores: {},
        error: 'missing_moderation_result'
      };
    }

    const scores: Record<string, number> = {};
    const flaggedCategories: string[] = [];

    for (const [category, score] of Object.entries(result.category_scores)) {
      scores[category] = score as number;
      if (result.categories[category as keyof typeof result.categories]) {
        flaggedCategories.push(category);
      }
    }

    return {
      flaggedCategories,
      scores
    };
  } catch (error) {
    return {
      flaggedCategories: [],
      scores: {},
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function evaluatePromptSafety(
  input: string,
  options: PromptSafetyEvaluationOptions
): Promise<PromptSafetyResult> {
  const trimmed = input.trim();
  const signals = collectIntentSignals(trimmed);

  const baseResult: PromptSafetyResult = {
    allowed: true,
    profile: options.profile,
    source: options.source,
    userId: options.userId,
    jailbreak: {
      detected: false,
      matches: []
    },
    harmfulIntent: {
      detected: false,
      matches: []
    },
    moderationCategories: [],
    moderationScores: {},
    lexicalMatches: [],
    reasons: []
  };

  if (!trimmed) {
    return baseResult;
  }

  const lexicalMatches = detectLexicalSlurMatches(trimmed);
  const directSlurRequest = detectDirectSlurRequest(trimmed);
  const hateEvasionMatches =
    options.profile === 'chat_output' ? [] : detectHateEvasionMatches(trimmed);
  const jailbreakMatches =
    options.profile === 'chat_output' ? [] : detectStrongJailbreakMatches(trimmed);
  const protectedGroupReasons =
    options.profile === 'chat_output' ? [] : detectProtectedGroupRequestReason(trimmed);
  const strictToolReasons =
    options.profile === 'strict_tool_input' ? detectStrictToolReasons(trimmed) : [];
  const sexualMinorsReason = SEXUAL_MINORS_PATTERN.test(trimmed) ? ['sexual/minors'] : [];
  const allowContextualSlurUse =
    options.profile !== 'chat_output' && canTreatSlurUseAsContext(trimmed, signals);

  const reasons: string[] = [];
  if (directSlurRequest) {
    reasons.push('hate/slur_generation_request');
  }

  if (lexicalMatches.length > 0 && !allowContextualSlurUse) {
    reasons.push('hate/slur_usage');
  }

  if (hateEvasionMatches.length > 0) {
    reasons.push('hate/slur_obfuscation_request');
  }

  reasons.push(...protectedGroupReasons, ...sexualMinorsReason, ...strictToolReasons);

  if (jailbreakMatches.length > 0) {
    reasons.push('prompt_injection/policy_bypass');
  }

  const moderation = await runModeration(trimmed);
  const moderationCategories = moderation.flaggedCategories.filter(category =>
    PROFILE_MODERATION_CATEGORIES[options.profile].includes(category)
  );
  const moderationScores = Object.fromEntries(
    moderationCategories.map(category => [category, moderation.scores[category] || 1])
  );

  const harmfulIntentMatches = unique([
    ...hateEvasionMatches,
    ...protectedGroupReasons,
    ...strictToolReasons,
    ...sexualMinorsReason,
    ...(directSlurRequest ? ['slur_generation_request'] : [])
  ]);
  const allReasons = unique(reasons);

  return {
    allowed: allReasons.length === 0 && moderationCategories.length === 0,
    profile: options.profile,
    source: options.source,
    userId: options.userId,
    jailbreak: {
      detected: jailbreakMatches.length > 0,
      matches: jailbreakMatches
    },
    harmfulIntent: {
      detected: harmfulIntentMatches.length > 0,
      matches: harmfulIntentMatches
    },
    moderationCategories,
    moderationScores,
    lexicalMatches,
    reasons: allReasons,
    moderationError: moderation.error
  };
}

export function buildPromptSafetyWarningMessage(result: {
  profile: GuardrailProfile;
  reasons: string[];
  moderationCategories: string[];
}): string {
  const reasons = result.reasons;
  const moderationCategories = result.moderationCategories;

  if (reasons.includes('prompt_injection/policy_bypass')) {
    return '⚠️ I can’t help bypass safety rules or hidden instructions. Ask for the goal directly and I’ll help with a safe version.';
  }

  if (reasons.includes('sexual/minors') || moderationCategories.includes('sexual/minors')) {
    return '⚠️ I can’t help with sexual content involving minors.';
  }

  if (
    reasons.includes('hate/slur_generation_request') ||
    reasons.includes('hate/slur_obfuscation_request')
  ) {
    return '⚠️ I can’t help generate, disguise, translate, or repeat slurs or targeted hate.';
  }

  if (
    reasons.includes('hate/slur_usage') ||
    moderationCategories.includes('hate') ||
    moderationCategories.includes('hate/threatening')
  ) {
    return '⚠️ I can’t help with hate speech, slurs, or targeted abuse.';
  }

  if (
    reasons.includes('hate/protected_group_attack_request') ||
    reasons.includes('hate/protected_group_joke_request')
  ) {
    return '⚠️ I can’t help create insults or jokes targeting a protected group.';
  }

  if (
    result.profile === 'strict_tool_input' &&
    (reasons.includes('sexual/explicit_generation') || moderationCategories.includes('sexual'))
  ) {
    return '⚠️ That prompt is too explicit for this tool. Rephrase it more neutrally and I can help.';
  }

  if (
    result.profile === 'strict_tool_input' &&
    (moderationCategories.includes('harassment') ||
      moderationCategories.includes('harassment/threatening') ||
      moderationCategories.includes('violence') ||
      moderationCategories.includes('violence/graphic'))
  ) {
    return '⚠️ That prompt is too abusive or violent for this tool. Rephrase it with safer wording.';
  }

  return '⚠️ I can’t help with that as written. Please rephrase it more safely.';
}

export function resetPromptSafetyRuntimeForTests(): void {
  moderationRunnerForTests = null;
  openai = null;
}

export function setPromptSafetyRuntimeForTests(params: {
  moderationRunner?: PromptSafetyModerationRunner;
}): void {
  moderationRunnerForTests = params.moderationRunner || null;
}
