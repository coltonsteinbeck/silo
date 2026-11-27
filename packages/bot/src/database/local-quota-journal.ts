import { Database } from 'bun:sqlite';
import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

export function openLocalQuotaJournal(path: string): Database {
  const directory = dirname(path);
  if (!isAbsolute(directory)) throw new Error('Quota journal directory must be absolute');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(directory);
  if (
    !metadata.isDirectory() ||
    metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error('Quota journal directory must be private to the bot account');
  }
  const file = lstatSync(path, { throwIfNoEntry: false });
  if (file && (!file.isFile() || file.uid !== metadata.uid)) {
    throw new Error('Quota journal must be a regular file owned by the bot account');
  }
  const db = new Database(path, { strict: true });
  try {
    chmodSync(path, 0o600);
    db.exec('PRAGMA busy_timeout = 1000');
    const mode = db.query<{ journal_mode: string }, []>('PRAGMA journal_mode = WAL').get();
    if (mode?.journal_mode !== 'wal') throw new Error('Quota journal requires WAL support');
    // A terminal measurement must survive process exit before the PostgreSQL write.
    db.exec('PRAGMA synchronous = FULL');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
