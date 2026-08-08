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

/**
 * How many of the 974 fetched words carry each field, in the order the report
 * prints them. The gaps are real and they are fine: `bromide` has no
 * pronunciation, `portentous` no etymology. Fields are independently optional
 * and a missing one is never a warning.
 *
 * `example` (singular) is in this table because it is a field like any other
 * when you are counting coverage. It is also a stray key with no column, which
 * is a separate matter, handled in the stray-key report.
 */
const COVERAGE: ReadonlyArray<readonly [field: string, expected: number]> = [
  ['definitions', 974],
  ['mnemonics', 974],
  ['part_of_speech', 974],
  ['usage_note', 974],
  ['etymology', 973],
  ['pronunciation', 973],
  ['examples', 970],
  ['example', 76],
];

/** Structural facts about the file, verified 2026-08-04 and frozen with it. */
const STRUCTURE = {
  dictionaries: 4,
  usageGuides: 6,
  multiWordHeadwords: 62,
} as const;

/**
 * Characters that make a headword multi-part: space, hyphen-minus, and the
 * Unicode hyphens and dashes. `a fortiori`, `coup de grâce`, `will-o'-the-wisp`,
 * `vis-à-vis` and 58 others. They matter for string matching, so they are
 * counted rather than assumed.
 */
const HEADWORD_SEPARATOR = /[ \-‐‑–—]/;

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
// Field coverage (5g)
// ---------------------------------------------------------------------------

/**
 * A field counts as present if the key exists and holds something other than
 * null. Absent and null are the same thing here — both become a NULL column at
 * step 6, and both are normal.
 */
function hasField(word: WordRecord, field: string): boolean {
  const value = word[field];
  return value !== undefined && value !== null;
}

function reportCoverage(backup: Backup, findings: Findings): void {
  const fetched = backup.words.filter(isFetched);

  console.log(`\nField coverage, of ${n(fetched.length)} fetched`);
  console.log(`  ${''.padEnd(24)}${'found'.padStart(7)}${'expected'.padStart(12)}`);

  for (const [field, expected] of COVERAGE) {
    const found = fetched.filter((word) => hasField(word, field)).length;
    const label = field === 'example' ? 'example (singular)' : field;
    console.log(countLine(label, found, expected));

    if (found !== expected) {
      findings.fail(
        `Field coverage for \`${field}\` is ${n(found)}, not the frozen ${n(expected)}.`,
      );
    }
  }

  // Coverage is quoted "of the 974 fetched", which is only the whole story if
  // the unfetched 96 carry nothing. They carry nothing but `word` — checked
  // rather than assumed, because a definition field on an unfetched word would
  // mean `definitions` is not the marker the whole script relies on.
  const strayOnUnfetched = new Set<string>();
  for (const word of backup.words) {
    if (isFetched(word)) continue;
    for (const key of Object.keys(word)) {
      if (key !== 'word') strayOnUnfetched.add(key);
    }
  }

  if (strayOnUnfetched.size === 0) {
    console.log('\n  The 96 unfetched words carry the `word` key and nothing else.');
  } else {
    findings.fail(
      'Unfetched words carry fields beyond `word`: ' +
        `${[...strayOnUnfetched].sort().join(', ')}. ` +
        '`definitions` may not be the fetched/unfetched marker after all.',
    );
  }
}

// ---------------------------------------------------------------------------
// Structural facts
// ---------------------------------------------------------------------------

/** One structural claim: printed either way, a failure when it does not hold. */
function claim(findings: Findings, holds: boolean, line: string, onFailure: string): void {
  console.log(`  ${holds ? 'ok  ' : 'FAIL'}  ${line}`);
  if (!holds) findings.fail(onFailure);
}

function reportStructure(backup: Backup, findings: Findings): void {
  console.log('\nStructure');

  // --- sources: an object of two arrays, not the flat array once assumed ----
  const dictionaries = backup.sources['dictionaries'];
  const usageGuides = backup.sources['usageGuides'];
  const dictCount = Array.isArray(dictionaries) ? dictionaries.length : -1;
  const guideCount = Array.isArray(usageGuides) ? usageGuides.length : -1;

  claim(
    findings,
    dictCount === STRUCTURE.dictionaries && guideCount === STRUCTURE.usageGuides,
    `sources is an object of two arrays: dictionaries ${dictCount}, usageGuides ${guideCount} ` +
      `(expected ${STRUCTURE.dictionaries} and ${STRUCTURE.usageGuides}).`,
    'sources is not the two-array object 24k describes. The schema stores it as two ' +
      'text[] columns, so this shape is load-bearing.',
  );
  console.log('        usageGuides is the file\'s one camelCase key; it becomes usage_guides.');

  // --- headwords -----------------------------------------------------------
  const headwords = backup.words.map((word) => word['word']);
  const allStrings = headwords.every((word) => typeof word === 'string');

  claim(
    findings,
    allStrings,
    `every one of the ${n(headwords.length)} records has a string \`word\`.`,
    'Some records have a missing or non-string `word`. The headword is the public ' +
      'identity of a record (24a); nothing can be loaded without it.',
  );

  if (!allStrings) return;
  const words = headwords as string[];

  const capitalized = words.filter((word) => word !== word.toLowerCase());
  claim(
    findings,
    capitalized.length === 0,
    `all ${n(words.length)} headwords are lowercase, zero exceptions.`,
    `${n(capitalized.length)} headwords are not lowercase: ${capitalized.slice(0, 5).join(', ')}. ` +
      '26a assumes it supplies every capital that will ever exist in the library.',
  );

  const distinct = new Set(words.map((word) => word.toLowerCase()));
  claim(
    findings,
    distinct.size === words.length,
    `all ${n(words.length)} headwords are distinct, compared case-insensitively.`,
    `${n(words.length - distinct.size)} headwords collide case-insensitively. The unique ` +
      'index words_user_word_lower (24h) would reject them at step 6.',
  );

  const multiWord = words.filter((word) => HEADWORD_SEPARATOR.test(word));
  claim(
    findings,
    multiWord.length === STRUCTURE.multiWordHeadwords,
    `${n(multiWord.length)} headwords are multi-word or hyphenated ` +
      `(expected ${n(STRUCTURE.multiWordHeadwords)}).`,
    `Found ${n(multiWord.length)} multi-word headwords, not the frozen ` +
      `${n(STRUCTURE.multiWordHeadwords)}.`,
  );

  // --- progress ------------------------------------------------------------
  // 24h settled that identity is the lowercase comparison, so progress keys are
  // resolved case-insensitively here exactly as step 9 will resolve them.
  const byLower = new Map(words.map((word) => [word.toLowerCase(), word]));
  const fetchedLower = new Set(
    backup.words.filter(isFetched).map((word) => String(word['word']).toLowerCase()),
  );

  const progressKeys = Object.keys(backup.progress);
  const orphans = progressKeys.filter((key) => !byLower.has(key.toLowerCase()));
  const atUnfetched = progressKeys.filter(
    (key) => byLower.has(key.toLowerCase()) && !fetchedLower.has(key.toLowerCase()),
  );

  claim(
    findings,
    orphans.length === 0,
    `all ${n(progressKeys.length)} progress records resolve to a headword.`,
    `${n(orphans.length)} progress records point at no word: ${orphans.slice(0, 5).join(', ')}.`,
  );

  claim(
    findings,
    atUnfetched.length === 0,
    'no progress record points at an unfetched word.',
    `${n(atUnfetched.length)} progress records point at unfetched words: ` +
      `${atUnfetched.slice(0, 5).join(', ')}.`,
  );

  const exact = progressKeys.filter((key) => byLower.get(key.toLowerCase()) === key).length;
  const inexact = progressKeys.length - exact;
  console.log(
    inexact === 0
      ? `        All ${n(exact)} match their headword exactly, so the case-insensitive ` +
          'match changes nothing today. Step 9 needs it anyway, once 26a adds capitals.'
      : `        ${n(exact)} match exactly; ${n(inexact)} need the case-insensitive match.`,
  );
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
  reportCoverage(backup, findings);
  reportStructure(backup, findings);

  process.exit(reportFindings(findings));
}

main();
