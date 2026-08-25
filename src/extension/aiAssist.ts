import * as vscode from "vscode";
import * as fs from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import type {
  AiEditorNote,
  AiResolvedSuggestion,
  AiStatus,
} from "../shared/types";

// Qwen2.5-1.5B-Instruct, Q4_K_M GGUF — chosen concretely over e.g. Llama-3.2
// because it's Apache-2.0 with no gated-repo click-through license, which
// matters for an unattended first-run download (a Llama-3.2 GGUF sits behind
// an authenticated HF token). Confirmed as the exact repo/filename the user's
// own Phase 0 spike downloaded and ran successfully (2026-08-25). ~1.1 GB.
const MODEL_FILENAME = "qwen2.5-1.5b-instruct-q4_k_m.gguf";
const MODEL_URL =
  "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf";
// Fallback only for the progress bar's percentage math, if HF ever serves a
// response without a Content-Length header — the real size always wins.
const MODEL_APPROX_BYTES = 1_120_000_000;

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
const GRAMMAR_SCHEMA = {
  type: "object",
  properties: {
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
  required: ["suggestions"],
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

function buildGrammarPrompt(text: string, voiceprint?: string): string {
  const voiceprintBlock = voiceprint
    ? `The author's style guide follows — weigh suggestions against it:\n"""${voiceprint}"""\n\n`
    : "";
  return (
    `You are a careful proofreader for fiction prose. Read the paragraph below one sentence at ` +
    `a time and check each sentence against this list:\n` +
    `- Subject-verb agreement and verb tense mistakes.\n` +
    `- A WRONG-WORD error: a real, correctly-spelled word used where a different word belongs ` +
    `— e.g. "meat" instead of "meant", "their" instead of "there", "form" instead of "from". ` +
    `This is a grammar issue, not spelling, even though the word by itself is spelled correctly ` +
    `— do not skip these.\n` +
    `- Missing or duplicated words, and dangling/incomplete clauses.\n` +
    `- Unclear or unnecessarily wordy phrasing.\n` +
    `- Tone that clashes with the surrounding prose.\n` +
    `Never flag a misspelled/non-word typo — a separate spellchecker already covers those.\n\n` +
    `List up to 5 real issues you find, one entry per issue. ONLY include an entry where ` +
    `"suggestion" is actually different from "original" — never include an entry to say a ` +
    `sentence is already correct. Return an empty list only if you have checked every sentence ` +
    `against the list above and genuinely found nothing — do not default to an empty list just ` +
    `because you're unsure; a plausible guess at a real issue is more useful than silence. Each ` +
    `"original" must be an EXACT substring quoted verbatim from the paragraph (never a ` +
    `paraphrase) so it can be located and replaced automatically.\n\n` +
    `${voiceprintBlock}Paragraph:\n"""${text}"""`
  );
}

function buildEditorPrompt(text: string, voiceprint?: string): string {
  const voiceprintBlock = voiceprint
    ? `The author's style guide follows — weigh your notes against it:\n"""${voiceprint}"""\n\n`
    : "";
  return (
    `You are a developmental fiction editor. For the paragraph below, give up to 4 short notes ` +
    `on craft — pacing, showing vs. telling, sensory detail, tension, POV consistency — never ` +
    `grammar or spelling. If there's nothing worth noting, return an empty list. Each note should ` +
    `be one or two sentences, specific to this paragraph, not generic writing advice. Tag every ` +
    `note's "sentiment" as "strength" if it calls out something that's genuinely working well, or ` +
    `"improvement" if it's something the author should consider changing — never use "strength" ` +
    `just to soften an improvement note; most notes on a working paragraph should be "improvement" ` +
    `unless something truly stands out as praiseworthy.\n\n` +
    `${voiceprintBlock}Paragraph:\n"""${text}"""`
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

  constructor(private readonly context: vscode.ExtensionContext) {}

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
      this.llamaCppModule = await import("node-llama-cpp");
      this.llama = await this.llamaCppModule.getLlama();
      this.model = await this.llama.loadModel({ modelPath });
      this.setStatus("ready");
    } catch (err) {
      console.error("flow-manuscript: AI model load failed", err);
      this.setStatus("error");
    }
  }

  /**
   * Downloads the GGUF into `context.globalStorageUri` if it isn't already
   * there, returning the final local path — or `undefined` if the user
   * cancelled. Written to a `*.download` temp filename and renamed to the
   * final name only on confirmed completion, so an interrupted download
   * never leaves a truncated file that a later run mistakes for valid.
   */
  private async ensureModelDownloaded(): Promise<string | undefined> {
    const dir = this.context.globalStorageUri;
    await vscode.workspace.fs.createDirectory(dir);
    const finalPath = vscode.Uri.joinPath(dir, MODEL_FILENAME).fsPath;
    if (fs.existsSync(finalPath)) return finalPath;

    const tmpPath = finalPath + ".download";
    this.setStatus("downloading");

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Flow Manuscript: downloading AI model (~1 GB, one-time)",
          cancellable: true,
        },
        async (progress, token) => {
          const controller = new AbortController();
          const cancelSub = token.onCancellationRequested(() =>
            controller.abort()
          );
          try {
            const res = await fetch(MODEL_URL, { signal: controller.signal });
            if (!res.ok || !res.body) {
              throw new Error(`Model download failed: HTTP ${res.status}`);
            }
            const total =
              Number(res.headers.get("content-length")) || MODEL_APPROX_BYTES;
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
      try {
        const grammar = await this.getGrammar("grammar");
        const context = await this.model.createContext();
        const session = new this.llamaCppModule.LlamaChatSession({
          contextSequence: context.getSequence(),
        });
        const raw = await session.prompt(
          buildGrammarPrompt(paragraphText, voiceprint),
          // Generous budget so the JSON object doesn't truncate mid-way.
          { grammar, maxTokens: 1024 }
        );
        const parsed = JSON.parse(raw);
        const rawSuggestions: any[] = Array.isArray(parsed?.suggestions)
          ? parsed.suggestions
          : [];
        const resolved: AiResolvedSuggestion[] = [];
        for (const s of rawSuggestions) {
          if (!s || typeof s.original !== "string" || !s.original) continue;
          const suggestionText =
            typeof s.suggestion === "string" ? s.suggestion : "";
          // Backstop for the "this sentence is fine" no-op the prompt asks
          // the model not to produce: if the model didn't actually propose
          // a change, there's nothing for the user to act on — drop it
          // rather than showing a decoration/popover with no real edit.
          if (suggestionText.trim() === s.original.trim()) continue;
          const start = paragraphText.indexOf(s.original);
          if (start === -1) continue;
          resolved.push({
            original: s.original,
            suggestion: suggestionText,
            reason: typeof s.reason === "string" ? s.reason : "",
            category: isSuggestionCategory(s.category)
              ? s.category
              : "clarity",
            start,
            end: start + s.original.length,
          });
        }
        return resolved;
      } catch (err) {
        // A bad/truncated JSON parse (or any other generation-time hiccup)
        // on one review degrades to an empty result, not an "error" status
        // — that status is reserved for model load/download failure, so one
        // bad generation doesn't disable every open panel's buttons.
        console.error("flow-manuscript: AI Grammar check failed", err);
        return [];
      }
    });
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
      try {
        const grammar = await this.getGrammar("editor");
        const context = await this.model.createContext();
        const session = new this.llamaCppModule.LlamaChatSession({
          contextSequence: context.getSequence(),
        });
        const raw = await session.prompt(
          buildEditorPrompt(paragraphText, voiceprint),
          { grammar, maxTokens: 1024 }
        );
        const parsed = JSON.parse(raw);
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
        return [];
      }
    });
  }

  dispose() {
    this._onDidChangeStatus.dispose();
    // Best-effort — node-llama-cpp's dispose surface wasn't exercised by the
    // Phase 0 spikes, so guard defensively rather than assume the exact
    // method names.
    try {
      this.model?.dispose?.();
    } catch {
      /* ignore */
    }
    try {
      this.llama?.dispose?.();
    } catch {
      /* ignore */
    }
  }
}
