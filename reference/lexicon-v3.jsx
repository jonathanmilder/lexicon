/**
 * LEXICON — Editor's Vocabulary Trainer
 * ======================================
 * v3 — April 2026
 *
 * Changes in v3:
 * - Clipboard-based export/import (replaces broken programmatic downloads in sandbox)
 * - MC quiz weighting: 80% studied words, 20% unstudied (pretesting benefit without
 *   the quiz feeling disconnected from study progress)
 *
 * Changes in v2:
 * - Rating labels: "No idea / Struggled / Got it / Knew it" (clearer metacognitive descriptors)
 * - Quiz feedback: prominent correct/incorrect banners with color-coded card borders
 * - Fill-in-the-blank targeting: draws from words at repetition ≥ 1 (studied at least once),
 *   biased toward words in the SM-2 sweet spot (repetition 2–4), with fallback
 * - Skip button on fill-in-the-blank: reveals answer, records failure (quality 1)
 * - Session length selection: 10 / 20 / 30 / All cards
 * - Post-session review: study and quiz both show summary with expandable word entries
 *   and link to library (review happens AFTER session, not during, to preserve retrieval practice)
 */
import { useState, useEffect, useRef } from "react";

const DEFAULT_SOURCES = {
  dictionaries: ["Merriam-Webster Unabridged", "American Heritage Dictionary (5th ed.)", "New Oxford American Dictionary"],
  usageGuides: ["Fowler's Dictionary of Modern English Usage", "Merriam-Webster's Dictionary of English Usage", "Theodore Bernstein's The Careful Writer"]
};

const TABS = [
  { id: "import", label: "Import" },
  { id: "library", label: "Library" },
  { id: "study", label: "Study" },
  { id: "quiz", label: "Quiz" },
  { id: "sources", label: "Sources" }
];

const RATING_LABELS = [
  { quality: 1, label: "No idea", desc: "Complete blank", color: "bg-red-900 hover:bg-red-800 text-red-200 border-red-800" },
  { quality: 3, label: "Struggled", desc: "Recalled with effort", color: "bg-yellow-900 hover:bg-yellow-800 text-yellow-200 border-yellow-800" },
  { quality: 4, label: "Got it", desc: "Solid recall", color: "bg-emerald-900 hover:bg-emerald-800 text-emerald-200 border-emerald-800" },
  { quality: 5, label: "Knew it", desc: "Instant", color: "bg-blue-900 hover:bg-blue-800 text-blue-200 border-blue-800" }
];

function buildSystemPrompt(sources) {
  return `You are an expert lexicographer and usage authority assisting a professional editor in building vocabulary fluency. When defining words, draw primarily from these authoritative sources:
DICTIONARIES (for definitions, pronunciation, etymology): ${sources.dictionaries.join(", ")}
USAGE GUIDES (for usage notes, distinctions, common errors): ${sources.usageGuides.join(", ")}
You may supplement with other reputable sources when these do not cover a term, but always prioritize the sources above.
For each word, provide:
- part_of_speech: primary part(s) of speech
- pronunciation: IPA pronunciation
- definitions: array of 1-3 definitions (primary first), each a concise string
- etymology: brief etymology
- usage_note: editorial-level usage guidance — distinctions from near-synonyms, common misuses, register, formality level. This is the most valuable field for an editor; make it substantive.
- examples: an array of 3 well-crafted example sentences demonstrating correct, nuanced usage in varied contexts
- mnemonics: a brief memory aid or association to help retention
Respond ONLY with valid JSON — no markdown, no backticks, no preamble. Return an array of objects, one per word, each with a "word" field plus the fields above.`;
}

function getInterval(ease, repetition) {
  if (repetition === 0) return 0;
  if (repetition === 1) return 1;
  if (repetition === 2) return 3;
  return Math.round(getInterval(ease, repetition - 1) * ease);
}

export default function VocabTrainer() {
  // Core state
  const [tab, setTab] = useState("import");
  const [words, setWords] = useState([]);
  const [progress, setProgress] = useState({});
  const [sources, setSources] = useState(DEFAULT_SOURCES);
  const [storageReady, setStorageReady] = useState(false);

  // Fetch state
  const [loading, setLoading] = useState(false);
  const [loadMsg, setLoadMsg] = useState("");
  const [errors, setErrors] = useState([]);

  // Import
  const [importText, setImportText] = useState("");

  // Library
  const [expandedWord, setExpandedWord] = useState(null);
  const [selectedWords, setSelectedWords] = useState(new Set());
  const [searchTerm, setSearchTerm] = useState("");
  const [libraryFilter, setLibraryFilter] = useState("all");

  // Study
  const [studyQueue, setStudyQueue] = useState([]);
  const [studyIdx, setStudyIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [sessionLength, setSessionLength] = useState(null);
  const [studyLog, setStudyLog] = useState([]);
  const [showStudyReview, setShowStudyReview] = useState(false);
  const [reviewExpandedWord, setReviewExpandedWord] = useState(null);

  // Quiz
  const [quizMode, setQuizMode] = useState(null);
  const [quizQ, setQuizQ] = useState(null);
  const [quizAnswer, setQuizAnswer] = useState(null);
  const [quizScore, setQuizScore] = useState({ correct: 0, total: 0 });
  const [quizInput, setQuizInput] = useState("");
  const [quizLog, setQuizLog] = useState([]);
  const [showQuizReview, setShowQuizReview] = useState(false);

  // Sources
  const [newSource, setNewSource] = useState("");
  const [newSourceType, setNewSourceType] = useState("dictionaries");
  const [jsonImportMsg, setJsonImportMsg] = useState("");
  const [showExportPanel, setShowExportPanel] = useState(false);
  const [showImportPanel, setShowImportPanel] = useState(false);
  const [importJsonText, setImportJsonText] = useState("");
  const [exportCopied, setExportCopied] = useState(false);

  // ─── Storage ───────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      try {
        const [w, p, s] = await Promise.all([
          window.storage.get("vocab-words").catch(() => null),
          window.storage.get("vocab-progress").catch(() => null),
          window.storage.get("vocab-sources").catch(() => null)
        ]);
        if (w?.value) setWords(JSON.parse(w.value));
        if (p?.value) setProgress(JSON.parse(p.value));
        if (s?.value) setSources(JSON.parse(s.value));
      } catch (e) { console.log("Storage load error:", e); }
      setStorageReady(true);
    }
    load();
  }, []);

  const saveTimeout = useRef(null);
  useEffect(() => {
    if (!storageReady) return;
    clearTimeout(saveTimeout.current);
    saveTimeout.current = setTimeout(async () => {
      try {
        await Promise.all([
          window.storage.set("vocab-words", JSON.stringify(words)),
          window.storage.set("vocab-progress", JSON.stringify(progress)),
          window.storage.set("vocab-sources", JSON.stringify(sources))
        ]);
      } catch (e) { console.log("Storage save error:", e); }
    }, 500);
  }, [words, progress, sources, storageReady]);

  // ─── Derived data ─────────────────────────────────────────
  const definedWords = words.filter(w => w.definitions);
  const now = new Date();
  const dueWords = definedWords.filter(w => {
    const p = progress[w.word];
    if (!p) return true;
    return new Date(p.nextReview) <= now;
  });
  const undefinedCount = words.filter(w => !w.definitions).length;
  const statsDue = dueWords.length;
  const statsMastered = definedWords.filter(w => {
    const p = progress[w.word];
    return p && p.repetition >= 5;
  }).length;

  const filteredWords = (searchTerm
    ? words.filter(w => w.word?.includes(searchTerm.toLowerCase()))
    : words
  ).filter(w => {
    if (libraryFilter === "defined") return !!w.definitions;
    if (libraryFilter === "undefined") return !w.definitions;
    return true;
  });

  // ─── Fetch logic ──────────────────────────────────────────
  const abortRef = useRef(null);

  function cancelFetch() {
    if (abortRef.current) abortRef.current.cancelled = true;
    setLoading(false);
    setLoadMsg("Fetch stopped. Progress has been saved.");
  }

  function clearStatus() { setLoadMsg(""); setErrors([]); }

  function fetchWithTimeout(url, options, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Request timed out after ${timeoutMs / 1000}s`)), timeoutMs);
      fetch(url, options)
        .then(resp => { clearTimeout(timer); resolve(resp); })
        .catch(err => { clearTimeout(timer); reject(err); });
    });
  }

  async function fetchDefinitions(wordList) {
    const session = { cancelled: false };
    abortRef.current = session;
    setLoading(true);
    setErrors([]);
    const results = [];
    const failed = [];
    const batchSize = 3;

    for (let i = 0; i < wordList.length; i += batchSize) {
      if (session.cancelled) break;
      const batch = wordList.slice(i, i + batchSize);
      const batchLabel = `${i + 1}–${Math.min(i + batchSize, wordList.length)} of ${wordList.length}`;
      setLoadMsg(`Fetching definitions ${batchLabel}...`);

      let attempts = 0;
      let success = false;
      while (attempts < 3 && !success) {
        if (session.cancelled) break;
        attempts++;
        try {
          const resp = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "claude-sonnet-4-20250514",
              max_tokens: 4000,
              system: buildSystemPrompt(sources),
              messages: [{ role: "user", content: `Define these words: ${JSON.stringify(batch.map(w => w.word))}` }]
            })
          }, 60000);

          if (!resp.ok) {
            const errBody = await resp.text().catch(() => "");
            throw new Error(`API returned ${resp.status}: ${errBody.slice(0, 200)}`);
          }
          const data = await resp.json();
          if (data.error) throw new Error(`API error: ${data.error.message || JSON.stringify(data.error)}`);
          const text = data.content?.map(c => c.text || "").join("") || "";
          if (!text.trim()) throw new Error("Empty response from API");
          const clean = text.replace(/```json|```/g, "").trim();
          const parsed = JSON.parse(clean);
          if (!Array.isArray(parsed)) throw new Error("Response was not an array");
          results.push(...parsed);
          success = true;
        } catch (e) {
          if (session.cancelled) break;
          const errMsg = `Batch ${batchLabel} (attempt ${attempts}): ${e.message}`;
          console.error(errMsg);
          const isRateLimit = e.message.includes("429") || e.message.includes("rate") || e.message.includes("overloaded") || e.message.includes("529");
          if (attempts >= 3) {
            failed.push(...batch.map(w => w.word));
            setErrors(prev => [...prev, errMsg]);
            if (isRateLimit) {
              setLoadMsg(`Rate limited at batch ${batchLabel}. Pausing 30s...`);
              await new Promise(r => setTimeout(r, 30000));
            } else {
              setLoadMsg(`Batch ${batchLabel} failed after retry. Continuing...`);
            }
          } else {
            const retryDelay = isRateLimit ? 15000 : 3000;
            setLoadMsg(`Batch ${batchLabel} failed${isRateLimit ? " (rate limited)" : ""}, retrying in ${retryDelay / 1000}s...`);
            await new Promise(r => setTimeout(r, retryDelay));
          }
        }
      }

      if (results.length > 0 && !session.cancelled) {
        setWords(prev => prev.map(w => {
          const def = results.find(r => r.word?.toLowerCase() === w.word?.toLowerCase());
          return def ? { ...w, ...def, word: w.word } : w;
        }));
      }
      if (i + batchSize < wordList.length && !session.cancelled) {
        await new Promise(r => setTimeout(r, 2500));
      }
    }

    if (!session.cancelled) {
      setWords(prev => prev.map(w => {
        const def = results.find(r => r.word?.toLowerCase() === w.word?.toLowerCase());
        return def ? { ...w, ...def, word: w.word } : w;
      }));
    }

    const successCount = results.length;
    const failCount = failed.length;
    abortRef.current = null;
    setLoading(false);
    if (session.cancelled) return;
    setLoadMsg(
      failCount > 0
        ? `Done: ${successCount} defined, ${failCount} failed. Use "Fetch missing" to retry.`
        : successCount > 0
        ? `Done! ${successCount} word(s) defined.`
        : "No definitions were fetched. Check the errors below."
    );
  }

  // ─── Import ───────────────────────────────────────────────
  function handleImport(shouldFetch = true) {
    const raw = [...new Set(importText.trim().split(/[\n,]+/).map(w => w.trim().toLowerCase()).filter(Boolean))];
    const existing = new Set(words.map(w => w.word.toLowerCase()));
    const newWords = raw.filter(w => !existing.has(w)).map(w => ({ word: w }));
    const skipped = raw.length - newWords.length;
    if (newWords.length === 0) {
      setLoadMsg(`All ${raw.length} word(s) are already in your library.`);
      return;
    }
    setWords(prev => [...prev, ...newWords]);
    setImportText("");
    const skipNote = skipped > 0 ? ` (${skipped} duplicate(s) skipped)` : "";
    if (shouldFetch) {
      setLoadMsg(`Added ${newWords.length} new word(s)${skipNote}. Fetching definitions...`);
      fetchDefinitions(newWords);
    } else {
      setLoadMsg(`Added ${newWords.length} new word(s)${skipNote}. Use Library → Re-fetch to define them.`);
    }
  }

  // ─── Library selection ────────────────────────────────────
  const lastCheckedRef = useRef(null);
  function toggleSelected(word, event) {
    const idx = filteredWords.findIndex(w => w.word === word);
    if (event?.shiftKey && lastCheckedRef.current !== null) {
      const start = Math.min(lastCheckedRef.current, idx);
      const end = Math.max(lastCheckedRef.current, idx);
      const rangeWords = filteredWords.slice(start, end + 1).map(w => w.word);
      setSelectedWords(prev => {
        const next = new Set(prev);
        rangeWords.forEach(w => next.add(w));
        return next;
      });
    } else {
      setSelectedWords(prev => {
        const next = new Set(prev);
        if (next.has(word)) next.delete(word); else next.add(word);
        return next;
      });
    }
    lastCheckedRef.current = idx;
  }

  function refetchSelected() {
    const toRefetch = words.filter(w => selectedWords.has(w.word));
    if (toRefetch.length === 0) return;
    setSelectedWords(new Set());
    fetchDefinitions(toRefetch);
  }

  // ─── Spaced repetition ────────────────────────────────────
  function recordAnswer(word, quality) {
    setProgress(prev => {
      const p = prev[word] || { ease: 2.5, repetition: 0, nextReview: new Date().toISOString() };
      let { ease, repetition } = p;
      if (quality < 3) {
        repetition = 0;
      } else {
        repetition += 1;
        ease = Math.max(1.3, ease + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)));
      }
      const interval = getInterval(ease, repetition);
      const next = new Date();
      next.setDate(next.getDate() + interval);
      return { ...prev, [word]: { ease, repetition, nextReview: next.toISOString() } };
    });
  }

  // ─── Study ────────────────────────────────────────────────
  function startStudy(mode) {
    const pool = mode === "due" ? (dueWords.length > 0 ? dueWords : definedWords) : definedWords;
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    const limited = sessionLength ? shuffled.slice(0, sessionLength) : shuffled;
    setStudyQueue(limited);
    setStudyIdx(0);
    setFlipped(false);
    setStudyLog([]);
    setShowStudyReview(false);
    setReviewExpandedWord(null);
  }

  function studyAnswer(quality) {
    const w = studyQueue[studyIdx];
    const ratingInfo = RATING_LABELS.find(r => r.quality === quality);
    setStudyLog(prev => [...prev, { word: w.word, quality, label: ratingInfo?.label || "", wordData: w }]);
    recordAnswer(w.word, quality);
    if (studyIdx < studyQueue.length - 1) {
      setStudyIdx(studyIdx + 1);
      setFlipped(false);
    } else {
      setShowStudyReview(true);
    }
  }

  function endStudySession() {
    if (studyLog.length > 0) {
      setShowStudyReview(true);
    } else {
      setStudyQueue([]);
      setStudyIdx(0);
      setShowStudyReview(false);
    }
  }

  function closeStudyReview() {
    setStudyQueue([]);
    setStudyIdx(0);
    setShowStudyReview(false);
    setStudyLog([]);
    setReviewExpandedWord(null);
  }

  // ─── Quiz ─────────────────────────────────────────────────
  function getExamples(w) {
    if (w.examples?.length > 0) return w.examples;
    if (w.example) return [w.example];
    return [];
  }

  function genQuiz(mode) {
    if (mode === "fillin") {
      // Fill-in-the-blank: draw from words the user has studied at least once
      // Prefer words in the SM-2 sweet spot (repetition 2–4)
      const studied = definedWords.filter(w => {
        const p = progress[w.word];
        return p && p.repetition >= 1;
      });

      if (studied.length < 1) return null;

      // Prefer sweet-spot words, but fall back to all studied words
      const sweetSpot = studied.filter(w => {
        const p = progress[w.word];
        return p.repetition >= 2 && p.repetition <= 4;
      });

      const pool = sweetSpot.length >= 1 ? sweetSpot : studied;
      const target = pool[Math.floor(Math.random() * pool.length)];
      const exArr = getExamples(target);
      const sentence = exArr.length > 0
        ? exArr[Math.floor(Math.random() * exArr.length)]
        : `Use the word "${target.word}" in context.`;
      const blanked = sentence.replace(new RegExp(target.word, "gi"), "______");
      return { mode, target, prompt: blanked, answer: target.word };
    }

    // Multiple choice modes need 4+ defined words
    if (definedWords.length < 4) return null;

    // Weight target selection: 80% studied words, 20% unstudied (pretesting)
    const studied = definedWords.filter(w => { const p = progress[w.word]; return p && p.repetition >= 1; });
    const unstudied = definedWords.filter(w => { const p = progress[w.word]; return !p || p.repetition < 1; });

    let target;
    if (studied.length > 0 && (unstudied.length === 0 || Math.random() < 0.8)) {
      target = studied[Math.floor(Math.random() * studied.length)];
    } else if (unstudied.length > 0) {
      target = unstudied[Math.floor(Math.random() * unstudied.length)];
    } else {
      target = definedWords[Math.floor(Math.random() * definedWords.length)];
    }

    // Pick 3 distractors from remaining words
    const others = definedWords.filter(w => w.word !== target.word);
    const distractors = [...others].sort(() => Math.random() - 0.5).slice(0, 3);

    if (mode === "def2word") {
      const options = [target, ...distractors].sort(() => Math.random() - 0.5);
      return { mode, target, options, prompt: target.definitions?.[0] || "No definition" };
    } else if (mode === "word2def") {
      const options = [target, ...distractors].sort(() => Math.random() - 0.5);
      return { mode, target, options, prompt: target.word };
    }
    return null;
  }

  function startQuiz(mode) {
    setQuizMode(mode);
    setQuizScore({ correct: 0, total: 0 });
    setQuizAnswer(null);
    setQuizInput("");
    setQuizLog([]);
    setShowQuizReview(false);
    setReviewExpandedWord(null);
    setQuizQ(genQuiz(mode));
  }

  function submitQuizAnswer(selected) {
    const correct = quizQ.mode === "fillin"
      ? typeof selected === "string" && selected.toLowerCase().trim() === quizQ.target.word.toLowerCase()
      : selected.word === quizQ.target.word;
    setQuizAnswer({ selected, correct, skipped: false });
    recordAnswer(quizQ.target.word, correct ? 4 : 1);
    setQuizScore(s => ({ correct: s.correct + (correct ? 1 : 0), total: s.total + 1 }));
    setQuizLog(prev => [...prev, { word: quizQ.target.word, correct, skipped: false, wordData: quizQ.target }]);
  }

  function skipQuizQuestion() {
    setQuizAnswer({ selected: null, correct: false, skipped: true });
    recordAnswer(quizQ.target.word, 1);
    setQuizScore(s => ({ ...s, total: s.total + 1 }));
    setQuizLog(prev => [...prev, { word: quizQ.target.word, correct: false, skipped: true, wordData: quizQ.target }]);
  }

  function nextQuizQ() {
    setQuizAnswer(null);
    setQuizInput("");
    setQuizQ(genQuiz(quizMode));
  }

  function endQuiz() {
    if (quizLog.length > 0) {
      setShowQuizReview(true);
    } else {
      setQuizMode(null);
      setQuizQ(null);
      setQuizLog([]);
    }
  }

  function closeQuizReview() {
    setQuizMode(null);
    setQuizQ(null);
    setQuizLog([]);
    setShowQuizReview(false);
    setReviewExpandedWord(null);
  }

  // ─── Styles ───────────────────────────────────────────────
  const bg = "bg-stone-950";
  const card = "bg-stone-900 border border-stone-800";
  const accent = "text-amber-400";
  const btn = "px-4 py-2 rounded-lg font-medium transition-all duration-150";
  const btnPrimary = `${btn} bg-amber-500 hover:bg-amber-400 text-stone-950`;
  const btnSecondary = `${btn} bg-stone-800 hover:bg-stone-700 text-stone-200 border border-stone-700`;
  const btnGhost = `${btn} text-stone-400 hover:text-stone-200 hover:bg-stone-800`;

  // ─── Shared subcomponents ─────────────────────────────────
  function ErrorPanel() {
    if (errors.length === 0) return null;
    return (
      <div className="bg-red-950 border border-red-800 rounded-lg p-4">
        <h3 className="text-sm font-semibold text-red-400 mb-2">Errors</h3>
        {errors.map((e, i) => (
          <p key={i} className="text-xs text-red-300 font-mono mb-1 break-all">{e}</p>
        ))}
        <button onClick={() => setErrors([])} className="text-xs text-red-500 hover:text-red-400 mt-2">Clear</button>
      </div>
    );
  }

  function WordDetail({ w }) {
    const exs = getExamples(w);
    return (
      <div className="space-y-3">
        {w.pronunciation && <p className="text-sm text-stone-500">{w.pronunciation}</p>}
        <div>
          <p className="text-xs font-semibold text-stone-500 uppercase tracking-wider mb-1">Definitions</p>
          {w.definitions?.map((d, i) => (
            <p key={i} className="text-sm text-stone-300 ml-3">
              <span className="text-stone-500 mr-1">{i + 1}.</span> {d}
            </p>
          ))}
        </div>
        {w.etymology && (
          <div>
            <p className="text-xs font-semibold text-stone-500 uppercase tracking-wider mb-1">Etymology</p>
            <p className="text-sm text-stone-400 ml-3 italic">{w.etymology}</p>
          </div>
        )}
        {w.usage_note && (
          <div>
            <p className="text-xs font-semibold text-amber-500 uppercase tracking-wider mb-1">Usage Note</p>
            <p className="text-sm text-stone-300 ml-3">{w.usage_note}</p>
          </div>
        )}
        {exs.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-stone-500 uppercase tracking-wider mb-1">Examples</p>
            {exs.map((ex, i) => (
              <p key={i} className="text-sm text-stone-400 ml-3 italic mb-1">"{ex}"</p>
            ))}
          </div>
        )}
        {w.mnemonics && (
          <div>
            <p className="text-xs font-semibold text-stone-500 uppercase tracking-wider mb-1">Memory Aid</p>
            <p className="text-sm text-stone-400 ml-3">{w.mnemonics}</p>
          </div>
        )}
      </div>
    );
  }

  function SessionReviewScreen({ log, type, onClose }) {
    // type: "study" or "quiz"
    const isStudy = type === "study";
    const ratingCounts = {};
    if (isStudy) {
      RATING_LABELS.forEach(r => { ratingCounts[r.label] = 0; });
      log.forEach(entry => { if (ratingCounts[entry.label] !== undefined) ratingCounts[entry.label]++; });
    }
    const correctCount = log.filter(e => e.correct).length;

    return (
      <div className="max-w-lg mx-auto space-y-6">
        <div className="text-center">
          <h2 className="text-xl font-semibold mb-2" style={{ fontFamily: "'Georgia', serif" }}>
            Session Complete
          </h2>
          <p className="text-stone-400 text-sm">
            {log.length} word{log.length !== 1 ? "s" : ""} reviewed
          </p>
        </div>

        {/* Stats summary */}
        <div className={`${card} rounded-xl p-5`}>
          {isStudy ? (
            <div className="flex justify-center gap-6">
              {RATING_LABELS.map(r => (
                <div key={r.label} className="text-center">
                  <p className="text-2xl font-bold text-stone-200">{ratingCounts[r.label]}</p>
                  <p className="text-xs text-stone-500 mt-1">{r.label}</p>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center">
              <p className="text-3xl font-bold text-stone-200">
                {correctCount}/{log.length}
                <span className="text-lg text-stone-500 ml-2">
                  ({log.length > 0 ? Math.round(correctCount / log.length * 100) : 0}%)
                </span>
              </p>
              <p className="text-sm text-stone-500 mt-1">correct</p>
            </div>
          )}
        </div>

        {/* Word list */}
        <div className="space-y-2">
          <p className="text-xs font-semibold text-stone-500 uppercase tracking-wider">Words reviewed</p>
          {log.map((entry, i) => {
            const isExpanded = reviewExpandedWord === entry.word + "-" + i;
            const w = entry.wordData;
            return (
              <div key={entry.word + "-" + i} className={`${card} rounded-lg overflow-hidden`}>
                <button
                  onClick={() => setReviewExpandedWord(isExpanded ? null : entry.word + "-" + i)}
                  className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-stone-800 transition-colors"
                >
                  <span className="font-semibold" style={{ fontFamily: "'Georgia', serif" }}>{entry.word}</span>
                  <div className="flex items-center gap-2">
                    {isStudy ? (
                      <span className={`text-xs px-2 py-0.5 rounded ${
                        entry.quality === 1 ? "bg-red-900 text-red-300" :
                        entry.quality === 3 ? "bg-yellow-900 text-yellow-300" :
                        entry.quality === 4 ? "bg-emerald-900 text-emerald-300" :
                        "bg-blue-900 text-blue-300"
                      }`}>{entry.label}</span>
                    ) : (
                      <span className={`text-xs px-2 py-0.5 rounded ${
                        entry.skipped ? "bg-stone-800 text-stone-400" :
                        entry.correct ? "bg-emerald-900 text-emerald-300" :
                        "bg-red-900 text-red-300"
                      }`}>{entry.skipped ? "Skipped" : entry.correct ? "Correct" : "Incorrect"}</span>
                    )}
                    <span className="text-stone-600 text-xs">{isExpanded ? "▲" : "▼"}</span>
                  </div>
                </button>
                {isExpanded && w && (
                  <div className="px-4 pb-4 border-t border-stone-800 pt-3">
                    <WordDetail w={w} />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex justify-center gap-3">
          <button onClick={onClose} className={btnPrimary}>Done</button>
          <button onClick={() => { onClose(); setTab("library"); }} className={btnSecondary}>
            Open Library
          </button>
        </div>
      </div>
    );
  }

  // ─── Fill-in-the-blank pool info ──────────────────────────
  const fillinPoolSize = definedWords.filter(w => {
    const p = progress[w.word];
    return p && p.repetition >= 1;
  }).length;

  // ─── Render ───────────────────────────────────────────────
  return (
    <div className={`${bg} min-h-screen text-stone-200`} style={{ fontFamily: "'Georgia', 'Times New Roman', serif" }}>
      {/* Header */}
      <div className="border-b border-stone-800 px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div>
            <h1 className={`text-2xl font-bold ${accent}`}>Lexicon</h1>
            <p className="text-stone-500 text-sm mt-0.5" style={{ fontFamily: "system-ui, sans-serif" }}>Editor's Vocabulary Trainer</p>
          </div>
          <div className="flex gap-4 text-sm" style={{ fontFamily: "system-ui, sans-serif" }}>
            <span className="text-stone-500">{words.length} words</span>
            <span className="text-stone-500">·</span>
            <span className={statsDue > 0 ? "text-amber-400" : "text-stone-500"}>{statsDue} due</span>
            <span className="text-stone-500">·</span>
            <span className="text-emerald-500">{statsMastered} mastered</span>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-stone-800" style={{ fontFamily: "system-ui, sans-serif" }}>
        <div className="max-w-4xl mx-auto flex">
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`px-5 py-3 text-sm font-medium transition-colors ${tab === t.id ? "text-amber-400 border-b-2 border-amber-400" : "text-stone-500 hover:text-stone-300"}`}>
              {t.label}
              {t.id === "study" && statsDue > 0 && (
                <span className="ml-1.5 bg-amber-500 text-stone-950 text-xs px-1.5 py-0.5 rounded-full">{statsDue}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="max-w-4xl mx-auto p-6" style={{ fontFamily: "system-ui, sans-serif" }}>

        {/* ═══ IMPORT TAB ═══ */}
        {tab === "import" && (
          <div className="space-y-6">
            <div>
              <h2 className="text-lg font-semibold mb-2">Import Words</h2>
              <p className="text-stone-400 text-sm mb-4">Paste your saved words below — one per line, or comma-separated. Claude will fetch editorial-grade definitions drawing from your preferred sources.</p>
            </div>
            <textarea value={importText} onChange={e => setImportText(e.target.value)}
              placeholder={"effulgent\ncaptious\nanodyne\ntendentious\nshibboleth"}
              className="w-full h-48 bg-stone-900 border border-stone-700 rounded-lg p-4 text-stone-200 placeholder-stone-600 focus:outline-none focus:border-amber-500 resize-none"
              style={{ fontFamily: "'Georgia', serif", fontSize: "1.05rem", lineHeight: "1.8" }} />
            <div className="flex items-center gap-4 flex-wrap">
              <button onClick={() => handleImport(true)} disabled={loading || !importText.trim()} className={btnPrimary + " disabled:opacity-40"}>
                {loading ? "Fetching..." : "Import & Define"}
              </button>
              <button onClick={() => handleImport(false)} disabled={loading || !importText.trim()} className={btnSecondary + " disabled:opacity-40"}>
                Import Only (no fetch)
              </button>
              {loading && (
                <button onClick={cancelFetch} className={`${btn} bg-red-900 hover:bg-red-800 text-red-200 border border-red-800 text-sm`}>
                  Stop
                </button>
              )}
              {loadMsg && <span className="text-sm text-stone-400">{loadMsg}</span>}
            </div>
            {words.length > 0 && (
              <div className={`${card} rounded-lg p-4 mt-4`}>
                <h3 className="text-sm font-semibold text-stone-400 mb-2">Quick re-fetch</h3>
                <p className="text-sm text-stone-500 mb-3">{undefinedCount} word(s) still need definitions.</p>
                {undefinedCount > 0 && (
                  <button onClick={() => fetchDefinitions(words.filter(w => !w.definitions))} disabled={loading} className={btnSecondary + " text-sm disabled:opacity-40"}>
                    Fetch missing definitions
                  </button>
                )}
              </div>
            )}
            <ErrorPanel />
          </div>
        )}

        {/* ═══ LIBRARY TAB ═══ */}
        {tab === "library" && (
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <input value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
                placeholder="Search words..."
                className="flex-1 bg-stone-900 border border-stone-700 rounded-lg px-4 py-2 text-sm text-stone-200 placeholder-stone-600 focus:outline-none focus:border-amber-500" />
              <span className="text-sm text-stone-500">{filteredWords.length} words</span>
            </div>
            <div className="flex gap-2">
              {[
                { id: "all", label: `All (${words.length})` },
                { id: "defined", label: `Defined (${words.length - undefinedCount})` },
                { id: "undefined", label: `Unfetched (${undefinedCount})` }
              ].map(f => (
                <button key={f.id} onClick={() => setLibraryFilter(f.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    libraryFilter === f.id ? "bg-amber-500 text-stone-950" : "bg-stone-800 text-stone-400 hover:text-stone-200 border border-stone-700"
                  }`}>{f.label}</button>
              ))}
            </div>
            {loading && (
              <div className="flex items-center gap-3 bg-amber-950 border border-amber-800 rounded-lg px-4 py-3 mb-2">
                <div className="w-3 h-3 rounded-full bg-amber-400 animate-pulse" />
                <span className="text-sm text-amber-300 flex-1">{loadMsg || "Fetching..."}</span>
                <button onClick={cancelFetch}
                  className="px-4 py-1.5 rounded-lg bg-red-700 hover:bg-red-600 text-white text-sm font-semibold">Stop</button>
              </div>
            )}
            {!loading && loadMsg && (
              <div className="flex items-center gap-3 bg-stone-900 border border-stone-800 rounded-lg px-4 py-3 mb-2">
                <span className="text-sm text-stone-400 flex-1">{loadMsg}</span>
                <button onClick={clearStatus} className="text-xs text-stone-300 hover:text-white px-2 py-1 rounded hover:bg-stone-700">✕ clear</button>
              </div>
            )}
            <div className="flex items-center gap-3 flex-wrap">
              <button onClick={() => fetchDefinitions(words)} disabled={loading || words.length === 0}
                className={btnSecondary + " text-sm disabled:opacity-40"}>
                {loading ? "Fetching..." : "Fetch all"}
              </button>
              {selectedWords.size > 0 && !loading && (
                <>
                  <button onClick={refetchSelected} disabled={loading}
                    className={btnPrimary + " text-sm disabled:opacity-40"}>
                    Fetch selected ({selectedWords.size})
                  </button>
                  <button onClick={() => setSelectedWords(new Set())} className={btnGhost + " text-sm"}>Clear selection</button>
                </>
              )}
              {filteredWords.length > 0 && selectedWords.size < filteredWords.length && (
                <button onClick={() => setSelectedWords(new Set(filteredWords.map(w => w.word)))}
                  className={btnGhost + " text-sm"}>Select all</button>
              )}
            </div>
            <ErrorPanel />
            {filteredWords.length === 0 && (
              <p className="text-stone-500 text-center py-12">No words yet. Go to Import to add some.</p>
            )}
            <div className="space-y-2">
              {filteredWords.map(w => {
                const isExpanded = expandedWord === w.word;
                const isSelected = selectedWords.has(w.word);
                const pr = progress[w.word];
                const mastered = pr && pr.repetition >= 5;
                return (
                  <div key={w.word} className={`rounded-lg overflow-hidden ${
                    isSelected ? "border-amber-600 bg-stone-900 border" :
                    w.definitions ? card : "bg-stone-900/50 border border-dashed border-stone-700"
                  }`}>
                    <div className="flex items-center">
                      <label className="pl-4 py-3 cursor-pointer flex items-center" onClick={e => e.stopPropagation()}>
                        <input type="checkbox" checked={isSelected} onChange={e => toggleSelected(w.word, e.nativeEvent)}
                          className="w-4 h-4 accent-amber-500 cursor-pointer" />
                      </label>
                      <button onClick={() => setExpandedWord(isExpanded ? null : w.word)}
                        className="flex-1 px-5 py-3 flex items-center justify-between text-left hover:bg-stone-800 transition-colors">
                        <div className="flex items-center gap-3">
                          <span className={`text-lg font-semibold ${w.definitions ? "" : "text-stone-500"}`} style={{ fontFamily: "'Georgia', serif" }}>{w.word}</span>
                          {w.part_of_speech && <span className="text-xs text-stone-500 italic">{w.part_of_speech}</span>}
                        </div>
                        <div className="flex items-center gap-2">
                          {mastered && <span className="text-xs text-emerald-500">✓ mastered</span>}
                          {!w.definitions && <span className="text-xs px-2 py-0.5 rounded bg-stone-800 text-stone-500">unfetched</span>}
                          <span className="text-stone-600">{isExpanded ? "▲" : "▼"}</span>
                        </div>
                      </button>
                    </div>
                    {isExpanded && w.definitions && (
                      <div className="px-5 pb-4 border-t border-stone-800 pt-3">
                        <WordDetail w={w} />
                        <button onClick={() => { setWords(prev => prev.filter(x => x.word !== w.word)); setExpandedWord(null); }}
                          className="text-xs text-red-400 hover:text-red-300 mt-3">Remove word</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ═══ STUDY TAB ═══ */}
        {tab === "study" && (
          <div className="space-y-6">
            {showStudyReview ? (
              <SessionReviewScreen log={studyLog} type="study" onClose={closeStudyReview} />
            ) : studyQueue.length === 0 ? (
              <div className="text-center py-12 space-y-6">
                <div>
                  <h2 className="text-lg font-semibold mb-2">Flashcard Study</h2>
                  <p className="text-stone-400 text-sm">
                    {statsDue > 0 ? `${statsDue} word(s) due for review.` : "No words due — study all words or add more."}
                  </p>
                </div>
                {/* Session length selector */}
                {definedWords.length > 0 && (
                  <div>
                    <p className="text-xs text-stone-500 uppercase tracking-wider mb-2">Session length</p>
                    <div className="flex justify-center gap-2">
                      {[10, 20, 30, null].map(n => (
                        <button key={n ?? "all"} onClick={() => setSessionLength(n)}
                          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                            sessionLength === n
                              ? "bg-amber-500 text-stone-950"
                              : "bg-stone-800 text-stone-400 hover:text-stone-200 border border-stone-700"
                          }`}>
                          {n ?? "All"}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="flex justify-center gap-4">
                  {statsDue > 0 && (
                    <button onClick={() => startStudy("due")} className={btnPrimary}>
                      Study Due ({sessionLength ? `${Math.min(sessionLength, statsDue)} of ${statsDue}` : statsDue})
                    </button>
                  )}
                  {definedWords.length > 0 && (
                    <button onClick={() => startStudy("all")} className={btnSecondary}>
                      Study All ({sessionLength ? `${Math.min(sessionLength, definedWords.length)} of ${definedWords.length}` : definedWords.length})
                    </button>
                  )}
                </div>
                {definedWords.length === 0 && (
                  <p className="text-stone-600 text-sm">Import and define some words first.</p>
                )}
              </div>
            ) : (
              <div className="max-w-lg mx-auto">
                <div className="flex justify-between items-center mb-4">
                  <span className="text-sm text-stone-500">Card {studyIdx + 1} of {studyQueue.length}</span>
                  <button onClick={endStudySession} className={btnGhost + " text-sm"}>End session</button>
                </div>
                <div onClick={() => !flipped && setFlipped(true)}
                  className={`${card} rounded-xl p-8 min-h-[320px] flex flex-col justify-center cursor-pointer hover:border-stone-700 transition-all`}>
                  {!flipped ? (
                    <div className="text-center">
                      <p className="text-3xl font-bold mb-3" style={{ fontFamily: "'Georgia', serif" }}>{studyQueue[studyIdx].word}</p>
                      {studyQueue[studyIdx].pronunciation && (
                        <p className="text-stone-400 text-base mb-6">{studyQueue[studyIdx].pronunciation}</p>
                      )}
                      <p className="text-stone-600 text-sm">Tap to reveal</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <p className="text-xl font-bold mb-1" style={{ fontFamily: "'Georgia', serif" }}>{studyQueue[studyIdx].word}</p>
                      <p className="text-xs text-stone-500 italic">{studyQueue[studyIdx].part_of_speech}</p>
                      {studyQueue[studyIdx].definitions?.map((d, i) => (
                        <p key={i} className="text-stone-300 text-sm"><span className="text-stone-500">{i + 1}.</span> {d}</p>
                      ))}
                      {studyQueue[studyIdx].usage_note && (
                        <div className="mt-3 pt-3 border-t border-stone-800">
                          <p className="text-xs font-semibold text-amber-500 mb-1">USAGE</p>
                          <p className="text-sm text-stone-400">{studyQueue[studyIdx].usage_note}</p>
                        </div>
                      )}
                      {getExamples(studyQueue[studyIdx]).length > 0 && (
                        <div className="mt-2 space-y-1">
                          {getExamples(studyQueue[studyIdx]).map((ex, i) => (
                            <p key={i} className="text-sm text-stone-500 italic">"{ex}"</p>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                {flipped && (
                  <div className="mt-5 space-y-2">
                    <div className="flex justify-center gap-3">
                      {RATING_LABELS.map(r => (
                        <button key={r.quality} onClick={() => studyAnswer(r.quality)}
                          className={`${btn} ${r.color} border flex-1`}>
                          <span className="block text-sm font-semibold">{r.label}</span>
                        </button>
                      ))}
                    </div>
                    <div className="flex justify-center gap-6 text-xs text-stone-600">
                      {RATING_LABELS.map(r => (
                        <span key={r.quality} className="flex-1 text-center">{r.desc}</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ═══ QUIZ TAB ═══ */}
        {tab === "quiz" && (
          <div className="space-y-6">
            {showQuizReview ? (
              <SessionReviewScreen log={quizLog} type="quiz" onClose={closeQuizReview} />
            ) : !quizMode ? (
              <div className="text-center py-12 space-y-6">
                <div>
                  <h2 className="text-lg font-semibold mb-2">Quiz Modes</h2>
                  <p className="text-stone-400 text-sm">
                    {definedWords.length < 4 ? "You need at least 4 defined words to start a quiz." : "Choose a quiz format."}
                  </p>
                </div>
                {definedWords.length >= 4 && (
                  <div className="flex flex-col items-center gap-3 max-w-sm mx-auto">
                    <button onClick={() => startQuiz("def2word")} className={btnSecondary + " w-full text-left"}>
                      <span className="font-semibold">Definition → Word</span>
                      <span className="text-stone-500 text-sm block">Read the definition, pick the word</span>
                    </button>
                    <button onClick={() => startQuiz("word2def")} className={btnSecondary + " w-full text-left"}>
                      <span className="font-semibold">Word → Definition</span>
                      <span className="text-stone-500 text-sm block">See the word, pick the right definition</span>
                    </button>
                    <button onClick={() => startQuiz("fillin")} className={btnSecondary + " w-full text-left"}>
                      <span className="font-semibold">Fill in the Blank</span>
                      <span className="text-stone-500 text-sm block">
                        Complete the sentence with the right word
                        {fillinPoolSize < 1 && " — study some flashcards first"}
                      </span>
                      {fillinPoolSize < 1 && (
                        <span className="text-amber-500 text-xs block mt-1">
                          Requires words you've studied at least once ({fillinPoolSize} available)
                        </span>
                      )}
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="max-w-lg mx-auto">
                <div className="flex justify-between items-center mb-4">
                  <span className="text-sm text-stone-500">
                    Score: {quizScore.correct}/{quizScore.total}
                    {quizScore.total > 0 && ` (${Math.round(quizScore.correct / quizScore.total * 100)}%)`}
                  </span>
                  <button onClick={endQuiz} className={btnGhost + " text-sm"}>End quiz</button>
                </div>

                {quizQ ? (
                  <div className={`rounded-xl overflow-hidden transition-all duration-200 ${
                    quizAnswer
                      ? quizAnswer.correct
                        ? "border-2 border-emerald-500 bg-stone-900"
                        : "border-2 border-red-500 bg-stone-900"
                      : card
                  }`}>
                    {/* Feedback banner */}
                    {quizAnswer && (
                      <div className={`px-6 py-3 flex items-center gap-3 ${
                        quizAnswer.correct
                          ? "bg-emerald-900/80"
                          : "bg-red-900/80"
                      }`}>
                        <span className="text-2xl">{quizAnswer.correct ? "✓" : "✗"}</span>
                        <div>
                          <p className={`font-semibold text-sm ${quizAnswer.correct ? "text-emerald-200" : "text-red-200"}`}>
                            {quizAnswer.correct ? "Correct!" : quizAnswer.skipped ? "Skipped" : "Incorrect"}
                          </p>
                          {!quizAnswer.correct && (
                            <p className="text-sm text-stone-300">
                              The answer was: <span style={{ fontFamily: "'Georgia', serif" }} className="italic font-semibold">{quizQ.target.word}</span>
                            </p>
                          )}
                        </div>
                      </div>
                    )}

                    <div className="p-6 space-y-5">
                      {/* Definition → Word */}
                      {quizQ.mode === "def2word" && (
                        <>
                          <p className="text-xs text-stone-500 uppercase tracking-wider">Which word matches this definition?</p>
                          <p className="text-stone-200 text-lg leading-relaxed" style={{ fontFamily: "'Georgia', serif" }}>{quizQ.prompt}</p>
                          <div className="grid grid-cols-2 gap-3">
                            {quizQ.options.map(o => {
                              const isSelected = quizAnswer?.selected?.word === o.word;
                              const isCorrect = o.word === quizQ.target.word;
                              let style = "bg-stone-800 hover:bg-stone-700 border-stone-700 text-stone-200";
                              if (quizAnswer) {
                                if (isCorrect) style = "bg-emerald-900 border-emerald-500 text-emerald-200 font-semibold";
                                else if (isSelected && !quizAnswer.correct) style = "bg-red-900 border-red-500 text-red-200";
                                else style = "bg-stone-800 border-stone-700 text-stone-500";
                              }
                              return (
                                <button key={o.word} disabled={!!quizAnswer} onClick={() => submitQuizAnswer(o)}
                                  className={`${btn} border ${style} disabled:cursor-default`}
                                  style={{ fontFamily: "'Georgia', serif" }}>
                                  {o.word}
                                </button>
                              );
                            })}
                          </div>
                        </>
                      )}

                      {/* Word → Definition */}
                      {quizQ.mode === "word2def" && (
                        <>
                          <p className="text-xs text-stone-500 uppercase tracking-wider">Which definition matches this word?</p>
                          <p className="text-2xl font-bold" style={{ fontFamily: "'Georgia', serif" }}>{quizQ.prompt}</p>
                          <div className="space-y-2">
                            {quizQ.options.map(o => {
                              const isSelected = quizAnswer?.selected?.word === o.word;
                              const isCorrect = o.word === quizQ.target.word;
                              let style = "bg-stone-800 hover:bg-stone-700 border-stone-700 text-stone-300";
                              if (quizAnswer) {
                                if (isCorrect) style = "bg-emerald-900 border-emerald-500 text-emerald-200";
                                else if (isSelected && !quizAnswer.correct) style = "bg-red-900 border-red-500 text-red-200";
                                else style = "bg-stone-800 border-stone-700 text-stone-500";
                              }
                              return (
                                <button key={o.word} disabled={!!quizAnswer} onClick={() => submitQuizAnswer(o)}
                                  className={`w-full text-left p-3 rounded-lg border ${style} text-sm transition-colors disabled:cursor-default`}>
                                  {o.definitions?.[0]}
                                </button>
                              );
                            })}
                          </div>
                        </>
                      )}

                      {/* Fill in the Blank */}
                      {quizQ.mode === "fillin" && (
                        <>
                          <p className="text-xs text-stone-500 uppercase tracking-wider">Fill in the blank</p>
                          <p className="text-stone-200 text-lg leading-relaxed italic" style={{ fontFamily: "'Georgia', serif" }}>{quizQ.prompt}</p>
                          {!quizAnswer ? (
                            <div className="space-y-3">
                              <div className="flex gap-2">
                                <input value={quizInput} onChange={e => setQuizInput(e.target.value)}
                                  onKeyDown={e => e.key === "Enter" && quizInput.trim() && submitQuizAnswer(quizInput)}
                                  placeholder="Type the word..."
                                  className="flex-1 bg-stone-800 border border-stone-700 rounded-lg px-4 py-2 text-stone-200 placeholder-stone-600 focus:outline-none focus:border-amber-500"
                                  style={{ fontFamily: "'Georgia', serif" }}
                                  autoFocus />
                                <button onClick={() => submitQuizAnswer(quizInput)} disabled={!quizInput.trim()} className={btnPrimary + " disabled:opacity-40"}>
                                  Check
                                </button>
                              </div>
                              <button onClick={skipQuizQuestion}
                                className="text-sm text-stone-500 hover:text-stone-300 transition-colors">
                                Skip — reveal answer
                              </button>
                            </div>
                          ) : null}
                        </>
                      )}

                      {/* Post-answer: usage note + next button */}
                      {quizAnswer && (
                        <div className="pt-3 border-t border-stone-800">
                          {quizQ.target.usage_note && (
                            <div className="mb-4">
                              <p className="text-xs font-semibold text-amber-500 mb-1">USAGE NOTE</p>
                              <p className="text-sm text-stone-400">{quizQ.target.usage_note}</p>
                            </div>
                          )}
                          <button onClick={nextQuizQ} className={btnPrimary + " w-full"}>Next Question</button>
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className={`${card} rounded-xl p-6 text-center`}>
                    <p className="text-stone-400 mb-4">
                      {quizMode === "fillin"
                        ? "No words available for fill-in-the-blank. Study some words with flashcards first — this mode works best with words you've reviewed at least once."
                        : "Not enough defined words for this quiz mode. You need at least 4."}
                    </p>
                    <button onClick={() => { setQuizMode(null); setTab("study"); }} className={btnSecondary}>
                      Go to Study
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ═══ SOURCES TAB ═══ */}
        {tab === "sources" && (
          <div className="space-y-6">
            <div>
              <h2 className="text-lg font-semibold mb-2">Preferred Sources</h2>
              <p className="text-stone-400 text-sm">These sources steer Claude's definitions and usage notes. Claude may supplement from other reputable sources when needed, but these take priority.</p>
            </div>
            {["dictionaries", "usageGuides"].map(type => (
              <div key={type} className={`${card} rounded-lg p-5`}>
                <h3 className={`text-sm font-semibold ${accent} uppercase tracking-wider mb-3`}>
                  {type === "dictionaries" ? "Dictionaries" : "Usage Guides"}
                </h3>
                <div className="space-y-2">
                  {sources[type].map((s, i) => (
                    <div key={i} className="flex items-center justify-between bg-stone-800 rounded-lg px-4 py-2">
                      <span className="text-sm text-stone-300">{s}</span>
                      <button onClick={() => setSources(prev => ({
                        ...prev, [type]: prev[type].filter((_, j) => j !== i)
                      }))} className="text-stone-600 hover:text-red-400 text-sm">✕</button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <div className={`${card} rounded-lg p-5`}>
              <h3 className="text-sm font-semibold text-stone-400 mb-3">Add a source</h3>
              <div className="flex gap-2">
                <select value={newSourceType} onChange={e => setNewSourceType(e.target.value)}
                  className="bg-stone-800 border border-stone-700 rounded-lg px-3 py-2 text-sm text-stone-300 focus:outline-none">
                  <option value="dictionaries">Dictionary</option>
                  <option value="usageGuides">Usage Guide</option>
                </select>
                <input value={newSource} onChange={e => setNewSource(e.target.value)}
                  placeholder="e.g., Garner's Modern English Usage"
                  className="flex-1 bg-stone-800 border border-stone-700 rounded-lg px-4 py-2 text-sm text-stone-300 placeholder-stone-600 focus:outline-none focus:border-amber-500" />
                <button onClick={() => {
                  if (newSource.trim()) {
                    setSources(prev => ({ ...prev, [newSourceType]: [...prev[newSourceType], newSource.trim()] }));
                    setNewSource("");
                  }
                }} className={btnPrimary + " text-sm"}>Add</button>
              </div>
            </div>
            <div className={`${card} rounded-lg p-5`}>
              <h3 className="text-sm font-semibold text-stone-400 mb-3">Data management</h3>
              <div className="flex gap-3 flex-wrap">
                <button onClick={() => { setShowExportPanel(!showExportPanel); setShowImportPanel(false); setExportCopied(false); }} className={btnSecondary + " text-sm"}>
                  {showExportPanel ? "Close export" : "Export all data"}
                </button>
                <button onClick={() => { setShowImportPanel(!showImportPanel); setShowExportPanel(false); setImportJsonText(""); setJsonImportMsg(""); }} className={btnSecondary + " text-sm"}>
                  {showImportPanel ? "Close import" : "Import from JSON"}
                </button>
                <button onClick={async () => {
                  if (confirm("Reset all data? This cannot be undone.")) {
                    setWords([]); setProgress({}); setSources(DEFAULT_SOURCES);
                    try {
                      await window.storage.delete("vocab-words");
                      await window.storage.delete("vocab-progress");
                      await window.storage.delete("vocab-sources");
                    } catch(e) {}
                  }
                }} className={`${btn} text-red-400 hover:bg-red-900 border border-red-900 text-sm`}>Reset all data</button>
              </div>

              {showExportPanel && (
                <div className="mt-4 space-y-3">
                  <p className="text-sm text-stone-400">Copy the JSON below and save it to a text file.</p>
                  <textarea readOnly value={JSON.stringify({ words, progress, sources }, null, 2)}
                    className="w-full h-48 bg-stone-800 border border-stone-700 rounded-lg p-3 text-xs text-stone-300 font-mono resize-none focus:outline-none"
                    onFocus={e => e.target.select()} />
                  <button onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(JSON.stringify({ words, progress, sources }, null, 2));
                      setExportCopied(true);
                      setTimeout(() => setExportCopied(false), 2000);
                    } catch {
                      // fallback: select the textarea content
                      setExportCopied(false);
                    }
                  }} className={btnPrimary + " text-sm"}>
                    {exportCopied ? "Copied!" : "Copy to clipboard"}
                  </button>
                </div>
              )}

              {showImportPanel && (
                <div className="mt-4 space-y-3">
                  <p className="text-sm text-stone-400">Paste your exported Lexicon JSON below.</p>
                  <textarea value={importJsonText} onChange={e => setImportJsonText(e.target.value)}
                    placeholder='Paste JSON here...'
                    className="w-full h-48 bg-stone-800 border border-stone-700 rounded-lg p-3 text-xs text-stone-300 font-mono resize-none focus:outline-none focus:border-amber-500" />
                  <div className="flex items-center gap-3">
                    <button onClick={() => {
                      try {
                        const data = JSON.parse(importJsonText);
                        let msg = [];
                        if (data.words && Array.isArray(data.words)) {
                          setWords(data.words);
                          msg.push(`${data.words.length} words`);
                        }
                        if (data.progress && typeof data.progress === "object") {
                          setProgress(data.progress);
                          msg.push("progress data");
                        }
                        if (data.sources && typeof data.sources === "object") {
                          setSources(data.sources);
                          msg.push("source preferences");
                        }
                        setJsonImportMsg(msg.length > 0 ? `Imported ${msg.join(", ")}.` : "No recognized data found.");
                        setImportJsonText("");
                        setShowImportPanel(false);
                      } catch {
                        setJsonImportMsg("Failed to parse JSON. Check that you pasted the complete export.");
                      }
                    }} disabled={!importJsonText.trim()} className={btnPrimary + " text-sm disabled:opacity-40"}>
                      Load data
                    </button>
                    {jsonImportMsg && <span className="text-sm text-stone-400">{jsonImportMsg}</span>}
                  </div>
                </div>
              )}

              {!showImportPanel && jsonImportMsg && (
                <div className="flex items-center gap-2 mt-3">
                  <span className="text-sm text-stone-400">{jsonImportMsg}</span>
                  <button onClick={() => setJsonImportMsg("")} className="text-xs text-stone-500 hover:text-stone-300">✕</button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}