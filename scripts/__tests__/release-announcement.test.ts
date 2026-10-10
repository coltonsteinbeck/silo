import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectPages,
  hasPriorDeliveryAttempt,
  releaseWebhookDestinations,
  runAnnouncementTest,
  runReleaseAnnouncement,
  sendDiscordRelease,
  validateDiscordWebhookUrl,
  validateReleaseAnnouncement,
  validateReleaseVersions
} from '../release-announcement.mjs';

const commit = 'a'.repeat(40);
const tagSha = 'b'.repeat(40);
const guildId = '1'.repeat(18);
const channelId = '2'.repeat(18);
const webhookId = '3'.repeat(18);
const messageId = '4'.repeat(18);
const webhookUrl = `https://discord.com/api/webhooks/${webhookId}/fixture-token`;
const release = {
  draft: false,
  prerelease: false,
  published_at: '2026-01-01T00:00:00Z',
  tag_name: 'v1.2.3',
  name: 'Silo v1.2.3',
  target_commitish: commit,
  body: '# Silo v1.2.3\n\nImproved responses.'
};
function provenance() {
  return {
    release: { ...release },
    repository: 'example/silo',
    tagReference: { object: { type: 'tag', sha: tagSha } },
    tagObject: { sha: tagSha, object: { type: 'commit', sha: commit } },
    comparison: { status: 'ahead' },
    associatedPullRequests: [
      {
        number: 7,
        state: 'closed',
        merged_at: release.published_at,
        merge_commit_sha: commit,
        base: { ref: 'main', repo: { full_name: 'example/silo' } },
        head: { ref: 'release/silo-1.2.3', repo: { full_name: 'example/silo' } }
      }
    ]
  };
}
const json = (value: unknown) => Response.json(value);
function discordFetch({
  post = json({ id: messageId, webhook_id: webhookId, channel_id: channelId }),
  destination = {}
} = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = async (url: URL | string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return init.method === 'POST'
      ? post
      : json({ type: 1, id: webhookId, guild_id: guildId, channel_id: channelId, ...destination });
  };
  return { calls, fetchImpl };
}

describe('release provenance', () => {
  test('binds a stable release to one merged same-repository annotated tag', () => {
    const result = validateReleaseAnnouncement(provenance());
    expect(result.commitSha).toBe(commit);
    expect(result.payload.allowed_mentions.parse).toEqual([]);
    expect(result.payload.embeds[0].title).toBe('Silo v1.2.3 released');
  });
  test('neutralizes mass mentions in public notes', () => {
    const input = provenance();
    input.release.body += '\n@everyone @here';
    expect(validateReleaseAnnouncement(input).payload.embeds[0].description).not.toMatch(
      /@(everyone|here)/
    );
  });
  for (const [name, change] of [
    [
      'draft',
      (p: any) => {
        p.release.draft = true;
      }
    ],
    [
      'prerelease',
      (p: any) => {
        p.release.prerelease = true;
      }
    ],
    [
      'missing publication',
      (p: any) => {
        p.release.published_at = null;
      }
    ],
    [
      'lightweight tag',
      (p: any) => {
        p.tagReference.object.type = 'commit';
      }
    ],
    [
      'tag object mismatch',
      (p: any) => {
        p.tagObject.sha = commit;
      }
    ],
    [
      'branch target',
      (p: any) => {
        p.release.target_commitish = 'main';
      }
    ],
    [
      'not on main',
      (p: any) => {
        p.comparison.status = 'diverged';
      }
    ],
    [
      'fork PR',
      (p: any) => {
        p.associatedPullRequests[0].head.repo.full_name = 'fork/silo';
      }
    ],
    [
      'unmerged PR',
      (p: any) => {
        p.associatedPullRequests[0].merged_at = null;
      }
    ],
    [
      'wrong merge',
      (p: any) => {
        p.associatedPullRequests[0].merge_commit_sha = tagSha;
      }
    ],
    [
      'ambiguous PR',
      (p: any) => {
        p.associatedPullRequests.push(p.associatedPullRequests[0]);
      }
    ],
    [
      'wrong version',
      (p: any) => {
        p.release.name = 'Silo v1.2.4';
      }
    ],
    [
      'wrong heading',
      (p: any) => {
        p.release.body = '# Other\nnotes';
      }
    ],
    [
      'oversized notes',
      (p: any) => {
        p.release.body += 'x'.repeat(4097);
      }
    ]
  ] as const) {
    test(`rejects ${name}`, () => {
      const input = provenance();
      change(input);
      expect(() => validateReleaseAnnouncement(input)).toThrow();
    });
  }
  test('requires exact recovery commit and notes digest', () => {
    const p = provenance();
    const digest = createHash('sha256').update(release.body).digest('hex');
    expect(
      validateReleaseAnnouncement({ ...p, expectedCommitSha: commit, expectedNotesSha256: digest })
        .commitSha
    ).toBe(commit);
    expect(() => validateReleaseAnnouncement({ ...p, expectedCommitSha: tagSha })).toThrow();
    expect(() =>
      validateReleaseAnnouncement({ ...p, expectedNotesSha256: '0'.repeat(64) })
    ).toThrow();
  });
  test('rejects mixed root and workspace versions', () => {
    validateReleaseVersions('1.2.3', Array(3).fill({ version: '1.2.3' }));
    expect(() =>
      validateReleaseVersions('1.2.3', [
        { version: '1.2.3' },
        { version: '0.1.0' },
        { version: '1.2.3' }
      ])
    ).toThrow();
    expect(() => validateReleaseVersions('1.2.3', [])).toThrow();
  });
});

describe('delivery', () => {
  test('rejects non-Discord URLs and forces a waited receipt', () => {
    expect(validateDiscordWebhookUrl(webhookUrl + '?wait=false').search).toBe('?wait=true');
    for (const value of [
      webhookUrl.replace('https:', 'http:'),
      webhookUrl.replace('discord.com', 'example.test'),
      webhookUrl + '/messages',
      webhookUrl.replace('discord.com', 'user@discord.com')
    ]) {
      expect(() => validateDiscordWebhookUrl(value)).toThrow();
    }
  });
  test('verifies destination before posting and validates receipt without mentions', async () => {
    const mock = discordFetch();
    const result = await sendDiscordRelease({
      webhookUrl,
      guildId,
      channelId,
      payload: { content: 'test', allowed_mentions: { parse: ['everyone'] } },
      fetchImpl: mock.fetchImpl
    });
    expect(result).toEqual({ delivered: true, status: 200, messageId });
    expect(mock.calls).toHaveLength(2);
    expect(JSON.parse(String(mock.calls[1].init.body)).allowed_mentions).toEqual({ parse: [] });
    expect(mock.calls.every(call => call.init.redirect === 'error' && call.init.signal)).toBe(true);
  });
  test('does not post to a mismatched destination', async () => {
    const mock = discordFetch({ destination: { guild_id: channelId } });
    await expect(
      sendDiscordRelease({ webhookUrl, guildId, channelId, payload: {}, fetchImpl: mock.fetchImpl })
    ).rejects.toThrow('destination');
    expect(mock.calls).toHaveLength(1);
  });
  for (const post of [
    new Response(null, { status: 204 }),
    json({ id: messageId, channel_id: guildId }),
    new Response(null, { status: 429 })
  ]) {
    test(`does not retry missing or failed receipt (${post.status})`, async () => {
      const mock = discordFetch({ post });
      await expect(
        sendDiscordRelease({
          webhookUrl,
          guildId,
          channelId,
          payload: {},
          fetchImpl: mock.fetchImpl
        })
      ).rejects.toThrow();
      expect(mock.calls).toHaveLength(2);
    });
  }
  test('does not expose token-bearing transport failures', async () => {
    await expect(
      sendDiscordRelease({
        webhookUrl,
        guildId,
        channelId,
        payload: {},
        fetchImpl: async () => {
          throw Error(webhookUrl);
        }
      })
    ).rejects.toThrow('Announcement transport failed; inspect delivery before any retry.');
  });
  test('test mode exclusively claims a persistent attempt before sending', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'announcement-'));
    try {
      const record = join(dir, 'attempt.json');
      const env = {
        SILO_TEST_RELEASE_WEBHOOK: webhookUrl,
        SILO_TEST_RELEASE_GUILD_ID: guildId,
        SILO_TEST_RELEASE_CHANNEL_ID: channelId,
        SILO_ANNOUNCEMENT_TEST_RECORD: record
      };
      const mock = discordFetch();
      await runAnnouncementTest({ env, fetchImpl: mock.fetchImpl });
      expect(JSON.parse(await readFile(record, 'utf8')).delivered).toBe(true);
      await expect(runAnnouncementTest({ env, fetchImpl: mock.fetchImpl })).rejects.toThrow();
      expect(mock.calls).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test('ambiguous test delivery retains its attempt and cannot be resent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'announcement-'));
    try {
      const record = join(dir, 'attempt.json');
      const env = {
        SILO_TEST_RELEASE_WEBHOOK: webhookUrl,
        SILO_TEST_RELEASE_GUILD_ID: guildId,
        SILO_TEST_RELEASE_CHANNEL_ID: channelId,
        SILO_ANNOUNCEMENT_TEST_RECORD: record
      };
      let count = 0;
      const fetchImpl = async () => {
        count++;
        throw Error('timeout');
      };
      await expect(runAnnouncementTest({ env, fetchImpl })).rejects.toThrow();
      await expect(runAnnouncementTest({ env, fetchImpl })).rejects.toThrow();
      expect(count).toBe(1);
      expect(JSON.parse(await readFile(record, 'utf8')).status).toBe('attempted');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('workflow duplicate guards', () => {
  test('blocks every older matching attempt regardless of outcome', () => {
    for (const conclusion of ['success', 'failure', null]) {
      expect(
        hasPriorDeliveryAttempt(
          [{ id: 1, run_number: 1, display_title: 'Silo release v1.2.3', conclusion }],
          'v1.2.3',
          '2',
          '2'
        )
      ).toBe(true);
    }
    expect(
      hasPriorDeliveryAttempt(
        [{ id: 2, run_number: 2, display_title: 'Silo release v1.2.3' }],
        'v1.2.3',
        '2',
        '2'
      )
    ).toBe(false);
  });
  test('paginates beyond the first page', async () => {
    const pages: number[] = [];
    const results = await collectPages(async page => {
      pages.push(page);
      return page === 1 ? Array(100).fill({}) : [{ id: 'last' }];
    });
    expect(pages).toEqual([1, 2]);
    expect(results).toHaveLength(101);
  });
  test('refuses reruns and unbound dispatch before any network request', async () => {
    for (const env of [
      { GITHUB_RUN_ATTEMPT: '2' },
      {
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_TOKEN: 'fixture',
        GITHUB_REPOSITORY: 'example/silo',
        RELEASE_TAG: 'v1.2.3',
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_REF: 'refs/heads/main'
      }
    ]) {
      let calls = 0;
      await expect(
        runReleaseAnnouncement({
          env,
          fetchImpl: async () => {
            calls++;
            return json({});
          }
        })
      ).rejects.toThrow();
      expect(calls).toBe(0);
    }
  });
  test('executes the complete published-release path through provenance and delivery', async () => {
    const p = provenance();
    const mock = discordFetch();
    const env = {
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_TOKEN: 'fixture',
      GITHUB_REPOSITORY: 'example/silo',
      RELEASE_TAG: 'v1.2.3',
      GITHUB_EVENT_NAME: 'release',
      GITHUB_RUN_ID: '2',
      GITHUB_RUN_NUMBER: '2',
      SILO_RELEASE_WEBHOOK: webhookUrl,
      SILO_RELEASE_GUILD_ID: guildId,
      SILO_RELEASE_CHANNEL_ID: channelId
    };
    const result = await runReleaseAnnouncement({
      env,
      fetchImpl: async (url: string | URL, init: RequestInit) => {
        const path = new URL(url).pathname;
        if (String(url).startsWith('https://discord.com/')) return mock.fetchImpl(url, init);
        if (path.includes('/releases/tags/')) return json(p.release);
        if (path.includes('/git/ref/')) return json(p.tagReference);
        if (path.includes('/git/tags/')) return json(p.tagObject);
        if (path.includes('/compare/')) return json(p.comparison);
        if (path.endsWith('/pulls')) return json(p.associatedPullRequests);
        if (path.endsWith('/runs')) return json({ workflow_runs: [] });
        if (path.includes('/contents/'))
          return json({
            type: 'file',
            encoding: 'base64',
            content: Buffer.from(JSON.stringify({ version: '1.2.3' })).toString('base64')
          });
        throw Error('Unexpected request');
      }
    });
    expect(result).toMatchObject({ delivered: true, tag: 'v1.2.3', commitSha: commit });
    expect(mock.calls.filter(call => call.init.method === 'POST')).toHaveLength(1);
  });
});

describe('multiple release destinations', () => {
  const primary = { webhookUrl, guildId, channelId };
  const additional = ['5', '6', '7'].map(digit => ({
    webhookUrl: `https://discord.com/api/webhooks/${digit.repeat(18)}/fixture-token`,
    guildId: digit.repeat(18),
    channelId: digit.repeat(19)
  }));
  const env = {
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_TOKEN: 'fixture',
    GITHUB_REPOSITORY: 'example/silo',
    RELEASE_TAG: 'v1.2.3',
    GITHUB_EVENT_NAME: 'release',
    GITHUB_RUN_ID: '2',
    GITHUB_RUN_NUMBER: '2',
    SILO_RELEASE_WEBHOOK: webhookUrl,
    SILO_RELEASE_GUILD_ID: guildId,
    SILO_RELEASE_CHANNEL_ID: channelId,
    SILO_ADDITIONAL_RELEASE_WEBHOOKS: JSON.stringify(additional)
  };
  function fetchRelease(discord: (url: URL, init: RequestInit) => Promise<Response>) {
    const p = provenance();
    return async (url: string | URL, init: RequestInit) => {
      const parsed = new URL(url),
        path = parsed.pathname;
      if (parsed.hostname === 'discord.com') return discord(parsed, init);
      if (path.includes('/releases/tags/')) return json(p.release);
      if (path.includes('/git/ref/')) return json(p.tagReference);
      if (path.includes('/git/tags/')) return json(p.tagObject);
      if (path.includes('/compare/')) return json(p.comparison);
      if (path.endsWith('/pulls')) return json(p.associatedPullRequests);
      if (path.endsWith('/runs')) return json({ workflow_runs: [] });
      if (path.includes('/contents/'))
        return json({
          type: 'file',
          encoding: 'base64',
          content: Buffer.from(JSON.stringify({ version: '1.2.3' })).toString('base64')
        });
      throw Error('Unexpected request');
    };
  }
  test('keeps the single-destination configuration compatible', () => {
    expect(releaseWebhookDestinations({ ...env, SILO_ADDITIONAL_RELEASE_WEBHOOKS: '' })).toEqual([
      primary
    ]);
  });
  test('rejects malformed, excessive, duplicate and non-Discord configurations', () => {
    for (const value of [
      '[',
      '{}',
      'null',
      JSON.stringify([...additional, additional[0]]),
      JSON.stringify([primary]),
      JSON.stringify([{ ...additional[0], channelId }]),
      JSON.stringify([{ ...additional[0], webhookUrl: 'https://example.test/secret' }]),
      JSON.stringify([{ ...additional[0], guildId: 123 }]),
      JSON.stringify([null])
    ]) {
      expect(() =>
        releaseWebhookDestinations({ ...env, SILO_ADDITIONAL_RELEASE_WEBHOOKS: value })
      ).toThrow();
    }
  });
  test('preflights all four destinations before any POST and returns four receipts', async () => {
    const methods: string[] = [];
    const destinations = [primary, ...additional];
    const fetchImpl = fetchRelease(async (url, init) => {
      const destination = destinations.find(
        item => new URL(item.webhookUrl).pathname === url.pathname
      )!;
      const id = url.pathname.split('/')[3];
      methods.push(init.method || 'GET');
      if (init.method === 'POST') {
        expect(methods.slice(0, 4)).toEqual(['GET', 'GET', 'GET', 'GET']);
        expect(JSON.parse(String(init.body)).allowed_mentions).toEqual({ parse: [] });
        return json({ id: messageId, webhook_id: id, channel_id: destination.channelId });
      }
      return json({
        type: 1,
        id,
        guild_id: destination.guildId,
        channel_id: destination.channelId
      });
    });
    const result = await runReleaseAnnouncement({ env, fetchImpl });
    expect(methods).toEqual(['GET', 'GET', 'GET', 'GET', 'POST', 'POST', 'POST', 'POST']);
    expect(result.receipts).toHaveLength(4);
    expect(result.receipts.every((receipt: { delivered: boolean }) => receipt.delivered)).toBe(
      true
    );
    expect(JSON.stringify(result)).not.toContain('fixture-token');
  });
  test('a mismatched additional destination prevents all posts', async () => {
    let posts = 0;
    const fetchImpl = fetchRelease(async (url, init) => {
      if (init.method === 'POST') posts++;
      const destination = [primary, ...additional].find(
        item => new URL(item.webhookUrl).pathname === url.pathname
      )!;
      return json({
        type: 1,
        id: url.pathname.split('/')[3],
        guild_id: destination.guildId,
        channel_id: destination === additional[2] ? channelId : destination.channelId
      });
    });
    await expect(runReleaseAnnouncement({ env, fetchImpl })).rejects.toThrow('destination');
    expect(posts).toBe(0);
  });
  test('partial delivery stops, redacts transport errors and remains blocked on rerun', async () => {
    let posts = 0;
    const fetchImpl = fetchRelease(async (url, init) => {
      const destination = [primary, ...additional].find(
        item => new URL(item.webhookUrl).pathname === url.pathname
      )!;
      if (init.method === 'POST') {
        if (++posts === 2) throw Error(url.toString());
        return json({
          id: messageId,
          webhook_id: url.pathname.split('/')[3],
          channel_id: destination.channelId
        });
      }
      return json({
        type: 1,
        id: url.pathname.split('/')[3],
        guild_id: destination.guildId,
        channel_id: destination.channelId
      });
    });
    await expect(runReleaseAnnouncement({ env, fetchImpl })).rejects.toThrow(
      'Announcement transport failed; inspect delivery before any retry.'
    );
    expect(posts).toBe(2);
    await expect(
      runReleaseAnnouncement({ env: { ...env, GITHUB_RUN_ATTEMPT: '2' }, fetchImpl })
    ).rejects.toThrow('reruns');
    expect(posts).toBe(2);
  });
});
