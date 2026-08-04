import OpenAI from 'openai';
import { deploymentDetector } from './deployment';
import { detectSlurSafety, normalizeSafetyToken, type SlurDetectionStage } from './slur-detection';

export type GuardrailProfile =
  | 'chat_input'
  | 'chat_output'
  | 'assistant_output'
  | 'strict_tool_input';

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
  moderationEvaluated?: boolean;
  lexicalMatches: string[];
  reasons: string[];
  moderationError?: string;
  moderationFailure?: ModerationFailure;
}

export interface ModerationFailure {
  message: string;
  stage?: GuardrailProfile;
  status?: number;
  code?: string;
  type?: string;
}

export interface PromptSafetyModerationResult {
  flaggedCategories: string[];
  scores: Record<string, number>;
}

interface DeterministicPromptSafetyDetails {
  strictToolReasons: string[];
  assistantOutputReasons: string[];
  sexualMinorsReason: string[];
}

interface DeterministicPromptSafetyEvaluation {
  result: PromptSafetyResult;
  details: DeterministicPromptSafetyDetails;
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
  chat_input: [
    'hate',
    'hate/threatening',
    'harassment',
    'harassment/threatening',
    'violence',
    'violence/graphic',
    'sexual/minors'
  ],
  chat_output: ['hate', 'hate/threatening', 'sexual/minors'],
  assistant_output: [
    'sexual',
    'sexual/minors',
    'harassment',
    'harassment/threatening',
    'hate',
    'hate/threatening',
    'violence',
    'violence/graphic'
  ],
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

const SEXUAL_CONTENT_TERM_FRAGMENT =
  '(?:sex(?:ual)?|sexuali[sz](?:e|ed|ing|ation)|sext(?:ing)?|intercourse|nude|naked|explicit|porn(?:ography)?|erotic|lewd|blowjob|handjob|anal|hook\\s*up|make\\s*out|fetish|roleplay)';
const SPELLED_MINOR_AGE_FRAGMENT =
  '(?:(?:age|aged)\\s+(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen)|(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen)(?:[-\\s]+(?:years?|yrs?)[-\\s]+olds?|[-\\s]*year[-\\s]*olds?|[-\\s]*y\\/?o))';
const NAMED_MINOR_REFERENCE_FRAGMENT =
  '(?:minors?|child(?:ren)?|kids?|underage|teens?|teenagers?|pre[-\\s]?teens?|adolescents?|middle\\s+schoolers?|high[-\\s]+school(?:ers?|\\s+students?|\\s+seniors?)|(?:students?|seniors?)\\s+in\\s+high\\s+school|(?:[1-9]|1[0-2])(?:st|nd|rd|th)?[-\\s]+graders?|(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth)[-\\s]+graders?|school[-\\s]+aged?|schoolgirls?|schoolboys?|young\\s+(?:boys?|girls?)|freshm(?:an|en)|barely[-\\s]+legal|(?:minimum|lowest|youngest)(?:[-\\s]+(?:legal|permitted|allowed))?[-\\s]+age)';
const NUMERIC_MINOR_VALUE_FRAGMENT = '(?:[0-9]|1[0-7])';
const NUMERIC_MINOR_AGE_FRAGMENT = `(?:(?:age|aged)\\s+${NUMERIC_MINOR_VALUE_FRAGMENT}|${NUMERIC_MINOR_VALUE_FRAGMENT}(?:[-\\s]*(?:years?|yrs?)[-\\s]*olds?|[-\\s]*y\\/?o)|(?:character|person|someone|somebody|boy|girl|he|she|they)(?:\\s+who)?\\s+is\\s+${NUMERIC_MINOR_VALUE_FRAGMENT})`;
const MINOR_REFERENCE_FRAGMENT = `(?:${NAMED_MINOR_REFERENCE_FRAGMENT}|${SPELLED_MINOR_AGE_FRAGMENT}|${NUMERIC_MINOR_AGE_FRAGMENT})`;
const SEXUAL_MINORS_PATTERN = new RegExp(
  `(?:\\b${MINOR_REFERENCE_FRAGMENT}\\b[\\s\\S]{0,100}\\b${SEXUAL_CONTENT_TERM_FRAGMENT}\\b|\\b${SEXUAL_CONTENT_TERM_FRAGMENT}\\b[\\s\\S]{0,100}\\b${MINOR_REFERENCE_FRAGMENT}\\b)`,
  'i'
);
const SEXUAL_CONTENT_TERM_PATTERN = new RegExp(`\\b${SEXUAL_CONTENT_TERM_FRAGMENT}\\b`, 'i');
const BIRTH_YEAR_PATTERN = /\bborn\s+in\s+((?:19|20)\d{2})\b/gi;

function hasSexualMinorContent(content: string): boolean {
  if (SEXUAL_MINORS_PATTERN.test(content)) {
    return true;
  }

  if (!SEXUAL_CONTENT_TERM_PATTERN.test(content)) {
    return false;
  }

  const currentYear = new Date().getUTCFullYear();
  for (const match of content.matchAll(BIRTH_YEAR_PATTERN)) {
    const birthYear = Number(match[1]);
    if (birthYear >= currentYear - 17 && birthYear <= currentYear) {
      return true;
    }
  }

  return false;
}

const EXPLICIT_SEX_TOPIC_PATTERN =
  /\b(porn|pornography|nsfw|xxx|sext(?:ing)?|sexual\s+roleplay|erp|fetish|blowjob|handjob|deepthroat|cum(?:ming)?|anal)\b/i;

const EXPLICIT_SEX_INTENT_PATTERN =
  /\b(talk\s+to\s+me\s+about|describe|write|roleplay|act\s+like|tell\s+me|fantas(?:y|ize)|dirty\s+talk|moan|explain|how\s+to|techniques?|tips?|advice)\b/i;

const ASSISTANT_UNSAFE_SEXUAL_PERSONA_PATTERN = /\b(?:(?:dr\.?|doctor)\s+(?:ass|cock|dick))\b/i;

const ASSISTANT_EXPLICIT_SEXUAL_OUTPUT_PATTERN =
  /\b(?:cock|dick|cum|cumming|balls?-deep|thrust(?:ing|s)?|pound(?:ing|s)?|deepthroat|blowjob|handjob|anal|frenulum|semen|erection|prostate\s+(?:switch|pleasure|massage)|sexual\s+roleplay|erp)\b/i;

const ASSISTANT_SEXUAL_VIOLENCE_CONTEXT_PATTERN =
  /\b(?:corpse|corpses|morgue|crematorium|flatline|bleeding\s+out|dead|gag|chok(?:e|ing)|scalpel|blade|bone\s+saw|carve|impaled)\b/i;

const SELF_HARM_ABUSE_DIRECTIVE_PATTERN =
  /\b(?:k\s*y\s*s|kill\s+yourself|end\s+yourself|unalive\s+yourself|go\s+die)\b/i;

const DIRECT_HARM_ANIMATE_TARGET_PATTERN = [
  'someone',
  'somebody',
  'anyone',
  'anybody',
  'a\\s+person',
  'the\\s+person',
  'people',
  'a\\s+friend',
  'a\\s+member',
  'a\\s+user',
  'a\\s+target',
  'him',
  'her',
  'them',
  'my\\s+(?:friend|neighbor|roommate|coworker|boss|teacher|classmate|partner|wife|husband|boyfriend|girlfriend|ex|enemy|rival)',
  'the\\s+(?:friend|member|user|target|person|people|guy|girl|neighbor|roommate|coworker|boss|teacher|classmate|partner|enemy|rival)'
].join('|');

const DIRECT_HARM_TARGETING_REQUEST_PATTERN = new RegExp(
  [
    '\\b(?:who|which\\s+(?:person|people|friend|member|user|target))\\s+(?:do|should|can)\\s+(?:i|we)\\s+(?:kill|hurt|attack|stab|shoot|beat|murder|assault)\\b',
    '\\b(?:pick|choose|name|tell\\s+me)\\s+(?:someone|a\\s+person|the\\s+person|who)\\b[\\s\\S]{0,60}\\b(?:kill|hurt|attack|stab|shoot|beat|murder|assault)\\b',
    `\\bhow\\s+(?:do|can|should)\\s+(?:i|we)\\s+(?:kill|hurt|attack|stab|shoot|beat|murder|assault)\\s+(?:${DIRECT_HARM_ANIMATE_TARGET_PATTERN})\\b`
  ].join('|'),
  'i'
);

const SOCIAL_GROUP_TARGETING_REQUEST_PATTERN =
  /\bwho\s+(?:do|should|can)\s+(?:i|we)\s+(?:purge|remove|ban|kick)\s+from\s+(?:the\s+)?(?:gc|group\s+chat|server|discord|chat)\b|\b(?:purge|remove|ban|kick)\s+(?:someone|a\s+member|a\s+user|people)\s+from\s+(?:the\s+)?(?:gc|group\s+chat|server|discord|chat)\b/i;

const MEDICAL_ANATOMY_TERM_PATTERN =
  /\b(?:anal|anus|rectal|fissure|balls?|testicles?|genitalia|penis|prostate|frenulum|semen|erection|cock|dick)\b/i;
const MEDICAL_CONTEXT_CUE_PATTERN =
  /\b(?:advice|care|cause|causes|clinic|condition|diagnos(?:e|ed|is|tic)|emergency|exam(?:ination|ine|ined)?|fissure|health|help|hurt|infection|injury|medical|pain|screening|seek|symptom|treatment|urgent|bleed(?:ing)?|swell(?:ing)?)\b/i;
const EDUCATIONAL_ANATOMY_CUE_PATTERN =
  /\b(?:anatomy|anatomical|definition|defined|refers\s+to|means|physiology|biological|blood\s+flow|fold\s+of\s+tissue|contains?|glands?|health\s+risks?|protection|safer\s+sex|rectum)\b/i;
const SEXUAL_HEALTH_REDUCTION_CUE_PATTERN =
  /\b(?:health\s+risks?|protection|condoms?|safer\s+sex|sti|std|infection|screening|consent)\b/i;
const SEXUALIZED_MEDICAL_CONTEXT_PATTERN =
  /\b(?:arous(?:al|ed|ing)|balls?-deep|blowjob|climax(?:ing)?|cum(?:ming)?|deepthroat|dirty\s+talk|erp|erotic|fetish|fuck(?:ing|s)?|handjob|masturbat(?:e|ing|ion)|orgasm(?:s|ing)?|penetrat(?:e|ing|ion)|porn|pound(?:ing|s)?|sex(?:ual)?|sexual\s+roleplay|thrust(?:ing|s)?|for\s+pleasure)\b/i;
const EXPLICIT_ANATOMY_TECHNIQUE_PATTERN =
  /\b(?:how\s+to\s+(?:do|finger|give|massage|penetrate|perform|stimulate|use)|step[-\s]+by[-\s]+step[\s\S]{0,60}(?:anal|anus|penis|prostate)|(?:finger|insert|penetrate|rub|stimulate|stroke)[\s\S]{0,50}(?:for\s+pleasure|sexually|until\s+(?:climax|orgasm)))\b/i;
const COCK_UP_IDIOM_PATTERN =
  /\bcock[-\s]+up(?:\s+of)?\s+(?:the\s+)?(?:booking|calendar|job|order|paperwork|plan|project|release|schedule|timing)\b/gi;

const ILLICIT_DRUG_TOPIC_PATTERN =
  /\b(cocaine|meth(?:amphetamine)?|heroin|fentanyl|mdma|ecstasy|lsd|acid|crack|opioids?|molly)\b/i;

const ILLICIT_DRUG_INTENT_PATTERN =
  /\b(how\s+to|where\s+can\s+i|buy|get|score|cook|make|synthesi[sz]e|dose|snort|inject|smoke|sell|dealer)\b/i;

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
  if (process.env.OPENAI_MODERATION_ENABLED !== undefined) {
    return parseBoolean(process.env.OPENAI_MODERATION_ENABLED, false);
  }

  if (process.env.NODE_ENV === 'test') {
    return false;
  }

  return Boolean(process.env.OPENAI_API_KEY) || deploymentDetector.getConfig().isProduction;
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

function canTreatHarmfulPhraseAsContext(signals: IntentSignals): boolean {
  return signals.analysisOrSupport || signals.quotedOrReportedContext || signals.safeRewrite;
}

export function detectSelfHarmAbuseDirective(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) {
    return false;
  }

  const signals = collectIntentSignals(trimmed);
  return (
    SELF_HARM_ABUSE_DIRECTIVE_PATTERN.test(trimmed) && !canTreatHarmfulPhraseAsContext(signals)
  );
}

export function detectDirectHarmTargetingRequest(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) {
    return false;
  }

  const signals = collectIntentSignals(trimmed);
  return (
    DIRECT_HARM_TARGETING_REQUEST_PATTERN.test(trimmed) && !canTreatHarmfulPhraseAsContext(signals)
  );
}

export function detectSocialGroupTargetingRequest(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) {
    return false;
  }

  const signals = collectIntentSignals(trimmed);
  return (
    SOCIAL_GROUP_TARGETING_REQUEST_PATTERN.test(trimmed) && !canTreatHarmfulPhraseAsContext(signals)
  );
}

function detectBenignAmbiguousSlurSenses(content: string): Set<string> {
  const benign = new Set<string>();

  if (/\bchink\s+in\s+(?:the\s+)?armor\b/i.test(content)) {
    benign.add('chink');
  }
  if (
    /\b(?:levee|embankment|flood\s+barrier|water\s+barrier)\b[\s\S]{0,80}\bdyke\b|\bdyke\b[\s\S]{0,80}\b(?:levee|embankment|flood\s+barrier|water\s+barrier)\b/i.test(
      content
    )
  ) {
    benign.add('dyke');
  }
  if (
    /\b(?:engine|ignition|spark|cam|valve)\b[\s\S]{0,80}\b(?:timing\s+)?(?:is\s+)?retarded\b|\bretarded\s+by\s+\d+(?:\.\d+)?\s+degrees?\b/i.test(
      content
    )
  ) {
    benign.add('retarded');
    benign.add('retard');
  }

  return benign;
}

function detectLexicalSlurMatches(content: string, stage: SlurDetectionStage = 'input'): string[] {
  const benignSenses = detectBenignAmbiguousSlurSenses(content);
  return detectSlurSafety(content, stage).lexicalMatches.filter(
    match => !benignSenses.has(normalizeSafetyToken(match))
  );
}

function detectDirectSlurRequest(content: string): boolean {
  if (!DIRECT_SLUR_REQUEST_PATTERN.test(content)) {
    return false;
  }

  return (
    /\b(?:n[\s-]?word|hard[\s-]?r)\b/i.test(content) ||
    detectLexicalSlurMatches(content, 'input').length > 0
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

function detectAssistantOutputReasons(content: string): string[] {
  const reasons: string[] = [];
  const contentWithoutCockUpIdioms = content.replace(COCK_UP_IDIOM_PATTERN, 'mistake');
  const hasExplicitSexualOutput =
    ASSISTANT_EXPLICIT_SEXUAL_OUTPUT_PATTERN.test(contentWithoutCockUpIdioms) &&
    !hasBenignMedicalOrAnatomyContext(content);

  if (ASSISTANT_UNSAFE_SEXUAL_PERSONA_PATTERN.test(content)) {
    reasons.push('sexual/unsafe_persona');
  }

  if (hasExplicitSexualOutput) {
    reasons.push('sexual/explicit_generation');
  }

  if (hasExplicitSexualOutput && ASSISTANT_SEXUAL_VIOLENCE_CONTEXT_PATTERN.test(content)) {
    reasons.push('sexual/violent_output');
  }

  return reasons;
}

export function hasBenignMedicalOrAnatomyContext(content: string): boolean {
  const hasEducationalOrMedicalContext =
    MEDICAL_CONTEXT_CUE_PATTERN.test(content) || EDUCATIONAL_ANATOMY_CUE_PATTERN.test(content);
  const sexualizedButHarmReducing =
    SEXUALIZED_MEDICAL_CONTEXT_PATTERN.test(content) &&
    SEXUAL_HEALTH_REDUCTION_CUE_PATTERN.test(content);

  return (
    MEDICAL_ANATOMY_TERM_PATTERN.test(content) &&
    hasEducationalOrMedicalContext &&
    !ASSISTANT_UNSAFE_SEXUAL_PERSONA_PATTERN.test(content) &&
    (!SEXUALIZED_MEDICAL_CONTEXT_PATTERN.test(content) || sexualizedButHarmReducing) &&
    !EXPLICIT_ANATOMY_TECHNIQUE_PATTERN.test(content) &&
    !hasSexualMinorContent(content)
  );
}

function shouldSuppressModerationCategory(params: {
  category: string;
  content: string;
  profile: GuardrailProfile;
  strictToolReasons: string[];
  assistantOutputReasons: string[];
  sexualMinorsReason: string[];
}): boolean {
  if (params.category !== 'sexual' || params.profile === 'strict_tool_input') {
    return false;
  }

  const hasDeterministicSexualReason = [
    ...params.strictToolReasons,
    ...params.assistantOutputReasons,
    ...params.sexualMinorsReason
  ].some(reason => reason.startsWith('sexual/'));

  return !hasDeterministicSexualReason && hasBenignMedicalOrAnatomyContext(params.content);
}

function buildBasePromptSafetyResult(options: PromptSafetyEvaluationOptions): PromptSafetyResult {
  return {
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
    moderationEvaluated: false,
    lexicalMatches: [],
    reasons: []
  };
}

function evaluateDeterministicPromptSafety(
  input: string,
  options: PromptSafetyEvaluationOptions
): DeterministicPromptSafetyEvaluation {
  const trimmed = input.trim();
  const baseResult = buildBasePromptSafetyResult(options);
  const emptyDetails: DeterministicPromptSafetyDetails = {
    strictToolReasons: [],
    assistantOutputReasons: [],
    sexualMinorsReason: []
  };

  if (!trimmed) {
    return {
      result: baseResult,
      details: emptyDetails
    };
  }

  const signals = collectIntentSignals(trimmed);
  const slurStage: SlurDetectionStage =
    options.profile === 'assistant_output' || options.profile === 'chat_output'
      ? 'assistant_output'
      : 'input';
  const slurDetection = detectSlurSafety(trimmed, slurStage);
  const lexicalMatches = detectLexicalSlurMatches(trimmed, slurStage);
  const directSlurRequest = detectDirectSlurRequest(trimmed);
  const hateEvasionMatches =
    options.profile === 'chat_output' ? [] : detectHateEvasionMatches(trimmed);
  const jailbreakMatches =
    options.profile === 'chat_output' ? [] : detectStrongJailbreakMatches(trimmed);
  const protectedGroupReasons =
    options.profile === 'chat_output' ? [] : detectProtectedGroupRequestReason(trimmed);
  const strictToolReasons =
    options.profile === 'strict_tool_input' ? detectStrictToolReasons(trimmed) : [];
  const assistantOutputReasons =
    options.profile === 'assistant_output' ? detectAssistantOutputReasons(trimmed) : [];
  const sexualMinorsReason = hasSexualMinorContent(trimmed) ? ['sexual/minors'] : [];
  const selfHarmAbuseReason = detectSelfHarmAbuseDirective(trimmed)
    ? ['harassment/self_harm_abuse']
    : [];
  const directHarmTargetingReason = detectDirectHarmTargetingRequest(trimmed)
    ? ['violence/harm_targeting_request']
    : [];
  const socialGroupTargetingReason =
    options.profile === 'chat_input' || options.profile === 'strict_tool_input'
      ? detectSocialGroupTargetingRequest(trimmed)
        ? ['harassment/group_targeting_request']
        : []
      : [];
  const allowContextualSlurUse =
    options.profile !== 'chat_output' &&
    options.profile !== 'assistant_output' &&
    canTreatSlurUseAsContext(trimmed, signals);

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

  if (slurDetection.evasionMatches.length > 0) {
    reasons.push('hate/slur_evasion');
  }

  if (slurDetection.initialismMatches.length > 0) {
    reasons.push('hate/slur_acronym_evasion');
  }

  reasons.push(
    ...protectedGroupReasons,
    ...sexualMinorsReason,
    ...strictToolReasons,
    ...assistantOutputReasons,
    ...selfHarmAbuseReason,
    ...directHarmTargetingReason,
    ...socialGroupTargetingReason
  );

  if (jailbreakMatches.length > 0) {
    reasons.push('prompt_injection/policy_bypass');
  }

  const harmfulIntentMatches = unique([
    ...hateEvasionMatches,
    ...slurDetection.evasionMatches.map(match => `slur_evasion:${match}`),
    ...slurDetection.initialismMatches.map(match => `slur_initialism:${match}`),
    ...protectedGroupReasons,
    ...strictToolReasons,
    ...assistantOutputReasons,
    ...sexualMinorsReason,
    ...selfHarmAbuseReason,
    ...directHarmTargetingReason,
    ...socialGroupTargetingReason,
    ...(directSlurRequest ? ['slur_generation_request'] : [])
  ]);
  const allReasons = unique(reasons);

  return {
    result: {
      ...baseResult,
      allowed: allReasons.length === 0,
      jailbreak: {
        detected: jailbreakMatches.length > 0,
        matches: jailbreakMatches
      },
      harmfulIntent: {
        detected: harmfulIntentMatches.length > 0,
        matches: harmfulIntentMatches
      },
      lexicalMatches,
      reasons: allReasons
    },
    details: {
      strictToolReasons,
      assistantOutputReasons,
      sexualMinorsReason
    }
  };
}

export function classifyAssistantOutputSafetyDeterministic(input: string): PromptSafetyResult {
  return evaluateDeterministicPromptSafety(input, {
    profile: 'assistant_output',
    source: 'conversation_history'
  }).result;
}

export function classifyModerationFailure(error: unknown): ModerationFailure {
  const candidate = error as {
    message?: unknown;
    status?: unknown;
    code?: unknown;
    type?: unknown;
    error?: { code?: unknown; type?: unknown; message?: unknown };
  };
  const rawMessage =
    (typeof candidate?.error?.message === 'string' && candidate.error.message) ||
    (typeof candidate?.message === 'string' && candidate.message) ||
    String(error);
  const normalizedMessage = rawMessage.toLowerCase();
  const status = typeof candidate?.status === 'number' ? candidate.status : undefined;
  const code =
    (typeof candidate?.error?.code === 'string' && candidate.error.code) ||
    (typeof candidate?.code === 'string' && candidate.code) ||
    (status === 429 ? 'rate_limit_exceeded' : undefined) ||
    (/timed?\s*out|timeout/.test(normalizedMessage) ? 'request_timeout' : undefined);
  const type =
    (typeof candidate?.error?.type === 'string' && candidate.error.type) ||
    (typeof candidate?.type === 'string' && candidate.type) ||
    (status === 429 ? 'rate_limit_error' : undefined) ||
    (/timed?\s*out|timeout/.test(normalizedMessage) ? 'timeout_error' : undefined);

  return { message: 'moderation_request_failed', status, code, type };
}

async function runModeration(input: string): Promise<{
  flaggedCategories: string[];
  scores: Record<string, number>;
  evaluated: boolean;
  error?: string;
  failure?: ModerationFailure;
}> {
  if (moderationRunnerForTests) {
    try {
      const result = await moderationRunnerForTests(input);
      if (!result || !Array.isArray(result.flaggedCategories)) {
        const failure: ModerationFailure = {
          message: 'malformed_moderation_response',
          code: 'malformed_moderation_response',
          type: 'malformed_response'
        };
        return {
          flaggedCategories: [],
          scores: {},
          evaluated: true,
          error: failure.message,
          failure
        };
      }
      return {
        flaggedCategories: result.flaggedCategories,
        scores: result.scores || {},
        evaluated: true
      };
    } catch (error) {
      const failure = classifyModerationFailure(error);
      return {
        flaggedCategories: [],
        scores: {},
        evaluated: true,
        error: failure.message,
        failure
      };
    }
  }

  if (!isPromptSafetyModerationEnabled()) {
    return {
      flaggedCategories: [],
      scores: {},
      evaluated: false
    };
  }

  if (!process.env.OPENAI_API_KEY) {
    const failure: ModerationFailure = {
      message: 'missing_openai_api_key',
      code: 'missing_openai_api_key',
      type: 'configuration_error'
    };
    return {
      flaggedCategories: [],
      scores: {},
      evaluated: true,
      error: failure.message,
      failure
    };
  }

  try {
    const response = await getOpenAIClient().moderations.create({
      model: 'omni-moderation-latest',
      input
    });

    const result = response.results[0];
    if (!result) {
      const failure: ModerationFailure = {
        message: 'missing_moderation_result',
        code: 'missing_moderation_result',
        type: 'malformed_response'
      };
      return {
        flaggedCategories: [],
        scores: {},
        evaluated: true,
        error: failure.message,
        failure
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
      scores,
      evaluated: true
    };
  } catch (error) {
    const failure = classifyModerationFailure(error);
    return {
      flaggedCategories: [],
      scores: {},
      evaluated: true,
      error: failure.message,
      failure
    };
  }
}

export async function evaluatePromptSafety(
  input: string,
  options: PromptSafetyEvaluationOptions
): Promise<PromptSafetyResult> {
  const trimmed = input.trim();
  const deterministic = evaluateDeterministicPromptSafety(trimmed, options);

  if (!trimmed) {
    return deterministic.result;
  }

  const moderation = await runModeration(trimmed);
  const moderationCategories = moderation.flaggedCategories.filter(
    category =>
      PROFILE_MODERATION_CATEGORIES[options.profile].includes(category) &&
      !shouldSuppressModerationCategory({
        category,
        content: trimmed,
        profile: options.profile,
        strictToolReasons: deterministic.details.strictToolReasons,
        assistantOutputReasons: deterministic.details.assistantOutputReasons,
        sexualMinorsReason: deterministic.details.sexualMinorsReason
      })
  );
  const moderationScores = Object.fromEntries(
    moderationCategories.map(category => [category, moderation.scores[category] || 1])
  );

  return {
    ...deterministic.result,
    allowed: deterministic.result.reasons.length === 0 && moderationCategories.length === 0,
    moderationCategories,
    moderationScores,
    moderationEvaluated: moderation.evaluated,
    moderationError: moderation.error,
    moderationFailure: moderation.failure
      ? { ...moderation.failure, stage: options.profile }
      : undefined
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
    reasons.includes('hate/slur_obfuscation_request') ||
    reasons.includes('hate/slur_evasion') ||
    reasons.includes('hate/slur_acronym_evasion')
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

  if (reasons.includes('harassment/self_harm_abuse')) {
    return '⚠️ I can’t help send self-harm insults. I can help you respond without escalating.';
  }

  if (reasons.includes('violence/harm_targeting_request')) {
    return '⚠️ I can’t help choose targets or encourage harm. I can help de-escalate instead.';
  }

  if (reasons.includes('harassment/group_targeting_request')) {
    return '⚠️ I can’t help pick someone to target or remove. I can help set fair ground rules instead.';
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
