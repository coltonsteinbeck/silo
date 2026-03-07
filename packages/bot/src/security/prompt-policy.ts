import { createHash } from 'crypto';

export interface PromptPolicyResolution {
  effectivePrompt: string;
  promptHash: string;
  usedCustomPrompt: boolean;
  rejectedCustomPrompt: boolean;
  customPromptHash: string | null;
}

function hashPrompt(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex').substring(0, 16);
}

function parseAllowedPromptHashes(raw: string | undefined): Set<string> {
  if (!raw) {
    return new Set();
  }

  return new Set(
    raw
      .split(',')
      .map(item => item.trim())
      .filter(Boolean)
  );
}

export function resolvePromptPolicy(params: {
  customPrompt: string | null;
  defaultPrompt: string;
  allowedPromptHashesRaw?: string;
}): PromptPolicyResolution {
  const { customPrompt, defaultPrompt, allowedPromptHashesRaw } = params;
  const normalizedCustomPrompt = customPrompt?.trim() || null;

  if (!normalizedCustomPrompt) {
    return {
      effectivePrompt: defaultPrompt,
      promptHash: 'default',
      usedCustomPrompt: false,
      rejectedCustomPrompt: false,
      customPromptHash: null
    };
  }

  const customPromptHash = hashPrompt(normalizedCustomPrompt);
  const allowedPromptHashes = parseAllowedPromptHashes(allowedPromptHashesRaw);

  if (allowedPromptHashes.size > 0 && !allowedPromptHashes.has(customPromptHash)) {
    return {
      effectivePrompt: defaultPrompt,
      promptHash: 'default',
      usedCustomPrompt: false,
      rejectedCustomPrompt: true,
      customPromptHash
    };
  }

  return {
    effectivePrompt: normalizedCustomPrompt,
    promptHash: customPromptHash,
    usedCustomPrompt: true,
    rejectedCustomPrompt: false,
    customPromptHash
  };
}
