import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import type {
  AiEditorNote,
  AiResolvedSuggestion,
  AiStatus,
} from "../shared/types";

/**
 * Known-compatible local GGUF chat models, selectable from
 * `flowManuscript.ai.model` in Settings. All four were confirmed to exist at
 * these exact repo+filename paths via web search (2026-08-25); sizes are the
 * quantized file's approximate download size, used only as a fallback for
 * the progress bar if a response ever lacks a Content-Length header.
 *
 * "qwen2.5-1.5b-instruct" is the original default (Apache-2.0, confirmed
 * working end to end by the user's own Phase 0 spike). The others are
 * offered as alternatives for users who want a different quality/size
 * trade-off, or whose experience with the default hasn't been good enough —
 * small local models vary noticeably in how reliably they follow
 * instructions like "only flag a real issue."
 */
const MODEL_PRESETS: Record<
  string,
  { label: string; filename: string; url: string; approxBytes: number }
> = {
  "qwen2.5-1.5b-instruct": {
    label: "Qwen2.5 1.5B Instruct — Apache-2.0, ~1.1 GB, smallest/fastest",
    filename: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
    url: "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf",
    approxBytes: 1_120_000_000,
  },
  "smollm2-1.7b-instruct": {
    label: "SmolLM2 1.7B Instruct — Apache-2.0, ~1.1 GB, different vendor/training than the default",
    filename: "smollm2-1.7b-instruct-q4_k_m.gguf",
    url: "https://huggingface.co/HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF/resolve/main/smollm2-1.7b-instruct-q4_k_m.gguf",
    approxBytes: 1_060_000_000,
  },
  "qwen2.5-3b-instruct": {
    label: "Qwen2.5 3B Instruct — Qwen Research License (non-commercial use only), ~2.1 GB, larger/more capable",
    filename: "qwen2.5-3b-instruct-q4_k_m.gguf",
    url: "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf",
    approxBytes: 2_100_000_000,
  },
  "phi-3.5-mini-instruct": {
    label: "Phi-3.5 Mini Instruct — default, MIT, ~2.4 GB, most capable of these four",
    filename: "Phi-3.5-mini-instruct-Q4_K_M.gguf",
    url: "https://huggingface.co/bartowski/Phi-3.5-mini-instruct-GGUF/resolve/main/Phi-3.5-mini-instruct-Q4_K_M.gguf",
    approxBytes: 2_390_000_000,
  },
};
// Was qwen2.5-1.5b-instruct through Phase 3. Changed 2026-08-25 after the
// 1.5B model repeatedly declared a paragraph containing "He had not meant
// are take it" free of errors — a capability ceiling no amount of prompt
// work moved. Phi-3.5 Mini is ~2.4 GB rather than ~1.1 GB, so first run
// downloads more, but proofreading is the whole point of the feature and
// the smaller model could not do it reliably.
const DEFAULT_MODEL_KEY = "phi-3.5-mini-instruct";

/** Resolves `flowManuscript.ai.model` (+ the custom-model settings, if that's
 * what's selected) to a concrete {filename, url, approxBytes} to download.
 * `filename` is always sanitized to a bare basename before being joined onto
 * `globalStorageUri` — it comes from a preset we control, or from a
 * user-editable setting we don't fully trust as a path segment. */
function resolveModelConfig(): {
  filename: string;
  url: string;
  approxBytes: number;
} {
  const cfg = vscode.workspace.getConfiguration("flowManuscript");
  const key = cfg.get<string>("ai.model", DEFAULT_MODEL_KEY);
  if (key === "custom") {
    const url = cfg.get<string>("ai.customModelUrl", "").trim();
    const rawFilename = cfg.get<string>("ai.customModelFilename", "").trim();
    if (!url || !rawFilename) {
      throw new Error(
        'flowManuscript.ai.model is set to "custom" but ' +
          "flowManuscript.ai.customModelUrl and/or flowManuscript.ai.customModelFilename " +
          "are empty. Set both in Settings, or choose a built-in model instead."
      );
    }
    return { url, filename: path.basename(rawFilename), approxBytes: 1_500_000_000 };
  }
  const preset = MODEL_PRESETS[key] ?? MODEL_PRESETS[DEFAULT_MODEL_KEY];
  return preset;
}

const SUGGESTION_CATEGORIES = [
  "grammar",
  "clarity",
  "tone",
  "wordiness",
] as const;
const NOTE_CATEGORIES = [
  "pacing",
  "show-vs-tell",
  "sensory",
  "tension",
  "pov",
  "other",
] as const;
const NOTE_SENTIMENTS = ["strength", "improvement"] as const;

function isSuggestionCategory(
  v: unknown
): v is AiResolvedSuggestion["category"] {
  return (
    typeof v === "string" &&
    (SUGGESTION_CATEGORIES as readonly string[]).includes(v)
  );
}
function isNoteCategory(v: unknown): v is AiEditorNote["category"] {
  return typeof v === "string" && (NOTE_CATEGORIES as readonly string[]).includes(v);
}
function isNoteSentiment(v: unknown): v is AiEditorNote["sentiment"] {
  return typeof v === "string" && (NOTE_SENTIMENTS as readonly string[]).includes(v);
}

// JSON-schema-constrained decoding via `llama.createGrammarForJsonSchema` —
// confirmed working in the Phase 0.1/0.2 spikes, no hand-written GBNF needed.
// `analysis` is deliberately the FIRST property, and it is not shown to the
// user — it exists purely as a scratchpad. Under grammar-constrained
// decoding the model has no room to reason: it starts emitting the JSON
// immediately, and for a 1.5B model the cheapest first token in
// `"suggestions": [` is the one that closes it again. Observed exactly that
// (2026-08-25): a clean, correctly-scoped prompt returned `{"suggestions":
// []}` on a paragraph with several obvious errors. Because node-llama-cpp's
// JSON-schema grammar emits keys in schema order, putting a free-text field
// first forces the model to write out its per-sentence pass BEFORE it can
// reach the array — plain chain-of-thought, just inside the constrained
// output. It's also logged, so its reasoning is visible when results look
// wrong.
const GRAMMAR_SCHEMA = {
  type: "object",
  properties: {
    analysis: { type: "string" },
    suggestions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          original: { type: "string" },
          suggestion: { type: "string" },
          reason: { type: "string" },
          category: { type: "string", enum: [...SUGGESTION_CATEGORIES] },
        },
        required: ["original", "suggestion", "reason", "category"],
      },
    },
  },
  required: ["analysis", "suggestions"],
};

const EDITOR_SCHEMA = {
  type: "object",
  properties: {
    notes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          note: { type: "string" },
          category: { type: "string", enum: [...NOTE_CATEGORIES] },
          quote: { type: "string" },
          sentiment: { type: "string", enum: [...NOTE_SENTIMENTS] },
        },
        required: ["note", "category", "sentiment"],
      },
    },
  },
  required: ["notes"],
};

/** The built-in AI Grammar instructions, also shown to the user (as the
 * default value's *description*, not the value itself — see package.json)
 * so they have a working example to start editing from. Deliberately does
 * NOT include the trailing voiceprint/paragraph block — `composePrompt()`
 * appends that uniformly for both the default and any custom override. */
const DEFAULT_GRAMMAR_INSTRUCTIONS =
  `You are a careful proofreader for fiction prose. Work in two steps.\n\n` +
  `STEP 1 — write the "analysis" field first. Go through the text under review one sentence ` +
  `at a time. For each sentence, quote it and then say either "OK" or exactly what is wrong ` +
  `with it. Check every sentence before you stop.\n\n` +
  `STEP 2 — write the "suggestions" array, one entry for each problem you identified in ` +
  `step 1 (at most 5).\n\n` +
  `The problems to look for, most important first:\n` +
  `1. A WRONG WORD — a correctly-spelled word sitting where a different word belongs. These ` +
  `are the easiest to miss precisely because every word is spelled correctly, so read for ` +
  `sense, not for spelling. Examples: "She new the answer" (should be "knew"); "They would ` +
  `of come" (should be "have"); "he went form there" (should be "from").\n` +
  `2. A MISSING or DUPLICATED word. Examples: "He walked to the the door" (duplicated "the"); ` +
  `"She had nothing say" (missing "to").\n` +
  `3. Subject-verb agreement or verb tense mistakes.\n` +
  `4. Phrasing that is unclear or wordier than it needs to be.\n\n` +
  `Ignore misspelled non-words — a spellchecker already handles those.\n\n` +
  `For each entry in "suggestions":\n` +
  `- "original": copy the exact words from the text under review, character for character. ` +
  `Copy the SHORTEST span that contains the problem — usually two to six words, not the whole ` +
  `sentence. Copy only from the text under review, never from these instructions or from a ` +
  `style guide section.\n` +
  `- "suggestion": those same words, corrected. It must differ from "original".\n` +
  `- "reason": a short explanation of the problem.\n` +
  `- "category": one of grammar, clarity, tone, wordiness.\n\n` +
  `If step 1 genuinely found nothing wrong in any sentence, return an empty "suggestions" array.`;

/** The built-in AI Editor instructions — same role as
 * `DEFAULT_GRAMMAR_INSTRUCTIONS` above. */
const DEFAULT_EDITOR_INSTRUCTIONS =
  `You are a developmental fiction editor. For the paragraph below, give up to 4 short notes ` +
  `on craft — pacing, showing vs. telling, sensory detail, tension, POV consistency — never ` +
  `grammar or spelling. If there's nothing worth noting, return an empty list. Each note should ` +
  `be one or two sentences, specific to this paragraph, not generic writing advice. Tag every ` +
  `note's "sentiment" as "strength" if it calls out something that's genuinely working well, or ` +
  `"improvement" if it's something the author should consider changing — never use "strength" ` +
  `just to soften an improvement note; most notes on a working paragraph should be "improvement" ` +
  `unless something truly stands out as praiseworthy.`;

/**
 * Shared prompt assembly for both AI Grammar and AI Editor. `instructions`
 * is either the built-in default above or the user's
 * `flowManuscript.ai.grammarPrompt`/`ai.editorPrompt` override (trimmed,
 * empty-string-means-"use the default" — see `getCustomPrompt`).
 *
 * The output JSON *shape* is enforced separately by grammar-constrained
 * decoding (`GRAMMAR_SCHEMA`/`EDITOR_SCHEMA`) regardless of what this prompt
 * says — a custom override can change what the model is told to look for
 * and how, but can't break the field structure the host parses.
 *
 * Two ways to use a custom override:
 * - Plain instructions, no placeholders: the voiceprint block (if any) and
 *   the paragraph are appended automatically, same layout as the default.
 * - Instructions containing a literal `{{paragraph}}` (and optionally
 *   `{{voiceprint}}`): full control over the final prompt layout — both are
 *   substituted in place and nothing is appended.
 */
function composePrompt(
  instructions: string,
  text: string,
  voiceprint: string | undefined
): string {
  // The voiceprint block is fenced off aggressively. A real failure this
  // caused (2026-08-25): a voiceprint written as imperative style rules
  // ("Never use the dash. At all.") read to a 1.5B model as more text to
  // critique, and AI Grammar came back quoting the *style guide* instead of
  // the prose — 5 suggestions, none of them from the paragraph, all silently
  // dropped. Hence the explicit REFERENCE ONLY framing, the "never quote
  // from this" instruction, and putting the text under review last behind
  // an unmistakable header so it's the most recent thing in context.
  const voiceprintBlock = voiceprint
    ? `--- BEGIN STYLE GUIDE (REFERENCE ONLY) ---\n` +
      `The following is the author's style guide. It describes how they want to write. ` +
      `It is NOT the text under review: never quote from it, never critique it, never treat ` +
      `its rules as sentences needing correction. Use it only to judge whether something in ` +
      `the text under review fits the author's stated preferences.\n` +
      `${voiceprint}\n` +
      `--- END STYLE GUIDE ---\n\n`
    : "";
  if (instructions.includes("{{paragraph}}")) {
    return instructions
      .replace(/\{\{voiceprint\}\}/g, voiceprintBlock)
      .replace(/\{\{paragraph\}\}/g, text);
  }
  return (
    `${instructions}\n\n${voiceprintBlock}` +
    `--- BEGIN TEXT UNDER REVIEW ---\n${text}\n--- END TEXT UNDER REVIEW ---\n\n` +
    `Review only the text between BEGIN/END TEXT UNDER REVIEW above.`
  );
}

/**
 * Locates the model's quoted `original` inside the real paragraph text.
 *
 * An exact `indexOf` is the happy path, but small models routinely quote
 * *almost* verbatim — a trailing period dropped, a straight quote where the
 * editor holds a curly one, doubled spaces collapsed, different case on the
 * first word. Every one of those made the old exact-only lookup return -1,
 * which silently dropped an otherwise-good suggestion. So this falls back
 * through progressively more forgiving matches, and critically always
 * returns a span expressed in the ORIGINAL paragraph's coordinates (the
 * host's contract with the webview), never the normalized string's.
 *
 * Returns `null` if even the loosest match fails — the caller drops the
 * suggestion rather than shipping a bogus position.
 */
function locateOriginal(
  paragraphText: string,
  original: string
): { start: number; end: number; matchedText: string } | null {
  const exact = paragraphText.indexOf(original);
  if (exact !== -1) {
    return { start: exact, end: exact + original.length, matchedText: original };
  }

  // Trimmed — the model wrapped the quote in stray whitespace.
  const trimmed = original.trim();
  if (trimmed && trimmed !== original) {
    const at = paragraphText.indexOf(trimmed);
    if (at !== -1) {
      return { start: at, end: at + trimmed.length, matchedText: trimmed };
    }
  }

  // Case-insensitive — the model re-capitalized the first word.
  const lowerAt = paragraphText.toLowerCase().indexOf(trimmed.toLowerCase());
  if (trimmed && lowerAt !== -1) {
    return {
      start: lowerAt,
      end: lowerAt + trimmed.length,
      matchedText: paragraphText.slice(lowerAt, lowerAt + trimmed.length),
    };
  }

  // Whitespace/punctuation-tolerant: build a regex from the quote where any
  // run of whitespace matches any run of whitespace, curly and straight
  // quotes/apostrophes are interchangeable, and a trailing sentence-ending
  // punctuation mark is optional. Escaping everything else keeps this a
  // literal match, not a user-controlled pattern.
  if (!trimmed) return null;
  const withoutTrailingPunct = trimmed.replace(/[.,;:!?]+$/, "");
  if (!withoutTrailingPunct) return null;
  const pattern = withoutTrailingPunct
    .split(/\s+/)
    .map((word) =>
      word
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/['‘’]/g, "['‘’]")
        .replace(/["“”]/g, '["“”]')
    )
    .join("\\s+");
  try {
    const re = new RegExp(pattern + "[.,;:!?]?", "i");
    const m = re.exec(paragraphText);
    if (m && m.index !== -1) {
      return {
        start: m.index,
        end: m.index + m[0].length,
        matchedText: m[0],
      };
    }
  } catch {
    /* malformed pattern — fall through to null */
  }
  return null;
}

/** Hard ceiling on how many separate model calls one AI Grammar run makes.
 * Each sentence is its own inference, so an unusually long paragraph could
 * otherwise spin for minutes. Anything past this is skipped and reported in
 * the output log — never silently dropped. */
const MAX_SENTENCES_PER_RUN = 25;

/**
 * Splits a paragraph into sentences, each with its exact start offset in the
 * original paragraph — those offsets are what let a suggestion found inside
 * one sentence be mapped back onto paragraph coordinates for the webview.
 *
 * Intentionally simple: split on sentence-ending punctuation, keeping any
 * trailing quote/bracket with the sentence it closes. It will over-split on
 * abbreviations ("Mr. Carl" becomes two fragments), which is acceptable here
 * — a fragment just becomes one more cheap check, and no offset is harmed.
 * Fragments with no letters (stray "...") are skipped as nothing to review.
 */
function splitSentences(text: string): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  const re = /[^.!?]*[.!?]+["'”’)\]]*\s*|[^.!?]+$/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // Zero-length match would spin forever; nudge past it.
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    const raw = m[0];
    const leading = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed.length >= 3 && /[A-Za-z]/.test(trimmed)) {
      out.push({ text: trimmed, start: m.index + leading });
    }
  }
  return out;
}

/** Single-sentence variant of the grammar instructions. A small model does
 * far better told "here is one sentence, what is wrong with it" than asked
 * to sweep a whole paragraph — the paragraph-wide version reliably skimmed
 * and reported nothing. Same two-step analysis-then-suggestions shape, same
 * worked examples, just scoped down. */
const DEFAULT_SENTENCE_GRAMMAR_INSTRUCTIONS =
  `You are a careful proofreader for fiction prose. You will be shown ONE sentence.\n\n` +
  `STEP 1 — write the "analysis" field. Read the sentence word by word and say, for each ` +
  `part of it, whether it makes sense. Pay special attention to whether every word is the ` +
  `word the author actually meant.\n\n` +
  `STEP 2 — write the "suggestions" array: one entry per problem (at most 3), or an empty ` +
  `array if the sentence is genuinely correct.\n\n` +
  `The problems to look for, most important first:\n` +
  `1. A WRONG WORD — a correctly-spelled word sitting where a different word belongs. Read ` +
  `for sense, not for spelling. Examples: "She new the answer" (should be "knew"); "They ` +
  `would of come" (should be "have"); "he went form there" (should be "from"); "I have not ` +
  `meant are do that" (should be "meant to do that").\n` +
  `2. A MISSING or DUPLICATED word. Examples: "He walked to the the door" (duplicated "the"); ` +
  `"She had nothing say" (missing "to").\n` +
  `3. Subject-verb agreement or verb tense mistakes.\n` +
  `4. Phrasing that is unclear or wordier than it needs to be.\n\n` +
  `Ignore misspelled non-words — a spellchecker already handles those.\n\n` +
  `For each entry in "suggestions":\n` +
  `- "original": copy the exact words from the sentence, character for character. Copy the ` +
  `SHORTEST span containing the problem — usually two to six words, never the whole sentence ` +
  `unless the whole sentence is the problem.\n` +
  `- "suggestion": those same words, corrected. It must differ from "original".\n` +
  `- "reason": a short explanation.\n` +
  `- "category": one of grammar, clarity, tone, wordiness.`;

function buildSentenceGrammarPrompt(
  sentence: string,
  voiceprint?: string,
  customInstructions?: string
): string {
  return composePrompt(
    customInstructions || DEFAULT_SENTENCE_GRAMMAR_INSTRUCTIONS,
    sentence,
    voiceprint
  );
}

function buildGrammarPrompt(
  text: string,
  voiceprint?: string,
  customInstructions?: string
): string {
  return composePrompt(
    customInstructions || DEFAULT_GRAMMAR_INSTRUCTIONS,
    text,
    voiceprint
  );
}

function buildEditorPrompt(
  text: string,
  voiceprint?: string,
  customInstructions?: string
): string {
  return composePrompt(
    customInstructions || DEFAULT_EDITOR_INSTRUCTIONS,
    text,
    voiceprint
  );
}

/**
 * One process-wide singleton (instantiated once in `activate()`, not
 * per-manuscript) that owns the local grammar/style model. Phase 3: real
 * node-llama-cpp integration, using the exact API confirmed by the Phase
 * 0.1/0.2 spikes. See the plan (`.spec` / tender-rolling-ullman.md) for the
 * full design and the packaging work (Phase 0.3) that ships node-llama-cpp's
 * native binaries alongside this bundle.
 */
export class AiAssist implements vscode.Disposable {
  private readonly _onDidChangeStatus = new vscode.EventEmitter<void>();
  readonly onDidChangeStatus = this._onDidChangeStatus.event;

  private _status: AiStatus = "disabled";
  get status(): AiStatus {
    return this._status;
  }

  /** Set once `ensureReady()` has kicked off loading, so repeat calls (from
   * both the tree-visibility hook and defensively from each review method)
   * are idempotent and don't restart the load. */
  private loadingPromise: Promise<void> | undefined;

  /**
   * Both review methods funnel through this queue — multiple EditorPanels
   * across manuscripts, and both buttons within one panel, could call in
   * around the same time; a small local model should not run overlapping
   * inferences. Chaining via `.then(runNext, runNext)` (both the success and
   * failure handler) matters: a bare `this.queue = this.queue.then(() =>
   * work())` is a real bug — once any queued task's promise rejects, every
   * subsequent `.then()` on that chain silently stops firing forever,
   * wedging all future reviews of either kind. Each queued task catches its
   * own errors internally (see `runQueued`), so in practice the queue's own
   * promise should never actually reject — the double-handler is defense in
   * depth against a bug in that internal catch, not the primary safety net.
   */
  private queue: Promise<void> = Promise.resolve();

  // node-llama-cpp handles, populated once `load()` reaches "ready".
  // Untyped (`any`) — see extension.ts / build-extension.js's comments on
  // why node-llama-cpp stays external rather than bundled/typed directly.
  private llamaCppModule: any;
  private llama: any;
  private model: any;
  // A fresh context+session is created per review call rather than reused
  // (see checkGrammar/reviewAsEditor) — a shared LlamaChatSession
  // accumulates prior turns as conversation history, which is wrong for
  // independent, unrelated paragraph reviews. Grammars are the one thing
  // safely cached: they depend only on the fixed JSON schema, not on the
  // conversation.
  private readonly grammarCache = new Map<"grammar" | "editor", any>();

  /** Everything users can see about what the model is actually doing —
   * which model loaded, download/load failures with the real error (not
   * just a swallowed "no issues found"), and on every AI Grammar/AI Editor
   * parse failure, the model's raw output. Surfaced via the
   * `flowManuscript.showAiOutput` command (see extension.ts) since
   * console.error alone only shows up in the Extension Host's Debug
   * Console, which most users never open — a silent parse failure and a
   * genuine "nothing to flag" result would otherwise look identical in the
   * UI (both just show an empty suggestion list). */
  private readonly output = vscode.window.createOutputChannel(
    "Flow Manuscript AI"
  );

  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration("flowManuscript.ai.enabled") ||
          e.affectsConfiguration("flowManuscript.ai.model") ||
          e.affectsConfiguration("flowManuscript.ai.customModelUrl") ||
          e.affectsConfiguration("flowManuscript.ai.customModelFilename")
        ) {
          this.handleConfigChange();
        }
      })
    );
  }

  private setStatus(status: AiStatus) {
    if (this._status === status) return;
    this._status = status;
    this._onDidChangeStatus.fire();
  }

  private isEnabled(): boolean {
    return vscode.workspace
      .getConfiguration("flowManuscript")
      .get<boolean>("ai.enabled", false);
  }

  showOutput() {
    this.output.show(true);
  }

  /**
   * A model or enabled-state setting changed. Tear down whatever's loaded
   * (a loaded `model`/`llama` handle and cached grammars are specific to
   * the model that was active when they were created) and immediately try
   * `ensureReady()` again — this is what makes a live Settings change take
   * effect right away instead of requiring the tree view to be closed and
   * reopened. If AI is now disabled, `ensureReady()` no-ops and the model
   * simply stays unloaded (freeing its memory), which is a bonus fix over
   * the previous behavior where turning the setting off never actually
   * unloaded an already-loaded model.
   */
  private async handleConfigChange() {
    this.teardownModel();
    this.grammarCache.clear();
    this.loadingPromise = undefined;
    this.setStatus("disabled");
    await this.ensureReady();
  }

  private teardownModel() {
    try {
      this.model?.dispose?.();
    } catch {
      /* ignore — best-effort, see dispose()'s comment */
    }
    try {
      this.llama?.dispose?.();
    } catch {
      /* ignore */
    }
    this.model = undefined;
    this.llama = undefined;
    this.llamaCppModule = undefined;
  }

  /**
   * Idempotent — safe to call repeatedly (tree-visibility hook fires every
   * time the view becomes visible again, and each review method also calls
   * this defensively in case the tree was never opened). No-ops if AI isn't
   * enabled, or if a load is already in flight / already finished.
   */
  async ensureReady(): Promise<void> {
    if (!this.isEnabled()) return;
    if (this._status === "ready" || this._status === "error") return;
    if (!this.loadingPromise) {
      this.loadingPromise = this.load();
    }
    return this.loadingPromise;
  }

  private async load(): Promise<void> {
    try {
      const modelPath = await this.ensureModelDownloaded();
      if (!modelPath) {
        // Cancelled by the user mid-download — ensureModelDownloaded()
        // already reset status to "disabled". Clear loadingPromise so a
        // future ensureReady() (e.g. reopening the tree) retries instead of
        // replaying this cancelled attempt's already-resolved promise.
        this.loadingPromise = undefined;
        return;
      }
      this.setStatus("loading");
      this.output.appendLine(`Loading model: ${modelPath}`);
      this.llamaCppModule = await import("node-llama-cpp");
      this.llama = await this.llamaCppModule.getLlama();
      this.model = await this.llama.loadModel({ modelPath });
      this.output.appendLine("Model loaded, status: ready");
      this.setStatus("ready");
    } catch (err) {
      console.error("flow-manuscript: AI model load failed", err);
      this.output.appendLine(
        `Model load failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`
      );
      this.setStatus("error");
    }
  }

  /**
   * Downloads the active model's GGUF (per `resolveModelConfig()`, which
   * reads `flowManuscript.ai.model` and the custom-model settings) into
   * `context.globalStorageUri` if it isn't already there, returning the
   * final local path — or `undefined` if the user cancelled. Written to a
   * `*.download` temp filename and renamed to the final name only on
   * confirmed completion, so an interrupted download never leaves a
   * truncated file that a later run mistakes for valid. Switching models
   * leaves any previously-downloaded GGUF on disk rather than deleting it —
   * switching back doesn't re-download, at the cost of using more disk over
   * time if you try several models.
   */
  private async ensureModelDownloaded(): Promise<string | undefined> {
    const { filename, url, approxBytes } = resolveModelConfig();
    const dir = this.context.globalStorageUri;
    await vscode.workspace.fs.createDirectory(dir);
    const finalPath = vscode.Uri.joinPath(dir, filename).fsPath;
    if (fs.existsSync(finalPath)) return finalPath;

    const tmpPath = finalPath + ".download";
    this.setStatus("downloading");

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Flow Manuscript: downloading AI model "${filename}" (one-time)`,
          cancellable: true,
        },
        async (progress, token) => {
          const controller = new AbortController();
          const cancelSub = token.onCancellationRequested(() =>
            controller.abort()
          );
          try {
            const res = await fetch(url, { signal: controller.signal });
            if (!res.ok || !res.body) {
              throw new Error(`Model download failed: HTTP ${res.status}`);
            }
            const total =
              Number(res.headers.get("content-length")) || approxBytes;
            let downloaded = 0;
            let lastPct = 0;
            const nodeStream = Readable.fromWeb(res.body as any);
            nodeStream.on("data", (chunk: Buffer) => {
              downloaded += chunk.length;
              const pct = Math.min(100, Math.floor((downloaded / total) * 100));
              if (pct > lastPct) {
                progress.report({ increment: pct - lastPct, message: `${pct}%` });
                lastPct = pct;
              }
            });
            await pipeline(nodeStream, fs.createWriteStream(tmpPath));
            await fs.promises.rename(tmpPath, finalPath);
          } catch (err) {
            await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
            throw err;
          } finally {
            cancelSub.dispose();
          }
        }
      );
    } catch (err: any) {
      if (err?.name === "AbortError") {
        this.setStatus("disabled");
        return undefined;
      }
      throw err;
    }
    return finalPath;
  }

  /** Chains `work` onto the queue; always resolves so the chain never wedges
   * (see the `queue` field doc comment). Errors from `work` are caught here
   * and rethrown to the *caller* of `runQueued`, not left to propagate into
   * the chain itself. */
  private runQueued<T>(work: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      try {
        return await work();
      } catch (err) {
        console.error("flow-manuscript: AI review task failed", err);
        throw err;
      }
    };
    const resultPromise = this.queue.then(run, run);
    // Keep the queue itself always-resolving regardless of whether `work`
    // (or the previous task) threw — a bare `.then(next)` would wedge every
    // future task once any one of them rejects.
    this.queue = resultPromise.then(
      () => undefined,
      () => undefined
    );
    return resultPromise;
  }

  private async getGrammar(kind: "grammar" | "editor"): Promise<any> {
    const cached = this.grammarCache.get(kind);
    if (cached) return cached;
    const schema = kind === "grammar" ? GRAMMAR_SCHEMA : EDITOR_SCHEMA;
    const grammar = await this.llama.createGrammarForJsonSchema(schema);
    this.grammarCache.set(kind, grammar);
    return grammar;
  }

  /** Reads `flowManuscript.ai.grammarPrompt`/`ai.editorPrompt` — an empty or
   * whitespace-only value (the default) means "use the built-in prompt";
   * `buildGrammarPrompt`/`buildEditorPrompt` treat `undefined` the same way
   * via `||`. */
  private getCustomPrompt(kind: "grammar" | "editor"): string | undefined {
    const key = kind === "grammar" ? "ai.grammarPrompt" : "ai.editorPrompt";
    const value = vscode.workspace
      .getConfiguration("flowManuscript")
      .get<string>(key, "")
      .trim();
    return value || undefined;
  }

  /**
   * Whether to include the voiceprint in AI Grammar's prompt. Defaults to
   * FALSE, unlike AI Editor which always gets it.
   *
   * Rationale (from a real failure, 2026-08-25): a voiceprint is typically
   * written as imperative craft rules ("Never use the dash. At all."). A
   * 1.5B model given that alongside a paragraph reviewed the *style guide*
   * and returned five suggestions quoting it, none from the prose — AI
   * Grammar produced nothing usable at all. Grammar checking is mechanical
   * (agreement, wrong words, missing words); it barely benefits from voice
   * guidance, while AI Editor's craft notes genuinely do. So the default
   * trades a marginal benefit for a feature that actually works, and the
   * setting is there for anyone on a larger model that can keep the two
   * blocks straight.
   */
  private useVoiceprintForGrammar(): boolean {
    return vscode.workspace
      .getConfiguration("flowManuscript")
      .get<boolean>("ai.useVoiceprintForGrammar", false);
  }

  /**
   * Whether AI Grammar reviews one sentence per model call (the default)
   * rather than the whole paragraph in a single call.
   *
   * Per-sentence is the default because whole-paragraph review failed in
   * practice (2026-08-25): asked to sweep a ~160-word paragraph, the model
   * skimmed, wrote generic boilerplate into its analysis field, and declared
   * a paragraph containing "He had not meant are take it" free of errors.
   * Narrowing each call to a single sentence makes it a far easier task. The
   * cost is one inference per sentence, so a review takes proportionally
   * longer — turn this off to trade accuracy back for speed.
   */
  private grammarPerSentence(): boolean {
    return vscode.workspace
      .getConfiguration("flowManuscript")
      .get<boolean>("ai.grammarPerSentence", true);
  }

  /**
   * Review the current paragraph for grammar/clarity/tone/wordiness issues.
   * `voiceprint`, if given, is prepended as style context (see
   * editorPanel.ts's resolution order: per-manuscript `.claude/voiceprint.md`
   * overrides the global `flowManuscript.ai.voiceprintPath` setting).
   *
   * The model is never trusted with character offsets — small instruct
   * models are unreliable at emitting correct integer positions even under
   * grammar-constrained decoding (the grammar enforces JSON syntax, not
   * correct content). Instead each suggestion's exact-quote `original` is
   * located in `paragraphText` via `indexOf`; a suggestion that doesn't
   * appear verbatim (the model paraphrased instead of quoting) is dropped
   * rather than shipped with a bogus position.
   */
  async checkGrammar(
    paragraphText: string,
    voiceprint?: string
  ): Promise<AiResolvedSuggestion[]> {
    await this.ensureReady();
    return this.runQueued(async () => {
      if (this._status !== "ready" || !this.model || !this.llama) return [];
      // See useVoiceprintForGrammar()'s doc comment — off by default because
      // an imperative style guide reliably derails a small model's
      // proofreading. `effectiveVoiceprint` (not the raw argument) is what
      // the prompt works from; the raw one is still used to detect the
      // "model quoted the style guide" failure when it IS enabled.
      const effectiveVoiceprint = this.useVoiceprintForGrammar()
        ? voiceprint
        : undefined;
      const perSentence = this.grammarPerSentence();

      // Each unit is reviewed by its own model call. In per-sentence mode
      // that's one call per sentence, with `start` recording where the
      // sentence begins inside the paragraph so offsets can be mapped back;
      // in whole-paragraph mode it's a single unit at offset 0.
      let units = perSentence
        ? splitSentences(paragraphText)
        : [{ text: paragraphText, start: 0 }];
      if (units.length > MAX_SENTENCES_PER_RUN) {
        this.output.appendLine(
          `[AI Grammar] paragraph has ${units.length} sentences; reviewing only ` +
            `the first ${MAX_SENTENCES_PER_RUN} (flowManuscript.ai.grammarPerSentence ` +
            `runs one model call per sentence). The rest were NOT checked.`
        );
        units = units.slice(0, MAX_SENTENCES_PER_RUN);
      }

      this.output.appendLine(
        `[AI Grammar] reviewing ${units.length} ${
          perSentence ? "sentence(s), one model call each" : "paragraph (single call)"
        }. voiceprint: ${
          voiceprint === undefined
            ? "none found"
            : effectiveVoiceprint
            ? `included (${voiceprint.length} chars)`
            : "found but EXCLUDED from this prompt " +
              "(flowManuscript.ai.useVoiceprintForGrammar is off)"
        }.`
      );

      const resolved: AiResolvedSuggestion[] = [];
      // Guards against the same span being decorated twice — possible when
      // an over-split fragment overlaps its neighbour, or when the model
      // reports one problem under two categories.
      const claimedSpans = new Set<string>();
      let totalRaw = 0;

      for (let i = 0; i < units.length; i++) {
        const unit = units[i];
        const label = perSentence
          ? `[sentence ${i + 1}/${units.length}]`
          : `[paragraph]`;
        const rawSuggestions = await this.runGrammarPass(
          unit.text,
          effectiveVoiceprint,
          perSentence,
          label
        );
        totalRaw += rawSuggestions.length;

        for (const s of rawSuggestions) {
          if (!s || typeof s.original !== "string" || !s.original) {
            this.output.appendLine(
              `  ${label} dropped (no usable "original" field): ${JSON.stringify(s)}`
            );
            continue;
          }
          const suggestionText =
            typeof s.suggestion === "string" ? s.suggestion : "";
          // Locate BEFORE the no-op check. Order matters for diagnosis: when
          // the model reviewed the wrong text entirely (quoting the style
          // guide instead of the prose — a real failure seen 2026-08-25), it
          // also emits suggestion == original, so a no-op-first ordering
          // reported those as "no-op" and hid the actual cause.
          //
          // The search is scoped to THIS unit's text, then the resulting
          // offsets are shifted by `unit.start` so they address the whole
          // paragraph — which is the coordinate space the webview expects.
          const located = locateOriginal(unit.text, s.original);
          if (!located) {
            const fromVoiceprint =
              voiceprint !== undefined &&
              locateOriginal(voiceprint, s.original) !== null;
            this.output.appendLine(
              fromVoiceprint
                ? `  ${label} dropped (model quoted the STYLE GUIDE, not the text ` +
                    `under review): ${JSON.stringify(s.original)}`
                : `  ${label} dropped (quote not found in the text it was given — ` +
                    `model paraphrased instead of quoting): ${JSON.stringify(s.original)}`
            );
            continue;
          }
          // Backstop for the "this sentence is fine" no-op the prompt asks
          // the model not to produce: if the model didn't actually propose a
          // change there's nothing to act on, so don't render a decoration.
          if (suggestionText.trim() === s.original.trim()) {
            this.output.appendLine(
              `  ${label} dropped (no-op: suggestion identical to original): ` +
                `${JSON.stringify(s.original)}`
            );
            continue;
          }
          const start = unit.start + located.start;
          const end = unit.start + located.end;
          const spanKey = `${start}:${end}`;
          if (claimedSpans.has(spanKey)) {
            this.output.appendLine(
              `  ${label} dropped (duplicate of a span already suggested): ` +
                `${JSON.stringify(located.matchedText)}`
            );
            continue;
          }
          claimedSpans.add(spanKey);
          if (located.matchedText !== s.original) {
            this.output.appendLine(
              `  ${label} fuzzy-matched ${JSON.stringify(s.original)} -> ` +
                `${JSON.stringify(located.matchedText)}`
            );
          }
          this.output.appendLine(
            `  ${label} KEPT ${JSON.stringify(located.matchedText)} -> ` +
              `${JSON.stringify(suggestionText)}`
          );
          resolved.push({
            // Ship the text as it actually appears in the paragraph, not as
            // the model quoted it — the webview re-verifies the span against
            // the live document and would drop a mismatch.
            original: located.matchedText,
            suggestion: suggestionText,
            reason: typeof s.reason === "string" ? s.reason : "",
            category: isSuggestionCategory(s.category) ? s.category : "clarity",
            start,
            end,
          });
        }
      }

      this.output.appendLine(
        `[AI Grammar] ${resolved.length} of ${totalRaw} raw suggestion(s) survived ` +
          `filtering and were sent to the editor.` +
          (resolved.length === 0 && totalRaw > 0
            ? ` (Nothing will highlight — see the per-suggestion reasons above.)`
            : "")
      );
      return resolved;
    });
  }

  /**
   * One model call over one chunk of text (a single sentence in per-sentence
   * mode, the whole paragraph otherwise), returning the raw, still-unresolved
   * suggestion objects the model emitted.
   *
   * Errors are contained here rather than aborting the whole run: in
   * per-sentence mode a single sentence that produces unparseable JSON should
   * cost that one sentence, not every other sentence's results. The failure is
   * logged with the raw output so it stays distinguishable from a genuine
   * "nothing wrong here".
   */
  private async runGrammarPass(
    text: string,
    effectiveVoiceprint: string | undefined,
    perSentence: boolean,
    label: string
  ): Promise<any[]> {
    let raw: string | undefined;
    let context: any;
    try {
      const grammar = await this.getGrammar("grammar");
      context = await this.model.createContext();
      const session = new this.llamaCppModule.LlamaChatSession({
        contextSequence: context.getSequence(),
      });
      const custom = this.getCustomPrompt("grammar");
      raw = await session.prompt(
        perSentence
          ? buildSentenceGrammarPrompt(text, effectiveVoiceprint, custom)
          : buildGrammarPrompt(text, effectiveVoiceprint, custom),
        // The `analysis` scratchpad precedes the suggestions array, so the
        // budget has to cover the model's reasoning as well as the output.
        // Truncating mid-object yields invalid JSON and a silently empty
        // result. A single sentence needs far less room than a paragraph.
        { grammar, maxTokens: perSentence ? 768 : 2048 }
      );
      // `raw` is assigned from an `any`-typed call (session.prompt(), on the
      // untyped node-llama-cpp session — see the class doc comment), so TS's
      // control-flow narrowing falls back to the declared `string |
      // undefined`; the assertion is safe because the assignment above always
      // runs first within this try.
      const parsed = JSON.parse(raw as string);
      if (typeof parsed?.analysis === "string" && parsed.analysis.trim()) {
        this.output.appendLine(
          `  ${label} analysis: ${parsed.analysis.trim()}`
        );
      }
      return Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];
    } catch (err) {
      // Degrades to an empty result for this chunk, never an "error" status —
      // that's reserved for model load/download failure, so one bad
      // generation doesn't disable every open panel's buttons.
      console.error("flow-manuscript: AI Grammar pass failed", err);
      this.output.appendLine(
        `  ${label} FAILED: ${err instanceof Error ? err.message : String(err)}` +
          (raw !== undefined ? `\n    raw model output: ${raw}` : "")
      );
      return [];
    } finally {
      // Each pass gets a fresh context (a reused LlamaChatSession would carry
      // the previous sentence forward as conversation history). Releasing it
      // matters more now that one run can create dozens.
      try {
        context?.dispose?.();
      } catch {
        /* best-effort — see dispose()'s comment on node-llama-cpp's surface */
      }
    }
  }

  /** Review the current paragraph for developmental-craft notes (pacing,
   * showing vs. telling, sensory detail, tension, POV) — read-only, no
   * positions to resolve. See `checkGrammar`'s doc comment for the
   * voiceprint and error-handling behavior, which this mirrors. */
  async reviewAsEditor(
    paragraphText: string,
    voiceprint?: string
  ): Promise<AiEditorNote[]> {
    await this.ensureReady();
    return this.runQueued(async () => {
      if (this._status !== "ready" || !this.model || !this.llama) return [];
      let raw: string | undefined;
      try {
        const grammar = await this.getGrammar("editor");
        const context = await this.model.createContext();
        const session = new this.llamaCppModule.LlamaChatSession({
          contextSequence: context.getSequence(),
        });
        raw = await session.prompt(
          buildEditorPrompt(
            paragraphText,
            voiceprint,
            this.getCustomPrompt("editor")
          ),
          { grammar, maxTokens: 1024 }
        );
        // See the matching comment in checkGrammar() above — same
        // TS-narrowing quirk, same reasoning for why the assertion is safe.
        const parsed = JSON.parse(raw as string);
        const rawNotes: any[] = Array.isArray(parsed?.notes)
          ? parsed.notes
          : [];
        const notes: AiEditorNote[] = [];
        for (const n of rawNotes) {
          if (!n || typeof n.note !== "string" || !n.note) continue;
          notes.push({
            note: n.note,
            category: isNoteCategory(n.category) ? n.category : "other",
            quote:
              typeof n.quote === "string" && n.quote ? n.quote : undefined,
            // Default to "improvement" (not "strength") when the model's tag
            // is missing/invalid — the safer failure mode is surfacing a note
            // under "needs improvement" than silently burying it in praise.
            sentiment: isNoteSentiment(n.sentiment) ? n.sentiment : "improvement",
          });
        }
        return notes;
      } catch (err) {
        console.error("flow-manuscript: AI Editor review failed", err);
        this.output.appendLine(
          `[AI Editor] failed: ${err instanceof Error ? err.message : String(err)}` +
            (raw !== undefined ? `\nraw model output: ${raw}` : "")
        );
        return [];
      }
    });
  }

  dispose() {
    this._onDidChangeStatus.dispose();
    this.output.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.teardownModel();
  }
}
