import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { AiSuggestion, AiResolvedSuggestion } from "../../src/shared/types";

export const aiSuggestKey = new PluginKey("flowAiSuggest");

/**
 * One AI Grammar suggestion with its doc-absolute span already resolved.
 * The host sends `AiResolvedSuggestion` with `start`/`end` relative to the
 * paragraph text it reviewed (see shared/types.ts); App.tsx converts those
 * to absolute doc positions (`from + start` / `from + end`, using the same
 * `from` it sent in `requestAiReview`) and re-verifies the span still holds
 * the expected text before ever constructing one of these — this plugin
 * itself does no offset math, it just renders whatever it's given.
 */
export interface AiSuggestionDeco {
  docFrom: number;
  docTo: number;
  suggestion: AiResolvedSuggestion;
}

function buildDecorations(doc: any, items: AiSuggestionDeco[]): DecorationSet {
  const decos = items.map((item) =>
    Decoration.inline(item.docFrom, item.docTo, {
      class: "ai-suggest-error",
      "data-ai-original": item.suggestion.original,
      "data-ai-suggestion": item.suggestion.suggestion,
      "data-ai-reason": item.suggestion.reason,
      "data-ai-category": item.suggestion.category,
    })
  );
  return DecorationSet.create(doc, decos);
}

/**
 * ProseMirror plugin rendering AI Grammar decorations. Unlike spellcheck,
 * there is no debounce timer here — checks are manual (a toolbar button
 * click, current-paragraph scope only), so decorations are set exactly once
 * per check result via `setMeta(aiSuggestKey, items)`, and App.tsx also uses
 * that same meta (with a filtered array) to remove a single dismissed/
 * accepted suggestion without touching the others.
 *
 * On any other document change (typing, an edit from Accept, etc.) the
 * whole set is cleared rather than remapped through the change: a
 * suggestion's span was computed against a specific snapshot of the
 * paragraph text, and silently remapping it forward risks it drifting onto
 * the wrong words. A fresh check is required after any edit, same as the
 * staleness guard already applied when a check's results first arrive.
 */
export function createAiSuggestPlugin() {
  const plugin = new Plugin({
    key: aiSuggestKey,
    state: {
      init() {
        return DecorationSet.empty;
      },
      apply(tr, old) {
        const meta = tr.getMeta(aiSuggestKey);
        if (meta) {
          return buildDecorations(tr.doc, meta as AiSuggestionDeco[]);
        }
        if (tr.docChanged) {
          return DecorationSet.empty;
        }
        return old;
      },
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
    },
  });
  return plugin;
}

/** Dispatch a fresh (or filtered) set of AI Grammar decorations. */
export function setAiDecorations(view: any, items: AiSuggestionDeco[]) {
  view.dispatch(view.state.tr.setMeta(aiSuggestKey, items));
}

/**
 * Given a DOM click target, find the AI Grammar suggestion span under it, if
 * any — mirrors `misspelledWordAt` in spellcheckPlugin.ts, but reads the
 * suggestion back off the decoration's own data attributes instead of a
 * side-table, since there's no separate "checker" object to consult here.
 */
export function aiSuggestionAt(
  view: EditorView,
  target: EventTarget | null
): { suggestion: AiSuggestion; from: number; to: number } | null {
  let el = target as HTMLElement | null;
  while (el && el.nodeType === 1) {
    if (el.classList?.contains("ai-suggest-error")) {
      const original = el.getAttribute("data-ai-original");
      const suggestion = el.getAttribute("data-ai-suggestion");
      const reason = el.getAttribute("data-ai-reason");
      const category = el.getAttribute("data-ai-category");
      if (original && suggestion != null && reason != null && category) {
        const from = view.posAtDOM(el, 0);
        const to = from + original.length;
        return {
          from,
          to,
          suggestion: {
            original,
            suggestion,
            reason,
            category: category as AiSuggestion["category"],
          },
        };
      }
    }
    el = el.parentElement;
  }
  return null;
}

/**
 * Find the paragraph the cursor is currently in. `$from.start()` (not
 * `blockRange`) is the correct anchor so `docPos = from + charOffset` lines
 * up with what the host computes against the same paragraph text. Returns
 * null when the cursor isn't inside a plain paragraph (headings, code
 * blocks, etc.) — both AI Grammar and AI Editor no-op in that case rather
 * than reviewing something that isn't prose.
 */
export function findCurrentParagraph(
  state: EditorState
): { text: string; from: number } | null {
  const { $from } = state.selection;
  if ($from.parent.type.name !== "paragraph") return null;
  const text = $from.parent.textContent;
  if (!text.trim()) return null;
  return { text, from: $from.start() };
}
