import { describe, expect, test } from 'bun:test';
import { Pool } from 'pg';
import {
  sentimentClassifier,
  buildSentimentStyleInstruction,
  shouldApplySentiment
} from '../../security/sentiment-classifier';

type PromptSample = {
  guild_id: string;
  user_id: string;
  content: string;
};

type UserMemoryRow = {
  user_id: string;
  memory_content: string;
};

function buildBaselineAnswer(prompt: string, memoryHint: string): string {
  const core = prompt.replace(/\s+/g, ' ').trim().slice(0, 180);
  const memoryPart = memoryHint ? ` Context: ${memoryHint.slice(0, 90)}.` : '';
  return `Here is a direct answer to your request: ${core}.${memoryPart}`;
}

function buildSentimentAwareAnswer(
  baseline: string,
  styleInstruction: string,
  sentimentApplied: boolean
): string {
  if (!sentimentApplied || !styleInstruction) {
    return baseline;
  }

  const empathyPrefix =
    styleInstruction.includes('Acknowledge frustration briefly') ||
    styleInstruction.includes('clarifying question')
      ? 'I hear you. '
      : 'Understood. ';

  return `${empathyPrefix}${baseline}`;
}

describe('sentiment local supabase synthetic comparison', () => {
  test('shows measurable answer-shape changes on local supabase prompt samples', async () => {
    if (process.env.RUN_SYNTHETIC_DB_TESTS !== 'true') {
      expect(true).toBe(true);
      return;
    }

    const previousMode = process.env.SENTIMENT_MODE;
    const previousEnabled = process.env.SENTIMENT_ENABLED;
    const previousMinConfidence = process.env.SENTIMENT_MIN_CONFIDENCE;
    process.env.SENTIMENT_ENABLED = 'true';
    process.env.SENTIMENT_MIN_CONFIDENCE = '0.55';
    process.env.SENTIMENT_MODE = 'heuristic';

    const connectionString =
      process.env.LOCAL_SUPABASE_DB_URL ||
      'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
    const pool = new Pool({ connectionString, connectionTimeoutMillis: 3000 });

    try {
      const promptResult = await pool.query<PromptSample>(
        `SELECT guild_id, user_id, content
         FROM conversation_messages
         WHERE role = 'user' AND content IS NOT NULL AND length(trim(content)) > 0
         ORDER BY created_at DESC
         LIMIT 30`
      );

      if (promptResult.rows.length === 0) {
        expect(true).toBe(true);
        return;
      }

      const userIds = [...new Set(promptResult.rows.map(row => row.user_id))];
      const tableCheck = await pool.query<{ exists: string | null }>(
        `SELECT to_regclass('public.user_memory') as exists`
      );
      const hasUserMemoryTable = Boolean(tableCheck.rows[0]?.exists);
      const memoryMap = new Map<string, string>();
      if (hasUserMemoryTable && userIds.length > 0) {
        const memoryResult = await pool.query<UserMemoryRow>(
          `SELECT DISTINCT ON (user_id) user_id, memory_content
           FROM user_memory
           WHERE user_id = ANY($1::text[])
           ORDER BY user_id, updated_at DESC`,
          [userIds]
        );
        for (const row of memoryResult.rows) {
          memoryMap.set(row.user_id, row.memory_content);
        }
      }

      const sampledRows = [...promptResult.rows];
      const seed = promptResult.rows[0];
      if (seed) {
        sampledRows.push({
          guild_id: seed.guild_id,
          user_id: seed.user_id,
          content: `${seed.content} I am frustrated and confused, and this is urgent.`
        });
      }

      let changedCount = 0;
      let appliedCount = 0;

      for (const row of sampledRows) {
        const memoryHint = memoryMap.get(row.user_id) || '';
        const baseline = buildBaselineAnswer(row.content, memoryHint);
        const sentiment = await sentimentClassifier.classifyPrompt(row.content);
        const styleInstruction = buildSentimentStyleInstruction(sentiment);
        const sentimentApplied = shouldApplySentiment(sentiment);
        const shaped = buildSentimentAwareAnswer(baseline, styleInstruction, sentimentApplied);

        if (sentimentApplied) {
          appliedCount += 1;
        }
        if (shaped !== baseline) {
          changedCount += 1;
        }
      }

      // Expect at least one sentiment-applied delta when data has emotional variance.
      expect(appliedCount).toBeGreaterThan(0);
      expect(changedCount).toBeGreaterThan(0);
    } finally {
      await pool.end();
      process.env.SENTIMENT_MODE = previousMode;
      process.env.SENTIMENT_ENABLED = previousEnabled;
      process.env.SENTIMENT_MIN_CONFIDENCE = previousMinConfidence;
    }
  }, 20000);
});
