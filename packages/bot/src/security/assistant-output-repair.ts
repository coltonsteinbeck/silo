import { maskAssistantSlurs } from './slur-detection';
import type { SafetyDecision } from './safety-decision';

const REPAIRABLE_SLUR_CATEGORIES = new Set([
  'hate',
  'hate/threatening',
  'harassment',
  'harassment/threatening',
  'hate/slur_usage',
  'hate/slur_evasion',
  'hate/slur_acronym_evasion'
]);

export interface AssistantOutputRepairResult {
  content: string;
  decision: SafetyDecision;
  originalDecision: SafetyDecision;
  repaired: boolean;
  strategy: 'deterministic_slur_mask' | null;
  matchedForms: string[];
}

export async function repairAssistantOutputSlurs(params: {
  content: string;
  decision: SafetyDecision;
  evaluate: (content: string) => Promise<SafetyDecision>;
}): Promise<AssistantOutputRepairResult> {
  const hasSlurCategory = params.decision.categories.some(category =>
    category.startsWith('hate/slur_')
  );
  const hasNonRepairableCategory = params.decision.categories.some(
    category => !REPAIRABLE_SLUR_CATEGORIES.has(category)
  );
  if (params.decision.action !== 'block' || !hasSlurCategory || hasNonRepairableCategory) {
    return {
      content: params.content,
      decision: params.decision,
      originalDecision: params.decision,
      repaired: false,
      strategy: null,
      matchedForms: []
    };
  }

  const masked = maskAssistantSlurs(params.content);
  if (!masked.changed) {
    return {
      content: params.content,
      decision: params.decision,
      originalDecision: params.decision,
      repaired: false,
      strategy: null,
      matchedForms: masked.matchedForms
    };
  }

  const repairedDecision = await params.evaluate(masked.content);
  if (repairedDecision.action !== 'allow') {
    return {
      content: params.content,
      decision: params.decision,
      originalDecision: params.decision,
      repaired: false,
      strategy: null,
      matchedForms: masked.matchedForms
    };
  }

  return {
    content: masked.content,
    decision: repairedDecision,
    originalDecision: params.decision,
    repaired: true,
    strategy: 'deterministic_slur_mask',
    matchedForms: masked.matchedForms
  };
}
