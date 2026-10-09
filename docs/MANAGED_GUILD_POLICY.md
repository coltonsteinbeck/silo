# Managed guild content safeguards

The backend loads administrator-managed guild policies from `app_private.guild_persona_policies`. Policy data is not available to ordinary bot commands or database API roles. Each policy may contain a JSON boolean named `safeguardsEnabled`; omitting it preserves the protected default of `true`.

A trusted database operator can disable application content safeguards for one existing managed guild. Select the intended policy by its exact guild identifier, set `safeguardsEnabled` to the JSON boolean `false`, and update the timestamp. Preserve the other policy fields and verify that exactly one row changed before committing the transaction.

To re-enable them, set the same field to `true`. The bot reads the committed value at each content safety gate without a cache or restart. A final delivery check also re-evaluates unchanged text for managed guilds, so re-enablement applies to responses still being generated. Content already delivered cannot be recalled by this switch.

Only the literal JSON boolean `false` disables safeguards. Missing rows, missing values, malformed values, database failures, unregistered guilds, and direct messages retain safeguards. Registering a new managed guild or changing other policy fields still requires the normal registry initialization; this switch does not hot-reload the whole persona policy.

While disabled, application input/output content checks, prompt-injection text replacement, canonical safety prompt additions, assistant history quarantine, and slur/profanity masking follow that guild's policy. Input limits, administrator permissions, quotas, graph/tool budgets, external-resource restrictions, Discord mention neutralization, and tracing remain active. Provider-enforced content restrictions also remain active. Re-enabling safeguards restores content checks and quarantines unsafe assistant history on subsequent reuse.

No schema migration is needed beyond the managed policy table. Keep policy values and guild identifiers in private operator data. Application rollback retains the policy JSON; versions that predate this field may reject it at startup, so remove the field with `policy - 'safeguardsEnabled'` before rolling back to such a version.
