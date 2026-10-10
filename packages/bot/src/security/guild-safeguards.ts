import { logger } from '@silo/core';
import type { Pool } from 'pg';

let database: Pick<Pool, 'query'> | null = null;
let managedGuilds: ReadonlySet<string> = new Set();

export function initializeGuildSafeguards(
  pool: Pick<Pool, 'query'>,
  guildIds: Iterable<string>
): void {
  database = pool;
  managedGuilds = new Set(guildIds);
}

/** Read at each gate: never cache an operator's emergency re-enablement. */
export async function areGuildSafeguardsEnabled(guildId?: string | null): Promise<boolean> {
  if (!database || !guildId || !managedGuilds.has(guildId)) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const query = {
      text: `SELECT policy -> 'safeguardsEnabled' AS enabled
             FROM app_private.guild_persona_policies WHERE guild_id = $1`,
      values: [guildId],
      query_timeout: 1000
    };
    const { rows } = await Promise.race([
      database.query<{ enabled: unknown }>(query),
      new Promise<never>((_, reject) => {
        // The driver's query timeout begins only after pool acquisition.
        timer = setTimeout(() => reject(new Error('Content policy lookup timed out')), 1000);
      })
    ]);
    // Only an explicit JSON boolean can disable content safeguards.
    return rows.length !== 1 || rows[0]?.enabled !== false;
  } catch {
    logger.warn('Managed content policy lookup failed; safeguards remain enabled');
    return true;
  } finally {
    clearTimeout(timer);
  }
}
