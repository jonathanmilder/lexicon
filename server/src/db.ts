/**
 * db.ts — the connection pool (Q21c).
 *
 * A pool is a small set of open connections that requests borrow and give back,
 * rather than each request paying to open one. The analogy is a shelf of library
 * cards: you take one, use it, put it back. Where the analogy breaks is that a
 * card left on the shelf too long goes stale — an idle connection can be severed
 * from the far end — which is what `idleTimeoutMillis` below is about.
 *
 * TLS IS NOT CONFIGURED HERE. It comes from db-config.ts, which strips the TLS
 * parameters out of the connection string and passes `ssl` explicitly. See that
 * module for why the difference is load-bearing (Q18, amendments 2 and 3).
 *
 *
 * WHAT DOES NOT GO IN THIS FILE, EVER (Q21a)
 * ------------------------------------------
 * Nothing in this project queries the database on a schedule. No keep-warm timer,
 * no `setInterval`, no health check that runs `SELECT 1`.
 *
 * The reason is a fact about Neon that is worth stating plainly, because it is
 * counterintuitive: a Neon compute sleeps after five minutes with NO QUERIES —
 * not five minutes with no connections. Opening a connection wakes it; holding
 * one open does not keep it awake. So a pool that sits idle overnight costs
 * nothing, while one `SELECT 1` every five minutes is a compute that never
 * sleeps and a free tier exhausted around day seventeen, with no error printed
 * anywhere until the month ends.
 *
 * That is the whole reason the numbers below are described as latency choices
 * rather than cost choices. They are not the quota lever. What issues queries,
 * and how often, is the quota lever.
 */

import pg from 'pg';
import type { Pool } from 'pg';
import { buildConnectionConfig } from './db-config.ts';

/**
 * Build the pool.
 *
 * A function rather than an exported `const pool` so that reading DATABASE_URL
 * stays in one place — index.ts — where the boot hook already needs it. Two
 * modules reading the same variable is two places to keep in step and two
 * different messages when it is missing.
 */
export function createPool(connectionString: string): Pool {
  const pool = new pg.Pool({
    // connectionString (TLS parameters removed) and the explicit ssl object.
    ...buildConnectionConfig(connectionString),

    // One user, one Render instance. A 0.25 CU Neon compute allows 104
    // connections, 97 after Neon's reserved slots, so this is nowhere near any
    // limit — it is chosen to be bounded and comprehensible, and to leave room
    // for the hand-run loader connecting at the same time.
    max: 5,

    // Sixty seconds sits safely under Neon's five-minute suspend window, so the
    // pool always closes an idle connection before Neon can sever it. That turns
    // "handle a connection dropped from the far end" from a runtime problem into
    // a scheduling one. It costs nothing in compute hours: during a study session
    // the compute is awake anyway, and afterwards the last connection dies at
    // sixty seconds, long before the suspend.
    idleTimeoutMillis: 60_000,

    // The one real improvement over pg's defaults, where 0 means wait forever.
    // Ten seconds leaves room for a Neon cold start and then fails loudly.
    connectionTimeoutMillis: 10_000,

    // `min` is left at pg's default of 0. A minimum above zero is the one pool
    // setting that would deliberately hold connections open. Stated here because
    // its absence is a decision, and an absent decision is invisible.
  });

  // NOT OPTIONAL. An error on an IDLE pooled client — the far end closing it,
  // a network blip — is emitted on the pool object itself, and an unhandled
  // 'error' event on a Node EventEmitter takes the whole process down. So a
  // connection dropped at 3am would kill a server with no requests in flight.
  //
  // LOG AND DO NOT EXIT. The pool opens fresh connections when queries next
  // arrive, and that is also what wakes a sleeping Neon compute. Exiting here
  // would turn a self-healing event into an outage.
  pool.on('error', (error) => {
    console.error(`pg pool error (idle client): ${error.message}`);
  });

  return pool;
}
