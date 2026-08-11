/**
 * Migration runner (Q28).
 *
 * Applies every .sql file in server/migrations that has not been applied before,
 * in filename order, each in its own transaction. Records what it applied in a
 * schema_migrations table that it creates itself.
 *
 * Reads DATABASE_URL and nothing else. It never chooses a database. The
 * connection itself is configured by server/src/db-config.ts, which is where the
 * explicit TLS setting lives (Q18, amendment 2).
 *
 * Run it with `npm run migrate`, which supplies --env-file=.env. At step 7a the
 * server calls runMigrations() on boot, before Express accepts its first request.
 *
 * Rules that come with this design, and must not be relaxed later:
 *   - An applied migration file is never edited and never renamed. If 001 was
 *     wrong, 002 fixes it.
 *   - There are no down migrations. Recovery is restore-from-backup or fix-forward.
 */

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import type { Client as PgClient } from 'pg';
import { buildConnectionConfig, describeTarget, describeTls } from './db-config.ts';
import { formatDatabaseError } from './format-database-error.ts';

const { Client } = pg;

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

/**
 * The runner bootstraps its own tracking table. This is the one place in the
 * project where IF NOT EXISTS is correct: it is bootstrapping, not schema change.
 * It deliberately does not live in 001_initial_schema.sql, so that 001 stays
 * purely about the application's own tables.
 */
const CREATE_TRACKING_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  );
`;

async function rollbackQuietly(client: PgClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // If the failure also killed the connection, ROLLBACK fails too. Postgres has
    // already discarded the transaction in that case, so nothing is left to undo.
  }
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

export async function runMigrations(connectionString: string): Promise<void> {
  // TLS comes from db-config.ts rather than from pg's reading of `sslmode` in the
  // string. See that module for why the difference matters (Q18, amendment 2).
  const client = new Client(buildConnectionConfig(connectionString));

  console.log(`migrate: target ${describeTarget(connectionString)}`);
  console.log(`migrate: TLS ${describeTls(connectionString)}`);

  try {
    await client.connect();
  } catch (error) {
    console.error('migrate: could not connect.');
    console.error(formatDatabaseError(error));
    process.exit(1);
  }

  // Set to the offending filename if a migration fails. Checked after the connection
  // has been closed, because process.exit() would skip the finally block below.
  let failedOn: string | null = null;

  try {
    await client.query(CREATE_TRACKING_TABLE);

    const recorded = await client.query<{ filename: string }>(
      'SELECT filename FROM schema_migrations',
    );
    const alreadyApplied = new Set(recorded.rows.map((row) => row.filename));

    // Plain sort, not localeCompare: filenames are zero-padded ASCII, so ordering
    // by code unit is ordering by number. That is what the zero-padding buys.
    const onDisk = (await readdir(MIGRATIONS_DIR))
      .filter((name) => name.endsWith('.sql'))
      .sort();

    const pending = onDisk.filter((name) => !alreadyApplied.has(name));

    console.log(
      `migrate: ${count(onDisk.length, 'file')} on disk, ` +
        `${alreadyApplied.size} already applied.`,
    );

    if (pending.length === 0) {
      console.log('migrate: nothing to apply. The database is up to date.');
      return;
    }

    console.log(`migrate: applying ${count(pending.length, 'file')}.`);

    let applied = 0;

    for (const filename of pending) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, filename), 'utf8');

      // One transaction per file, with the tracking INSERT inside it. Applying and
      // recording are one event: split them and you get either a migration marked
      // done that never ran, or one that runs again on the next deploy.
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [
          filename,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await rollbackQuietly(client);
        console.error(`migrate: FAILED on ${filename}. Nothing in this file was applied.`);
        console.error(formatDatabaseError(error));
        // Stop here. Earlier files stay applied and recorded; fix this one and re-run.
        failedOn = filename;
        break;
      }

      console.log(`  applied ${filename}`);
      applied += 1;
    }

    if (!failedOn) {
      console.log(`migrate: done. ${count(applied, 'file')} applied.`);
    }
  } finally {
    await client.end();
  }

  if (failedOn) process.exit(1);
}

// ---------------------------------------------------------------------------
// The command-line half
// ---------------------------------------------------------------------------
//
// Everything above is a library. Everything below runs only when Node was told
// to run THIS file — `npm run migrate`. `import.meta.main` is Node's own answer
// to that question (added in v24.2; this project is on v24.14.1), and it is why
// server/src/index.ts can import runMigrations for the boot hook without the
// import itself reading the environment, connecting, and exiting the process.
//
// The alternative shapes, and why not: splitting the file in two would move the
// runner off the path Q28 records, and comparing import.meta.url against
// process.argv[1] by hand is the same test written less clearly and with a
// Windows path-separator trap in it.

if (import.meta.main) {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    console.error('migrate: DATABASE_URL is not set.');
    console.error('  It belongs in .env — see .env.example for the shape.');
    console.error('  `npm run migrate` passes --env-file=.env for you.');
    process.exit(1);
  }

  await runMigrations(connectionString);
}
