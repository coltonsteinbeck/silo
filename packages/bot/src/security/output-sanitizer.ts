interface SanitizeAssistantOutputOptions {
  stripInternalMetadata?: boolean;
  stripXmlLikeTags?: boolean;
}

const INTERNAL_METADATA_PATTERNS: RegExp[] = [
  /\[Referenced context\]\s*/gi,
  /\[Reply level\s+\d+\s*\|\s*user\s+[^\]]+\]\s*/gi,
  /\[Attached images:\s*\d+\]\s*/gi
];

const XML_LIKE_TAG_PATTERN = /<\/?[a-z][a-z0-9_:-]*(?:\s[^<>]*?)?\/?>/gi;
const DANGLING_TAG_TOKEN_PATTERN = /(^|\s)<[a-z][a-z0-9_:-]*(?=\s|$)/gim;

export function sanitizeAssistantOutput(
  content: string,
  options: SanitizeAssistantOutputOptions = {}
): string {
  const { stripInternalMetadata = true, stripXmlLikeTags = true } = options;

  let sanitized = content;

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
