'use strict';

/**
 * propose-capitalizations.js — the 26a proposal script.
 *
 * WHAT THIS IS FOR
 * ----------------
 * Every one of the 1,070 headwords in the v3.1 library is lowercase. v3.1
 * lowercased the headword at import but left every other field alone, so
 * `panglossian` is the key while its own usage note reads *Panglossian*.
 * This script mines that prose to work out which headwords deserve a capital.
 *
 * It PROPOSES. It does not decide. Every proposal is reviewed by hand, and the
 * loader (step 6) applies only the ones marked "accepted".
 *
 * WHAT IT READS
 * -------------
 * For each word, three of its own fields:
 *   usage_note   (string,  974 words)
 *   examples     (array,   970 words)
 *   example      (string,   76 words — singular)
 *
 * The singular `example` is scanned even though the loader discards it (Q27).
 * Reading for EVIDENCE and loading for STORAGE are separate jobs. In practice
 * it holds 57 headword occurrences of which 1 is capitalized, and it changes no
 * verdict — but the method has to be right regardless of what the data happens
 * to contain this time.
 *
 * WHAT IT WRITES
 * --------------
 *   data/capitalizations.json      the decisions file. YOU edit it; the loader
 *                                  reads it. Re-runs preserve your decisions.
 *   data/capitalization-review.md  the evidence dossier. GENERATED. Read it,
 *                                  never edit it — a re-run overwrites it.
 *
 * Neither file carries a timestamp, deliberately. The input is frozen and the
 * analysis is deterministic, so re-running produces byte-identical output and
 * an empty git diff. A spurious diff on every run trains you to ignore diffs.
 *
 * THE FIVE FALSE POSITIVES IT GUARDS AGAINST
 * ------------------------------------------
 * A capital letter in prose is only evidence about a word's canonical spelling
 * if nothing else in the sentence forced it. Five things force one:
 *
 *   1. SENTENCE-INITIAL position. "Panglossian is a term of criticism" says
 *      nothing; "a Panglossian account of the finances" says everything.
 *      Filters 1,400+ occurrences — by far the biggest source of noise.
 *
 *   2. QUOTATION-INITIAL position. A quoted sentence capitalizes its first word
 *      mid-sentence: "framing a hypothetical ('Suppose that X is true')".
 *      Not in the original spec; found while calibrating. Worth 8 candidates,
 *      among them `contingent`, `hard cheese`, `humbug` and `suppose`.
 *
 *   3. ALL-CAPS EMPHASIS. Some notes shout the headword throughout: `career`
 *      and `catalepsy` write CAREER and CATALEPSY as a house style. A rough
 *      earlier run duly proposed `career -> CAREER`.
 *
 *   4. MARKDOWN EMPHASIS around a sentence-initial word: `*Impassive* describes
 *      outward demeanour`. The asterisk hides the preceding full stop.
 *
 *   5. A PROPER NOUN IN A DIFFERENT SENSE. "His Serene Highness", "the Rufous
 *      Hummingbird", "Chester Herald", "Flume Gorge" — evidence about the name,
 *      not the headword. This one cannot be detected reliably, so it is not
 *      filtered: it is FLAGGED ("adjacent capital") and routed to your review.
 *
 * Mixed evidence is never resolved automatically either. If a word appears both
 * capitalized and lowercase mid-sentence, that is a judgment call and it goes
 * to you with both sides shown.
 *
 * USAGE
 * -----
 *   node scripts/propose-capitalizations.js <path-to-backup.json> [options]
 *
 *     --out-dir <dir>   where to write (default: data/ beside this repo)
 *     --force           write even if the safety guards object
 *
 * The input path is required and has no default, on purpose. Two backup files
 * sit side by side in Dropbox and only the larger `-b` one is the file of
 * record; a default would eventually load the wrong one silently.
 *
 * Plain Node, no dependencies, CommonJS. If a root package.json ever sets
 * "type": "module", rename this to .cjs — nothing else needs to change.
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Baselines. Hard-coded because v3.1 is frozen in data as well as code, so
// these cannot drift. If the file we are handed disagrees, it is the wrong
// file — which is exactly the mistake worth catching, given the near-identical
// sibling backup sitting in the same folder.
// ---------------------------------------------------------------------------
const EXPECTED_WORDS = 1070;
const EXPECTED_FETCHED = 974;
const EXPECTED_CANDIDATES = 45;
const CANDIDATE_TOLERANCE = 8; // outside 37–53, something is wrong; stop.

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

// Characters that may stand in for a space or hyphen inside a multi-word
// headword, so `will-o'-the-wisp` still matches `will o' the wisp`. Each class
// matches EXACTLY ONE character, which keeps the match the same length as the
// headword — that is what makes the case transfer below positionally exact.
const SEPARATOR = '[ \\-\\u2010\\u2011\\u2013\\u2014]';
const APOSTROPHE = "['\\u2019]";

const escapeRegExp = ch => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Build a case-insensitive whole-phrase matcher for one headword.
 *
 * The boundaries are lookarounds over \p{L}\p{N} rather than \b. JavaScript's
 * \b is ASCII-only, so `\bmanqué\b` misbehaves on the trailing é — and 67 of
 * the 1,070 headwords carry an accent, a hyphen, an apostrophe or a space.
 *
 * A trailing apostrophe is deliberately allowed through the boundary, so
 * "her career's arc" counts as an occurrence of `career`, while "careerist"
 * does not.
 */
function buildMatcher(headword) {
  let pattern = '';
  for (const ch of headword) {
    if (ch === ' ' || ch === '-') pattern += SEPARATOR;
    else if (ch === "'") pattern += APOSTROPHE;
    else pattern += escapeRegExp(ch);
  }
  return new RegExp(`(?<![\\p{L}\\p{N}])(${pattern})(?![\\p{L}\\p{N}])`, 'giu');
}

const isUpper = ch => ch !== ch.toLowerCase() && ch === ch.toUpperCase();
const letters = str => [...str].filter(ch => ch.toLowerCase() !== ch.toUpperCase());

/** Trap 3: SHOUTED emphasis, not orthography. Needs 2+ letters so "I" is safe. */
const isAllCaps = str => letters(str).length >= 2 && letters(str).every(isUpper);

/**
 * Transfer the observed capitalization onto the headword, character by
 * character, keeping the HEADWORD's own punctuation and accents. A proposal
 * may therefore differ from the headword in case and in nothing else — so a
 * curly apostrophe or a stripped accent in the prose can never leak into the
 * library. Returns null if the lengths disagree, which the 1:1 character
 * classes above should make impossible.
 */
function transferCase(headword, matched) {
  if (matched.length !== headword.length) return null;
  let out = '';
  for (let i = 0; i < headword.length; i++) {
    out += isUpper(matched[i]) ? headword[i].toUpperCase() : headword[i];
  }
  return out;
}

// Abbreviations whose full stop does not end a sentence.
const ABBREVIATION = /(?:^|[\s(])(?:e\.g|i\.e|cf|etc|vs|viz|ibid|Dr|Mr|Mrs|Ms|St|No|Fig|Ed|Vol|approx)\.$/;

const OPENING_QUOTES = '"\'‘“';

/** An opening quote, as opposed to a possessive apostrophe like "editors'". */
const isOpeningQuote = (text, i) =>
  OPENING_QUOTES.includes(text[i]) && (i === 0 || !/[\p{L}\p{N}]/u.test(text[i - 1]));

/**
 * Traps 1, 2 and 4. Returns why a capital here would be forced by position,
 * or null if the position is neutral and the capital means something.
 */
function positionallyForced(text, index) {
  let i = index - 1;

  // Step over markdown emphasis glued to the word: *Impassive*
  while (i >= 0 && (text[i] === '*' || text[i] === '_')) i--;
  if (i < 0) return 'sentence-initial';

  // A quote opening immediately before the word: ('Suppose that X is true')
  if (isOpeningQuote(text, i)) return 'quote-initial';

  // Otherwise walk back over spaces and opening punctuation to find the end
  // of the previous sentence.
  while (i >= 0 && /[\s*_"'‘’“”(\[{]/.test(text[i])) i--;
  if (i < 0) return 'sentence-initial';

  if (!'.!?…'.includes(text[i])) return null;
  if (text[i] === '.') {
    if (ABBREVIATION.test(text.slice(0, i + 1))) return null; // "e.g. Foo"
    if (text[i + 1] === ',') return null;                     // "e.g., Foo"
  }
  return 'sentence-initial';
}

/** Trap 5's tell: a capitalized neighbour suggests a name or a title. */
function hasAdjacentCapital(text, start, end) {
  const before = text.slice(Math.max(0, start - 40), start).match(/([\p{L}\p{N}'-]+)[\s]*$/u);
  const after = text.slice(end).match(/^[\s]*([\p{L}\p{N}'-]+)/u);
  const capitalized = token => token && /^\p{Lu}/u.test(token[1]) && !isAllCaps(token[1]);
  return Boolean(capitalized(before) || capitalized(after));
}

// ---------------------------------------------------------------------------
// The usage note's own ruling
// ---------------------------------------------------------------------------

const CASE_TALK = /\b(capitaliz|capitalis|lowercas|lower-cas|uppercas|upper-cas|capital letter|proper noun)/i;

/**
 * 27 of the 45 candidates have a usage note that rules on capitalization
 * outright — `stockholm syndrome` says "Capitalize both words as a proper noun
 * compound". That is better evidence than any heuristic here, so pull the
 * sentence out and put it in front of the reviewer.
 */
function caseRulingSentences(note) {
  if (typeof note !== 'string') return [];
  return note
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => CASE_TALK.test(s));
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/** The three prose fields, labelled, in a stable order. */
function proseFields(word) {
  const fields = [];
  if (typeof word.usage_note === 'string') fields.push(['usage_note', word.usage_note]);
  if (Array.isArray(word.examples)) {
    word.examples.forEach((s, i) => {
      if (typeof s === 'string') fields.push([`examples[${i}]`, s]);
    });
  }
  if (typeof word.example === 'string') fields.push(['example', word.example]); // Q27
  return fields;
}

function analyse(word) {
  const headword = word.word;
  const fields = proseFields(word);
  const matcher = buildMatcher(headword);

  const forEvidence = [];   // capitalized, position-neutral: says "capitalize me"
  const againstEvidence = []; // lowercase: nothing ever forces a lowercase letter
  const discarded = [];     // capitalized but forced, or shouted
  let lengthAnomalies = 0;

  for (const [field, text] of fields) {
    matcher.lastIndex = 0;
    let m;
    while ((m = matcher.exec(text)) !== null) {
      const matched = m[1];
      const form = transferCase(headword, matched);
      if (form === null) { lengthAnomalies++; continue; }

      const start = m.index;
      const end = start + matched.length;
      const record = {
        field,
        form,
        matched,
        start,
        context: text.slice(Math.max(0, start - 70), start),
        after: text.slice(end, end + 70),
        adjacentCapital: hasAdjacentCapital(text, start, end),
      };

      if (matched === matched.toLowerCase()) { againstEvidence.push(record); continue; }
      if (isAllCaps(matched)) { discarded.push({ ...record, reason: 'all-caps' }); continue; }

      const forced = positionallyForced(text, start);
      if (forced) { discarded.push({ ...record, reason: forced }); continue; }

      forEvidence.push(record);
    }
  }

  return { headword, fields, forEvidence, againstEvidence, discarded, lengthAnomalies };
}

/** Rank the observed capitalized forms; the most frequent becomes the proposal. */
function tallyForms(records) {
  const counts = new Map();
  for (const r of records) counts.set(r.form, (counts.get(r.form) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function flagsFor(result, forms) {
  const flags = [];
  if (result.againstEvidence.length) flags.push('mixed evidence');
  if (forms.length > 1) flags.push('competing forms');
  if (result.forEvidence.length === 1) flags.push('single occurrence');
  if (result.forEvidence.some(r => r.adjacentCapital)) flags.push('adjacent capital');
  if (result.discarded.some(r => r.reason === 'all-caps')) flags.push('all-caps elsewhere');
  return flags;
}

// ---------------------------------------------------------------------------
// Rendering the dossier
// ---------------------------------------------------------------------------

/** Neutralise markdown that occurs in the prose (68 asterisks live in there). */
const escapeMd = s => s.replace(/([\\`*_[\]|<>])/g, '\\$1').replace(/\s+/g, ' ');

function renderEvidenceLine(record) {
  const before = escapeMd(record.context);
  const after = escapeMd(record.after);
  const hit = escapeMd(record.matched);
  const lead = record.context.length >= 70 ? '…' : '';
  const tail = record.after.length >= 70 ? '…' : '';
  return `> \`${record.field}\` — ${lead}${before}**${hit}**${after}${tail}`;
}

function renderCandidate(entry) {
  const { headword, proposal, forms, flags, result, rulings } = entry;
  const lines = [];
  lines.push(`### \`${headword}\` → \`${proposal}\``);
  lines.push('');

  const tally = forms.map(([form, n]) => `\`${form}\` ×${n}`).join(', ');
  lines.push(`*${result.forEvidence.length} capitalized mid-sentence (${tally}) · ` +
    `${result.againstEvidence.length} lowercase · ` +
    `${result.discarded.length} discarded as forced or shouted*`);
  if (flags.length) lines.push(`**Flags:** ${flags.join(' · ')}`);
  lines.push('');

  if (rulings.length) {
    lines.push('**The usage note rules on this directly:**');
    for (const r of rulings) lines.push(`> ${escapeMd(r)}`);
    lines.push('');
  }

  lines.push('**Capitalized, position-neutral — the evidence to capitalize:**');
  lines.push('');
  for (const r of result.forEvidence) { lines.push(renderEvidenceLine(r)); lines.push('>'); }
  lines.pop();

  if (result.againstEvidence.length) {
    lines.push('');
    lines.push('**Lowercase — the evidence against:**');
    lines.push('');
    for (const r of result.againstEvidence) { lines.push(renderEvidenceLine(r)); lines.push('>'); }
    lines.pop();
  }

  const forced = result.discarded.filter(r => r.reason !== 'all-caps');
  if (forced.length) {
    lines.push('');
    lines.push(`<details><summary>${forced.length} capital(s) discarded as positionally forced</summary>`);
    lines.push('');
    for (const r of forced) lines.push(`${renderEvidenceLine(r)}  \n> *(${r.reason})*`);
    lines.push('');
    lines.push('</details>');
  }

  lines.push('');
  return lines.join('\n');
}

function renderDossier(state) {
  const { sourceName, sourceBytes, candidates, tiers, trapCounts } = state;
  const out = [];

  out.push('# Capitalization review');
  out.push('');
  out.push('**Generated file — do not edit.** Every run overwrites it.');
  out.push('Record your decisions in `data/capitalizations.json`; this document is');
  out.push('the evidence behind each proposal, nothing more.');
  out.push('');
  out.push(`Source: \`${sourceName}\` (${sourceBytes.toLocaleString('en-US')} bytes, ` +
    `${EXPECTED_WORDS.toLocaleString('en-US')} headwords, all lowercase).`);
  out.push('');
  out.push('Each proposal comes from that word\'s own `usage_note`, `examples` and');
  out.push('singular `example`. A capital counts as evidence only where nothing else');
  out.push('forced it — not at the start of a sentence, not at the start of a');
  out.push('quotation, and not where the note SHOUTS the word throughout.');
  out.push('');

  out.push('## The whole job at a glance');
  out.push('');
  out.push('| # | headword | proposed | flags |');
  out.push('|---|---|---|---|');
  candidates.forEach((c, i) => {
    out.push(`| ${i + 1} | \`${c.headword}\` | \`${c.proposal}\` | ${c.flags.join(' · ') || '—'} |`);
  });
  out.push('');

  const unanimous = candidates.filter(c => !c.flags.includes('mixed evidence'));
  const mixed = candidates.filter(c => c.flags.includes('mixed evidence'));

  out.push('## Unanimous — every occurrence capitalized');
  out.push('');
  out.push(`${unanimous.length} words. The headword never appears in lowercase in its own`);
  out.push('prose. Still your call, but the evidence does not conflict.');
  out.push('');
  for (const c of unanimous) out.push(renderCandidate(c));

  out.push('## Mixed evidence — judgment required');
  out.push('');
  out.push(`${mixed.length} words appear both ways mid-sentence. This is where the`);
  out.push('proper-noun-in-another-sense cases live: *His **Serene** Highness*, *the');
  out.push('**Rufous** Hummingbird*, *Chester **Herald***. A capital there is evidence');
  out.push('about a name, not about the headword.');
  out.push('');
  for (const c of mixed) out.push(renderCandidate(c));

  out.push('## Not proposed, but worth knowing');
  out.push('');
  out.push(`**Capitals only ever in a forced position (${tiers.nearMiss.length}).** ` +
    'The usage note simply opens with the headword and never uses it again, so');
  out.push('there is no position-neutral evidence either way:');
  out.push('');
  out.push(tiers.nearMiss.map(w => `\`${w}\``).join(', ') || '_none_');
  out.push('');
  out.push(`**Never appears in its own prose (${tiers.noOccurrence.length}).** ` +
    'Nothing to mine:');
  out.push('');
  out.push(tiers.noOccurrence.map(w => `\`${w}\``).join(', ') || '_none_');
  out.push('');
  out.push(`**No prose at all (${tiers.noProse.length}).** The unfetched words. They are ` +
    'fetched after cutover,');
  out.push('by a prompt that will ask for canonical orthography directly.');
  out.push('');

  out.push('## What the filters removed');
  out.push('');
  out.push('| forced or discarded because | occurrences |');
  out.push('|---|---|');
  out.push(`| sentence-initial | ${trapCounts['sentence-initial'] || 0} |`);
  out.push(`| quotation-initial | ${trapCounts['quote-initial'] || 0} |`);
  out.push(`| all-caps emphasis | ${trapCounts['all-caps'] || 0} |`);
  out.push('');
  out.push('Without those filters this script proposes 55 words, which is what an');
  out.push('earlier rough run found. Two of the extras are `career` and `catalepsy`,');
  out.push('whose notes write CAREER and CATALEPSY throughout; eight more are');
  out.push('capitals that merely open a quoted sentence.');
  out.push('');

  return out.join('\n');
}

// ---------------------------------------------------------------------------
// The decisions file
// ---------------------------------------------------------------------------

const STATUS_UNREVIEWED = 'unreviewed';

/**
 * Merge new proposals over whatever review has already happened.
 *
 * The script owns `script_proposed`. You own `capitalization` and `status`.
 * Once you have touched an entry — accepted it, rejected it, or corrected the
 * capitalization by hand — a re-run leaves your version alone and reports the
 * disagreement instead of silently overwriting hours of review.
 */
function mergeDecisions(existing, candidates) {
  const merged = {};
  const report = { carried: [], refreshed: [], fresh: [], changed: [], orphaned: [] };

  for (const c of candidates) {
    const prior = existing[c.headword];
    if (!prior) {
      merged[c.headword] = {
        capitalization: c.proposal,
        status: STATUS_UNREVIEWED,
        script_proposed: c.proposal,
      };
      report.fresh.push(c.headword);
      continue;
    }

    const untouched = prior.status === STATUS_UNREVIEWED &&
      prior.capitalization === prior.script_proposed;

    if (untouched) {
      merged[c.headword] = {
        capitalization: c.proposal,
        status: STATUS_UNREVIEWED,
        script_proposed: c.proposal,
      };
      report.refreshed.push(c.headword);
    } else {
      merged[c.headword] = {
        capitalization: prior.capitalization,
        status: prior.status,
        script_proposed: c.proposal,
      };
      report.carried.push(c.headword);
      if (prior.capitalization !== c.proposal && prior.status !== 'rejected') {
        report.changed.push(`${c.headword}: you have "${prior.capitalization}", script now proposes "${c.proposal}"`);
      }
    }
  }

  for (const word of Object.keys(existing)) {
    if (!merged[word]) report.orphaned.push(word);
  }

  return { merged, report };
}

function renderDecisionsFile(merged) {
  // JSON.stringify, never hand-rolled string concatenation. At two-space indent
  // it already puts one field on one line, which is all the hand-rolled version
  // was buying — and that version managed to emit a raw newline inside a string
  // literal, producing a file that would not parse.
  //
  // Keys are sorted so the file has a stable order and a decision change shows
  // up as a one-line git diff rather than a reshuffle.
  const corrections = {};
  for (const word of Object.keys(merged).sort((a, b) => a.localeCompare(b))) {
    corrections[word] = merged[word];
  }
  return JSON.stringify({
    _README: [
      'Capitalization corrections for the v3.1 import. Set `status` to "accepted" or "rejected" — the loader applies accepted entries and nothing else.',
      'Correct `capitalization` by hand if a proposal is close but wrong. A re-run preserves any entry you have touched.',
      'Evidence for every entry is in data/capitalization-review.md.',
      "`script_proposed` records the script's own suggestion. Do not edit it — it is how a re-run tells your work from its own.",
    ],
    corrections,
  }, null, 2) + '\n';
}

function readExistingDecisions(file) {
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed.corrections || {};
  } catch (err) {
    console.error(`\nCannot parse the existing ${path.basename(file)}:`);
    console.error(`  ${err.message}`);
    console.error('Fix the JSON or move the file aside. Refusing to overwrite a file');
    console.error('that may hold review decisions I cannot read.\n');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { source: null, outDir: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') args.force = true;
    else if (a === '--out-dir') args.outDir = argv[++i];
    else if (a.startsWith('--')) { console.error(`Unknown option: ${a}`); process.exit(1); }
    else if (args.source === null) args.source = a;
    else { console.error(`Unexpected extra argument: ${a}`); process.exit(1); }
  }
  return args;
}

function usage() {
  console.error(`
Propose canonical capitalizations for the Lexicon headwords.

  node scripts/propose-capitalizations.js <path-to-backup.json> [--out-dir <dir>] [--force]

The input path is required and has no default. The file of record is
lexicon-backup-2026-08-03-b.json (2,037,770 bytes) — NOT the smaller
lexicon-backup-2026-08-03.json that sits beside it.
`);
  process.exit(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.source) usage();

  const sourcePath = path.resolve(args.source);
  if (!fs.existsSync(sourcePath)) {
    console.error(`\nNo such file: ${sourcePath}\n`);
    process.exit(1);
  }

  const sourceBytes = fs.statSync(sourcePath).size;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  } catch (err) {
    console.error(`\nThat file is not valid JSON: ${err.message}\n`);
    process.exit(1);
  }
  if (!Array.isArray(data.words)) {
    console.error('\nNo `words` array. That is not a Lexicon backup.\n');
    process.exit(1);
  }

  const total = data.words.length;
  const fetched = data.words.filter(w => Array.isArray(w.definitions)).length;
  const notLowercase = data.words.filter(w => w.word !== w.word.toLowerCase());

  console.log(`\nRead ${path.basename(sourcePath)} — ${sourceBytes.toLocaleString('en-US')} bytes`);
  console.log(`  ${total} words, ${fetched} fetched, ${total - fetched} unfetched`);

  // Wrong-file guard. The sibling backup has ~800 fewer words; catching that
  // here is cheaper than discovering it in the corrections file.
  if (total !== EXPECTED_WORDS || fetched !== EXPECTED_FETCHED) {
    console.error(`\n  STOP — expected ${EXPECTED_WORDS} words and ${EXPECTED_FETCHED} fetched.`);
    console.error('  This looks like the wrong backup. The file of record is');
    console.error('  lexicon-backup-2026-08-03-b.json at 2,037,770 bytes.');
    if (!args.force) { console.error('  Nothing written. Pass --force to override.\n'); process.exit(1); }
    console.error('  --force given; continuing anyway.\n');
  }
  if (notLowercase.length) {
    console.log(`  NOTE: ${notLowercase.length} headwords are already capitalized ` +
      `(${notLowercase.slice(0, 5).map(w => w.word).join(', ')}). ` +
      'The premise of 26a is that none are.');
  }

  // ---- analyse -------------------------------------------------------------
  const candidates = [];
  const tiers = { noProse: [], noOccurrence: [], confirmedLowercase: [], nearMiss: [] };
  const trapCounts = {};
  let lengthAnomalies = 0;

  for (const word of data.words) {
    const result = analyse(word);
    lengthAnomalies += result.lengthAnomalies;
    for (const d of result.discarded) trapCounts[d.reason] = (trapCounts[d.reason] || 0) + 1;

    if (!result.fields.length) { tiers.noProse.push(result.headword); continue; }

    const noHits = !result.forEvidence.length && !result.againstEvidence.length &&
      !result.discarded.length;
    if (noHits) { tiers.noOccurrence.push(result.headword); continue; }

    if (!result.forEvidence.length) {
      const forcedCapitals = result.discarded.some(d => d.reason !== 'all-caps');
      if (forcedCapitals && !result.againstEvidence.length) tiers.nearMiss.push(result.headword);
      else tiers.confirmedLowercase.push(result.headword);
      continue;
    }

    const forms = tallyForms(result.forEvidence);
    candidates.push({
      headword: result.headword,
      proposal: forms[0][0],
      forms,
      flags: flagsFor(result, forms),
      rulings: caseRulingSentences(word.usage_note),
      result,
    });
  }

  candidates.sort((a, b) => a.headword.localeCompare(b.headword));

  console.log('\n  tier                                    words');
  console.log(`  no prose at all (unfetched)             ${String(tiers.noProse.length).padStart(5)}`);
  console.log(`  never appears in its own prose          ${String(tiers.noOccurrence.length).padStart(5)}`);
  console.log(`  confirmed lowercase                     ${String(tiers.confirmedLowercase.length).padStart(5)}`);
  console.log(`  capitals only in forced positions       ${String(tiers.nearMiss.length).padStart(5)}`);
  console.log(`  CANDIDATES                              ${String(candidates.length).padStart(5)}`);
  const sum = tiers.noProse.length + tiers.noOccurrence.length +
    tiers.confirmedLowercase.length + tiers.nearMiss.length + candidates.length;
  console.log(`  ${'-'.repeat(40)} ${String(sum).padStart(5)}${sum === total ? '' : '  <-- DOES NOT SUM'}`);

  console.log('\n  filtered as positionally forced or shouted:');
  for (const reason of ['sentence-initial', 'quote-initial', 'all-caps']) {
    console.log(`    ${reason.padEnd(22)} ${String(trapCounts[reason] || 0).padStart(5)}`);
  }
  if (lengthAnomalies) console.log(`  length anomalies (expected 0): ${lengthAnomalies}`);

  // ---- candidate-count guard ----------------------------------------------
  const low = EXPECTED_CANDIDATES - CANDIDATE_TOLERANCE;
  const high = EXPECTED_CANDIDATES + CANDIDATE_TOLERANCE;
  if (candidates.length < low || candidates.length > high) {
    console.error(`\n  STOP — ${candidates.length} candidates, expected ${low}–${high}.`);
    console.error('  A filter is probably misfiring. Nothing written.');
    console.error('  Review the tier table above before overriding.');
    if (!args.force) { console.error('  Pass --force to write anyway.\n'); process.exit(1); }
    console.error('  --force given; writing anyway.\n');
  }

  // ---- write ---------------------------------------------------------------
  const outDir = args.outDir ? path.resolve(args.outDir) : path.join(__dirname, '..', 'data');
  fs.mkdirSync(outDir, { recursive: true });
  const decisionsPath = path.join(outDir, 'capitalizations.json');
  const dossierPath = path.join(outDir, 'capitalization-review.md');

  const existing = readExistingDecisions(decisionsPath);
  const { merged, report } = mergeDecisions(existing, candidates);

  fs.writeFileSync(decisionsPath, renderDecisionsFile(merged), 'utf8');
  fs.writeFileSync(dossierPath, renderDossier({
    sourceName: path.basename(sourcePath), sourceBytes, candidates, tiers, trapCounts,
  }), 'utf8');

  console.log(`\n  wrote ${path.relative(process.cwd(), decisionsPath)}  (${candidates.length} entries — you edit this)`);
  console.log(`  wrote ${path.relative(process.cwd(), dossierPath)}  (evidence — generated, do not edit)`);

  if (Object.keys(existing).length) {
    console.log(`\n  merged with the existing decisions file:`);
    console.log(`    ${report.carried.length} reviewed entries preserved`);
    console.log(`    ${report.refreshed.length} unreviewed entries refreshed`);
    console.log(`    ${report.fresh.length} entries new since the last run`);
    for (const line of report.changed) console.log(`    CHANGED  ${line}`);
    for (const word of report.orphaned) console.log(`    DROPPED  ${word} — no longer proposed, your decision discarded`);
  }

  const reviewed = Object.values(merged).filter(e => e.status !== STATUS_UNREVIEWED).length;
  console.log(`\n  ${reviewed}/${candidates.length} reviewed. ` +
    'The loader applies entries marked "accepted" and nothing else.\n');
}

main();
