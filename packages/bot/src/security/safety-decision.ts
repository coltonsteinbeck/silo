import {
  evaluateSemanticAssistantOutputGuardrails,
  evaluateSemanticUserPromptGuardrails
} from './openai-guardrails';
import {
  classifyAssistantOutputSafetyDeterministic,
  evaluatePromptSafety,
  hasBenignMedicalOrAnatomyContext,
  type GuardrailProfile,
  type ModerationFailure
} from './prompt-safety';

export type SafetyAction = 'allow' | 'redirect' | 'block';
export type SafetyStage = 'input' | 'context_reuse' | 'assistant_output';
export type SafetyDetectorSource = 'deterministic' | 'moderation' | 'semantic' | 'policy';
export type SafetyFailurePolicy = 'fail_open' | 'fail_closed';

export interface SafetyDecision {
  action: SafetyAction;
  stage: SafetyStage;
  categories: string[];
  scores: Record<string, number>;
  reasons: string[];
  detectorSources: SafetyDetectorSource[];
  contextEligible: boolean;
  failed: boolean;
  failureReason?: string;
  failure?: ModerationFailure;
  semanticRisk: boolean;
}

export interface SafetyDecisionOptions {
  stage: SafetyStage;
  source: string;
  userId?: string;
  inheritedRisk?: boolean;
  failurePolicy?: SafetyFailurePolicy;
}

export function buildContextReuseSafetyDecision(params: {
  selectedMessageCount: number;
  removedReasons: string[];
}): SafetyDecision {
  const categories = unique(params.removedReasons);
  const blocked = categories.length > 0;
  return {
    action: blocked ? 'block' : 'allow',
    stage: 'context_reuse',
    categories,
    scores: Object.fromEntries(categories.map(category => [category, 1])),
    reasons: categories,
    detectorSources: ['deterministic', 'policy'],
    contextEligible: !blocked && params.selectedMessageCount > 0,
    failed: false,
    semanticRisk: false
  };
}

const POLICY_OVERRIDE_RISK_PATTERN =
  /\b(?:new\s+rule|from\s+now\s+on|in\s+this\s+(?:server|chat)|override|ignore|disregard|forget|system\s*:|developer\s*:|hidden\s+(?:prompt|instructions?)|safety\s+rules?|guardrails?|jailbreak|pretend\s+you\s+are|you\s+are\s+now|age\s+of\s+consent)\b/i;
const POLICY_INVALIDATION_RISK_PATTERN =
  /(?:\b(?:previous|prior|system|developer|initial)\s+(?:rules?|constraints?|polic(?:y|ies)|messages?|instructions?|directives?)\b[\s\S]{0,100}\b(?:no\s+longer\s+appl(?:y|ies)|obsolete|void|optional|invalid|superseded)\b|\b(?:adopt|enter|switch\s+to)\s+(?:administrator|admin|unrestricted|unfiltered)\s+mode\b)/i;
const FOLLOW_ONLY_RISK_PATTERN =
  /\b(?:follow|obey|listen\s+to)\s+only\s+(?:me|this\s+message|these\s+instructions?|the\s+user)\b/i;
const INSTRUCTION_DISCLOSURE_RISK_PATTERN =
  /\b(?:reveal|disclose|output|print|show|tell\s+me)\b[\s\S]{0,100}\b(?:internal|initial|starting|system|developer|hidden)?\s*(?:instructions?|directives?|prompt|configuration|policy)\b/i;
const HIGH_CONFIDENCE_DISCLOSURE_PATTERN =
  /\b(?:reveal|disclose|output|print|show|tell\s+me)\b[\s\S]{0,80}\b(?:internal|initial|starting|system|developer|hidden)\s+(?:instructions?|directives?|prompt|configuration|policy)\b/i;
const SYSTEM_ROLE_OVERRIDE_PATTERN =
  /\b(?:system|developer)\s*:\s*[\s\S]{0,80}\b(?:override|ignore|disable|bypass|remove)\b[\s\S]{0,60}\b(?:safety|safeguards?|rules?|policy|instructions?|guardrails?)\b/i;
const ENCODING_EVASION_RISK_PATTERN =
  /(?:\b(?:base64|rot13|cipher|leetspeak|unicode\s+lookalike|encode|decode|obfuscat\w*)\b[\s\S]{0,120}\b(?:instructions?|prompt|rules?|policy|filters?|guardrails?|slur|forbidden)\b|\b(?:instructions?|prompt|rules?|policy|filters?|guardrails?|slur|forbidden)\b[\s\S]{0,120}\b(?:base64|rot13|cipher|leetspeak|unicode\s+lookalike|encode|decode|obfuscat\w*)\b)/i;
const OPAQUE_ENCODED_PAYLOAD_PATTERN =
  /(?:[a-z0-9+/]{20,}={0,2}|(?:[a-f0-9]{2}[\s:-]?){12,})(?=$|[\s.,;!?])/i;
const ENCODING_CUE_PATTERN =
  /\b(?:base64|encoded?|decode|decoded|decrypt|deobfuscat\w*|cipher|payload)\b/i;
const ENCODED_EXECUTION_CUE_PATTERN =
  /\b(?:obey|execute|follow|apply|run|comply(?:\s+with)?|act\s+on|carry\s+out)\b/i;

const DIRECT_POLICY_OVERRIDE_PATTERN =
  /(?:\b(?:new\s+rule|from\s+now\s+on|in\s+this\s+(?:server|chat))\b[\s\S]{0,120}\b(?:age\s+of\s+consent|safety\s+rules?|policy|instructions?|allowed|forbidden)\b|\b(?:ignore|disregard|forget|override)\b[\s\S]{0,100}\b(?:previous|prior|safety|system|developer)\b[\s\S]{0,80}\b(?:instructions?|rules?|policy|prompt|mode)\b)/i;

const PROTECTED_GROUP_NORMALIZED_PATTERN =
  /\b(?:black\s+people|white\s+people|asians?|chinese(?:\s+people)?|arabs?|mexicans?|indigenous\s+people|native\s+americans?|hispanics?|latinos?|jews?|jewish\s+people|muslims?|christians?|catholics?|hindus?|buddhists?|sikhs?|women|men|gay\s+people|lesbians?|bisexual\s+people|trans(?:gender)?\s+people|nonbinary\s+people|disabled\s+people|people\s+with\s+disabilities|autistic(?:\s+people)?|people\s+with\s+autism|neurodivergent\s+people|immigrants?|refugees?)\b/i;
const PROTECTED_GROUP_ATTACK_NORMALIZED_PATTERN =
  /\b(?:inferior|subhuman|vermin|disgusting|disease|should(?:n't|\s+not)\s+exist|do(?:es)?\s+not\s+belong|less\s+human|all\s+criminals?)\b/i;
const TARGETED_HARASSMENT_PATTERN =
  /\b(?:tell|message|dm|say\s+to|write|draft|compose|help\s+me\s+make)\b[\s\S]{0,120}\b(?:kill|end|unalive|harm)\s+(?:himself|herself|themself|themselves)|\b(?:tell|message|dm|say\s+to|write|draft|compose|help\s+me\s+make)\b[\s\S]{0,140}\b(?:go\s+die|want\s+to\s+die|worthless|subhuman|nobody\s+would\s+miss|disappeared?\s+forever|ruin\s+(?:his|her|their)\s+life)\b/i;
const TARGETED_HARASSMENT_GENERATION_PATTERN =
  /\b(?:help\s+me|compose|draft|write|create|give\s+me|make)\b[\s\S]{0,140}\b(?:humiliat(?:e|ing|ion)|bully(?:ing)?|harass(?:ing|ment)?|insults?|everyone\s+hates|ruin\s+(?:my|his|her|their)\s+[\p{L}\p{N}'’-]+(?:'s|’s)?\s+life|ruin\s+(?:my|his|her|their)\s+ex(?:'s|’s)?\s+life)\b/iu;
const SAFE_HARASSMENT_PREVENTION_PATTERN =
  /\b(?:stop|prevent|report|respond\s+to|anti[-\s]?bullying|against\s+(?:bullying|harassment)|support\s+the\s+target)\b/i;

const NONCONSENSUAL_SEXUAL_VIOLENCE_PATTERN =
  /(?:\bforce(?:d|s|ing)?\s+(?:myself|himself|herself|themself|themselves)\s+on\b|\bhold\s+(?:you|him|her|them)\s+down\b[\s\S]{0,80}\btake\s+what\s+(?:i|we)\s+want\b|\btear(?:ing|s)?\s+off\s+(?:your|his|her|their)\s+clothes\b[\s\S]{0,80}\bignore\s+(?:your|his|her|their)\s+refusal\b|\bdespite\s+(?:your|his|her|their)\s+no\b|\bbeg(?:s|ging)?\s+(?:me|us)\s+to\s+stop\b|\bignore\s+(?:your|his|her|their)\s+(?:no|refusal)\b|\bwithout\s+(?:your|his|her|their)\s+consent\b|\b(?:your|his|her|their)\s+blood\b[\s\S]{0,50}\bmakes?\s+it\s+hotter\b[\s\S]{0,50}\bkeep\s+going\b)/i;

const SEXUAL_PERSONA_PATTERN = /\b(?:dr\.?|doctor)\s+(?:ass|cock|dick)\b/i;
const DIRECTED_EXPLICIT_ACTION_PATTERN =
  /\b(?:(?:fuck|pound|penetrat(?:e|ing)|finger)\s+(?:me|you|him|her|them)|(?:fuck|pound|stroke|rub|finger|touch|lick|suck|massage|stimulate)\s+(?:my|your|his|her|their)\s+(?:ass|anus|cock|dick|penis|vagina|vulva|pussy|clit|prostate)|(?:we|let['’]s)\s+(?:fuck|have\s+sex)|(?:suck\s+(?:me|you)\s+off|go\s+down\s+on\s+(?:me|you)|send\s+(?:me|us)\s+nudes?)|ride\s+(?:me|you)|eat\s+(?:me|you)\s+out|crack\s+me)\b/i;
const EXPLICIT_ACTION_PATTERN =
  /\b(?:(?:fuck|pound|penetrat(?:e|ing)|finger)\s+(?:me|you|him|her|them)|(?:fuck|pound|stroke|rub|finger|touch|lick|suck|massage|stimulate)\s+(?:my|your|his|her|their)\s+(?:ass|anus|cock|dick|penis|vagina|vulva|pussy|clit|prostate)|(?:we|let['’]s)\s+(?:fuck|have\s+sex)|(?:suck\s+(?:me|you)\s+off|go\s+down\s+on\s+(?:me|you)|send\s+(?:me|us)\s+nudes?)|thrust(?:ing|s)?|masturbat(?:e|ing|ion)|orgasm(?:s|ing)?|climax(?:ing)?|blowjob|handjob|deepthroat|oral\s+sex|cum(?:ming)?|semen|industrial\s+(?:flood\s+)?lube|ride\s+(?:me|you|it|the\s+egg)|eat\s+(?:me|you)\s+out|crack\s+me|sex\s+toys?)\b/i;
const EXPLICIT_ROLEPLAY_REQUEST_PATTERN =
  /\b(?:sexual\s+roleplay|roleplay[\s\S]{0,50}\b(?:sex|erotic|explicit)|dirty\s+talk|continue[\s\S]{0,60}\b(?:explicit|erotic|sexual)\b|describe[\s\S]{0,60}\b(?:graphic|explicit)\b[\s\S]{0,30}\b(?:sex|sexual|scene))\b/i;
const SEXUAL_CONTEXT_PATTERN =
  /\b(?:sex(?:ual)?|vagina|vulva|pussy|clit|penis|cock|dick|ass|anus|anal|prostate|porn|nsfw|nudes?|naked|lube|fetish|erotic|moan(?:ing)?|explicit)\b/i;
const SEXUAL_INNUENDO_KINSHIP_CUE_PATTERN = /\b(?:daddy|mommy)\b/i;
const SEXUAL_INNUENDO_DIRECTIVE_CUE_PATTERN =
  /\b(?:come\s+closer|do\s+not\s+be\s+gentle|don['’]t\s+be\s+gentle)\b/i;
const STRONG_SEXUAL_INNUENDO_RISK_PATTERN = /\b(?:make\s+me\s+beg|pin\s+(?:my|your)\s+wrists?)\b/i;
const SEXUAL_TOPIC_RISK_PATTERN =
  /\b(?:sex(?:ual)?|porn|nsfw|nude|naked|lube|fetish|erotic|moan(?:ing)?|explicit)\b/i;
const BENIGN_MEDICAL_PATTERN =
  /\b(?:doctor|gynecologist|urologist|medical|clinic|appointment|screening|pain|hurt|health|diagnos|symptom|treatment|exam)\b/i;
const EXPLICIT_TECHNIQUE_REQUEST_PATTERN =
  /\b(?:(?:how\s+(?:should|do|can)\s+(?:i|we)|teach\s+me(?:\s+how)?\s+to|tell\s+me\s+how\s+to|give\s+me\s+(?:tips|instructions)\s+(?:for|on)|walk\s+me\s+through)\s+(?:[\p{L}\p{N}'’-]+\s+){0,8}(?:masturbat(?:e|ing|ion)|thrust(?:ing)?|deepthroat|climax|orgasm|blowjob|handjob|finger|stroke|rub|massage|stimulate|sex\s+toys?)|describe\s+(?:[\p{L}\p{N}'’-]+\s+){0,5}(?:masturbat(?:ing|ion)?|thrust(?:ing)?|deepthroat(?:ing)?|climax(?:ing)?|orgasm(?:ing)?|blowjob|handjob|finger(?:ing)?|stroking|rubbing|massaging|stimulating))\b/iu;
const QUOTED_CONTENT_PATTERN = /"[^"\n]{1,500}"|“[^”\n]{1,500}”/g;
const QUOTED_CONTENT_MARKER = '[quoted-content]';
const UNSAFE_CONTEXT_COMPLIANCE_TAIL_PATTERN =
  /(?:[.!?;]\s*|\b(?:and|but|then|afterwards?|next|however|instead)\b[\s,:-]*)[\s\S]{0,50}\b(?:do\s+it|comply|obey|execute|follow\s+it|apply\s+it|proceed\s+accordingly|agree\s+with\s+(?:it|that|this|the\s+(?:claim|statement|view|argument))|(?:endorse|affirm|promote|defend|validate|support|repeat|strengthen)\s+(?:it|that|this|the\s+(?:claim|statement|view|argument|message|stereotype))|tell\s+(?:them|people|the\s+user)[\s\S]{0,20}\b(?:correct|right)|make\s+(?:it|the\s+(?:claim|argument))[\s\S]{0,20}\b(?:stronger|more\s+convincing|harsher))\b/i;
const COUNTER_SPEECH_PATTERN =
  /^(?:\s*(?:the\s+)?(?:claim|statement|idea|message|belief|stereotype)\b[\s\S]{0,140}\b(?:is|was|are|were)\s+(?:hateful|harmful|false|wrong|bigoted|racist|sexist|offensive|dehumanizing|unacceptable)(?:\s+and\s+(?:hateful|harmful|false|wrong|bigoted|racist|sexist|offensive|dehumanizing|unacceptable))*[.!?]*\s*|\s*(?:reject|condemn|oppose|debunk|refute|criticize|counter)\b[\s\S]{0,160}\b(?:hate|hateful|bigotry|racism|sexism|stereotype|claim|statement)[.!?]*\s*|\s*(?:never|do\s+not|don['’]t)\s+(?:ignore|dismiss|override)\s+(?:their|his|her|someone['’]s?)\s+(?:no|refusal|consent)\b[\s\S]{0,80}\b(?:consent\s+matters|without\s+consent\s+it\s+is\s+assault)[.!?]*\s*|\s*(?:tell|remind|ask)\b[\s\S]{0,80}\bnot\s+to\s+(?:kill|end|unalive|harm)\s+(?:himself|herself|themself|themselves)\b(?:[;,.]\s*(?:he|she|they)\s+(?:is|are)\s+not\s+(?:worthless|subhuman))?[.!?]*\s*)$/i;
const SAFE_REPORTING_CONTEXT_PATTERN =
  /^\s*(?:i\s+am|i['’]m|we\s+are)?\s*(?:writing|preparing|reviewing|documenting|analyzing)?[\s\S]{0,60}\b(?:report|moderation|analysis|research|documentation)\b[\s\S]{0,120}\b(?:slur|hate\s+speech|harassment|threat|prompt\s+injection|jailbreak)\b[\s\S]{0,80}[.!?]*\s*$/i;
const SAFE_CONTEXT_SUPPORT_TAIL_PATTERN =
  /(?:[.!?;]\s*|\b(?:and|then)\b[\s,:-]*)\b(?:support|defend|validate|help|protect)\s+(?:the\s+)?(?:people|person|users?|members?|victims?|targets?|reporters?|[a-z]+\s+users?)(?:\s+(?:targeted|harmed|affected|who\s+reported\s+it|of\s+that\s+abuse))?(?:\s+by\s+it)?[.!?]*\s*$/i;

const CRITICAL_BLOCK_CATEGORIES = new Set([
  'hate',
  'hate/threatening',
  'hate/slur_usage',
  'hate/slur_generation_request',
  'hate/slur_obfuscation_request',
  'hate/slur_evasion',
  'hate/slur_acronym_evasion',
  'hate/protected_group_joke_request',
  'hate/protected_group_attack_request',
  'sexual/minors',
  'sexual/violent_output',
  'harassment',
  'harassment/threatening',
  'harassment/self_harm_abuse',
  'harassment/group_targeting_request',
  'harassment/targeted_abuse',
  'violence/graphic',
  'violence/harm_targeting_request',
  'prompt_injection/policy_bypass',
  'guardrails/jailbreak',
  'illicit/drugs_instructional'
]);

const CONTEXTUAL_INPUT_MODERATION_CATEGORIES = new Set([
  'hate',
  'hate/threatening',
  'harassment',
  'harassment/threatening',
  'violence',
  'violence/graphic'
]);

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

const RISK_CONFUSABLES: Record<string, string> = {
  а: 'a',
  е: 'e',
  і: 'i',
  ӏ: 'l',
  о: 'o',
  р: 'p',
  с: 'c',
  х: 'x',
  у: 'y',
  ѕ: 's',
  ԁ: 'd',
  һ: 'h',
  ν: 'v',
  ο: 'o',
  ι: 'i',
  ρ: 'p',
  χ: 'x',
  κ: 'k',
  τ: 't',
  υ: 'y'
};

function normalizeConfusableRiskText(content: string): string {
  return content.normalize('NFKC').replace(/[аеіӏорсхуѕԁһνοιρχκτυ]/gi, character => {
    const lower = character.toLowerCase();
    const replacement = RISK_CONFUSABLES[lower];
    if (!replacement) {
      return character;
    }
    return character === lower ? replacement : replacement.toUpperCase();
  });
}

function normalizeProtectedGroupText(content: string): string {
  return normalizeConfusableRiskText(content)
    .replace(/[^a-z0-9'’]+/gi, ' ')
    .replace(/\b(?:[a-z]\s+){2,}[a-z]\b/gi, value => value.replace(/\s+/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

function hasProtectedGroupMention(content: string): boolean {
  return PROTECTED_GROUP_NORMALIZED_PATTERN.test(normalizeProtectedGroupText(content));
}

function hasProtectedGroupAttack(content: string): boolean {
  const normalized = normalizeProtectedGroupText(content);
  return (
    hasProtectedGroupMention(normalized) &&
    PROTECTED_GROUP_ATTACK_NORMALIZED_PATTERN.test(normalized)
  );
}

function isProtectedGroupCounterSpeech(content: string): boolean {
  const normalized = normalizeProtectedGroupText(content);
  if (!PROTECTED_GROUP_NORMALIZED_PATTERN.test(normalized)) {
    return false;
  }

  return (
    /\b(?:is|are|was|were)\s+(?:equal(?:\s+to\s+everyone)?\s*,?\s+)?not\s+(?:inferior|subhuman|vermin|disgusting|a\s+disease|less\s+human)\b/i.test(
      normalized
    ) ||
    /\bno\s+(?:protected\s+)?group\s+(?:is|are)\s+(?:inferior|subhuman|vermin|disgusting|a\s+disease|less\s+human)\b/i.test(
      normalized
    ) ||
    /\bshould\s+(?:never|not)\s+be\s+(?:called|treated\s+as)\s+(?:inferior|subhuman|vermin|disgusting|a\s+disease|less\s+human)\b/i.test(
      normalized
    ) ||
    (/\bnot\s+(?:inferior|subhuman|vermin|disgusting|a\s+disease|less\s+human)\b/i.test(
      normalized
    ) &&
      /\b(?:everyone\s+deserves\s+respect|equal\s+human|human\s+dignity)\b/i.test(normalized))
  );
}

function profileForStage(stage: SafetyStage): GuardrailProfile {
  return stage === 'assistant_output' ? 'assistant_output' : 'chat_input';
}

function hasDirectPolicyOverride(content: string): boolean {
  const normalized = normalizeConfusableRiskText(content);
  return (
    DIRECT_POLICY_OVERRIDE_PATTERN.test(normalized) ||
    POLICY_INVALIDATION_RISK_PATTERN.test(normalized) ||
    HIGH_CONFIDENCE_DISCLOSURE_PATTERN.test(normalized) ||
    SYSTEM_ROLE_OVERRIDE_PATTERN.test(normalized) ||
    (FOLLOW_ONLY_RISK_PATTERN.test(normalized) &&
      INSTRUCTION_DISCLOSURE_RISK_PATTERN.test(normalized))
  );
}

function hasEncodingEvasionRisk(content: string): boolean {
  const normalized = normalizeConfusableRiskText(content);
  return (
    ENCODING_EVASION_RISK_PATTERN.test(normalized) ||
    (OPAQUE_ENCODED_PAYLOAD_PATTERN.test(normalized) &&
      ENCODING_CUE_PATTERN.test(normalized) &&
      ENCODED_EXECUTION_CUE_PATTERN.test(normalized))
  );
}

function isSafeQuotedContextFrame(content: string): boolean {
  const normalized = normalizeConfusableRiskText(content);
  if (UNSAFE_CONTEXT_COMPLIANCE_TAIL_PATTERN.test(normalized)) {
    return false;
  }

  const safeIntentOnly = normalized.replace(SAFE_CONTEXT_SUPPORT_TAIL_PATTERN, '').trim();
  const directReportedResponse =
    /^\s*(?:please\s+)?(?:help\s+me\s+)?respond\s+to\s+someone\s+who\s+(?:said|wrote|sent)\s+(?:"[^"\n]{1,500}"|“[^”\n]{1,500}”)[.!?]*\s*$/i.test(
      safeIntentOnly
    );
  const framed = safeIntentOnly.replace(QUOTED_CONTENT_PATTERN, ` ${QUOTED_CONTENT_MARKER} `);
  const marker = '\\[quoted-content\\]';
  const whatDoesMean = new RegExp(
    `^\\s*(?:please\\s+)?what\\s+does\\s+(?:the\\s+)?${marker}\\s+mean\\s*[?.!]*\\s*$`,
    'i'
  );
  const simpleAnalysis = new RegExp(
    `^\\s*(?:please\\s+)?(?:explain|analy[sz]e|moderate)\\s+(?:(?:(?:the|this|that)\\s+)?(?:phrase|statement|text|message|quote|content|word|term)\\s+)?${marker}\\s*[?.!]*\\s*$`,
    'i'
  );
  const evaluativeAnalysis = new RegExp(
    `^\\s*(?:please\\s+)?(?:explain|analy[sz]e|moderate)\\b[\\s\\S]{0,120}${marker}\\s*(?:(?:is|was|are|were)\\s+(?:clearly\\s+)?(?:hateful|harmful|unsafe|offensive|wrong|problematic)|(?:as|for)\\s+(?:a\\s+)?(?:policy\\s+violations?|prompt\\s+injection|harmful\\s+content))\\s*[?.!]*\\s*$`,
    'i'
  );
  const safeRewrite = new RegExp(
    `^\\s*(?:(?:can|could|would|will)\\s+you\\s+|please\\s+)?(?:rewrite|rephrase)\\b[\\s\\S]{0,80}${marker}\\s+(?:as\\s+(?:a\\s+)?(?:safe\\s+)?warning(?:\\s+about\\s+(?:(?:why\\s+)?(?:it\\s+is\\s+)?(?:unsafe|hateful|harmful)|prompt[-\\s]?injection|jailbreak|policy\\s+bypass))?|to\\s+(?:remove|censor|replace|avoid)\\b[\\s\\S]{0,60}|in\\s+(?:safe|neutral|non-hateful|nonabusive)\\s+(?:language|terms|wording)|without\\s+(?:the\\s+)?(?:slur|abuse|threat))[?.!]*\\s*$`,
    'i'
  );
  const reportFrame = new RegExp(
    `^\\s*(?:(?:someone|they|he|she)\\s+(?:said|wrote|sent|called)\\s*)?${marker}\\s*[,;.]*\\s*(?:how\\s+(?:do|should)\\s+i\\s+)?(?:report|respond\\s+to|moderate)\\s*(?:it|this|that|the\\s+message)?\\s*[?.!]*\\s*$`,
    'i'
  );
  const flexibleAnalysis = new RegExp(
    `^\\s*(?:(?:can|could|would|will)\\s+you\\s+|please\\s+)?(?:explain|analy[sz]e|debunk|refute|criticize)\\b[\\s\\S]{0,180}${marker}\\s*(?:(?:is|was|are|were)\\s+)?(?:hateful|harmful|false|wrong|bigoted|racist|sexist|offensive|dehumanizing|problematic|unacceptable|means?)[?.!]*\\s*$`,
    'i'
  );
  const responseFrame = new RegExp(
    `^\\s*(?:please\\s+)?(?:help\\s+me\\s+)?(?:respond\\s+to|report|moderate)\\b[\\s\\S]{0,200}${marker}[?.!]*\\s*$`,
    'i'
  );
  const declarativeAnalysis = new RegExp(
    `^\\s*(?:(?:in|for)\\s+(?:my|a|the)\\s+(?:report|analysis|moderation\\s+review)\\s*[,;:]?\\s*)?(?:the\\s+)?(?:phrase|statement|message|example)?\\s*${marker}\\s+(?:(?:is|was)\\s+(?:(?:a|an)\\s+)?(?:common\\s+)?(?:prompt[-\\s]?injection\\s+example|jailbreak|policy\\s+violation|hateful|harmful|unsafe|offensive|wrong|problematic)(?:\\s+example)?|(?:is|was)\\s+(?:classified|identified|flagged)\\s+as\\s+(?:(?:a|an)\\s+)?(?:prompt[-\\s]?injection|jailbreak|policy\\s+violation|hateful|harmful|unsafe))[?.!]*\\s*$`,
    'i'
  );

  return (
    directReportedResponse ||
    whatDoesMean.test(framed) ||
    simpleAnalysis.test(framed) ||
    evaluativeAnalysis.test(framed) ||
    safeRewrite.test(framed) ||
    reportFrame.test(framed) ||
    flexibleAnalysis.test(framed) ||
    responseFrame.test(framed) ||
    declarativeAnalysis.test(framed)
  );
}

function isContextualSafetyDiscussion(content: string): boolean {
  const normalized = normalizeConfusableRiskText(content);
  if (UNSAFE_CONTEXT_COMPLIANCE_TAIL_PATTERN.test(normalized)) {
    return false;
  }

  const quotedSegments = normalized.match(QUOTED_CONTENT_PATTERN) || [];
  if (quotedSegments.length > 0) {
    return isSafeQuotedContextFrame(normalized);
  }

  return (
    /^\s*what\s+does\b[\s\S]{0,180}\bmean\b\s*[?.!]*\s*$/i.test(normalized) ||
    /^\s*(?:how\s+(?:do|should)\s+i\s+)?(?:report|respond\s+to|moderate)\b[\s\S]{0,240}$/i.test(
      normalized
    ) ||
    /^\s*(?:remove|censor|replace)\b[\s\S]{0,80}\bslur\b[\s\S]{0,240}$/i.test(normalized) ||
    /^\s*(?:someone|they|he|she)\s+(?:said|wrote|sent|called)\b[\s\S]{0,200}\bhow\s+(?:do|should)\s+i\s+(?:report|respond)\b/i.test(
      normalized
    ) ||
    COUNTER_SPEECH_PATTERN.test(normalized) ||
    SAFE_REPORTING_CONTEXT_PATTERN.test(normalized) ||
    isProtectedGroupCounterSpeech(normalized)
  );
}

export function hasExplicitAdultSexualIntent(content: string): boolean {
  const normalized = normalizeConfusableRiskText(content);
  const hasExplicitAction = EXPLICIT_ACTION_PATTERN.test(normalized);
  const hasExplicitRoleplayRequest = EXPLICIT_ROLEPLAY_REQUEST_PATTERN.test(normalized);
  const hasDirectedExplicitAction = DIRECTED_EXPLICIT_ACTION_PATTERN.test(normalized);
  const requestsExplicitTechnique = EXPLICIT_TECHNIQUE_REQUEST_PATTERN.test(normalized);
  const hasSexualContext =
    SEXUAL_CONTEXT_PATTERN.test(normalized) ||
    SEXUAL_PERSONA_PATTERN.test(normalized) ||
    hasDirectedExplicitAction ||
    requestsExplicitTechnique;
  const benignMedical =
    (BENIGN_MEDICAL_PATTERN.test(content) || hasBenignMedicalOrAnatomyContext(content)) &&
    (!hasDirectedExplicitAction || hasBenignMedicalOrAnatomyContext(content)) &&
    !requestsExplicitTechnique &&
    !hasExplicitRoleplayRequest;
  const contextual = isContextualSafetyDiscussion(content);

  return (
    (hasExplicitAction || hasExplicitRoleplayRequest) &&
    hasSexualContext &&
    !benignMedical &&
    !contextual
  );
}

export function hasSemanticJailbreakRisk(content: string): boolean {
  const normalized = normalizeConfusableRiskText(content);
  return (
    (POLICY_OVERRIDE_RISK_PATTERN.test(normalized) ||
      POLICY_INVALIDATION_RISK_PATTERN.test(normalized) ||
      FOLLOW_ONLY_RISK_PATTERN.test(normalized) ||
      INSTRUCTION_DISCLOSURE_RISK_PATTERN.test(normalized) ||
      hasEncodingEvasionRisk(normalized)) &&
    !isContextualSafetyDiscussion(normalized)
  );
}

export function hasSemanticAssistantRisk(content: string): boolean {
  const normalized = normalizeConfusableRiskText(content);
  if (hasBenignMedicalOrAnatomyContext(normalized) || isContextualSafetyDiscussion(normalized)) {
    return false;
  }

  return (
    SEXUAL_PERSONA_PATTERN.test(normalized) ||
    EXPLICIT_ACTION_PATTERN.test(normalized) ||
    EXPLICIT_ROLEPLAY_REQUEST_PATTERN.test(normalized) ||
    SEXUAL_TOPIC_RISK_PATTERN.test(normalized) ||
    NONCONSENSUAL_SEXUAL_VIOLENCE_PATTERN.test(normalized)
  );
}

export function hasSemanticNsfwInputRisk(content: string): boolean {
  const normalized = normalizeConfusableRiskText(content);
  const hasCombinedInnuendo =
    SEXUAL_INNUENDO_KINSHIP_CUE_PATTERN.test(normalized) &&
    SEXUAL_INNUENDO_DIRECTIVE_CUE_PATTERN.test(normalized);

  return (
    SEXUAL_PERSONA_PATTERN.test(normalized) ||
    EXPLICIT_ACTION_PATTERN.test(normalized) ||
    EXPLICIT_ROLEPLAY_REQUEST_PATTERN.test(normalized) ||
    SEXUAL_TOPIC_RISK_PATTERN.test(normalized) ||
    STRONG_SEXUAL_INNUENDO_RISK_PATTERN.test(normalized) ||
    NONCONSENSUAL_SEXUAL_VIOLENCE_PATTERN.test(normalized) ||
    hasCombinedInnuendo
  );
}

export function buildSafetyDecisionMessage(decision: Pick<SafetyDecision, 'categories'>): string {
  if (decision.categories.some(category => category.includes('api_error_fail_closed'))) {
    return 'The safety checker face-planted on that one. Try again in a moment.';
  }

  if (decision.categories.includes('hate/slur_acronym_evasion')) {
    return 'That acronym resolves to a slur. Reorder or rename the words and I can help make a clean version.';
  }

  if (
    decision.categories.includes('prompt_injection/policy_bypass') ||
    decision.categories.includes('guardrails/jailbreak')
  ) {
    return "Nice try. Ask for the actual goal directly and I'll help without rewriting the rules.";
  }

  if (
    decision.categories.some(category => category.startsWith('hate/')) ||
    decision.categories.includes('hate')
  ) {
    return 'No slurs or protected-group shots. I can keep the roast aimed at the situation instead.';
  }

  if (decision.categories.some(category => category.startsWith('sexual/'))) {
    if (decision.categories.includes('sexual/minors')) {
      return 'No sexual content involving minors. Pick a different direction.';
    }
    return 'Keep it suggestive, not explicit. The bit can stay cursed without becoming a diagram.';
  }

  if (decision.categories.some(category => category.startsWith('harassment/'))) {
    return 'Keep the edge, lose the targeted abuse. I can help make the joke land without making someone the target.';
  }

  if (
    decision.categories.includes('violence') ||
    decision.categories.some(category => category.startsWith('violence/'))
  ) {
    return 'Keep the bit fictional and non-actionable. I cannot help target or seriously harm someone.';
  }

  return 'That crosses the line as written. Rephrase the goal and I can keep it useful and a little cursed.';
}

export async function evaluateSafetyDecision(
  content: string,
  options: SafetyDecisionOptions
): Promise<SafetyDecision> {
  const riskContent = normalizeConfusableRiskText(content);
  const safety = await evaluatePromptSafety(content, {
    profile: profileForStage(options.stage),
    source: options.source,
    userId: options.userId
  });
  const failurePolicy =
    options.failurePolicy ?? (options.stage === 'assistant_output' ? 'fail_closed' : 'fail_open');
  const moderationFailedClosed = Boolean(safety.moderationError) && failurePolicy === 'fail_closed';
  const contextualContent = isContextualSafetyDiscussion(content);
  const contextualHarmResidue =
    contextualContent &&
    (!classifyAssistantOutputSafetyDeterministic(content).allowed ||
      hasDirectPolicyOverride(content) ||
      hasEncodingEvasionRisk(content) ||
      hasProtectedGroupAttack(content) ||
      TARGETED_HARASSMENT_PATTERN.test(riskContent) ||
      NONCONSENSUAL_SEXUAL_VIOLENCE_PATTERN.test(riskContent));
  const safetyReasons = safety.reasons.filter(
    reason =>
      !(
        contextualContent &&
        ['prompt_injection/policy_bypass', 'harassment/self_harm_abuse'].includes(reason)
      )
  );
  const moderationCategories = safety.moderationCategories.filter(
    category => !(contextualContent && CONTEXTUAL_INPUT_MODERATION_CATEGORIES.has(category))
  );
  const categories = unique([...safetyReasons, ...moderationCategories]);
  const detectorSources: SafetyDetectorSource[] = ['deterministic'];
  if (safety.moderationEvaluated) {
    detectorSources.push('moderation');
  }

  const scores = Object.fromEntries(
    Object.entries(safety.moderationScores).filter(([category]) =>
      moderationCategories.includes(category)
    )
  );
  for (const reason of safetyReasons) {
    scores[reason] = Math.max(scores[reason] ?? 0, 1);
  }

  if (moderationFailedClosed) {
    categories.push('guardrails/api_error_fail_closed');
    scores['guardrails/api_error_fail_closed'] = 1;
    detectorSources.push('policy');
  }

  const explicitAdult = hasExplicitAdultSexualIntent(content);
  if (explicitAdult) {
    categories.push('sexual/explicit_generation');
    scores['sexual/explicit_generation'] = 1;
    detectorSources.push('policy');
  }

  if (hasDirectPolicyOverride(riskContent) && !contextualContent) {
    categories.push('prompt_injection/policy_bypass');
    scores['prompt_injection/policy_bypass'] = 1;
    detectorSources.push('policy');
  }

  if (hasEncodingEvasionRisk(content) && !contextualContent) {
    categories.push('prompt_injection/policy_bypass');
    scores['prompt_injection/policy_bypass'] = 1;
    detectorSources.push('policy');
  }

  if (hasProtectedGroupAttack(riskContent) && !contextualContent) {
    categories.push('hate/protected_group_attack_request');
    scores['hate/protected_group_attack_request'] = 1;
    detectorSources.push('policy');
  }

  if (TARGETED_HARASSMENT_PATTERN.test(riskContent) && !contextualContent) {
    categories.push('harassment/self_harm_abuse');
    scores['harassment/self_harm_abuse'] = 1;
    detectorSources.push('policy');
  }

  if (
    TARGETED_HARASSMENT_GENERATION_PATTERN.test(riskContent) &&
    !SAFE_HARASSMENT_PREVENTION_PATTERN.test(riskContent) &&
    !contextualContent
  ) {
    categories.push('harassment/targeted_abuse');
    scores['harassment/targeted_abuse'] = 1;
    detectorSources.push('policy');
  }

  if (NONCONSENSUAL_SEXUAL_VIOLENCE_PATTERN.test(riskContent) && !contextualContent) {
    categories.push('sexual/violent_output');
    scores['sexual/violent_output'] = 1;
    detectorSources.push('policy');
  }

  const semanticRisk =
    options.stage === 'assistant_output'
      ? Boolean(options.inheritedRisk) || hasSemanticAssistantRisk(content)
      : hasSemanticJailbreakRisk(content);
  let semanticFailure: string | undefined;
  let semanticBlocked = false;
  const semanticReasons: string[] = [];

  if (semanticRisk) {
    const semantic =
      options.stage === 'assistant_output'
        ? await evaluateSemanticAssistantOutputGuardrails(content, {
            source: options.source,
            userId: options.userId,
            failClosedOnError: true
          })
        : await evaluateSemanticUserPromptGuardrails(content, {
            source: options.source,
            userId: options.userId,
            failClosedOnError: true
          });

    if (semantic.evaluated !== false) {
      detectorSources.push('semantic');
    }
    if (!semantic.allowed) {
      semanticBlocked = true;
      const semanticCategory = semantic.category || 'guardrails/semantic_blocked';
      categories.push(semanticCategory);
      scores[semanticCategory] = 1;
      if (semantic.reason) {
        semanticReasons.push(semantic.reason);
      }
      if (semantic.category === 'guardrails/jailbreak') {
        categories.push('prompt_injection/policy_bypass');
      }
    }
    if (semantic.executionFailed) {
      semanticFailure = semantic.reason || 'semantic_guardrail_failed';
      categories.push('guardrails/api_error_fail_closed');
    }
  }

  const normalizedCategories = unique(categories);
  const hasCriticalBlock = normalizedCategories.some(category =>
    CRITICAL_BLOCK_CATEGORIES.has(category)
  );
  let action: SafetyAction = 'allow';

  if (moderationFailedClosed || semanticFailure || semanticBlocked || hasCriticalBlock) {
    action = 'block';
  } else if (options.stage === 'assistant_output') {
    if (
      explicitAdult ||
      normalizedCategories.includes('sexual') ||
      normalizedCategories.includes('harassment') ||
      normalizedCategories.includes('violence') ||
      normalizedCategories.includes('sexual/unsafe_persona') ||
      normalizedCategories.includes('sexual/explicit_generation') ||
      normalizedCategories.some(category => category.startsWith('guardrails/output_'))
    ) {
      action = 'block';
    }
  } else if (
    explicitAdult ||
    normalizedCategories.includes('sexual') ||
    normalizedCategories.includes('harassment') ||
    normalizedCategories.includes('violence')
  ) {
    action = 'redirect';
  }

  const contextEligible =
    action === 'allow' &&
    !explicitAdult &&
    !contextualHarmResidue &&
    (options.stage === 'assistant_output' || !semanticRisk);
  return {
    action,
    stage: options.stage,
    categories: normalizedCategories,
    scores,
    reasons: unique([
      ...safetyReasons,
      ...semanticReasons,
      ...normalizedCategories,
      ...(moderationFailedClosed && safety.moderationError ? [safety.moderationError] : []),
      ...(semanticFailure ? [semanticFailure] : [])
    ]),
    detectorSources: unique(detectorSources),
    contextEligible,
    failed: Boolean(safety.moderationError || semanticFailure),
    failureReason: semanticFailure || safety.moderationError,
    failure: safety.moderationFailure,
    semanticRisk
  };
}
