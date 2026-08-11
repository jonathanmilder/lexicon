/**
 * db-config.ts — the one place a Postgres connection is configured (Q18, amendment 2).
 *
 * Three programs in this project open a connection:
 *
 *   server/src/migrate.ts          the migration runner   (exists)
 *   server/scripts/import-json.ts  the loader             (step 6)
 *   server/src/db.ts               the Express pool       (step 7a)
 *
 * All three build their configuration here, so the TLS setting is written once
 * and cannot go missing from one of them by accident.
 *
 * This module does NOT choose a database. Each program reads its own environment
 * variable and hands the string in: the runner and the pool read DATABASE_URL,
 * the loader reads DATABASE_URL_DEV or DATABASE_URL_MAIN according to --target.
 * Keeping that choice out of here is the whole of Q18.
 *
 *
 * WHY THIS MODULE EDITS THE CONNECTION STRING
 * -------------------------------------------
 * `sslmode=` is a libpq convention — libpq being the C client that psql is built
 * on. This project uses `pg`, the pure-JavaScript driver, which re-implements
 * that parsing itself. Two facts about that re-implementation, both read from
 * the installed source rather than assumed:
 *
 *   1. THE STRING BEATS THE OBJECT. pg builds its configuration as
 *
 *        Object.assign({}, config, parse(config.connectionString))
 *
 *      (pg/lib/connection-parameters.js). The parsed string is the last
 *      argument, so it OVERWRITES anything the caller passed. And
 *      pg-connection-string sets `config.ssl = {}` the moment it sees an
 *      `sslmode` parameter. So passing `ssl` alongside a string that carries
 *      `sslmode` does nothing at all: the object is silently discarded.
 *
 *      This was proved, not reasoned: pointing `ssl.ca` at a self-signed
 *      certificate that cannot have issued Neon's still connected cleanly.
 *
 *   2. THE MEANINGS ARE IN FLUX. pg-connection-string 2.14 currently treats
 *      `prefer`, `require` and `verify-ca` as aliases for `verify-full`, and
 *      prints a warning saying that in pg 9 they will revert to libpq semantics,
 *      "which have weaker security guarantees". So the same string means
 *      different things in different versions, and an npm upgrade could weaken
 *      this connection with nothing in the repo changing.
 *
 * Together those are the case the Map made in the abstract: a connection string
 * can say verify-full and behave like require — a security setting believed on
 * and silently off, which is worse than an honest require.
 *
 * So this module REMOVES the TLS parameters from the string and passes `ssl`
 * explicitly. With no `sslmode` present, pg-connection-string emits no `ssl` key,
 * nothing overwrites ours, and the decision lands where it belongs: on Node's own
 * TLS layer, whose behaviour does not move when `pg` changes its mind.
 *
 * NO CA BUNDLE IS PINNED. Node's own root store is what should be trusted.
 * Pinning an authority would buy a rotation outage in exchange for nothing here.
 *
 * The connection string should still carry `sslmode=verify-full`. It no longer
 * does any work, but it states the intent to a reader and to any other client —
 * psql, a GUI — that connects with the same string.
 */

import type { ClientConfig } from 'pg';

/**
 * The parameters pg-connection-string reads to build its own `ssl` object. Any
 * one of them present is enough to overwrite ours, so all of them come out.
 *
 * `sslnegotiation` is deliberately NOT in this list: it chooses a handshake
 * (`postgres` or `direct`), not a trust policy, and pg reads it separately.
 * Nothing here sets it. If it is ever set to `direct`, revisit this module —
 * pg-connection-string treats that as implying SSL and would emit an `ssl` key.
 */
const TLS_STRING_PARAMETERS = ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert'] as const;

interface StrippedString {
  /** The connection string with every TLS parameter removed. */
  readonly connectionString: string;
  /** What was removed, as `name=value`, for the line a program prints. */
  readonly removed: readonly string[];
}

/**
 * Remove the TLS parameters, leaving everything else exactly as it was.
 *
 * Rebuilding a URL that carries a password is worth being nervous about, so the
 * result is checked rather than trusted: every other part of the string must
 * come back identical. A mismatch throws instead of connecting somewhere
 * unexpected with a mangled credential.
 */
function stripTlsParameters(connectionString: string): StrippedString {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    // Not a URL. Hand it back untouched and let pg produce the error — this
    // module has no better message than the driver's own.
    return { connectionString, removed: [] };
  }

  const original = new URL(connectionString);
  const removed: string[] = [];

  for (const name of TLS_STRING_PARAMETERS) {
    const value = url.searchParams.get(name);
    if (value === null) continue;
    removed.push(`${name}=${value}`);
    url.searchParams.delete(name);
  }

  if (removed.length === 0) return { connectionString, removed };

  for (const part of ['username', 'password', 'hostname', 'port', 'pathname'] as const) {
    if (url[part] !== original[part]) {
      throw new Error(
        `db-config: rebuilding the connection string changed its ${part}. ` +
          'Refusing to connect. Report this — it means a character in the string ' +
          'does not survive a URL round trip.',
      );
    }
  }

  return { connectionString: url.toString(), removed };
}

/**
 * The configuration every connection in this project is built from.
 *
 * `rejectUnauthorized: true` is Node's TLS setting, not pg's. It requires the
 * server to present a certificate chaining to an authority in Node's root store,
 * and — because pg passes the hostname through to TLS as the servername — that
 * the certificate also names the host actually dialled. Those two checks together
 * are what `verify-full` means.
 */
export function buildConnectionConfig(connectionString: string): ClientConfig {
  return {
    connectionString: stripTlsParameters(connectionString).connectionString,
    ssl: { rejectUnauthorized: true },
  };
}

/**
 * Shorten a Neon hostname to the part that proves which endpoint answered,
 * without printing the whole address.
 *
 * Neon endpoint hostnames read `ep-<adjective>-<noun>-<id>.<region>.aws.neon.tech`.
 * The two branches of this project have different adjectives, so the first two
 * segments plus the region are enough to tell `dev` from `main` at a glance —
 * which is the entire job of the line this appears in. The unique id and the
 * constant `aws.neon.tech` tail do no work and come out.
 *
 * Anything that is not shaped like that — `localhost`, a bare IP, a short host —
 * has nothing to abbreviate and is returned untouched.
 */
function abbreviateHost(hostname: string): string {
  const labels = hostname.split('.');
  const endpoint = labels[0];
  const region = labels[1];
  if (endpoint === undefined || region === undefined) return hostname;

  const segments = endpoint.split('-');
  if (segments.length <= 2) return hostname;

  // ASCII '...' rather than a real ellipsis: Windows PowerShell 5.1 reads output
  // through the legacy codepage and would render one as mojibake, and this line
  // exists to be pasted into chat and into session logs.
  return `${segments.slice(0, 2).join('-')}-...${region}`;
}

/**
 * Database name and an abbreviated endpoint, for the line every connecting
 * program prints before it acts.
 *
 * The connection string contains the password and must never be printed in full.
 * The hostname is not a credential, but it is the project's address, and runs get
 * pasted into chat and into Notion session logs — so it is abbreviated too. What
 * survives is exactly what the line is FOR: proof that the intended target
 * resolved, printed before anything happens.
 *
 * The BRANCH name is deliberately absent, because it is not in the connection
 * string: Neon puts the branch in the endpoint id, not in a readable label, and
 * both branches use the same database name. The loader knows its branch from
 * `--target` and prints that itself on the line above. The server genuinely does
 * not know — under Q18 it reads DATABASE_URL and never chooses a database —
 * and printing a guess would be worse than printing nothing.
 */
export function describeTarget(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    const database = url.pathname.replace(/^\//, '') || '(no database in the string)';
    return `${database} @ ${abbreviateHost(url.hostname)}`;
  } catch {
    return '(could not parse the connection string)';
  }
}

/**
 * One line saying what TLS was actually enforced, and what was taken out of the
 * string to enforce it. Printed by every program that connects, so a run never
 * has to be trusted on this point.
 */
export function describeTls(connectionString: string): string {
  const { removed } = stripTlsParameters(connectionString);
  const dropped =
    removed.length === 0
      ? 'no TLS parameters were in the string'
      : `${removed.join(', ')} dropped from the string, decided in code instead`;
  return `ssl { rejectUnauthorized: true } — ${dropped}`;
}
