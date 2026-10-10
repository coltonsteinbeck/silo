import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { AdminAdapter, PatchNotesWebhook } from '../database/admin-adapter';
import { sanitizeDiscordMassMentions } from '../security/output-sanitizer';

type FetchOptions = NonNullable<Parameters<typeof fetch>[1]>;

const snowflake = /^[0-9]{15,22}$/;
const tokenPattern = /^[A-Za-z0-9._-]{20,200}$/;
const webhookName = 'Silo Patch Notes';

function encryptionKey(value: string): Buffer {
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) {
    throw new Error('Patch-note encryption is not configured.');
  }
  return key;
}

function binding(webhook: Pick<PatchNotesWebhook, 'guildId' | 'channelId' | 'webhookId'>): Buffer {
  if (![webhook.guildId, webhook.channelId, webhook.webhookId].every(id => snowflake.test(id))) {
    throw new Error('Invalid patch-note destination.');
  }
  return Buffer.from(`${webhook.guildId}:${webhook.channelId}:${webhook.webhookId}`);
}

export function encryptPatchNotesToken(
  token: string,
  webhook: PatchNotesWebhook,
  keyValue: string
): string {
  if (!tokenPattern.test(token)) throw new Error('Invalid webhook credential.');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(keyValue), nonce);
  cipher.setAAD(binding(webhook));
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [
    'v1',
    nonce.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64')
  ].join(':');
}

export function decryptPatchNotesToken(webhook: PatchNotesWebhook, keyValue: string): string {
  try {
    const parts = webhook.encryptedToken.split(':');
    if (parts.length !== 4 || parts[0] !== 'v1') throw new Error();
    const nonce = Buffer.from(parts[1]!, 'base64'),
      tag = Buffer.from(parts[2]!, 'base64');
    if (nonce.length !== 12 || tag.length !== 16) throw new Error();
    const cipher = createDecipheriv('aes-256-gcm', encryptionKey(keyValue), nonce);
    cipher.setAAD(binding(webhook));
    cipher.setAuthTag(tag);
    const token = Buffer.concat([
      cipher.update(Buffer.from(parts[3]!, 'base64')),
      cipher.final()
    ]).toString('utf8');
    if (!tokenPattern.test(token)) throw new Error();
    return token;
  } catch {
    throw new Error('Patch-note credential could not be unlocked.');
  }
}

// Never expose transport errors: they can contain the webhook URL and token.
async function discord(path: string, init: FetchOptions = {}): Promise<any> {
  try {
    const response = await fetch(`https://discord.com/api/v10${path}`, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error();
    return response.status === 204 ? null : await response.json();
  } catch {
    throw new Error('Patch-note Discord request failed.');
  }
}

export class PatchNotesService {
  constructor(
    private db: AdminAdapter,
    private bot: { id: string; token: string },
    private keyValue: string
  ) {
    encryptionKey(keyValue);
    if (!snowflake.test(bot.id) || !bot.token) throw new Error('Patch-note bot is not ready.');
  }

  async setup(guildId: string, channelId: string, userId: string): Promise<PatchNotesWebhook> {
    if (![guildId, channelId, userId].every(id => snowflake.test(id)))
      throw new Error('Invalid destination.');
    const headers = { Authorization: `Bot ${this.bot.token}`, 'Content-Type': 'application/json' };
    try {
      return await this.db.configurePatchNotesWebhook(guildId, async () => {
        const hooks = await discord(`/channels/${channelId}/webhooks`, { headers });
        if (!Array.isArray(hooks)) throw new Error('Invalid webhook response.');
        const owned = hooks.filter(
          hook => hook.type === 1 && hook.name === webhookName && hook.user?.id === this.bot.id
        );
        if (owned.length > 1)
          throw new Error('Multiple patch-note webhooks require administrator review.');
        const hook =
          owned[0] ??
          (await discord(`/channels/${channelId}/webhooks`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ name: webhookName })
          }));
        if (
          hook.type !== 1 ||
          hook.guild_id !== guildId ||
          hook.channel_id !== channelId ||
          hook.user?.id !== this.bot.id ||
          !snowflake.test(hook.id) ||
          !tokenPattern.test(hook.token ?? '')
        ) {
          throw new Error('Webhook destination could not be verified.');
        }
        const webhook: PatchNotesWebhook = {
          guildId,
          channelId,
          webhookId: hook.id,
          createdBy: userId,
          encryptedToken: ''
        };
        webhook.encryptedToken = encryptPatchNotesToken(hook.token, webhook, this.keyValue);
        return webhook;
      });
    } catch {
      // Creation or commit may have succeeded despite a lost receipt. Leave the
      // bot-owned hook intact so a later setup can adopt it without a duplicate.
      throw new Error('Patch-note setup failed. Check bot permissions and database configuration.');
    }
  }

  async send(
    guildId: string,
    userId: string,
    version: string,
    notes: string
  ): Promise<'delivered' | 'already-attempted'> {
    if (!/^v?\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version) || version.length > 80) {
      throw new Error('Use a release version such as 1.2.3.');
    }
    version = version.replace(/^v/, '');
    const content = sanitizeDiscordMassMentions(`Silo ${version}\n${notes.trim()}`);
    if (!notes.trim() || notes.length > 1800 || content.length > 2000)
      throw new Error('Patch notes must contain 1–1800 characters.');
    const webhook = await this.db.getPatchNotesWebhook(guildId);
    if (!webhook) throw new Error('Set up a patch-note webhook first.');
    if (webhook.guildId !== guildId) throw new Error('Webhook guild mismatch.');
    const token = decryptPatchNotesToken(webhook, this.keyValue);
    const path = `/webhooks/${webhook.webhookId}/${token}`;
    const current = await discord(path);
    if (
      current.id !== webhook.webhookId ||
      current.type !== 1 ||
      current.guild_id !== guildId ||
      current.channel_id !== webhook.channelId
    ) {
      throw new Error('The webhook destination changed. Administrator review is required.');
    }
    if (
      !(await this.db.claimPatchNotesDelivery(
        guildId,
        version,
        createHash('sha256').update(content).digest('hex'),
        userId
      ))
    ) {
      return 'already-attempted';
    }
    // The durable claim survives any uncertain network outcome. Never automatically retry.
    const message = await discord(`${path}?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } })
    });
    if (
      !snowflake.test(message.id ?? '') ||
      message.channel_id !== webhook.channelId ||
      message.webhook_id !== webhook.webhookId
    ) {
      throw new Error('Patch-note delivery receipt could not be verified.');
    }
    await this.db.completePatchNotesDelivery(guildId, version, message.id);
    return 'delivered';
  }
}
