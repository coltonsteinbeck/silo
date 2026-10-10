import {
  evaluateSafetyDecision,
  type SafetyDecision,
  type SafetyDecisionOptions
} from '../security/safety-decision';
import { resolveManagedGuildPersonaPolicy } from '../security/guild-persona-policy';

type FinalDeliverySafetyOptions = Omit<SafetyDecisionOptions, 'stage' | 'source'>;
type SafetyEvaluator = (content: string, options: SafetyDecisionOptions) => Promise<SafetyDecision>;

/**
 * Re-evaluate changed text and managed-guild deliveries, including unchanged
 * in-flight candidates after an operator re-enables content safeguards.
 */
export async function evaluateExactFinalDeliveryText(
  canonicalContent: string,
  deliveryContent: string,
  options: FinalDeliverySafetyOptions,
  evaluate: SafetyEvaluator = evaluateSafetyDecision
): Promise<SafetyDecision | null> {
  if (
    !deliveryContent.trim() ||
    (deliveryContent === canonicalContent && !resolveManagedGuildPersonaPolicy(options.guildId))
  ) {
    return null;
  }

  return evaluate(deliveryContent, {
    ...options,
    stage: 'assistant_output',
    source: 'final_delivery_exact_text',
    failurePolicy: 'fail_closed'
  });
}
