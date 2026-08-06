> **STATUS — v3.1 build record. Frozen 2026-08-04.**
> The Map (Notion → Lexicon → Map) is authoritative for the standalone effort: every
> open question, every decision, the target schema, and the migration plan live there,
> not here. This brief is the record of the v3.1 artifact as built — what it does and
> why it was built that way. It is kept for its rationale, which still holds.
> v3.1 is frozen in **code and data**. Nothing is being added to it.

# Lexicon — Project Brief (v3.1 build record)

## Purpose

Lexicon is an editor's vocabulary trainer, built as a Claude artifact. It solves a
specific problem: professional editors accumulate large saved-word lists on dictionary
apps like Merriam-Webster, but those apps offer no way to convert saved words into
structured study tools. Lexicon bridges that gap — it accepts a raw word list, generates
editorial-grade definitions via the Claude API, and serves them back as adaptive
flashcards and quizzes.

Built for one user: a professional copyeditor with 20+ years of experience, whose
workflow priorities are precision, authoritative sourcing, and usage-level nuance —
not just definitions.

## What v3.1 does

- Paste-to-import of word lists (comma or newline separated), with dedup on the
  lowercased word string
- "Import Only" mode for loading large lists without triggering API calls
- Claude API integration generating, per word: `part_of_speech`, `pronunciation` (IPA),
  `definitions` (1–3), `etymology`, `usage_note`, `examples` (3), and `mnemonics`
- Preferred-source system steering Claude toward specific references, in two groups
- Library with search, filtering (All / Defined / Unfetched), checkbox selection with
  shift-click range select, and per-word expand/collapse
- Fetch and re-fetch controls with batch processing, status banner, and Stop button
- Spaced-repetition flashcards (SM-2) with four self-rating tiers
- Session length in Study mode: 10 / 20 / 30 / All
- Three quiz modes: definition→word, word→definition, fill-in-the-blank
- Persistent storage across sessions via the artifact storage API
- JSON export of all data

**Unverified detail:** the exact wording of the four rating tiers is not confirmed.
Two versions appear in older notes ("Missed / Hard / Good / Easy" and "No idea /
Struggled / Got it / Knew it"). The four-tier structure is certain; the labels are not.
Under the freeze this is not worth opening the artifact to check — the standalone should
pick labels deliberately, and the distinction that matters is that recognition without
recall is a failure state, so the tiers must not let a half-remembered word count as
known.

## Frozen data — the numbers

Read from `lexicon-backup-2026-08-03-b.json` on 2026-08-04 and cross-checked against
the artifact's own on-screen counts. The data freeze makes these permanent.

| | |
|---|---|
| Words | 1,070 |
| Fetched (have `definitions`) | 974 |
| Unfetched | 96 |
| Progress records (words ever rated) | 95 |
| Study Due | 971 |
| Study All | 974 |
| Preferred sources | 10, in two groups |

**Study Due** counts fetched words that are either unrated or past their review date:
879 never-rated + 92 overdue. Only three rated words are still scheduled in the future.
**Study All** counts all fetched words.

**Preferred sources as configured:**
*Dictionaries* — Merriam-Webster Unabridged; American Heritage (5th ed.); New Oxford
American; Webster's New International, 2nd ed.
*Usage guides* — Fowler's; Merriam-Webster's Dictionary of English Usage; Bernstein's
*The Careful Writer*; Garner's Modern English Usage; Pinker's *A Sense of Style*;
*Dreyer's English*.

The dictionary/usage-guide split is probably load-bearing — it is plausibly what lets
the fetch prompt ask one group for definitions and the other for usage.

## Export shape

`{ words, progress, sources }`.

A **word** is `{ word }` plus, once fetched, the seven fields listed above. Only the
presence of `definitions` marks fetched vs unfetched. Fetched fields are independently
optional: `bromide` has no pronunciation, `portentous` no etymology. `definitions` and
`examples` are true JSON arrays; `mnemonics` is a plural key holding a singular string.

A **progress record** is `{ ease, repetition, nextReview }`, keyed by the word string,
and exists only for words actually rated. There is no rating timestamp.

`sources` is **not** a flat array. It is an object with two arrays, `dictionaries` and
`usageGuides` — and `usageGuides` is the one camelCase key in the file.

**All 1,070 headwords are lowercase.** Import lowercased the headword but left every
other field untouched, because definition text arrived from the API afterward — so
`panglossian` is the key while the usage note reads *Panglossian*. Canonical
capitalization is recoverable from prose already on disk.

**Five stray keys exist** from earlier fetch generations, with no equivalent in the
target schema: `example` (a singular string, on 76 words — four of which have no
`examples` array at all), `confusables` (3), `etymology_note` (3), `pronunciation_note`
(1), and `definitons`, a typo (1). Their disposition is an open question on the Map.

**62 headwords are multi-word or hyphenated** — *a fortiori*, *coup de grâce*,
*will-o'-the-wisp*, *vis-à-vis*, and others. Two (`epi-`, `ur-`) are prefixes rather
than words.

## Key technical decisions

### API batching: 3 words per call
Early iterations used 5 and 10. Both timed out frequently, because the rich output per
word — three examples, usage note, etymology, mnemonic — pushes token counts high.
Batches of 3 proved reliable inside the 60-second window.

### 60-second timeout via a simple Promise wrapper
An initial implementation using `AbortSignal.any` failed silently in the artifact
runtime. Replaced with a plain `Promise.race` wrapping `fetch` against a `setTimeout`
reject — no dependency on newer browser APIs.

### Rate-limit detection and adaptive backoff
Detects 429/529 and escalates: 15s on first retry, 30s pause after final failure before
moving on. Standard inter-batch pause is 2.5s. This allows runs of 25+ words before
hitting limits, against ~12 with the original 800ms spacing.

### Cancellation by flag, not AbortController
`AbortController` proved unreliable in the sandbox. Cancellation uses a simple
`{ cancelled: boolean }` object checked each loop iteration; the Stop button sets the
flag and updates UI state immediately.

### Incremental saves during fetch runs
Results merge into state after each successful batch, not at the end of the run. A
cancelled or failed run therefore preserves all completed work, and the Unfetched filter
shows exactly what remains.

### Storage architecture
Three keys via the artifact persistent storage API: `vocab-words`, `vocab-progress`,
`vocab-sources`. Writes debounced at 500ms to avoid excessive storage calls during batch
operations.

### Spaced repetition: SM-2
Standard SM-2, four user-facing quality levels mapped onto the 0–5 scale. Intervals are
recursive: day 1 → day 3 → previous interval × ease factor. Ease floor 1.3. A missed
word resets to repetition 0 — which is why "repetition 0" cannot distinguish a never-
rated word from a just-missed one.

### Quiz design
Fill-in-the-blank targets SM-2 repetitions 2–4, where recall is fragile enough to be
worth testing. Multiple choice weights 80% studied / 20% unstudied — excluding unstudied
words entirely would forfeit the pretest benefit. Hint mechanisms and recency bias in
quiz targeting were both considered and rejected.

## Design decisions

### Dark mode, serif headings
Dark stone palette with amber accents. Word display uses Georgia/serif to match the
editorial context; UI chrome uses system sans-serif. Usage notes are rendered in amber
to signal their primacy — for an editor, the usage note is the most valuable field.

### Unfetched word styling
Dashed borders and dimmed text, with a pill badge reading "unfetched."

### Source-steering over dictionary scraping
Rather than scraping Merriam-Webster directly (blocked by authentication and ToS),
Claude generates definitions under instruction to draw on specific authoritative
sources. This produces richer content — particularly the usage notes — than a straight
dictionary scrape would.

## Sandbox constraints (and what they cost)

These shaped v3.1 and disappear on deployment. The workarounds are not worth porting.

- `confirm()` and `alert()` are blocked in the artifact iframe → inline confirmation UI
- Programmatic downloads cause white-screen crashes → clipboard-based textarea panels
  for data portability
- Storage is scoped per artifact → JSON export/import is the only migration path
- Artifacts carry hidden state: publish status appears tied to a version rather than the
  artifact, unpublishing is irreversible and deletes storage, and a chat can hold a stale
  copy that looks live. The live artifact is identified by its word counts, not by title
  or publish button.

## What is not in this document

Everything about the standalone effort — deployment, hosting, database, schema,
migration, accounts, and the automatic-capture loop — lives in the Map, along with the
full record of what has been decided and what remains open. The Map is the working
document; this brief is background.
