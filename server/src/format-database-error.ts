/**
 * format-database-error.ts — one way of printing a Postgres error.
 *
 * Three programs now catch database errors and want to show them:
 *
 *   server/src/migrate.ts          the migration runner
 *   server/scripts/import-json.ts  the loader
 *   server/src/index.ts            the Express server   (step 7a)
 *
 * The runner and the loader each carried their own copy. Two copies is a
 * coincidence; three is a module, so the third caller is where it gets extracted
 * rather than copied again.
 *
 * WHAT THIS IS FOR, AND WHAT IT IS NOT FOR. The output goes to the terminal, to
 * the person who ran the program. It never goes into an HTTP response. A Postgres
 * error can quote the offending statement, and a statement can quote data; the
 * connection string is in the same process. Nothing here is shaped for a stranger
 * to read, so nothing here should reach one.
 */

/**
 * The extra diagnostic fields node-postgres hangs off a database error. They are
 * plain properties on an ordinary Error, not a class of its own, which is why
 * this is an interface asserted onto the error rather than an `instanceof` test.
 */
export interface PostgresErrorFields {
  code?: string;
  detail?: string;
  hint?: string;
  position?: string;
  where?: string;
  constraint?: string;
}

/**
 * The order fields are printed in. `code` first because it is the one that can be
 * looked up; `constraint` last because by the time it matters you already know
 * which table you were writing to.
 */
const FIELDS = ['code', 'detail', 'hint', 'position', 'where', 'constraint'] as const;

/** The Postgres error verbatim, indented, one field per line. */
export function formatDatabaseError(error: unknown): string {
  if (!(error instanceof Error)) return `  ${String(error)}`;

  const fields = error as Error & PostgresErrorFields;
  const lines = [`  ${error.message}`];

  for (const key of FIELDS) {
    const value = fields[key];
    if (value) lines.push(`  ${key}: ${value}`);
  }
  return lines.join('\n');
}
