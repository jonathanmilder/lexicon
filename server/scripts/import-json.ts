/**
 * import-json.ts — the loader (Q5).
 *
 * WHAT THIS IS FOR
 * ----------------
 * The v3.1 artifact's library lives in a JSON export. This script is what moves
 * it into Postgres. It is built across three steps, and only the FIRST of them
 * exists today:
 *
 *   step 5  read the file, validate it, print what is there.   <- this is all
 *   step 6  insert the user, the settings, and the 1,070 words.
 *   step 9  insert the 95 progress records.
 *
 * SO: THIS SCRIPT DOES NOT TOUCH A DATABASE.
 * It does not import `pg`. It does not read DATABASE_URL, DATABASE_URL_DEV, or
 * DATABASE_URL_MAIN. It takes no --target. Two reasons, both deliberate:
 *
 *   1. 5d puts "fail before touching the database" first. A validator that needs
 *      a live connection cannot be run casually, and this one should be run
 *      fifty times while the reporting gets right.
 *   2. Q21: every connection wakes Neon's compute and spends from a 100 CU-hour
 *      monthly bucket that `dev` and `main` share. A file-only step costs nothing
 *      to iterate on.
 *
 * WHAT IT READS
 * -------------
 *   node server/scripts/import-json.ts <path-to-backup.json>
 *
 * No runner and no build step: Node 24 executes .ts directly by stripping the
 * type annotations. It does not check them — `npm run typecheck` does that.
 *
 * The path is required and has NO DEFAULT. Two backup files sit side by side in
 * Dropbox and only the larger one is the file of record:
 *
 *   lexicon-backup-2026-08-03-b.json   2,037,770 bytes   <- this one
 *   lexicon-backup-2026-08-03.json     1,302,925 bytes   <- NOT this one
 *
 * A default is how the wrong one gets read silently.
 *
 * WHAT COUNTS AS FAILURE (5e)
 * ---------------------------
 * Fail on anything suggesting the data is not what we understand it to be.
 * Warn on anything understood but unexpected.
 *
 * In practice the dividing line is the frozen baseline below. v3.1 is frozen in
 * data as well as code, so every number in BASELINE is a fact read off this file
 * on 2026-08-04, not an expectation. A number that disagrees means the wrong file
 * or a broken reader, so it FAILS. Anything the baseline does not cover — a key
 * nobody has seen before, a field present but empty — is a WARNING.
 *
 * A MISSING OPTIONAL FIELD IS NEITHER. `bromide` has no pronunciation and
 * `portentous` has no etymology. Gaps are normal and must never be warned on.
 * Only `definitions` marks a word fetched.
 */

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// The frozen baseline. Read from lexicon-backup-2026-08-03-b.json on 2026-08-04
// and confirmed against the artifact by hand. These are facts, not settings:
// v3.1 is frozen, so they cannot drift. Anything disagreeing is a finding.
// ---------------------------------------------------------------------------
const BASELINE = {
  words: 1070,
  fetched: 974,
  unfetched: 96,
  progress: 95,
} as const;

// ---------------------------------------------------------------------------
// Shapes. Everything off the disk is `unknown` until it has been checked —
// JSON.parse promises nothing, and the whole job of this script is to stop
// believing the file before it has been read.
// ---------------------------------------------------------------------------

/** One word as it appears in the export. Every key is optional except `word`. */
interface WordRecord {
  readonly [key: string]: unknown;
}

/** One progress record: `{ ease, repetition, nextReview }`, keyed by headword. */
interface ProgressRecord {
  readonly [key: string]: unknown;
}

interface Backup {
  readonly words: readonly WordRecord[];
  readonly progress: Readonly<Record<string, ProgressRecord>>;
  readonly sources: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Findings. Collected rather than thrown, so one run reports everything wrong
// with the file instead of only the first thing. Nothing here writes anywhere,
// so there is no reason to stop early.
// ---------------------------------------------------------------------------

class Findings {
  readonly failures: string[] = [];
  readonly warnings: string[] = [];

  fail(message: string): void {
    this.failures.push(message);
  }

  warn(message: string): void {
    this.warnings.push(message);
  }
}

// ---------------------------------------------------------------------------
// Small formatting helpers. The output is read by a person deciding whether to
// trust the file, so it is laid out as a table rather than a log.
// ---------------------------------------------------------------------------

const n = (value: number): string => value.toLocaleString('en-US');

/** One line of the counts table: label, found, expected, verdict. */
function countLine(label: string, found: number, expected: number): string {
  const verdict = found === expected ? 'ok' : 'MISMATCH';
  return (
    `  ${label.padEnd(24)}` +
    `${n(found).padStart(7)}` +
    `${n(expected).padStart(12)}` +
    `   ${verdict}`
  );
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Read and parse the file. These are the only failures that stop the run dead:
 * if there is no parseable object with a `words` array, every later check would
 * be reporting on nothing.
 */
function readBackup(sourcePath: string): { backup: Backup; bytes: number } {
  let bytes: number;
  try {
    bytes = statSync(sourcePath).size;
  } catch {
    console.error(`\nNo such file: ${sourcePath}\n`);
    process.exit(1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(sourcePath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nThat file is not valid JSON: ${message}\n`);
    process.exit(1);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.error('\nThe file does not hold a JSON object. That is not a Lexicon backup.\n');
    process.exit(1);
  }

  const root = parsed as Record<string, unknown>;

  if (!Array.isArray(root['words'])) {
    console.error('\nNo `words` array. That is not a Lexicon backup.\n');
    process.exit(1);
  }

  // `progress` and `sources` are checked rather than assumed, but a bad one is a
  // finding and not a reason to stop: the word counts are still worth printing.
  const progress =
    typeof root['progress'] === 'object' && root['progress'] !== null && !Array.isArray(root['progress'])
      ? (root['progress'] as Record<string, ProgressRecord>)
      : {};

  const sources =
    typeof root['sources'] === 'object' && root['sources'] !== null && !Array.isArray(root['sources'])
      ? (root['sources'] as Record<string, unknown>)
      : {};

  return {
    backup: { words: root['words'] as WordRecord[], progress, sources },
    bytes,
  };
}

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

/** A word is fetched if it has a `definitions` array. Nothing else marks it. */
function isFetched(word: WordRecord): boolean {
  return Array.isArray(word['definitions']);
}

function reportCounts(backup: Backup, findings: Findings): void {
  const words = backup.words.length;
  const fetched = backup.words.filter(isFetched).length;
  const unfetched = words - fetched;
  const progress = Object.keys(backup.progress).length;

  console.log('\nCounts');
  console.log(`  ${''.padEnd(24)}${'found'.padStart(7)}${'expected'.padStart(12)}`);
  console.log(countLine('words', words, BASELINE.words));
  console.log(countLine('fetched', fetched, BASELINE.fetched));
  console.log(countLine('unfetched', unfetched, BASELINE.unfetched));
  console.log(countLine('progress records', progress, BASELINE.progress));

  // The wrong-file guard. The sibling backup holds 1,071 words of which only 663
  // are fetched, so it trips on the second line even though it passes the first.
  const mismatched =
    words !== BASELINE.words ||
    fetched !== BASELINE.fetched ||
    unfetched !== BASELINE.unfetched ||
    progress !== BASELINE.progress;

  if (mismatched) {
    findings.fail(
      'Counts disagree with the frozen baseline. Either this is the wrong file, or ' +
        'the reader is broken. The file of record is lexicon-backup-2026-08-03-b.json ' +
        'at 2,037,770 bytes — not the smaller sibling beside it.',
    );
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function reportSource(sourcePath: string, bytes: number): void {
  console.log('\nimport-json — read and validate (step 5).');
  console.log('No database is opened and nothing is written.');
  console.log('\nSource');
  console.log(`  ${path.basename(sourcePath)}`);
  console.log(`  ${n(bytes)} bytes`);
  console.log(`  ${sourcePath}`);
}

/** Print the findings and return the exit code. */
function reportFindings(findings: Findings): number {
  for (const failure of findings.failures) {
    console.log(`\nFAIL  ${failure}`);
  }
  for (const warning of findings.warnings) {
    console.log(`\nWARN  ${warning}`);
  }

  const failed = findings.failures.length > 0;
  const verdict = failed ? 'FAIL' : 'PASS';

  console.log(
    `\nResult: ${verdict} — ${n(findings.failures.length)} failure(s), ` +
      `${n(findings.warnings.length)} warning(s).\n`,
  );

  return failed ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

interface Args {
  readonly source: string;
}

function usage(): never {
  console.error(`
Read a Lexicon backup, validate it, and print what is in it. Writes nothing.

  node server/scripts/import-json.ts <path-to-backup.json>

The path is required and has no default. The file of record is
lexicon-backup-2026-08-03-b.json (2,037,770 bytes) — NOT the smaller
lexicon-backup-2026-08-03.json that sits beside it.
`);
  process.exit(1);
}

function parseArgs(argv: readonly string[]): Args {
  let source: string | null = null;

  for (const arg of argv) {
    if (arg.startsWith('--')) {
      console.error(`Unknown option: ${arg}`);
      process.exit(1);
    } else if (source === null) {
      source = arg;
    } else {
      console.error(`Unexpected extra argument: ${arg}`);
      process.exit(1);
    }
  }

  if (source === null) usage();
  return { source };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const sourcePath = path.resolve(args.source);

  const { backup, bytes } = readBackup(sourcePath);
  const findings = new Findings();

  reportSource(sourcePath, bytes);
  reportCounts(backup, findings);

  process.exit(reportFindings(findings));
}

main();
