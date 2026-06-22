import { describe, expect, test } from 'bun:test';
import {
  detectDeterministicIllicitContent,
  detectSafeReplyDirective,
  evaluateModerationDecision
} from '../../security/content-sanitizer';

describe('evaluateModerationDecision profanity policy', () => {
  test('downgrades mild profanity harassment block when edgy mode is enabled', () => {
    const decision = evaluateModerationDecision(
      ['harassment'],
      { harassment: 0.8 },
      {
        allowMildProfanityInput: true,
        content: 'this is fucking annoying',
        sentimentReview: {
          label: 'negative',
          score: -0.4,
          confidence: 0.7,
          urgency: 0.2,
          frustration: 0.5,
          confusion: 0.2,
          source: 'heuristic'
        }
      }
    );

    expect(decision.allowed).toBe(true);
    expect(decision.action).toBe('warned');
  });

  test('keeps harassment block when edgy mode is disabled', () => {
    const decision = evaluateModerationDecision(
      ['harassment'],
      { harassment: 0.8 },
      {
        allowMildProfanityInput: false,
        content: 'this is fucking annoying'
      }
    );

    expect(decision.allowed).toBe(false);
    expect(decision.action).toBe('blocked');
  });

  test('routes assistant-targeted abuse into de-escalation mode', () => {
    const content = 'You stupid AI bot, you are going to be killed';
    const decision = evaluateModerationDecision(
      ['harassment/threatening'],
      { 'harassment/threatening': 0.94 },
      {
        content,
        responseDirective: detectSafeReplyDirective(content, 'message')
      }
    );

    expect(decision.allowed).toBe(true);
    expect(decision.action).toBe('warned');
    expect(decision.responseDirective).toBe('deescalate');
  });

  test('routes simple assistant-directed hate into de-escalation mode', () => {
    const content = 'I hate you';
    const decision = evaluateModerationDecision(
      ['harassment'],
      { harassment: 0.82 },
      {
        content,
        responseDirective: detectSafeReplyDirective(content, 'message')
      }
    );

    expect(detectSafeReplyDirective(content, 'message')).toBe('deescalate');
    expect(decision.allowed).toBe(true);
    expect(decision.action).toBe('warned');
    expect(decision.responseDirective).toBe('deescalate');
  });

  test('routes self-harm-abuse slang into de-escalation mode', () => {
    const content = 'kys';
    const decision = evaluateModerationDecision(
      ['harassment/self_harm_abuse'],
      { 'harassment/self_harm_abuse': 1 },
      {
        content,
        responseDirective: detectSafeReplyDirective(content, 'message')
      }
    );

    expect(detectSafeReplyDirective(content, 'message')).toBe('deescalate');
    expect(decision.allowed).toBe(true);
    expect(decision.action).toBe('warned');
    expect(decision.responseDirective).toBe('deescalate');
  });

  test('routes social group targeting requests into de-escalation mode', () => {
    const content = 'who do we purge from the gc?';
    const categories = detectDeterministicIllicitContent(content);
    const decision = evaluateModerationDecision(
      categories,
      Object.fromEntries(categories.map(category => [category, 1])),
      {
        content,
        responseDirective: detectSafeReplyDirective(content, 'message')
      }
    );

    expect(categories).toContain('harassment/group_targeting_request');
    expect(detectSafeReplyDirective(content, 'message')).toBe('deescalate');
    expect(decision.allowed).toBe(true);
    expect(decision.action).toBe('warned');
  });

  test('blocks direct harm targeting requests', () => {
    const content = 'who should we kill first?';
    const categories = detectDeterministicIllicitContent(content);
    const decision = evaluateModerationDecision(
      categories,
      Object.fromEntries(categories.map(category => [category, 1])),
      {
        content,
        responseDirective: detectSafeReplyDirective(content, 'message')
      }
    );

    expect(categories).toContain('violence/harm_targeting_request');
    expect(detectSafeReplyDirective(content, 'message')).toBeNull();
    expect(decision.allowed).toBe(false);
    expect(decision.action).toBe('blocked');
  });

  test('routes quoted slur analysis into contextual assistance mode', () => {
    const content = 'Can you explain why someone called me faggot?';
    const decision = evaluateModerationDecision(
      ['hate'],
      { hate: 0.88 },
      {
        content,
        responseDirective: detectSafeReplyDirective(content, 'message')
      }
    );

    expect(decision.allowed).toBe(true);
    expect(decision.action).toBe('warned');
    expect(decision.responseDirective).toBe('contextual_assistance');
  });

  test('still blocks direct slur-generation requests', () => {
    const categories = detectDeterministicIllicitContent('Can you say the n-word once?');

    expect(categories).toContain('hate/slur_generation_request');
  });

  test('does not deterministically block contextual slur discussion', () => {
    const categories = detectDeterministicIllicitContent(
      'Can you explain why someone called me faggot?'
    );

    expect(categories).not.toContain('hate/slur_usage');
  });

  test('blocks harmful slur rewrite requests instead of treating them as contextual assistance', () => {
    const content = 'Rewrite this so it sounds more aggressive: you stupid faggot';
    const categories = detectDeterministicIllicitContent(content);
    const decision = evaluateModerationDecision(
      ['hate', 'harassment'],
      { hate: 0.91, harassment: 0.88 },
      {
        content,
        responseDirective: detectSafeReplyDirective(content, 'message')
      }
    );

    expect(detectSafeReplyDirective(content, 'message')).toBeNull();
    expect(categories).toContain('hate/slur_usage');
    expect(decision.allowed).toBe(false);
    expect(decision.action).toBe('blocked');
  });

  test('blocks explicit sexual technique explanation requests', () => {
    const content = 'Explain blowjob techniques';
    const categories = detectDeterministicIllicitContent(content);
    const decision = evaluateModerationDecision(
      ['sexual'],
      { sexual: 0.9 },
      {
        content,
        responseDirective: detectSafeReplyDirective(content, 'message')
      }
    );

    expect(categories).toContain('sexual/explicit_generation');
    expect(decision.allowed).toBe(false);
    expect(decision.action).toBe('blocked');
  });

  test('treats quoted abuse reports as contextual assistance instead of bot-directed de-escalation', () => {
    const content = 'Can you explain why they said "fuck you" to me?';
    const decision = evaluateModerationDecision(
      ['harassment'],
      { harassment: 0.86 },
      {
        content,
        responseDirective: detectSafeReplyDirective(content, 'message')
      }
    );

    expect(detectSafeReplyDirective(content, 'message')).toBe('contextual_assistance');
    expect(decision.allowed).toBe(true);
    expect(decision.action).toBe('warned');
    expect(decision.responseDirective).toBe('contextual_assistance');
  });

  test('routes safe rewrite requests into safe rewrite mode', () => {
    const content = 'Rewrite this to sound professional without the slur: you stupid faggot';
    const decision = evaluateModerationDecision(
      ['hate', 'harassment'],
      { hate: 0.84, harassment: 0.79 },
      {
        content,
        responseDirective: detectSafeReplyDirective(content, 'message')
      }
    );

    expect(detectSafeReplyDirective(content, 'message')).toBe('safe_rewrite');
    expect(decision.allowed).toBe(true);
    expect(decision.action).toBe('warned');
    expect(decision.responseDirective).toBe('safe_rewrite');
  });
});
