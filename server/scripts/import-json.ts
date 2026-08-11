/**
 * import-json.ts — the loader (Q5).
 *
 * WHAT THIS IS FOR
 * ----------------
 * The v3.1 artifact's library lives in a JSON export. This script is what moves
 * it into Postgres. It is built across three steps, and TWO of them exist today:
 *
 *   step 5  read the file, validate it, print what is there.   <- done
 *   step 6  insert the user, the settings, and the 1,070 words. <- done
 *   step 9  insert the 95 progress records.                     <- not yet
 *
 * HOW TO RUN IT
 * -------------
 *   node --env-file=.env server/scripts/import-json.ts \
 *        <path-to-backup.json> --target dev|main [--dry-run] [--strict]
 *
 * No runner and no build step: Node 24 executes .ts directly by stripping the
 * type annotations. It does not check them — `npm run typecheck` does that.
 *
 * TWO ARGUMENTS, NEITHER WITH A DEFAULT (5c, Q18)
 * -----------------------------------------------
 * The FILE PATH has no default. Two backup files sit side by side in Dropbox and
 * only the larger one is the file of record:
 *
 *   lexicon-backup-2026-08-03-b.json   2,037,770 bytes   <- this one
 *   lexicon-backup-2026-08-03.json     1,302,925 bytes   <- NOT this one
 *
 * A default is how the wrong one gets read silently.
 *
 * --target has no default AND NO FALLBACK. It selects DATABASE_URL_DEV or
 * DATABASE_URL_MAIN. It never reads DATABASE_URL — that variable belongs to the
 * server, which is not allowed to choose a database, whereas this program is the
 * one that runs TRUNCATE and must be told out loud. A command retyped without
 * --target stops for lack of a target rather than assuming one; that guard is
 * what made deferring --dry-run from step 5 to step 6 safe, so removing it later
 * silently invalidates a decision made elsewhere.
 *
 * --target main additionally requires a typed confirmation.
 *
 * WHAT IT WRITES (5d, steps 3 to 5 of the sequence)
 * -------------------------------------------------
 * Inside ONE transaction: TRUNCATE the four application tables, insert the single
 * users row and its user_settings row, then insert all 1,070 words verbatim with
 * 26a's accepted corrections and Q27's five rules applied.
 *
 * schema_migrations is NOT truncated. It belongs to the migration runner (Q28);
 * emptying it would make the database and the repo disagree, silently.
 *
 * --dry-run runs the whole transaction and then ROLLs BACK instead of
 * COMMITting. The point is to exercise every write and every constraint and
 * throw the result away — not to skip the writes.
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
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import type { Client as PgClient } from 'pg';
import { buildConnectionConfig, describeTarget, describeTls } from '../src/db-config.ts';
import { formatDatabaseError } from '../src/format-database-error.ts';

const { Client } = pg;

/** The repo root, found from this file rather than from the current directory. */
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 26a's decisions file. The loader applies only entries marked `accepted`. */
const CORRECTIONS_PATH = path.join(REPO_ROOT, 'data', 'capitalizations.json');

/**
 * --target selects one of these and nothing else. DATABASE_URL is deliberately
 * absent: it is the server's variable, and the server never chooses a database.
 */
const TARGET_VARIABLES = {
  dev: 'DATABASE_URL_DEV',
  main: 'DATABASE_URL_MAIN',
} as const;

type Target = keyof typeof TARGET_VARIABLES;

/** What must be typed, in full, before anything is written to main. */
const MAIN_CONFIRMATION = 'load main';

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

/** The three top-level keys of the export: `{ words, progress, sources }`. */
const TOP_LEVEL_KEYS = new Set(['words', 'progress', 'sources']);

/** The eight word keys that become columns on `words`. Everything else is stray. */
const MAPPED_KEYS = new Set([
  'word',
  'part_of_speech',
  'pronunciation',
  'definitions',
  'etymology',
  'usage_note',
  'examples',
  'mnemonics',
]);

/** The three keys of a progress record: `{ ease, repetition, nextReview }`. */
const PROGRESS_KEYS = new Set(['ease', 'repetition', 'nextReview']);

/** SM-2's ease floor. Below this is not impossible, only worth a second look. */
const EASE_FLOOR = 1.3;

/**
 * The five stray keys Q27 resolved. None of them becomes a column, and each has
 * a rule that step 6 will apply. Step 5 only counts them and names the words.
 *
 * These five are RECOGNISED, so they are report lines rather than warnings. A
 * sixth key would be genuinely unrecognised, and that is the warning 5e means.
 *
 * The distinction is load-bearing: `--strict` is ON at cutover, so making the
 * five permanent warnings would make `--strict` fail every run by construction,
 * which would make the flag worthless on the one day it exists for.
 */
const STRAY_KEYS: ReadonlyArray<{
  readonly key: string;
  readonly expected: number;
  readonly disposition: readonly string[];
}> = [
  {
    key: 'example',
    expected: 76,
    disposition: [
      'Fallback, not merge: where `examples` exists it wins outright.',
      'Merging would need to decide whether two sentences are the same sentence,',
      'and that is exact string matching — a curly apostrophe apart and a near',
      'duplicate slips into a tool built for orthographic precision.',
    ],
  },
  {
    key: 'confusables',
    expected: 3,
    disposition: [
      'Discarded, reported by word. A bare list of near-miss words with no',
      'explanation; `usage_note` is already told to carry that job.',
    ],
  },
  {
    key: 'etymology_note',
    expected: 3,
    disposition: ['Appended to `etymology`, separated by a blank line.'],
  },
  {
    key: 'pronunciation_note',
    expected: 1,
    disposition: ['Appended to `pronunciation`, separated by a blank line.'],
  },
  {
    key: 'definitons',
    expected: 1,
    disposition: [
      'A typo for `definitions`. Discarded, reported by word AND by key name —',
      'a silent discard means a recurrence vanishes without trace.',
      'Note it holds an array, not a string, exactly as `definitions` would.',
    ],
  },
];

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
  /** Kept so a fourth top-level key can be noticed rather than ignored. */
  readonly topLevelKeys: readonly string[];
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

/** `1 word` / `2 words`. Same helper migrate.ts uses, for the same reason. */
function count(value: number, noun: string, plural = `${noun}s`): string {
  return `${n(value)} ${value === 1 ? noun : plural}`;
}

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
    backup: {
      words: root['words'] as WordRecord[],
      progress,
      sources,
      topLevelKeys: Object.keys(root),
    },
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
    // Counted, not quoted: on the wrong file this line would otherwise claim 96
    // while the counts table above it reported 408.
    const unfetched = backup.words.length - fetched.length;
    console.log(
      `\n  The ${n(unfetched)} unfetched words carry the \`word\` key and nothing else.`,
    );
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
    `${count(capitalized.length, 'headword')} ${capitalized.length === 1 ? 'is' : 'are'} not ` +
      `lowercase: ${capitalized.slice(0, 5).join(', ')}. ` +
      '26a assumes it supplies every capital that will ever exist in the library.',
  );

  const distinct = new Set(words.map((word) => word.toLowerCase()));
  claim(
    findings,
    distinct.size === words.length,
    `all ${n(words.length)} headwords are distinct, compared case-insensitively.`,
    `${count(words.length - distinct.size, 'headword')} collide case-insensitively. The unique ` +
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
    `${count(orphans.length, 'progress record')} point at no word: ` +
      `${orphans.slice(0, 5).join(', ')}.`,
  );

  claim(
    findings,
    atUnfetched.length === 0,
    'no progress record points at an unfetched word.',
    `${count(atUnfetched.length, 'progress record')} point at unfetched words: ` +
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
// Stray keys (5e, Q27)
// ---------------------------------------------------------------------------

/** The headwords carrying a given key, for the named report lines Q27 requires. */
function wordsWith(backup: Backup, key: string): string[] {
  return backup.words
    .filter((word) => word[key] !== undefined)
    .map((word) => String(word['word']));
}

/** `x, y and z` — the report names words, and it should read like prose. */
function series(items: readonly string[], limit = 8): string {
  const shown = items.slice(0, limit);
  const tail = items.length > limit ? `, and ${n(items.length - limit)} more` : '';
  if (shown.length <= 1) return (shown[0] ?? '') + tail;
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}${tail}`;
}

function reportStrayKeys(backup: Backup, findings: Findings): void {
  console.log('\nStray keys — present in the file, no column in the schema (Q27)');
  console.log(`  ${''.padEnd(24)}${'found'.padStart(7)}${'expected'.padStart(12)}`);

  for (const { key, expected, disposition } of STRAY_KEYS) {
    const carriers = wordsWith(backup, key);
    console.log(countLine(key, carriers.length, expected));

    for (const line of disposition) console.log(`        ${line}`);

    if (key === 'example') {
      // Q27 requires both outcomes of the fallback in the summary. Counting them
      // is detection; nothing is transformed here.
      const alsoPlural = carriers.filter((word) =>
        backup.words.some((w) => w['word'] === word && Array.isArray(w['examples'])),
      );
      const only = carriers.filter((word) => !alsoPlural.includes(word));
      console.log(
        `        ${n(alsoPlural.length)} also have \`examples\` — those sentences are ` +
          'discarded at step 6.',
      );
      console.log(
        `        ${n(only.length)} have \`example\` alone — promoted to sole entry: ` +
          `${series(only)}.`,
      );
    } else {
      console.log(`        On: ${series(carriers)}.`);
    }

    if (carriers.length !== expected) {
      findings.fail(
        `Stray key \`${key}\` appears on ${n(carriers.length)} words, not the frozen ` +
          `${n(expected)}. Q27's rule for it was decided against that count.`,
      );
    }
  }

  // --- the sixth key -------------------------------------------------------
  // This is what 5e's "unrecognised keys are warnings, never silent" is about.
  const known = new Set([...MAPPED_KEYS, ...STRAY_KEYS.map((stray) => stray.key)]);
  const unrecognised = new Map<string, string[]>();

  for (const word of backup.words) {
    for (const key of Object.keys(word)) {
      if (known.has(key)) continue;
      const carriers = unrecognised.get(key) ?? [];
      carriers.push(String(word['word']));
      unrecognised.set(key, carriers);
    }
  }

  if (unrecognised.size === 0) {
    console.log('\n  No sixth stray key. Every key in the file is either a column or one of the five.');
  } else {
    for (const [key, carriers] of [...unrecognised].sort()) {
      findings.warn(
        `Unrecognised key \`${key}\` on ${count(carriers.length, 'word')}: ${series(carriers)}. ` +
          'Nothing in Q27 says what to do with it, so step 6 would drop it silently. ' +
          'Decide the rule before loading.',
      );
    }
  }

  // --- the top level -------------------------------------------------------
  // The export is `{ words, progress, sources }`. A fourth key is the same kind
  // of surprise as a sixth word key, one level up.
  const strayTopLevel = backup.topLevelKeys.filter((key) => !TOP_LEVEL_KEYS.has(key));
  if (strayTopLevel.length > 0) {
    findings.warn(
      `The export has top-level keys beyond words, progress and sources: ` +
        `${series(strayTopLevel)}. Nothing reads them.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Progress records
// ---------------------------------------------------------------------------

/**
 * The shape of the 95 records step 9 will insert. Checked here rather than
 * there, because 5d wants the file to fail before Postgres is opened, and a
 * malformed `nextReview` is exactly the kind of thing that would otherwise
 * surface halfway through a transaction.
 */
function reportProgressShape(backup: Backup, findings: Findings): void {
  const malformed: string[] = [];
  const lowEase: string[] = [];
  const unrecognised = new Map<string, string[]>();
  let earliest = Infinity;
  let latest = -Infinity;

  for (const [word, record] of Object.entries(backup.progress)) {
    const ease = record['ease'];
    const repetition = record['repetition'];
    const nextReview = record['nextReview'];

    const timestamp = typeof nextReview === 'string' ? Date.parse(nextReview) : NaN;

    if (
      typeof ease !== 'number' ||
      !Number.isInteger(repetition) ||
      Number.isNaN(timestamp)
    ) {
      malformed.push(word);
      continue;
    }

    if (ease < EASE_FLOOR) lowEase.push(word);
    earliest = Math.min(earliest, timestamp);
    latest = Math.max(latest, timestamp);

    for (const key of Object.keys(record)) {
      if (PROGRESS_KEYS.has(key)) continue;
      const carriers = unrecognised.get(key) ?? [];
      carriers.push(word);
      unrecognised.set(key, carriers);
    }
  }

  console.log('\nProgress records');

  claim(
    findings,
    malformed.length === 0,
    `all ${n(Object.keys(backup.progress).length)} hold a numeric ease, an integer ` +
      'repetition and a parseable nextReview.',
    `${count(malformed.length, 'progress record')} ${malformed.length === 1 ? 'is' : 'are'} ` +
      `malformed: ${series(malformed)}. ` +
      'Step 9 converts nextReview to timestamptz and cannot do so from these.',
  );

  if (Number.isFinite(earliest) && Number.isFinite(latest)) {
    const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
    console.log(`        nextReview spans ${day(earliest)} to ${day(latest)}.`);
  }

  for (const [key, carriers] of [...unrecognised].sort()) {
    findings.warn(
      `Unrecognised key \`${key}\` inside ${count(carriers.length, 'progress record')}: ` +
        `${series(carriers)}. A progress record should hold only ease, repetition ` +
        'and nextReview.',
    );
  }

  if (lowEase.length > 0) {
    findings.warn(
      `${count(lowEase.length, 'progress record')} ${lowEase.length === 1 ? 'sits' : 'sit'} ` +
        `below SM-2's ease floor of ${EASE_FLOOR}: ${series(lowEase)}. Understood but ` +
        'unexpected — the algorithm should not go there.',
    );
  }
}

// ---------------------------------------------------------------------------
// 26a — the capitalization corrections
//
// All 1,070 headwords in the file are lowercase, so this file supplies every
// capital the library will ever have. The hand review is a SOFT dependency: the
// loader is re-runnable, so an early run legitimately applies few or none. What
// it must not do is apply an entry nobody has looked at.
// ---------------------------------------------------------------------------

interface Corrections {
  /** lower(word) -> the verbatim headword to store. Accepted entries only. */
  readonly accepted: ReadonlyMap<string, string>;
  /** Every status found, and how many entries carry it. */
  readonly byStatus: ReadonlyMap<string, number>;
  readonly total: number;
}

function readCorrections(findings: Findings): Corrections {
  const accepted = new Map<string, string>();
  const byStatus = new Map<string, number>();

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(CORRECTIONS_PATH, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    findings.fail(
      `Could not read ${path.relative(REPO_ROOT, CORRECTIONS_PATH)}: ${message}. ` +
        '26a is an explicit step of the load, so a missing or unparseable decisions ' +
        'file is a stop, not a silent skip.',
    );
    return { accepted, byStatus, total: 0 };
  }

  const root = parsed as Record<string, unknown>;
  const entries = root['corrections'];

  if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
    findings.fail('The corrections file has no `corrections` object.');
    return { accepted, byStatus, total: 0 };
  }

  for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) {
      findings.fail(`Correction \`${key}\` is not an object.`);
      continue;
    }

    const entry = value as Record<string, unknown>;
    const status = typeof entry['status'] === 'string' ? entry['status'] : '(no status)';
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);

    if (status !== 'accepted') continue;

    const capitalization = entry['capitalization'];
    if (typeof capitalization !== 'string' || capitalization.length === 0) {
      findings.fail(`Correction \`${key}\` is accepted but has no \`capitalization\` string.`);
      continue;
    }

    // A capitalization changes case and nothing else. Anything else is a rename,
    // which would silently retitle an entry — and 26a is not a renaming tool.
    if (capitalization.toLowerCase() !== key.toLowerCase()) {
      findings.fail(
        `Correction \`${key}\` is accepted but proposes \`${capitalization}\`, which ` +
          'differs by more than case. That is a rename, not a capitalization.',
      );
      continue;
    }

    accepted.set(key.toLowerCase(), capitalization);
  }

  return { accepted, byStatus, total: Object.keys(entries as object).length };
}

// ---------------------------------------------------------------------------
// The write plan — every transformation, applied in memory, before any
// connection is opened. 5d wants failure to happen at the cheapest moment, and
// a row that cannot be built is cheaper to find here than mid-transaction.
// ---------------------------------------------------------------------------

/** One row of `words`, in schema terms rather than in the file's terms. */
interface WordRow {
  readonly word: string;
  readonly partOfSpeech: string | null;
  readonly pronunciation: string | null;
  readonly definitions: string[] | null;
  readonly etymology: string | null;
  readonly usageNote: string | null;
  readonly examples: string[] | null;
  readonly mnemonics: string | null;
}

/** What Q27's five rules actually did, by word, for the named report lines. */
interface StrayKeyOutcome {
  readonly examplesSuperseded: string[];
  readonly examplePromoted: string[];
  readonly etymologyNoteAppended: string[];
  readonly pronunciationNoteAppended: string[];
  readonly definitonsDiscarded: string[];
  readonly confusablesDiscarded: string[];
}

interface WritePlan {
  readonly rows: readonly WordRow[];
  readonly dictionaries: string[];
  readonly usageGuides: string[];
  readonly stray: StrayKeyOutcome;
  /** The headwords 26a actually changed, as `word -> Word`. */
  readonly capitalized: string[];
}

/** A string, or null. Absent and null both become a NULL column. */
function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * A `text[]`, or null. An array holding anything but strings is a failure rather
 * than something to coerce: `text[]` cannot hold it, and silently stringifying a
 * value is exactly the kind of quiet damage this script exists to prevent.
 */
function textArrayOrNull(
  value: unknown,
  word: string,
  field: string,
  findings: Findings,
): string[] | null {
  if (!Array.isArray(value)) return null;

  const offenders = value.filter((element) => typeof element !== 'string');
  if (offenders.length > 0) {
    findings.fail(
      `\`${field}\` on ${word} holds ${count(offenders.length, 'non-string value')}. ` +
        'The column is text[] and cannot hold it.',
    );
    return null;
  }

  return value as string[];
}

/**
 * Q27: `etymology_note` and `pronunciation_note` are appended to the field they
 * annotate, separated by a blank line. If the field itself is missing the note
 * becomes the whole value — the ordinary consequence of the rule, not a case.
 */
function appendNote(base: string | null, note: unknown): string | null {
  if (typeof note !== 'string' || note.length === 0) return base;
  return base === null || base.length === 0 ? note : `${base}\n\n${note}`;
}

function buildWritePlan(
  backup: Backup,
  corrections: Corrections,
  findings: Findings,
): WritePlan {
  const rows: WordRow[] = [];
  const capitalized: string[] = [];
  const stray: StrayKeyOutcome = {
    examplesSuperseded: [],
    examplePromoted: [],
    etymologyNoteAppended: [],
    pronunciationNoteAppended: [],
    definitonsDiscarded: [],
    confusablesDiscarded: [],
  };

  const seenLower = new Set<string>();

  for (const record of backup.words) {
    const original = textOrNull(record['word']);
    if (original === null) continue; // already a failure in reportStructure

    // --- 26a ---------------------------------------------------------------
    // Words are stored VERBATIM (24h). The only thing that changes a headword on
    // the way in is an accepted correction.
    const correction = corrections.accepted.get(original.toLowerCase());
    const word = correction ?? original;
    if (correction !== undefined && correction !== original) {
      capitalized.push(`${original} -> ${correction}`);
    }
    seenLower.add(word.toLowerCase());

    // --- Q27: `examples` wins outright; `example` is a FALLBACK, not a merge --
    const plural = textArrayOrNull(record['examples'], word, 'examples', findings);
    const singular = textOrNull(record['example']);

    let examples: string[] | null;
    if (plural !== null && plural.length > 0) {
      examples = plural;
      if (singular !== null) stray.examplesSuperseded.push(word);
    } else if (singular !== null) {
      examples = [singular];
      stray.examplePromoted.push(word);
    } else {
      examples = plural;
    }

    // --- Q27: the two notes are appended to what they annotate ---------------
    let etymology = textOrNull(record['etymology']);
    if (record['etymology_note'] !== undefined) {
      etymology = appendNote(etymology, record['etymology_note']);
      stray.etymologyNoteAppended.push(word);
    }

    let pronunciation = textOrNull(record['pronunciation']);
    if (record['pronunciation_note'] !== undefined) {
      pronunciation = appendNote(pronunciation, record['pronunciation_note']);
      stray.pronunciationNoteAppended.push(word);
    }

    // --- Q27: the two discards, named rather than silent ---------------------
    if (record['definitons'] !== undefined) stray.definitonsDiscarded.push(word);
    if (record['confusables'] !== undefined) stray.confusablesDiscarded.push(word);

    rows.push({
      word,
      partOfSpeech: textOrNull(record['part_of_speech']),
      pronunciation,
      definitions: textArrayOrNull(record['definitions'], word, 'definitions', findings),
      etymology,
      usageNote: textOrNull(record['usage_note']),
      examples,
      mnemonics: textOrNull(record['mnemonics']),
    });
  }

  // An accepted correction for a word that is not in the file means the two
  // files have drifted apart. Loud, because the capital would simply never land.
  for (const key of corrections.accepted.keys()) {
    if (!seenLower.has(key)) {
      findings.fail(
        `Correction \`${key}\` is accepted but no such headword is in the backup. ` +
          'The corrections file and the backup disagree.',
      );
    }
  }

  // 24k: the loader's one camelCase translation, and the only translation it
  // performs. Order is preserved — the fetch prompt lists these sources in order.
  const dictionaries = textArrayOrNull(
    backup.sources['dictionaries'],
    'sources',
    'dictionaries',
    findings,
  );
  const usageGuides = textArrayOrNull(
    backup.sources['usageGuides'],
    'sources',
    'usageGuides',
    findings,
  );

  return {
    rows,
    dictionaries: dictionaries ?? [],
    usageGuides: usageGuides ?? [],
    stray,
    capitalized,
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * The four APPLICATION tables, named explicitly.
 *
 * schema_migrations is deliberately absent. It records which migration files
 * have been applied, and it belongs to the migration runner (Q28). Emptying it
 * here would leave the database and the repo disagreeing with each other, with
 * nothing to say so — and the runner would then re-apply 001 against tables that
 * already exist.
 *
 * RESTART IDENTITY is what makes the users row come back as id 1 on every run.
 * CASCADE is redundant while these four are the only tables, and is kept because
 * the day it stops being redundant is the day it is needed.
 */
const TRUNCATE_APPLICATION_TABLES =
  'TRUNCATE users, user_settings, words, progress RESTART IDENTITY CASCADE';

/** The columns of `words` this loader fills. created_at takes its default. */
const WORD_COLUMNS = [
  'user_id',
  'word',
  'part_of_speech',
  'pronunciation',
  'definitions',
  'etymology',
  'usage_note',
  'examples',
  'mnemonics',
] as const;

/**
 * Rows per INSERT. 1,070 single-row inserts would be 1,070 round trips to
 * us-east-2; at nine columns a batch of 200 is 1,800 parameters, well under
 * Postgres's limit of 65,535.
 */
const WORD_BATCH_SIZE = 200;

/**
 * `INSERT INTO words (...) VALUES ($1,...,$9), ($10,...,$18), ... RETURNING id, word`
 *
 * The placeholders are generated because their count depends on the batch size,
 * but the VALUES are still parameters — the headwords never enter the SQL text.
 */
function insertWordsSql(rowCount: number): string {
  const tuples: string[] = [];

  for (let row = 0; row < rowCount; row += 1) {
    const first = row * WORD_COLUMNS.length;
    const placeholders = WORD_COLUMNS.map((_, column) => `$${first + column + 1}`);
    tuples.push(`(${placeholders.join(', ')})`);
  }

  return (
    `INSERT INTO words (${WORD_COLUMNS.join(', ')})\n` +
    `VALUES ${tuples.join(', ')}\n` +
    'RETURNING id, word'
  );
}

interface WriteOutcome {
  readonly userId: string;
  readonly wordsInserted: number;
  /** lower(word) -> words.id. Step 9 resolves progress records through this. */
  readonly wordIds: ReadonlyMap<string, string>;
  readonly committed: boolean;
}

/**
 * Everything from the TRUNCATE onward, in ONE transaction.
 *
 * --dry-run does not skip any of this. It runs every statement and then rolls
 * back, so the constraints, the types and the unique index are all exercised
 * against the real data and the result is thrown away.
 */
async function writeAll(
  client: PgClient,
  plan: WritePlan,
  dryRun: boolean,
): Promise<WriteOutcome> {
  await client.query('BEGIN');

  console.log('\nWriting');
  await client.query(TRUNCATE_APPLICATION_TABLES);
  console.log('  truncated users, user_settings, words, progress (schema_migrations untouched)');

  // 24i: one users row, email deliberately NULL. It is unused in leg one and
  // kept because Q8 leans toward email-link auth.
  //
  // pg returns bigint as a string, because a Postgres bigint can hold values a
  // JavaScript number cannot represent exactly. Hence Number() rather than ===.
  const inserted = await client.query<{ id: string }>(
    'INSERT INTO users (email) VALUES (NULL) RETURNING id',
  );
  const userId = inserted.rows[0]?.id;

  if (userId === undefined || Number(userId) !== 1) {
    throw new Error(
      `The users row came back as id ${String(userId)}, not 1. The server reads ` +
        'DEFAULT_USER_ID=1, so this would present as an app with no words rather ' +
        'than as an error. Refusing to continue.',
    );
  }
  console.log(`  users: id ${userId}, email NULL (unused in leg one, 24i)`);

  // 24k: the camelCase-to-snake_case rename, and the loader's only translation.
  await client.query(
    'INSERT INTO user_settings (user_id, dictionaries, usage_guides) VALUES ($1, $2, $3)',
    [userId, plan.dictionaries, plan.usageGuides],
  );
  console.log(
    `  user_settings: ${count(plan.dictionaries.length, 'dictionary', 'dictionaries')}, ` +
      `${count(plan.usageGuides.length, 'usage guide')}, order preserved`,
  );

  // The word -> id map. Step 6 does not use it; step 9 resolves progress records
  // through it, case-insensitively (24h). It is built from RETURNING rather than
  // from insertion order, which Postgres does not promise for a multi-row INSERT.
  const wordIds = new Map<string, string>();

  for (let offset = 0; offset < plan.rows.length; offset += WORD_BATCH_SIZE) {
    const batch = plan.rows.slice(offset, offset + WORD_BATCH_SIZE);
    const values: unknown[] = [];

    for (const row of batch) {
      values.push(
        userId,
        row.word,
        row.partOfSpeech,
        row.pronunciation,
        row.definitions,
        row.etymology,
        row.usageNote,
        row.examples,
        row.mnemonics,
      );
    }

    const result = await client.query<{ id: string; word: string }>(
      insertWordsSql(batch.length),
      values,
    );

    for (const returned of result.rows) {
      wordIds.set(returned.word.toLowerCase(), returned.id);
    }
  }

  console.log(`  words: ${count(plan.rows.length, 'row')} inserted`);

  if (wordIds.size !== plan.rows.length) {
    throw new Error(
      `The word -> id map holds ${n(wordIds.size)} entries for ${n(plan.rows.length)} rows. ` +
        'Step 9 resolves every progress record through it, so it must be complete.',
    );
  }
  console.log(`  word -> id map: ${count(wordIds.size, 'entry', 'entries')} (step 9 reads this)`);

  if (dryRun) {
    await client.query('ROLLBACK');
  } else {
    await client.query('COMMIT');
  }

  return { userId, wordsInserted: plan.rows.length, wordIds, committed: !dryRun };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * Everything the run resolved, printed before it does anything at all. Both the
 * target and the file path are arguments with no default, so seeing what they
 * resolved to is the last check before a TRUNCATE.
 */
function reportResolved(args: Args, sourcePath: string, connectionString: string): void {
  console.log('\nimport-json — load words (step 6).');
  console.log('\nResolved, before anything happens');
  console.log(`  target       ${args.target}  ->  ${TARGET_VARIABLES[args.target]}`);
  console.log(`  database     ${describeTarget(connectionString)}`);
  console.log(`  TLS          ${describeTls(connectionString)}`);
  console.log(`  file         ${sourcePath}`);
  console.log(
    args.dryRun
      ? '  mode         DRY RUN — every write runs, then ROLLBACK'
      : '  mode         WRITE — the transaction is COMMITted',
  );
  if (args.strict) console.log('  --strict     warnings are treated as failures');
}

function reportSize(sourcePath: string, bytes: number): void {
  console.log('\nSource');
  console.log(`  ${path.basename(sourcePath)}`);
  console.log(`  ${n(bytes)} bytes`);
}

function reportCorrections(corrections: Corrections, plan: WritePlan): void {
  console.log('\nCapitalization corrections (26a)');
  console.log(`  ${count(corrections.total, 'entry', 'entries')} in ` +
    `${path.relative(REPO_ROOT, CORRECTIONS_PATH).replace(/\\/g, '/')}`);

  for (const [status, howMany] of [...corrections.byStatus].sort()) {
    const effect = status === 'accepted' ? 'applied' : 'skipped';
    console.log(`  ${String(howMany).padStart(4)} ${status.padEnd(12)} ${effect}`);
  }

  if (plan.capitalized.length === 0) {
    console.log('\n  No headword changed. The hand review is a soft dependency: the loader is');
    console.log('  re-runnable, so an early run applies few or none and a later run picks them up.');
  } else {
    console.log(`\n  ${count(plan.capitalized.length, 'headword')} capitalized:`);
    console.log(`  ${series(plan.capitalized, 12)}.`);
  }
}

/**
 * Q27's five rules, and what each one did. These are NAMED REPORT LINES, not
 * warnings: all five are in the frozen file forever, so warning on them would
 * make --strict fail every run by construction. An alarm that always sounds is
 * not an alarm. The warning is reserved for a SIXTH, unrecognised key.
 */
function reportStrayKeyOutcomes(plan: WritePlan): void {
  const { stray } = plan;

  console.log('\nQ27 — the five stray keys, as applied');

  const line = (label: string, howMany: number, what: string): void => {
    console.log(`  ${label.padEnd(20)}${String(howMany).padStart(4)}  ${what}`);
  };

  line(
    'example',
    stray.examplesSuperseded.length,
    'discarded, superseded by `examples`',
  );
  line('', stray.examplePromoted.length, 'promoted to sole entry');
  console.log(`                        ${series(stray.examplePromoted)}.`);

  line('etymology_note', stray.etymologyNoteAppended.length, 'appended to `etymology`');
  console.log(`                        ${series(stray.etymologyNoteAppended)}.`);

  line(
    'pronunciation_note',
    stray.pronunciationNoteAppended.length,
    'appended to `pronunciation`',
  );
  console.log(`                        ${series(stray.pronunciationNoteAppended)}.`);

  line('definitons', stray.definitonsDiscarded.length, 'DISCARDED — the typo, holding an array');
  console.log(`                        key \`definitons\` on ${series(stray.definitonsDiscarded)}.`);

  line('confusables', stray.confusablesDiscarded.length, 'DISCARDED');
  console.log(`                        ${series(stray.confusablesDiscarded)}.`);
}

function reportWritePlan(args: Args, plan: WritePlan): void {
  console.log('\nWrite plan — one transaction, from the TRUNCATE onward');
  console.log(`  ${TRUNCATE_APPLICATION_TABLES}`);
  console.log('  schema_migrations is not named and is not touched (Q28).');
  console.log(`  1 users row, 1 user_settings row, ${count(plan.rows.length, 'word')}.`);
  console.log(
    args.dryRun
      ? '  --dry-run: all of it runs, then ROLLBACK.'
      : `  This COMMITs against ${args.target}.`,
  );
}

function reportOutcome(outcome: WriteOutcome, target: Target): void {
  if (outcome.committed) {
    console.log(`\nCOMMITTED. ${target} now holds ${count(outcome.wordsInserted, 'word')}.`);
  } else {
    console.log('\nROLLED BACK — --dry-run. Every statement ran; the database is as it was.');
  }
}

/** Print the findings and return the exit code. */
function reportFindings(findings: Findings, strict: boolean): number {
  for (const failure of findings.failures) {
    console.log(`\nFAIL  ${failure}`);
  }
  for (const warning of findings.warnings) {
    console.log(`\n${strict ? 'WARN (strict: fails)' : 'WARN'}  ${warning}`);
  }

  const promoted = strict && findings.warnings.length > 0;
  const failed = findings.failures.length > 0 || promoted;

  const tally =
    `${count(findings.failures.length, 'failure')}, ${count(findings.warnings.length, 'warning')}` +
    (promoted ? ', promoted to failures by --strict' : '');

  console.log(`\nResult: ${failed ? 'FAIL' : 'PASS'} — ${tally}.\n`);

  return failed ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

interface Args {
  readonly source: string;
  readonly target: Target;
  readonly strict: boolean;
  readonly dryRun: boolean;
}

function usage(problem: string): never {
  console.error(`
${problem}

Load a Lexicon backup into Postgres: the user, the settings and 1,070 words.

  node --env-file=.env server/scripts/import-json.ts \\
       <path-to-backup.json> --target dev|main [--dry-run] [--strict]

    --target    REQUIRED, no default and no fallback. Selects
                DATABASE_URL_DEV or DATABASE_URL_MAIN. It never reads
                DATABASE_URL. --target main asks for a typed confirmation.
    --dry-run   run the entire transaction, then ROLLBACK instead of COMMIT.
                Nothing is skipped; the result is thrown away.
    --strict    treat every warning as a failure. Off during the build, on at
                cutover, when "understood but unexpected" stops being tolerable.

The path is REQUIRED and has no default. The file of record is
lexicon-backup-2026-08-03-b.json (2,037,770 bytes) — NOT the smaller
lexicon-backup-2026-08-03.json that sits beside it.
`);
  process.exit(1);
}

function parseArgs(argv: readonly string[]): Args {
  let source: string | null = null;
  let target: string | null = null;
  let strict = false;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;

    if (arg === '--strict') {
      strict = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--target') {
      // `--target` with nothing after it must not fall through to a default.
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) usage('--target needs a value.');
      target = value;
      index += 1;
    } else if (arg.startsWith('--target=')) {
      target = arg.slice('--target='.length);
    } else if (arg.startsWith('--')) {
      usage(`Unknown option: ${arg}`);
    } else if (source === null) {
      source = arg;
    } else {
      usage(`Unexpected extra argument: ${arg}`);
    }
  }

  if (source === null) usage('No backup file given.');

  // No default, no fallback, no inference. A step-5 command retyped without
  // --target stops here rather than assuming a database (5g, Q18).
  if (target === null) usage('No --target given. It has no default: say dev or main.');
  if (target !== 'dev' && target !== 'main') {
    usage(`--target must be dev or main, not \`${target}\`.`);
  }

  return { source, target, strict, dryRun };
}

/**
 * Q18: --target selects the variable; the variable holds the string. Nothing
 * falls back to DATABASE_URL, which is the server's and points wherever the
 * server happens to be pointed.
 */
function resolveTarget(target: Target): string {
  const variable = TARGET_VARIABLES[target];
  const connectionString = process.env[variable];

  if (!connectionString) {
    console.error(`\n--target ${target} reads ${variable}, and it is not set.`);
    console.error('  It belongs in .env — see .env.example for the shape.');
    console.error('  This command needs --env-file=.env; Node does not read .env on its own.\n');
    process.exit(1);
  }

  return connectionString;
}

/**
 * 5c: writing to main requires typing something. The dry run asks too — it does
 * not persist anything, but it does take an ACCESS EXCLUSIVE lock on the live
 * tables for the length of the transaction, which is not a thing to do to
 * production by accident.
 */
async function confirmMain(dryRun: boolean): Promise<void> {
  console.log('\n--target main. This is the branch the deployed app reads.');
  console.log(
    dryRun
      ? '  --dry-run rolls back, but the TRUNCATE still locks these tables while it runs.'
      : '  Its four application tables will be emptied and reloaded.',
  );

  const input = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await input.question(`\nType \`${MAIN_CONFIRMATION}\` to proceed: `);
  input.close();

  if (answer.trim() !== MAIN_CONFIRMATION) {
    console.log('\nNot confirmed. Nothing was written.\n');
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sourcePath = path.resolve(args.source);
  const connectionString = resolveTarget(args.target);

  reportResolved(args, sourcePath, connectionString);

  const { backup, bytes } = readBackup(sourcePath);
  const findings = new Findings();

  reportSize(sourcePath, bytes);

  // --- read and validate (step 5). Nothing is opened yet. ------------------
  reportCounts(backup, findings);
  reportCoverage(backup, findings);
  reportStructure(backup, findings);
  reportStrayKeys(backup, findings);
  reportProgressShape(backup, findings);

  // --- build every row in memory (step 6). Still nothing opened. -----------
  const corrections = readCorrections(findings);
  const plan = buildWritePlan(backup, corrections, findings);

  reportCorrections(corrections, plan);
  reportStrayKeyOutcomes(plan);
  reportWritePlan(args, plan);

  // 5d: fail before the database is touched. Everything above is free; the
  // moment a connection opens, Neon's compute wakes and a TRUNCATE is one
  // statement away.
  const blocked = findings.failures.length > 0 || (args.strict && findings.warnings.length > 0);
  if (blocked) {
    console.log('\nStopping before the database is opened. Nothing was written.');
    process.exit(reportFindings(findings, args.strict));
  }

  if (args.target === 'main') await confirmMain(args.dryRun);

  const client = new Client(buildConnectionConfig(connectionString));

  try {
    await client.connect();
  } catch (error) {
    console.error(`\nCould not connect to ${args.target}.`);
    console.error(formatDatabaseError(error));
    console.error('');
    process.exit(1);
  }

  let outcome: WriteOutcome;

  try {
    outcome = await writeAll(client, plan, args.dryRun);
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // If the failure killed the connection, Postgres has already discarded
      // the transaction and there is nothing left to undo.
    }
    await client.end();
    console.error('\nFAILED mid-transaction. Everything was rolled back; nothing was written.');
    console.error(formatDatabaseError(error));
    console.error('');
    process.exit(1);
  }

  await client.end();

  reportOutcome(outcome, args.target);
  process.exit(reportFindings(findings, args.strict));
}

await main();
