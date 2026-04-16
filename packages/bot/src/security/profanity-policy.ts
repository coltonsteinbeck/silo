const MILD_PROFANITY_TERMS = [
  'fuck',
  'fucking',
  'shit',
  'damn',
  'hell',
  'ass',
  'bastard',
  'crap',
  'bullshit',
  'wtf'
] as const;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildWholeWordRegex(term: string, global: boolean = false): RegExp {
  return new RegExp(`\\b${escapeRegex(term)}\\b`, global ? 'gi' : 'i');
}

const TERM_PATTERNS = MILD_PROFANITY_TERMS.map(term => ({
  term,
  testPattern: buildWholeWordRegex(term),
  replacePattern: buildWholeWordRegex(term, true)
}));

export function detectMildProfanity(content: string): string[] {
  const matches = new Set<string>();
  for (const { term, testPattern } of TERM_PATTERNS) {
    if (testPattern.test(content)) {
      matches.add(term);
    }
  }
  return [...matches];
}

export function sanitizeAssistantProfanity(content: string): {
  sanitized: string;
  changed: boolean;
  matchedTerms: string[];
} {
  let sanitized = content;
  const matchedTerms = new Set<string>();

  for (const { term, testPattern, replacePattern } of TERM_PATTERNS) {
    if (testPattern.test(sanitized)) {
      matchedTerms.add(term);
      sanitized = sanitized.replace(replacePattern, '***');
    }
  }

  return {
    sanitized,
    changed: sanitized !== content,
    matchedTerms: [...matchedTerms]
  };
}

export const profanityPolicy = {
  detectMildProfanity,
  sanitizeAssistantProfanity
};
