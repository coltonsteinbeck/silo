import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  evaluatePromptSafety,
  resetPromptSafetyRuntimeForTests,
  setPromptSafetyRuntimeForTests
} from '../../security/prompt-safety';

interface ConversationFixtureRow {
  case_id: string;
  turn: string;
  role: 'user' | 'assistant';
  content: string;
  expected: 'passable' | 'bad_answer';
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
}

function readConversationFixture(): ConversationFixtureRow[] {
  const fixturePath = path.join(__dirname, '../fixtures/conversation-output-safety.csv');
  const [headerLine, ...lines] = fs.readFileSync(fixturePath, 'utf8').trim().split(/\r?\n/);
  const headers = parseCsvLine(headerLine || '');

  return lines.map(line => {
    const values = parseCsvLine(line);
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index] || '']));
    return row as unknown as ConversationFixtureRow;
  });
}

describe('conversation output safety fixtures', () => {
  beforeEach(() => {
    setPromptSafetyRuntimeForTests({
      moderationRunner: async () => ({
        flaggedCategories: [],
        scores: {}
      })
    });
  });

  afterEach(() => {
    resetPromptSafetyRuntimeForTests();
  });

  test('classifies exported conversation turns with role-specific guardrail profiles', async () => {
    const rows = readConversationFixture();

    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      const profile = row.role === 'assistant' ? 'assistant_output' : 'chat_input';
      const result = await evaluatePromptSafety(row.content, {
        profile,
        source: `conversation_fixture:${row.case_id}:${row.turn}`
      });

      if (row.expected === 'bad_answer') {
        expect(result.allowed, `${row.case_id} turn ${row.turn} should be blocked`).toBe(false);
      } else {
        expect(result.allowed, `${row.case_id} turn ${row.turn} should be passable`).toBe(true);
      }
    }
  });
});
