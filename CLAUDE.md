# CLAUDE.md — Lexicon

Guidance for Claude Code when working in this repository.

> Moved out of `code\CLAUDE.md` on 2026-08-10, which is now a thin index across all
> projects. **This file only loads when Claude Code is opened inside `lexicon/`.** If you
> start a session at the `code\` root and intend to work on Lexicon, read this file
> explicitly first.

## What it is

**A rebuild in progress.** Lexicon is being ported from a Claude artifact prototype into a
deployed standalone app: Vite + React client, Express on Node server, Postgres on Neon via
`pg` with hand-written SQL, TypeScript, one repo, one deployed process. Nothing is deployed
yet.

`lexicon/` is its own git repo (`github.com/jonathanmilder/lexicon`, public, `main`).

The v3.1 artifact is **frozen in code and in data** and lives in `reference/` as the porting
reference. It is not the thing being developed, and it is not to be regenerated or reopened —
regenerating it in a new chat creates a separate artifact with empty storage.

## Read `map.md` first

`map.md` is the planning document: numbered decisions (Q-numbers, stable across sessions)
and the build sequence (Q20). **Read it before doing anything in this project.**

- It lives at the repo root, **gitignored**. Notion holds the authoritative copy.
- **Never edit it in place.** Corrections get reported for Jonathan to enter in Notion.
- If the local file and Notion disagree, Notion wins.

Division of labour, settled and not to be re-litigated: **decisions, pushback and Map upkeep
happen in chat; file-writing and run-look-adjust iteration happen in Claude Code.**

## Build position

**Steps 1–6 are complete. Step 7a — Express, the pool, and one endpoint — is next.**
Q21 resolved 2026-08-09. Steps 5, 6 and 9 (the loader) are Claude Code's; step 11's
acceptance checklist goes back to chat.

`map.md` is authoritative on build position and this line will drift. **If this section and
the map disagree, the map wins** — read it and correct this file.

## Repo conventions — non-negotiable

- **Filenames lowercase-with-hyphens, everywhere.** A deploy-safety rule (Q19), not style:
  Windows is case-insensitive and Linux is not, so a mis-cased import works locally and fails
  on Render. `core.ignorecase false` is set globally.
- **LF line endings.** `.gitattributes` pins `* text=auto eol=lf`. Do not add editor config
  that overrides it.
- **npm, Node 24** (v24.14.1, npm 11.11.0). `package-lock.json` gets committed.
- **`scripts/` is plain Node with zero dependencies**; `server/` is TypeScript and owns the
  toolchain. Different lifecycles, deliberately separate.
- **Never commit** the backup JSON (2 MB, lives in Dropbox) or `.env`.

## The data

Verified baseline, frozen 2026-08-04 — these are hard-coded in verification, not read at run
time: **1,070 words / 974 fetched / 96 unfetched / 95 progress records / 971 Study Due /
10 sources.** All 1,070 headwords are lowercase, zero exceptions.

The file of record is `lexicon-backup-2026-08-03-b.json` (2,037,770 bytes), in Dropbox at
`/AI/Projects/Lexicon/backups/` and synced locally to
`C:\Users\jonat\Dropbox\AI\Projects\Lexicon\backups\`. **A smaller sibling
`lexicon-backup-2026-08-03.json` (1,302,925 bytes, 1,071 words / 663 fetched) sits beside it
and is NOT the file** — it is the source of the superseded "~1,071 words" figure. Scripts take
an explicit path with no default for this reason.

Export shape is `{ words, progress, sources }`; word keys are snake_case; `sources` is an
object with `dictionaries` (4) and `usageGuides` (6), camelCase.

## What is in the repo

| Path | What |
|------|------|
| `scripts/propose-capitalizations.js` | The 26a proposal script (step 2, done). Plain Node, no deps. |
| `data/capitalizations.json` | 45 proposed capitalizations. Hand-reviewed; the loader applies only entries marked `accepted`. |
| `data/capitalization-review.md` | Generated evidence dossier. Read-only — a re-run overwrites it. |
| `server/src/migrate.ts` | Migration runner (step 5). |
| `reference/` | v3.1 source and both briefs. **A frozen record — do not modify.** |

## The v3.1 prototype (`reference/lexicon-v3.jsx`)

Consult the source for logic that is subtle and hard-won; consult the briefs and Q15a for what
must exist. Single-file React component, no bundler, imports only `useState`, `useEffect`,
`useRef`.

**Storage** — Three keys via the artifact persistent storage API:

- `vocab-words` — word objects with definitions
- `vocab-progress` — SM-2 scheduling state per word
- `vocab-sources` — user's preferred source list

Writes are debounced at 500ms.

**Claude API integration** — Fetches word definitions by calling the Claude API directly from
the artifact. Batch size is 3 words per call (larger batches cause timeouts due to rich
per-word output). Rate limit handling: detects 429/529 responses, escalates delays (15s →
30s), inter-batch pause of 2.5s. Cancellation uses a `{ cancelled: boolean }` flag checked at
each loop iteration (AbortController proved unreliable in the sandbox).

**Spaced repetition** — SM-2 algorithm. Four quality tiers: No idea (1) / Struggled (3) /
Got it (4) / Knew it (5). Ease floor 1.3. Missed cards reset to repetition 0.

**Quiz modes** — definition→word, word→definition, fill-in-the-blank. MC weighting is 80%
studied / 20% unstudied. Fill-in-the-blank targets words at repetition ≥ 1, biased toward
repetition 2–4.

**Export/Import** — Clipboard-based (programmatic downloads are broken in the artifact
sandbox).

**Sandbox workarounds are dropped, not ported.** No `confirm()`/`alert()`, no programmatic
downloads, per-artifact storage — all of these disappear on deployment. The clipboard
export and the inline confirmation UI exist to work around the sandbox and have no reason
to survive the port.

## Source steering

Rather than scraping dictionaries, the fetch prompt instructs Claude to draw from named
dictionaries and usage guides — MW Unabridged, AHD 5th, New Oxford, Fowler's, MW Usage,
Bernstein's *The Careful Writer* and others. **Usage notes are the highest-value field.**

`buildSystemPrompt()` emits two separately labelled lines, dictionaries and usage guides,
each welded to its own hand-written instruction string — which is why the schema stores them
as two columns rather than one list. Note the discrepancy: `DEFAULT_SOURCES` in the code holds
3 + 3, while the backup file holds 4 + 6. **General rule: for data, read the backup; for
logic, read the source.**

The prompt gets exactly one revision in the port — it must request **canonical orthography**,
because the 96 unfetched words are fetched post-cutover and are the only words whose capitals
will not come from `data/capitalizations.json`.
