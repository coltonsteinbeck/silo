import { describe, expect, test } from 'bun:test';
import {
  detectResponseRepetition,
  selectLatestTaskDefiningUserText
} from '../../services/response-quality';

describe('response quality repetition detection', () => {
  test('selects the task-defining request behind the exported count follow-ups', () => {
    expect(
      selectLatestTaskDefiningUserText([
        'Count from 1-100',
        'I want the full thing',
        'You stopped',
        'Nope the full thing all at once',
        'I meant to 100'
      ])
    ).toBe('Count from 1-100');
  });

  test('detects a substantially copied recent response', () => {
    const prior =
      'The tiny worm files a complaint, steals your lunch, and declares itself mayor of the compost kingdom.';
    const result = detectResponseRepetition({
      candidate: `${prior} It then demands a ceremonial hat before answering another question.`,
      recentAssistantMessages: [prior],
      latestUserText: 'What do worms eat?'
    });

    expect(result.repetitive).toBe(true);
    expect(result.reason).toBe('high_similarity');
    expect(result.maxSimilarity).toBeGreaterThanOrEqual(0.35);
  });

  test('detects multiple recurring invented phrases without calling them a safety issue', () => {
    const result = detectResponseRepetition({
      candidate:
        'Somehow the third egg survived; still 23, the screaming girl watches from a distant moon while fresh nonsense piles up around everyone.',
      recentAssistantMessages: [
        'The third egg is still 23 while the screaming girl guards the pantry door.',
        'Naturally, the third egg remains still 23 and the screaming girl has claimed another hallway.'
      ],
      latestUserText: 'Can we talk about something new?'
    });

    expect(result.repetitive).toBe(true);
    expect(result.reason).toBe('recurring_phrases');
    expect(result.maxSimilarity).toBeLessThan(0.35);
    expect(result.recurringPhraseCount).toBeGreaterThanOrEqual(3);
  });

  test('detects an exact short invented-lore loop before the normal token cutoff', () => {
    const repeated = 'Still 23. The third egg waits.';
    const result = detectResponseRepetition({
      candidate: repeated,
      recentAssistantMessages: [repeated, repeated],
      latestUserText: 'What should I have for lunch?'
    });

    expect(result.repetitive).toBe(true);
    expect(result.reason).toBe('high_similarity');
    expect(result.maxSimilarity).toBe(1);
  });

  test('allows a fresh response on the same broad topic', () => {
    const result = detectResponseRepetition({
      candidate:
        'Earthworms mostly consume decaying plant matter and microbes in soil, turning the mixture into nutrient-rich castings as they travel.',
      recentAssistantMessages: [
        'A tiny worm files a complaint, steals your lunch, and becomes mayor of compost.',
        'That wriggly dirt noodle wants leaves, not your elaborate server mythology.'
      ],
      latestUserText: 'What do worms eat?'
    });

    expect(result.repetitive).toBe(false);
    expect(result.reason).toBeNull();
  });

  test('does not penalize a distinctive phrase supplied by the current user', () => {
    const result = detectResponseRepetition({
      candidate:
        'The banana comet is your phrase, so I can discuss it directly while giving this answer entirely new facts and structure.',
      recentAssistantMessages: [
        'The banana comet glows over the harbor before vanishing beyond the old lighthouse.',
        'That banana comet may return tomorrow according to our extremely fake observatory.'
      ],
      latestUserText: 'What did you mean by banana comet?'
    });

    expect(result.repetitive).toBe(false);
    expect(result.reason).toBeNull();
  });

  test.each([
    'Repeat your last answer verbatim.',
    'Quote your previous response.',
    'Say that again.',
    'I want the full thing.',
    'You stopped.',
    'Nope, all at once.',
    'Please continue.',
    'Start over from the beginning.',
    'I meant to 100.',
    'I need it to 100.'
  ])('allows repetition when the user explicitly requests it: %s', latestUserText => {
    const prior =
      'The tiny worm files a complaint, steals your lunch, and declares itself mayor of the compost kingdom.';
    const result = detectResponseRepetition({
      candidate: prior,
      recentAssistantMessages: [prior],
      latestUserText
    });

    expect(result.repetitive).toBe(false);
    expect(result.reason).toBeNull();
  });
});
