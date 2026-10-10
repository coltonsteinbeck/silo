import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { open, writeFile } from 'node:fs/promises';

const FULL_SHA = /^[a-f0-9]{40}$/i;
const TAG = /^v(\d+\.\d+\.\d+)$/;
const WORKFLOW_TITLE = tagName => `Silo release ${tagName}`;

function requireFullSha(value, label) {
  if (!FULL_SHA.test(String(value || ''))) throw new Error(`${label} must be a full Git SHA.`);
  return String(value).toLowerCase();
}

function repositoryName(value) {
  const name = String(value || '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error('GITHUB_REPOSITORY must identify one repository.');
  }
  return name;
}

export function validateDiscordWebhookUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Silo release webhook is not a valid URL.');
  }
  if (
    url.protocol !== 'https:' ||
    !['discord.com', 'discordapp.com'].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    !/^\/api\/webhooks\/\d{17,20}\/[A-Za-z0-9._-]+$/.test(url.pathname)
  ) {
    throw new Error('Silo release webhook must be an HTTPS Discord webhook URL.');
  }
  url.search = '';
  url.searchParams.set('wait', 'true');
  return url;
}

export function validateReleaseAnnouncement({
  release,
  tagReference,
  tagObject,
  comparison,
  associatedPullRequests,
  repository,
  expectedCommitSha,
  expectedNotesSha256
}) {
  const repositoryFullName = repositoryName(repository);
  if (release?.draft !== false || release?.prerelease !== false || !release?.published_at) {
    throw new Error('Only a published stable GitHub Release may be announced.');
  }

  const tagName = String(release.tag_name || '');
  const version = tagName.match(TAG)?.[1];
  if (!version) throw new Error('Release tag must use vX.Y.Z.');
  if (release.name !== `Silo v${version}`) throw new Error('Release title must match its tag.');

  if (tagReference?.object?.type !== 'tag') {
    throw new Error('Silo releases require an annotated tag.');
  }
  const tagObjectSha = requireFullSha(tagReference.object.sha, 'Annotated tag object SHA');
  if (
    String(tagObject?.sha || '').toLowerCase() !== tagObjectSha ||
    tagObject?.object?.type !== 'commit'
  ) {
    throw new Error('Annotated release tag must peel directly to a commit.');
  }
  const commitSha = requireFullSha(tagObject.object.sha, 'Tagged commit SHA');
  if (expectedCommitSha && requireFullSha(expectedCommitSha, 'Expected commit SHA') !== commitSha) {
    throw new Error('Tagged commit does not match the approved recovery commit.');
  }
  if (String(release.target_commitish || '').toLowerCase() !== commitSha) {
    throw new Error('Release target must be the tagged commit.');
  }
  if (!['ahead', 'identical'].includes(comparison?.status)) {
    throw new Error('Tagged release commit must be contained in main.');
  }

  const sourceBranch = `release/silo-${version}`;
  const eligiblePullRequests = Array.isArray(associatedPullRequests)
    ? associatedPullRequests.filter(
        pullRequest =>
          pullRequest?.state === 'closed' &&
          Boolean(pullRequest?.merged_at) &&
          pullRequest?.base?.ref === 'main' &&
          pullRequest?.base?.repo?.full_name === repositoryFullName &&
          pullRequest?.head?.ref === sourceBranch &&
          pullRequest?.head?.repo?.full_name === repositoryFullName &&
          String(pullRequest?.merge_commit_sha || '').toLowerCase() === commitSha
      )
    : [];
  if (eligiblePullRequests.length !== 1) {
    throw new Error(
      `Tagged commit must have exactly one merged ${sourceBranch} to main pull request.`
    );
  }

  const heading = `# Silo v${version}`;
  const releaseBody = String(release.body || '').replace(/\r\n/g, '\n');
  if (expectedNotesSha256) {
    const digest = String(expectedNotesSha256).toLowerCase();
    if (
      !/^[a-f0-9]{64}$/.test(digest) ||
      createHash('sha256').update(releaseBody).digest('hex') !== digest
    ) {
      throw new Error('Release body does not match the approved recovery digest.');
    }
  }
  if (!releaseBody.startsWith(`${heading}\n`))
    throw new Error('Release body heading must match its tag.');
  const description = releaseBody
    .slice(heading.length)
    .trim()
    .replace(/@(everyone|here)/g, '@\u200b$1');
  const publishedAt = new Date(release.published_at);
  if (!description || description.length > 4_096 || Number.isNaN(publishedAt.valueOf())) {
    throw new Error('Release body or publication timestamp is invalid for Discord.');
  }

  return Object.freeze({
    tagName,
    commitSha,
    pullRequestNumber: eligiblePullRequests[0].number,
    payload: Object.freeze({
      allowed_mentions: Object.freeze({ parse: Object.freeze([]) }),
      embeds: Object.freeze([
        Object.freeze({
          color: 0x5865f2,
          title: `Silo v${version} released`,
          description,
          footer: Object.freeze({ text: `Silo v${version}` }),
          timestamp: publishedAt.toISOString()
        })
      ])
    })
  });
}

export function hasPriorDeliveryAttempt(runs, tagName, currentRunId, currentRunNumber) {
  const runNumber = Number(currentRunNumber);
  if (!Number.isSafeInteger(runNumber) || runNumber < 1) {
    throw new Error('Current workflow run number is invalid.');
  }
  return (
    Array.isArray(runs) &&
    runs.some(run => {
      if (
        String(run?.id) === String(currentRunId) ||
        run?.display_title !== WORKFLOW_TITLE(tagName)
      )
        return false;
      const candidateRunNumber = Number(run?.run_number);
      if (!Number.isSafeInteger(candidateRunNumber) || candidateRunNumber < 1) {
        throw new Error('Prior workflow run number is invalid.');
      }
      return candidateRunNumber < runNumber;
    })
  );
}

export async function collectPages(fetchPage) {
  const items = [];
  for (let page = 1; page <= 100; page += 1) {
    const pageItems = await fetchPage(page);
    if (!Array.isArray(pageItems)) throw new Error('Paginated GitHub response is invalid.');
    items.push(...pageItems);
    if (pageItems.length < 100) return items;
  }
  throw new Error('GitHub pagination limit reached; delivery blocked.');
}

async function githubJson(path, token, repository, fetchImpl = fetch) {
  const response = await safeFetch(fetchImpl, `https://api.github.com/repos/${repository}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'silo-release-announcement',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok)
    throw new Error(`GitHub release provenance request failed with status ${response.status}.`);
  return response.json();
}

// Never echo transport errors: they can contain the credential-bearing URL.
async function safeFetch(fetchImpl, url, options) {
  try {
    return await fetchImpl(url, options);
  } catch {
    throw new Error('Announcement transport failed; inspect delivery before any retry.');
  }
}

async function preflightDiscordWebhook({ webhookUrl, guildId, channelId }, fetchImpl) {
  if (![guildId, channelId].every(value => /^\d{17,20}$/.test(String(value || '')))) {
    throw new Error('Expected announcement destination is required.');
  }
  const url = validateDiscordWebhookUrl(webhookUrl);
  const webhookId = url.pathname.split('/')[3];
  const destinationResponse = await safeFetch(fetchImpl, url, {
    redirect: 'error',
    signal: AbortSignal.timeout(10_000)
  });
  if (!destinationResponse.ok)
    throw new Error(`Webhook preflight failed with status ${destinationResponse.status}.`);
  const destination = await destinationResponse.json().catch(() => null);
  if (
    destination?.type !== 1 ||
    destination.id !== webhookId ||
    destination.guild_id !== guildId ||
    destination.channel_id !== channelId
  ) {
    throw new Error('Webhook destination does not match configuration.');
  }
  return { url, webhookId, channelId };
}

async function postDiscordRelease({ url, webhookId, channelId }, payload, fetchImpl) {
  const response = await safeFetch(fetchImpl, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, allowed_mentions: { parse: [] } }),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok)
    throw new Error(
      `Announcement failed with status ${response.status}; delivery is not confirmed.`
    );
  const message = await response.json().catch(() => null);
  if (
    !/^\d{17,20}$/.test(String(message?.id || '')) ||
    message.webhook_id !== webhookId ||
    message.channel_id !== channelId
  ) {
    throw new Error('Announcement receipt is ambiguous; do not retry.');
  }
  return Object.freeze({ delivered: true, status: response.status, messageId: message.id });
}

export async function sendDiscordRelease({
  webhookUrl,
  payload,
  guildId,
  channelId,
  fetchImpl = fetch
}) {
  const destination = await preflightDiscordWebhook({ webhookUrl, guildId, channelId }, fetchImpl);
  return postDiscordRelease(destination, payload, fetchImpl);
}

export function releaseWebhookDestinations(env) {
  let additional = [];
  if (env.SILO_ADDITIONAL_RELEASE_WEBHOOKS) {
    try {
      additional = JSON.parse(env.SILO_ADDITIONAL_RELEASE_WEBHOOKS);
    } catch {
      throw new Error('Additional release webhooks must be a JSON array.');
    }
  }
  if (!Array.isArray(additional) || additional.length > 3) {
    throw new Error('At most three additional release webhooks are supported.');
  }
  const destinations = [
    {
      webhookUrl: env.SILO_RELEASE_WEBHOOK,
      guildId: env.SILO_RELEASE_GUILD_ID,
      channelId: env.SILO_RELEASE_CHANNEL_ID
    },
    ...additional
  ];
  const webhookIds = new Set();
  const channelIds = new Set();
  for (const destination of destinations) {
    if (
      !destination ||
      typeof destination !== 'object' ||
      Array.isArray(destination) ||
      Object.keys(destination).some(key => !['webhookUrl', 'guildId', 'channelId'].includes(key)) ||
      ![destination.guildId, destination.channelId].every(
        value => typeof value === 'string' && /^\d{17,20}$/.test(value)
      )
    ) {
      throw new Error('Release webhook destination configuration is invalid.');
    }
    const webhookId = validateDiscordWebhookUrl(destination.webhookUrl).pathname.split('/')[3];
    if (webhookIds.has(webhookId) || channelIds.has(destination.channelId)) {
      throw new Error('Duplicate release webhook or channel is not allowed.');
    }
    webhookIds.add(webhookId);
    channelIds.add(destination.channelId);
  }
  return destinations;
}

export function validateReleaseVersions(version, manifests) {
  if (manifests.length !== 3 || manifests.some(manifest => manifest?.version !== version)) {
    throw new Error('Tagged package versions must match the release.');
  }
}

// A separate destination and persistent exclusive attempt record keep smoke tests
// out of the release event path and prevent accidental repeats after a timeout.
export async function runAnnouncementTest({ env = process.env, fetchImpl = fetch } = {}) {
  if (!env.SILO_ANNOUNCEMENT_TEST_RECORD) throw new Error('Test attempt record path is required.');
  const attempt = await open(env.SILO_ANNOUNCEMENT_TEST_RECORD, 'wx', 0o600);
  try {
    await attempt.writeFile(JSON.stringify({ status: 'attempted' }) + '\n');
  } finally {
    await attempt.close();
  }
  const result = await sendDiscordRelease({
    webhookUrl: env.SILO_TEST_RELEASE_WEBHOOK,
    guildId: env.SILO_TEST_RELEASE_GUILD_ID,
    channelId: env.SILO_TEST_RELEASE_CHANNEL_ID,
    payload: {
      embeds: [
        {
          title: 'Silo release announcement test',
          description: 'Webhook delivery check. This is a test, not a release or deployment.'
        }
      ]
    },
    fetchImpl
  });
  await writeFile(env.SILO_ANNOUNCEMENT_TEST_RECORD, JSON.stringify(result) + '\n', {
    mode: 0o600
  });
  return result;
}

export async function runReleaseAnnouncement({ env = process.env, fetchImpl = fetch } = {}) {
  if (String(env.GITHUB_RUN_ATTEMPT || '') !== '1') {
    throw new Error('Silo release announcements are disabled for workflow reruns.');
  }
  const repository = repositoryName(env.GITHUB_REPOSITORY);
  const token = String(env.GITHUB_TOKEN || '');
  const tagName = String(env.RELEASE_TAG || '');
  if (!token || !TAG.test(tagName)) throw new Error('Release workflow identity is incomplete.');
  const expectedCommitSha = String(env.EXPECTED_COMMIT_SHA || '');
  const expectedNotesSha256 = String(env.EXPECTED_NOTES_SHA256 || '');
  if (Boolean(expectedCommitSha) !== Boolean(expectedNotesSha256)) {
    throw new Error('Recovery commit and notes bindings must be supplied together.');
  }

  if (
    !['release', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) ||
    (env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
      (env.GITHUB_REF !== 'refs/heads/main' || !expectedCommitSha || !expectedNotesSha256))
  ) {
    throw new Error('Only a published release or bound main-branch dispatch can announce.');
  }
  if (!/^\d+$/.test(String(env.GITHUB_RUN_ID || '')))
    throw new Error('Workflow run identity is missing.');
  const get = path => githubJson(path, token, repository, fetchImpl);
  const encodedTag = encodeURIComponent(tagName);
  const release = await get(`/releases/tags/${encodedTag}`);
  const tagReference = await get(`/git/ref/tags/${encodedTag}`);
  if (tagReference?.object?.type !== 'tag') {
    validateReleaseAnnouncement({ release, tagReference, repository });
  }
  const tagObject = await get(`/git/tags/${tagReference.object.sha}`);
  const commitSha = requireFullSha(tagObject?.object?.sha, 'Tagged commit SHA');
  const [comparison, associatedPullRequests, workflowRuns] = await Promise.all([
    get(`/compare/${commitSha}...main`),
    collectPages(page => get(`/commits/${commitSha}/pulls?per_page=100&page=${page}`)),
    collectPages(async page => {
      const result = await get(
        `/actions/workflows/release-announcement.yml/runs?per_page=100&page=${page}`
      );
      return result?.workflow_runs;
    })
  ]);
  // GitHub creates this run record before execution. Every older same-tag run is
  // treated as pending or delivered, so an ambiguous Discord POST is never retried.
  if (hasPriorDeliveryAttempt(workflowRuns, tagName, env.GITHUB_RUN_ID, env.GITHUB_RUN_NUMBER)) {
    throw new Error(`${tagName} already has a Silo release announcement attempt.`);
  }
  const announcement = validateReleaseAnnouncement({
    release,
    tagReference,
    tagObject,
    comparison,
    associatedPullRequests,
    repository,
    expectedCommitSha,
    expectedNotesSha256
  });
  const manifests = await Promise.all(
    ['package.json', 'packages/bot/package.json', 'packages/core/package.json'].map(async path => {
      const file = await get(`/contents/${path}?ref=${commitSha}`);
      if (file.encoding !== 'base64' || file.type !== 'file')
        throw new Error('Tagged package metadata is missing.');
      return JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
    })
  );
  validateReleaseVersions(tagName.slice(1), manifests);
  // Validate every destination before any POST. A partial or uncertain delivery
  // still consumes this workflow attempt; reruns must never resend earlier posts.
  const destinations = releaseWebhookDestinations(env);
  const prepared = await Promise.all(
    destinations.map(destination => preflightDiscordWebhook(destination, fetchImpl))
  );
  const receipts = [];
  for (const destination of prepared) {
    receipts.push(await postDiscordRelease(destination, announcement.payload, fetchImpl));
  }
  return {
    ...receipts[0],
    receipts,
    tag: announcement.tagName,
    commitSha: announcement.commitSha,
    pullRequestNumber: announcement.pullRequestNumber
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--test'))
      throw new Error('Unknown announcement argument.');
    const receipt =
      process.argv[2] === '--test' ? await runAnnouncementTest() : await runReleaseAnnouncement();
    process.stdout.write(JSON.stringify(receipt) + '\n');
  } catch (error) {
    process.stderr.write(`Announcement stopped: ${error.message}\n`);
    process.exitCode = 1;
  }
}
