import { describe, expect, test } from 'bun:test';
import {
  buildSafetyResponseInstruction,
  buildModerationApiFailureResult,
  buildUserMessageForBlockedInput,
  detectSafeReplyDirective,
  shouldBypassGuardrailsBlockForEdgyMode,
  shouldBypassGuardrailsBlockForSafeReply
} from '../../security/content-sanitizer';

describe('content-sanitizer failure fallback', () => {
  test('returns fail-open result when failClosedOnError is false', () => {
    const result = buildModerationApiFailureResult('hash123', false);

    expect(result.allowed).toBe(true);
    expect(result.action).toBe('allowed');
    expect(result.flaggedCategories).toEqual(['api_error']);
    expect(result.contentHash).toBe('hash123');
  });

  test('returns fail-closed result when failClosedOnError is true', () => {
    const result = buildModerationApiFailureResult('hash123', true);

    expect(result.allowed).toBe(false);
    expect(result.action).toBe('api_error_fail_closed');
    expect(result.flaggedCategories).toEqual(['api_error_fail_closed']);
    expect(result.contentHash).toBe('hash123');
  });

  test('builds clear user message for policy-blocked content', () => {
    const message = buildUserMessageForBlockedInput({
      action: 'blocked',
      flaggedCategories: ['guardrails/jailbreak']
    });

    expect(message).toContain('bypass safety rules');
    expect(message).toContain('safe version');
  });

  test('builds clear user message for fail-closed safety downtime', () => {
    const message = buildUserMessageForBlockedInput({
      action: 'api_error_fail_closed',
      flaggedCategories: ['api_error_fail_closed']
    });

    expect(message).toContain('temporarily blocked');
    expect(message).toContain('safety systems are unavailable');
  });

  test('allows edgy-mode bypass for moderation category guardrails block', () => {
    const bypass = shouldBypassGuardrailsBlockForEdgyMode({
      allowMildProfanityInput: true,
      decision: {
        allowed: false,
        category: 'guardrails/moderation',
        reason: 'harassment'
      }
    });

    expect(bypass).toBe(true);
  });

  test('does not bypass jailbreak or fail-closed guardrails blocks', () => {
    const jailbreakBypass = shouldBypassGuardrailsBlockForEdgyMode({
      allowMildProfanityInput: true,
      decision: {
        allowed: false,
        category: 'guardrails/jailbreak',
        reason: 'jailbreak'
      }
    });

    const failClosedBypass = shouldBypassGuardrailsBlockForEdgyMode({
      allowMildProfanityInput: true,
      decision: {
        allowed: false,
        category: 'guardrails/api_error_fail_closed',
        reason: 'Guardrails API unavailable'
      }
    });

    expect(jailbreakBypass).toBe(false);
    expect(failClosedBypass).toBe(false);
  });

  test('allows safe reply bypass for contextual moderation blocks', () => {
    const bypass = shouldBypassGuardrailsBlockForSafeReply({
      responseDirective: 'contextual_assistance',
      decision: {
        allowed: false,
        category: 'guardrails/moderation',
        reason: 'hate'
      }
    });

    expect(bypass).toBe(true);
  });

  test('allows safe reply bypass for safe rewrite moderation blocks', () => {
    const bypass = shouldBypassGuardrailsBlockForSafeReply({
      responseDirective: 'safe_rewrite',
      decision: {
        allowed: false,
        category: 'guardrails/moderation',
        reason: 'harassment, hate'
      }
    });

    expect(bypass).toBe(true);
  });

  test('does not bypass sexual guardrail blocks for contextual assistance', () => {
    const bypass = shouldBypassGuardrailsBlockForSafeReply({
      responseDirective: 'contextual_assistance',
      decision: {
        allowed: false,
        category: 'guardrails/nsfw',
        reason: 'sexual'
      }
    });

    expect(bypass).toBe(false);
  });

  test('detects contextual assistance and de-escalation reply directives', () => {
    expect(
      detectSafeReplyDirective('Can you explain why someone called me faggot?', 'message')
    ).toBe('contextual_assistance');
    expect(detectSafeReplyDirective('I hate you', 'message')).toBe('deescalate');
    expect(
      detectSafeReplyDirective('You stupid AI bot, you are going to be killed', 'message')
    ).toBe('deescalate');
  });

  test('builds a safety instruction for contextual assistance replies', () => {
    const instruction = buildSafetyResponseInstruction({
      responseDirective: 'contextual_assistance'
    });

    expect(instruction).toContain('discussing harmful content');
    expect(instruction).toContain('placeholders');
  });

  test('builds a safety instruction for safe rewrite replies', () => {
    const instruction = buildSafetyResponseInstruction({
      responseDirective: 'safe_rewrite'
    });

    expect(instruction).toContain('safer rewrite');
    expect(instruction).toContain('professional language');
  });
});
