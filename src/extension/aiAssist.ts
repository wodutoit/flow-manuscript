import * as vscode from "vscode";
import type {
  AiEditorNote,
  AiResolvedSuggestion,
  AiStatus,
} from "../shared/types";

/**
 * One process-wide singleton (instantiated once in `activate()`, not
 * per-manuscript) that owns the local grammar/style model. Phase 1: stub
 * internals only — fixed delay, one canned suggestion / one canned note,
 * timer-driven status cycling — so Phase 2's webview UI can be built and
 * demoed without depending on Phase 3's real node-llama-cpp integration.
 * See the plan (`.spec` / tender-rolling-ullman.md) for the full design.
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

  /**
   * STUB (Phase 1): cycles disabled -> downloading -> loading -> ready with
   * fixed delays, so the webview status pill has something real to react to.
   * Phase 3 replaces this body with the actual node-llama-cpp
   * download-if-needed-then-load sequence; the public shape (this method,
   * called only from `ensureReady()`) does not change.
   */
  private async load(): Promise<void> {
    try {
      this.setStatus("downloading");
      await delay(400);
      this.setStatus("loading");
      await delay(400);
      this.setStatus("ready");
    } catch (err) {
      console.error("flow-manuscript: AI model load failed", err);
      this.setStatus("error");
    }
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

  /**
   * STUB (Phase 1): returns one canned suggestion, with a real `indexOf`-
   * resolved span — mirrors the drop-if-not-found pattern Phase 3's real
   * model output will also need (a suggestion whose `original` doesn't
   * appear verbatim in `paragraphText` is dropped rather than shipped with a
   * bogus position).
   */
  async checkGrammar(paragraphText: string): Promise<AiResolvedSuggestion[]> {
    await this.ensureReady();
    return this.runQueued(async () => {
      await delay(500);
      const words = paragraphText.trim().split(/\s+/);
      if (words.length === 0 || !words[0]) return [];
      const original = words[0];
      const start = paragraphText.indexOf(original);
      if (start === -1) return [];
      const suggestion: AiResolvedSuggestion = {
        original,
        suggestion: original,
        reason: "Stub suggestion — Phase 1 placeholder, no real model yet.",
        category: "clarity",
        start,
        end: start + original.length,
      };
      return [suggestion];
    });
  }

  /** STUB (Phase 1): returns one canned note. */
  async reviewAsEditor(paragraphText: string): Promise<AiEditorNote[]> {
    await this.ensureReady();
    return this.runQueued(async () => {
      await delay(500);
      const quote = paragraphText.trim().slice(0, 60) || undefined;
      const note: AiEditorNote = {
        note: "Stub note — Phase 1 placeholder, no real model yet.",
        category: "other",
        quote,
      };
      return [note];
    });
  }

  dispose() {
    this._onDidChangeStatus.dispose();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
