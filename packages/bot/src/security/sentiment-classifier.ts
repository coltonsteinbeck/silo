import OpenAI from 'openai';
import { logger } from '@silo/core';

export type SentimentLabel = 'negative' | 'neutral' | 'positive' | 'mixed';

export interface SentimentClassification {
  label: SentimentLabel;
  score: number;
  confidence: number;
  urgency: number;
  frustration: number;
  confusion: number;
  source: 'ai' | 'heuristic';
}

interface RuntimeOverrides {
  classifyWithAi?: (
    text: string,
    context: 'prompt' | 'response'
  ) => Promise<SentimentClassification | null>;
}

let openaiClient: OpenAI | null = null;
let runtimeOverrides: RuntimeOverrides = {};

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampScore(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

function getOpenAiClient(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

function getTimeoutMs(): number {
  const timeoutMs = parseNumber(process.env.SENTIMENT_TIMEOUT_MS, 1200);
  return Math.max(150, Math.min(4000, timeoutMs));
}

function getMinConfidence(): number {
  return clamp01(parseNumber(process.env.SENTIMENT_MIN_CONFIDENCE, 0.6));
}

export function isSentimentEnabled(): boolean {
  return parseBoolean(process.env.SENTIMENT_ENABLED, true);
}

export function resetSentimentRuntimeForTests(): void {
  openaiClient = null;
  runtimeOverrides = {};
}

export function setSentimentRuntimeForTests(overrides: RuntimeOverrides): void {
  runtimeOverrides = overrides;
}

function classifyWithHeuristics(text: string): SentimentClassification {
  const normalized = text.toLowerCase();
  const negativeSignals = [
    'angry',
    'frustrated',
    'upset',
    'hate',
    'broken',
    'terrible',
    'annoying',
    'wtf',
    'awful'
  ];
  const positiveSignals = ['great', 'awesome', 'thanks', 'love', 'helpful', 'perfect', 'nice'];
  const urgencySignals = ['urgent', 'asap', 'now', 'immediately', 'quickly', 'right away'];
  const confusionSignals = ['confused', 'unclear', 'not sure', "don't understand", 'why'];

  const neg = negativeSignals.reduce((acc, token) => acc + (normalized.includes(token) ? 1 : 0), 0);
  const pos = positiveSignals.reduce((acc, token) => acc + (normalized.includes(token) ? 1 : 0), 0);
  const urgencyRaw = urgencySignals.reduce(
    (acc, token) => acc + (normalized.includes(token) ? 1 : 0),
    0
  );
  const confusionRaw = confusionSignals.reduce(
    (acc, token) => acc + (normalized.includes(token) ? 1 : 0),
    0
  );

  const rawScore = (pos - neg) / Math.max(1, pos + neg + 1);
  const score = clampScore(rawScore);
  const frustration = clamp01(neg / 3);
  const urgency = clamp01(urgencyRaw / 3);
  const confusion = clamp01(confusionRaw / 3);

  let label: SentimentLabel = 'neutral';
  if (Math.abs(score) < 0.1 && (pos > 0 || neg > 0)) {
    label = 'mixed';
  } else if (score <= -0.2) {
    label = 'negative';
  } else if (score >= 0.2) {
    label = 'positive';
  }

  const confidence = clamp01(
    0.45 + Math.min(0.4, (pos + neg) * 0.1 + urgency * 0.05 + confusion * 0.05)
  );

  return {
    label,
    score,
    confidence,
    urgency,
    frustration,
    confusion,
    source: 'heuristic'
  };
}

export function classifyPromptDeterministic(text: string): SentimentClassification | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  return classifyWithHeuristics(trimmed);
}

async function classifyWithAi(
  text: string,
  context: 'prompt' | 'response'
): Promise<SentimentClassification | null> {
  if (runtimeOverrides.classifyWithAi) {
    return runtimeOverrides.classifyWithAi(text, context);
  }

  if (!process.env.OPENAI_API_KEY) {
    return null;
  }

  const model = process.env.OPENAI_SENTIMENT_MODEL || 'gpt-4.1-mini';
  const system =
    'Classify sentiment and tone. Return strict JSON with keys: label, score, confidence, urgency, frustration, confusion. label must be one of negative, neutral, positive, mixed. score in [-1,1]. other numeric fields in [0,1].';

  const completion = await getOpenAiClient().chat.completions.create({
    model,
    temperature: 0,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: `context=${context}\ntext=${text.slice(0, 1200)}`
      }
    ],
    response_format: { type: 'json_object' }
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) {
    return null;
  }

  const parsed = JSON.parse(content) as Partial<SentimentClassification>;
  const label = parsed.label;
  if (!label || !['negative', 'neutral', 'positive', 'mixed'].includes(label)) {
    return null;
  }

  return {
    label,
    score: clampScore(typeof parsed.score === 'number' ? parsed.score : 0),
    confidence: clamp01(typeof parsed.confidence === 'number' ? parsed.confidence : 0.5),
    urgency: clamp01(typeof parsed.urgency === 'number' ? parsed.urgency : 0),
    frustration: clamp01(typeof parsed.frustration === 'number' ? parsed.frustration : 0),
    confusion: clamp01(typeof parsed.confusion === 'number' ? parsed.confusion : 0),
    source: 'ai'
  };
}

async function classify(
  text: string,
  context: 'prompt' | 'response'
): Promise<SentimentClassification | null> {
  if (!isSentimentEnabled()) {
    return null;
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const heuristic = classifyWithHeuristics(trimmed);
  const mode = (process.env.SENTIMENT_MODE || 'hybrid').toLowerCase();
  if (mode === 'heuristic') {
    return heuristic;
  }

  const timeoutMs = getTimeoutMs();
  const timeoutPromise = new Promise<null>(resolve => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref?.();
  });

  try {
    const aiResult = await Promise.race([classifyWithAi(trimmed, context), timeoutPromise]);
    if (aiResult) {
      return aiResult;
    }
  } catch (error) {
    logger.warn('Sentiment AI classification failed; using heuristic fallback', {
      context,
      error
    });
  }

  return heuristic;
}

export function shouldApplySentiment(classification: SentimentClassification | null): boolean {
  return Boolean(classification && classification.confidence >= getMinConfidence());
}

export function buildSentimentStyleInstruction(
  classification: SentimentClassification | null
): string {
  if (!shouldApplySentiment(classification) || !classification) {
    return '';
  }

  const clauses: string[] = [
    'Response tone rule: Keep the response calm, concise, and actionable.'
  ];

  if (classification.frustration >= 0.45) {
    clauses.push('Acknowledge frustration briefly, then offer the fastest safe next step.');
  }
  if (classification.confusion >= 0.45) {
    clauses.push('Use plain language and include one clarifying question if intent is ambiguous.');
  }
  if (classification.urgency >= 0.45) {
    clauses.push('Prioritize immediate steps first, then optional detail.');
  }

  return `\n\n${clauses.join(' ')}`;
}

export const sentimentClassifier = {
  classifyPrompt: (text: string) => classify(text, 'prompt'),
  classifyResponse: (text: string) => classify(text, 'response')
};
