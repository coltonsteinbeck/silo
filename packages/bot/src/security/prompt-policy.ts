import { createHash } from 'crypto';

export interface PromptPolicyResolution {
  effectivePrompt: string;
  promptHash: string;
  usedCustomPrompt: boolean;
  rejectedCustomPrompt: boolean;
  rejectedCustomPromptReason: 'allowlist_required' | 'hash_not_allowlisted' | null;
  customPromptHash: string | null;
}

export function hashPrompt(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex').substring(0, 16);
}

export function parseAllowedPromptHashes(raw: string | undefined): Set<string> {
  if (!raw) {
    return new Set();
  }

  const trimmedItems = raw
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);

  if (trimmedItems.length === 0) {
    throw new Error('SAFETY_ALLOWED_PROMPT_HASHES is configured but contains no valid entries');
  }

  const normalized = trimmedItems
    .filter(item => /^[a-f0-9]{16}$/i.test(item))
    .map(item => item.toLowerCase());

  if (normalized.length === 0) {
    throw new Error('SAFETY_ALLOWED_PROMPT_HASHES is configured but contains no valid hashes');
  }

  return new Set(normalized);
}

export function resolvePromptPolicy(params: {
  customPrompt: string | null;
  defaultPrompt: string;
  allowedPromptHashesRaw?: string;
  requireCustomPromptAllowlist?: boolean;
}): PromptPolicyResolution {
  const { customPrompt, defaultPrompt, allowedPromptHashesRaw, requireCustomPromptAllowlist } =
    params;
  const normalizedCustomPrompt = customPrompt?.trim() || null;
  const defaultPromptHash = hashPrompt(defaultPrompt);

  if (!normalizedCustomPrompt) {
    return {
      effectivePrompt: defaultPrompt,
      promptHash: defaultPromptHash,
      usedCustomPrompt: false,
      rejectedCustomPrompt: false,
      rejectedCustomPromptReason: null,
      customPromptHash: null
    };
  }

  const customPromptHash = hashPrompt(normalizedCustomPrompt);
  const allowedPromptHashes = parseAllowedPromptHashes(allowedPromptHashesRaw);

  if (requireCustomPromptAllowlist && allowedPromptHashes.size === 0) {
    return {
      effectivePrompt: defaultPrompt,
      promptHash: defaultPromptHash,
      usedCustomPrompt: false,
      rejectedCustomPrompt: true,
      rejectedCustomPromptReason: 'allowlist_required',
      customPromptHash
    };
  }

  if (allowedPromptHashes.size > 0 && !allowedPromptHashes.has(customPromptHash)) {
    return {
      effectivePrompt: defaultPrompt,
      promptHash: defaultPromptHash,
      usedCustomPrompt: false,
      rejectedCustomPrompt: true,
      rejectedCustomPromptReason: 'hash_not_allowlisted',
      customPromptHash
    };
  }

  return {
    effectivePrompt: normalizedCustomPrompt,
    promptHash: customPromptHash,
    usedCustomPrompt: true,
    rejectedCustomPrompt: false,
    rejectedCustomPromptReason: null,
    customPromptHash
  };
}
