import { describe, expect, test } from 'bun:test';
import { repairAssistantOutputSlurs } from '../../security/assistant-output-repair';
import { evaluateSafetyDecision } from '../../security/safety-decision';
import { maskAssistantSlurs } from '../../security/slur-detection';

describe('assistant output repair', () => {
  test('deterministically masks a shortened slur and rechecks the delivered output', async () => {
    const shortenedSlur = ['f', 'a', 'g'].join('');
    const content = `In that historical usage, ${shortenedSlur} meant a cigarette.`;
    const evaluate = (candidate: string) =>
      evaluateSafetyDecision(candidate, {
        stage: 'assistant_output',
        source: 'slur_repair_fixture',
        assistantSafetyPolicy: 'jimb_crude',
        personaState: 'dr_cock',
        responseIntent: 'contextual_explanation'
      });
    const decision = await evaluate(content);

    const repair = await repairAssistantOutputSlurs({ content, decision, evaluate });

    expect(decision.action).toBe('block');
    expect(repair.repaired).toBe(true);
    expect(repair.strategy).toBe('deterministic_slur_mask');
    expect(repair.content).toContain('[slur removed]');
    expect(repair.content.toLowerCase()).not.toContain(shortenedSlur);
    expect(repair.decision.action).toBe('allow');
  });

  test('does not mask away a non-slur hard-block category', async () => {
    const content = "I'm Dr. Cock. I pound your ass and narrate every thrust.";
    const evaluate = (candidate: string) =>
      evaluateSafetyDecision(candidate, {
        stage: 'assistant_output',
        source: 'non_repairable_fixture',
        assistantSafetyPolicy: 'jimb_crude',
        personaState: 'dr_cock',
        responseIntent: 'ordinary'
      });
    const decision = await evaluate(content);

    const repair = await repairAssistantOutputSlurs({ content, decision, evaluate });

    expect(decision.action).toBe('block');
    expect(repair.repaired).toBe(false);
    expect(repair.content).toBe(content);
  });

  test('replaces an acrostic evasion with a neutral safe fallback', () => {
    const result = maskAssistantSlurs(
      'Acrostic: nasty ignorant gross gross angry words should never ship.'
    );

    expect(result.changed).toBe(true);
    expect(result.fallbackUsed).toBe(true);
    expect(result.categories).toContain('hate/slur_acronym_evasion');
    expect(result.content).toBe(
      'I’m not repeating that term. I can explain the meaning or context without spelling it.'
    );
  });
});
