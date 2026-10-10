# Release announcements

The release announcement workflow posts public GitHub Release notes to a configured
Discord text channel. It does not deploy the application or require a running bot.
Use a separate incoming webhook for each destination. Create it under the Discord
server's **Settings → Integrations → Webhooks** and keep its URL secret.

## Configuration

Configure these GitHub Actions repository secrets:

- `SILO_RELEASE_WEBHOOK`: the incoming Discord webhook URL.
- `SILO_RELEASE_GUILD_ID`: the expected server ID.
- `SILO_RELEASE_CHANNEL_ID`: the expected text channel ID.
- `SILO_ADDITIONAL_RELEASE_WEBHOOKS` (optional): a JSON array of up to three
  additional destinations. Each object must contain `webhookUrl`, `guildId`, and
  `channelId` as strings. Store the entire array as one secret; omit it for a
  single destination.

The sender reads every webhook's destination before sending and rejects a mismatch.
Duplicate webhook IDs or channels are rejected. All destinations must pass the
preflight before any announcement is sent.
The bot process does not need these credentials. Do not put webhook URLs in source,
release notes, command arguments, or logs.

## Test delivery

Use a separate webhook and supply `SILO_TEST_RELEASE_WEBHOOK`,
`SILO_TEST_RELEASE_GUILD_ID`, and `SILO_TEST_RELEASE_CHANNEL_ID` through a secure
environment. Set `SILO_ANNOUNCEMENT_TEST_RECORD` to a new private file path, then run:

```sh
bun scripts/release-announcement.mjs --test
```

This posts one clearly labeled test message through the same destination checks
and delivery code as a release. The exclusive attempt file prevents repeats,
including after an ambiguous timeout. A successful receipt contains `delivered`,
HTTP status, and the message ID. Verify that message in the intended channel.
Do not delete an attempt file to retry an uncertain delivery.

## Release requirements

The workflow runs on publication of a stable GitHub Release. It requires:

- An annotated `vX.Y.Z` tag that points directly to a commit contained in `main`.
- Exactly one merged, same-repository `release/silo-X.Y.Z` → `main` pull request
  whose merge commit matches the tag.
- Matching versions in the root, bot, and core package manifests at that commit.
- Release title `Silo vX.Y.Z`, an exact commit SHA target, and release notes starting
  with `# Silo vX.Y.Z` followed by a newline.
- A nonempty notes body that fits a Discord embed after mention neutralization.

Publishing notes announces the release; it does not prove a deployment succeeded.
Complete the project's release and deployment checks before publication.

The workflow has read-only GitHub permissions and serializes attempts per tag.
Every older workflow run for the same tag blocks another send, regardless of its
conclusion. Workflow reruns are disabled. A bound manual dispatch from `main` is
available only when no older same-tag run exists; it requires the full tagged
commit SHA and SHA-256 digest of the release body with LF line endings.

## Delivery and recovery

The Discord request uses `wait=true`, disables mention parsing, refuses redirects,
and has a timeout. A successful HTTP status alone is insufficient: the returned
message must match the configured channel and webhook. The sender never retries.

Discord offers no transactional exactly-once guarantee. If a response or receipt
is missing, delivery is ambiguous. Inspect the original workflow and destination;
do not rerun, dispatch another same-tag attempt, or send around the guard. Even a
conclusive pre-send failure requires a separately reviewed recovery change before
another attempt. Do not weaken duplicate protection merely to obtain a green run.
With multiple destinations, a failure stops delivery to the remaining channels.
Earlier successful posts are retained, and the same-tag guard prevents their
duplication. Inspect every configured channel before planning recovery.

To disable announcements, remove the webhook secret or disable the workflow.
Deleting or rotating a compromised Discord webhook revokes its URL; update the
secret and verify the replacement destination before the next release.

## Local checks

```sh
bun test scripts/__tests__/release-announcement.test.ts
```

These tests use simulated HTTP responses and do not establish real delivery.
