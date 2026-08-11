/**
 * index.ts — the Express server (step 7a).
 *
 * The first vertical slice's server half: Postgres -> pg -> Express -> JSON.
 * One endpoint, no client, no styling. Step 7b adds Vite and React on the other
 * side of the same wire.
 *
 * HOW TO RUN IT
 * -------------
 *   npm run dev     node --env-file=.env server/src/index.ts
 *   npm start       node server/src/index.ts        (what Render will run)
 *
 * The difference is deliberate and is the whole of Q18's local/production split:
 * locally Node reads .env itself, natively, since v20.6 — no dotenv dependency.
 * On Render the environment variables are real environment variables, injected by
 * the platform, so no --env-file is passed and none is wanted. The difference is
 * visible in package.json rather than hidden inside a library.
 *
 * No runner and no build step: Node 24 executes .ts directly by stripping the
 * type annotations. It does not check them — `npm run typecheck` does that.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 *   - No health-check route. Render's default health check is a TCP probe: it
 *     confirms the port accepts a connection, which is a fact about the server,
 *     not about Postgres. An HTTP health route that ran SELECT 1 on a schedule
 *     would keep the Neon compute permanently awake and exhaust the free tier in
 *     about seventeen days, silently. Q21a: nothing in this project queries the
 *     database on a schedule. The cost is accepted and real — a TCP probe reports
 *     the service healthy while the database is unreachable.
 *   - No cors, no helmet, no morgan, no dotenv. Express is the only new runtime
 *     dependency, and each of those is either unnecessary here or a step-8
 *     question if it is a question at all.
 *   - No user filter on the query. Leg one has exactly one user; Q8 puts "make
 *     every query filter by the logged-in user" in leg two, as one job done once
 *     rather than a half-measure now.
 */

import express from 'express';
import { createPool } from './db.ts';
import { formatDatabaseError } from './format-database-error.ts';
import { runMigrations } from './migrate.ts';

/** Render supplies PORT. Locally, .env may or may not; 3000 if it does not. */
const DEFAULT_PORT = 3000;

/**
 * Every column of `words` except `user_id`, which is the single-user placeholder
 * of 24i and means nothing outside the server.
 *
 * ORDER BY lower(word) matches the functional unique index from 24h, so Postgres
 * can read the order straight off the index. No pagination: 1,070 rows is the
 * whole library, and if that turns out to be slow it is a fact worth learning
 * rather than a problem worth pre-solving.
 */
const SELECT_WORDS = `
  SELECT id, word, part_of_speech, pronunciation, definitions,
         etymology, usage_note, examples, mnemonics, created_at
    FROM words
   ORDER BY lower(word)
`;

function resolvePort(): number {
  const raw = process.env.PORT;
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT;

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`server: PORT is set to "${raw}", which is not a port number.`);
    process.exit(1);
  }
  return port;
}

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('server: DATABASE_URL is not set.');
  console.error('  It belongs in .env — see .env.example for the shape.');
  console.error('  `npm run dev` passes --env-file=.env for you.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Boot: migrate to completion, THEN listen (Q28, option A)
// ---------------------------------------------------------------------------
//
// A deploy must never land new code on a database that lacks something the code
// queries. Running the migrations at boot gives one mechanism, identical on this
// laptop and on Render: both `npm run dev` and `npm start` migrate, then serve.
//
// Failure then does the right thing with no configuration anywhere: the process
// exits non-zero, Render's health check never passes, the deploy is marked
// failed, and the previous working version stays live.
//
// runMigrations exits non-zero itself when it cannot connect or when a migration
// file fails. The catch below is for what it does not handle — an unreadable
// migrations directory, or db-config refusing a connection string it could not
// rebuild safely. Either way: say so, and do not listen.
try {
  await runMigrations(connectionString);
} catch (error) {
  console.error('server: the migration runner threw. Not starting.');
  console.error(formatDatabaseError(error));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------

const pool = createPool(connectionString);
const app = express();

app.get('/api/words', async (_request, response) => {
  try {
    const result = await pool.query(SELECT_WORDS);
    response.json(result.rows);
  } catch (error) {
    // The detail goes to the terminal, where the person running this can read
    // it. The response gets a fixed sentence: a Postgres error can quote the
    // failing statement, and nothing about this server's database belongs in
    // something a browser can see.
    console.error('server: GET /api/words failed.');
    console.error(formatDatabaseError(error));
    response.status(500).json({ error: 'Could not read the library.' });
  }
});

const port = resolvePort();

const server = app.listen(port, () => {
  console.log(`server: listening on http://localhost:${port}`);
  console.log(`server: try http://localhost:${port}/api/words`);
});

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------
//
// Render sends SIGTERM when it redeploys or restarts a service. Stop accepting
// new requests, let the ones in flight finish, then close the pool so the open
// Postgres connections are given back rather than dropped.
//
// Nothing calls process.exit here. Once the listener is closed and the pool is
// ended there is nothing left holding the event loop open, and Node exits by
// itself — which is the honest signal that the shutdown actually finished.
//
// SIGTERM only, which is what was asked for and what Render sends. Ctrl+C sends
// SIGINT and takes Node's default path: the process dies at once and prints none
// of the lines below. That is fine locally — Neon reclaims the connections — but
// it is why stopping the server by hand looks abrupt.
//
// UNVERIFIABLE UNTIL STEP 8. This is written, not tested: nothing sends this
// process a SIGTERM until Render does.
process.on('SIGTERM', () => {
  console.log('server: SIGTERM received. Closing.');

  server.close((error) => {
    if (error) console.error(`server: ${error.message}`);

    pool
      .end()
      .then(() => console.log('server: pool closed.'))
      .catch((poolError: unknown) => {
        console.error('server: the pool did not close cleanly.');
        console.error(formatDatabaseError(poolError));
      });
  });
});
