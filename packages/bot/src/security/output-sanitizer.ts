interface SanitizeAssistantOutputOptions {
  stripInternalMetadata?: boolean;
  stripXmlLikeTags?: boolean;
  neutralizeMassMentions?: boolean;
}

const INTERNAL_METADATA_PATTERNS: RegExp[] = [
  /\[Referenced context\]\s*/gi,
  /\[Reply level\s+\d+\s*\|\s*user\s+[^\]]+\]\s*/gi,
  /\[Attached images:\s*\d+\]\s*/gi
];

const XML_LIKE_TAG_PATTERN = /<\/?[a-z][a-z0-9_:-]*(?:\s[^<>]*?)?\/?>/gi;
const DANGLING_TAG_TOKEN_PATTERN = /(^|\s)<[a-z][a-z0-9_:-]*(?=\s|$)/gim;
const DISCORD_MASS_MENTION_PATTERN = /@(?:everyone|here)\b/gi;

export function sanitizeDiscordMassMentions(content: string): string {
  return content.replace(DISCORD_MASS_MENTION_PATTERN, match => match.slice(1).toLowerCase());
}

export function sanitizeAssistantOutput(
  content: string,
  options: SanitizeAssistantOutputOptions = {}
): string {
  const {
    stripInternalMetadata = true,
    stripXmlLikeTags = true,
    neutralizeMassMentions = true
  } = options;

  let sanitized = content;

  if (neutralizeMassMentions) {
    sanitized = sanitizeDiscordMassMentions(sanitized);
  }

  if (stripInternalMetadata) {
    for (const pattern of INTERNAL_METADATA_PATTERNS) {
      sanitized = sanitized.replace(pattern, '');
    }
  }

  if (stripXmlLikeTags) {
    sanitized = sanitized.replace(XML_LIKE_TAG_PATTERN, '');
    sanitized = sanitized.replace(DANGLING_TAG_TOKEN_PATTERN, '$1');
  }

  return sanitized
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
