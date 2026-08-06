# Lexicon — Project Brief

## Purpose

Lexicon is an editor's vocabulary trainer built as a Claude artifact. It solves a specific problem: professional editors accumulate large saved-word lists on dictionary apps like Merriam-Webster and Dictionary.com, but those apps offer no way to convert saved words into structured study tools. Lexicon bridges that gap — it accepts a raw word list, generates editorial-grade definitions via the Claude API, and serves them back as adaptive flashcards and quizzes.

The app is designed for one user: a professional copyeditor with 20+ years of experience, whose workflow priorities are precision, authoritative sourcing, and usage-level nuance (not just definitions).

## Current State (March 2026)

**Working and stable:**

- Paste-to-import of word lists (comma or newline separated), with dedup
- "Import Only" mode for loading large lists without triggering API calls
- Claude API integration generating: definitions (1–3), IPA pronunciation, etymology, usage notes, 3 example sentences, and a mnemonic per word
- Preferred-source system steering Claude toward specific dictionaries (MW Unabridged, AHD 5th, New Oxford) and usage guides (Fowler's, MW Usage, Bernstein's The Careful Writer), with user-customizable source list
- Library with search, filtering (All / Defined / Unfetched), checkbox selection with shift-click range select, and per-word expand/collapse
- Fetch and re-fetch controls with batch processing, status banner, and Stop button
- Spaced repetition flashcards (SM-2 algorithm) with 4-tier self-rating (Missed / Hard / Good / Easy)
- Three quiz modes: definition→word, word→definition, fill-in-the-blank
- Persistent storage across sessions via artifact storage API
- JSON export of all data

**In active use with ~1,071 words** imported from Merriam-Webster (extracted via Claude Chrome extension). Words are being fetched in batches over multiple sessions.

## Key Technical Decisions

### API batching: 3 words per call
Early iterations used batches of 5 and 10. Both caused frequent timeouts because the rich output per word (3 examples, usage notes, etymology, mnemonic) pushes token counts high. Batches of 3 proved reliable within the 60-second timeout window.

### 60-second timeout with simple Promise wrapper
An initial implementation using `AbortSignal.any` failed silently in the artifact runtime. Replaced with a straightforward `Promise.race` pattern wrapping `fetch` with a `setTimeout` reject — no dependency on newer browser APIs.

### Rate limit detection and adaptive backoff
The app detects 429/529 responses and applies escalating delays: 15s on first retry, 30s pause after final failure before moving to the next batch. Standard inter-batch pause is 2.5 seconds. This allows runs of 25+ words before hitting limits, versus ~12 with the original 800ms spacing.

### Cancellation via flag rather than AbortController
`AbortController` integration proved unreliable in the artifact sandbox. Cancellation now uses a simple `{ cancelled: boolean }` object checked at each loop iteration. The Stop button sets the flag and immediately updates UI state.

### Incremental saves during fetch runs
Results are merged into state after each successful batch, not at the end of the full run. This means a cancelled or failed run preserves all completed work. Combined with the Unfetched filter, users can see exactly what remains and resume seamlessly.

### Storage architecture
All data lives in three keys via the artifact persistent storage API: `vocab-words` (word objects with definitions), `vocab-progress` (SM-2 scheduling state per word), and `vocab-sources` (user's preferred source list). Writes are debounced at 500ms to avoid excessive storage calls during batch operations.

### Spaced repetition: SM-2 algorithm
Standard SM-2 with four user-facing quality levels mapped to the 0–5 scale. Interval calculation is recursive: day 1 → day 3 → previous interval × ease factor. Ease floor is 1.3. Words marked "Missed" reset to repetition 0.

## Design Decisions

### Dark mode, serif headings
The UI uses a dark stone palette with amber accents. Word display uses Georgia/serif to match the editorial context; UI chrome uses system sans-serif. The visual hierarchy puts usage notes in amber to signal their primacy — for an editor, the usage note is the most valuable field.

### Unfetched word styling
Unfetched words use dashed borders and dimmed text to visually separate them from defined entries. A pill badge ("unfetched") replaces the original subtle "no definition" text.

### Source-steering over dictionary scraping
Rather than scraping Merriam-Webster entries directly (blocked by authentication and ToS), the app has Claude generate definitions with instructions to draw from specific authoritative sources. This actually produces richer content — particularly the usage notes — than a straight dictionary scrape would.

## Future Considerations

- Dictionary.com import support (same pattern: extract word list, fetch via Claude)
- Bulk operations: delete selected, batch tag/categorize
- Study session statistics and progress visualization
- Quiz mode refinements: timed rounds, usage-note-based questions, etymology matching
- Possible migration to a standalone app if the artifact outgrows the sandbox constraints (particularly around API rate limits and storage size with 1,000+ fully defined words)

### Automatic word capture (high-value future feature)
The long-term vision is to integrate Lexicon into day-to-day reading so that words looked up on a device (e.g., long-press "Look Up" on iPhone) are automatically added to the library. This would transform Lexicon from a retroactive study tool into a passive vocabulary capture system.

**Implementation path (requires standalone deployment):**
1. **Capture layer:** An iOS Shortcut or Share Sheet extension that sends selected text to a backend (e.g., a simple API endpoint, Google Sheet, or Notion database).
2. **Ingestion layer:** Lexicon polls or receives pushes from the capture source, adding new words to the library and queuing them for definition fetching.
3. **Stretch:** A lightweight Progressive Web App or native iOS app with its own Share Sheet extension for a seamless select → share → done flow.

**Audience potential:** This workflow isn't editor-specific. Students, ESL learners, avid readers, and writers all share the same pain point — words looked up in context are forgotten because there's no bridge from "I just looked this up" to structured retention. Lexicon with automatic capture would close that loop entirely.
