import type { Pool } from 'pg';
import { z } from 'zod';
import { initializeGuildSafeguards } from './guild-safeguards';
import {
  classifyAssistantOutputSafetyDeterministic,
  isStandalonePersonaTitle
} from './prompt-safety';

const instruction = z.string().trim().min(1).max(4000);
const turnInstructions = z
  .object({
    default: instruction,
    alternate: instruction,
    ordinary: instruction,
    contextual_explanation: instruction,
    boundary_redirect: instruction
  })
  .strict()
  .readonly();
const aliases = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(80)
      .refine(
        value =>
          isStandalonePersonaTitle(value) ||
          classifyAssistantOutputSafetyDeterministic(value).reasons.length === 0
      )
  )
  .max(8)
  .readonly();
export const ManagedGuildPolicySchema = z
  .object({
    personaId: z.string().trim().min(1).max(80),
    textProvider: z.enum(['openai', 'xai']),
    textModel: z.string().regex(/^[a-zA-Z0-9._:-]{1,100}$/),
    promptVersion: z.string().trim().min(1).max(80),
    prompt: z.string().trim().min(1).max(16000),
    promptWithoutContentSafeguards: z.string().trim().min(1).max(16000).optional(),
    customPromptsDisabled: z.literal(true),
    assistantOutputBlockedMessage: z.string().trim().min(1).max(200),
    allowMildAssistantProfanity: z.boolean(),
    safeguardsEnabled: z.boolean().default(true),
    assistantSafetyPolicy: z.enum(['standard', 'contextual_banter']),
    alternatePersonaEnabled: z.boolean(),
    defaultAliases: aliases,
    alternateAliases: aliases,
    turnInstructions,
    turnInstructionsWithoutContentSafeguards: turnInstructions.optional()
  })
  .strict()
  .readonly();

export type ManagedGuildPersonaPolicy = z.infer<typeof ManagedGuildPolicySchema> & {
  readonly guildId: string;
};
let registry: ReadonlyMap<string, ManagedGuildPersonaPolicy> = new Map();

/** Load only administrator-migrated policy data, before registering handlers. */
export async function initializeManagedGuildPolicyRegistry(
  pool: Pick<Pool, 'query'>,
  configuredProviders?: readonly string[]
): Promise<void> {
  const { rows } = await pool.query(
    'SELECT guild_id, policy FROM app_private.guild_persona_policies'
  );
  const next = new Map<string, ManagedGuildPersonaPolicy>();
  for (const row of rows) {
    const policy = ManagedGuildPolicySchema.safeParse(row.policy);
    if (!/^[0-9]{15,22}$/.test(row.guild_id) || !policy.success || next.has(row.guild_id)) {
      // Never include validation input or private policy values in startup errors.
      throw new Error('Invalid managed guild policy data');
    }
    if (configuredProviders && !configuredProviders.includes(policy.data.textProvider))
      throw new Error('Managed guild provider is not configured');
    next.set(row.guild_id, Object.freeze({ ...policy.data, guildId: row.guild_id }));
  }
  registry = next;
  initializeGuildSafeguards(pool, next.keys());
}

export function getManagedGuildAssistantOutputBlockedMessages(): string[] {
  return [...registry.values()].map(policy => policy.assistantOutputBlockedMessage);
}

export function resolveManagedGuildPersonaPolicy(
  guildId?: string | null
): ManagedGuildPersonaPolicy | null {
  return guildId ? (registry.get(guildId) ?? null) : null;
}

export function isManagedGuildCustomPromptDisabled(guildId?: string | null): boolean {
  return Boolean(resolveManagedGuildPersonaPolicy(guildId)?.customPromptsDisabled);
}
