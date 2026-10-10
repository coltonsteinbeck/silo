# Patch-note webhooks

Server admins can use `/admin patch-notes-setup channel` to create a dedicated webhook and store its encrypted credential in the database. Each server has one destination. Repeated setup reuses it; selecting another channel does not replace an existing destination. `/admin patch-notes-status` shows the configured channel without revealing credentials.

Run `/admin patch-notes-send version notes` to publish patch notes. Versions use a format such as `1.2.3` or `1.2.3-rc.1`; an optional leading `v` is normalized. Notes may contain up to 1,800 characters. Mention parsing is disabled. The invoking admin and bot must have View Channel, Send Messages, and Manage Webhooks in the destination channel.

Apply the additive webhook migration before enabling these commands. Install `PATCH_NOTES_ENCRYPTION_KEY` as a stable, base64-encoded random 32-byte runtime secret. Back it up securely alongside database backups. Do not put it in source control or share webhook URLs. Losing or replacing the key makes existing credentials unreadable. The commands fail closed when the key is missing. Credentials are encrypted with AES-256-GCM and bound to the server, channel, and webhook identifiers; database browser roles have no access to either table.

A durable server/version claim is saved before each send. An uncertain network response or database receipt failure leaves that version attempted and prevents automatic replay. Check the destination and delivery record before operator recovery; changing the version just to retry can produce duplicates. After a failed setup, rerunning setup can adopt an existing webhook named `Silo Patch Notes` owned by the bot. Multiple matching hooks require administrator review.

These commands are a manual patch-note sender. The GitHub release announcement workflow uses its own protected webhook secrets and release verification. No database credentials are passed to that workflow, and these commands do not deploy the application.

Rollback the application commands if needed while retaining the additive tables and delivery claims. Preserve the encryption key while any credentials remain stored. Destination changes, key rotation, and recovery of ambiguous deliveries are explicit operator tasks.
