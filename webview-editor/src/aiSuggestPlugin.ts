import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { AiSuggestion, AiResolvedSuggestion } from "../../src/shared/types";

export const aiSuggestKey = new PluginKey<AiSuggestState>("flowAiSuggest");

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
  const decos = items.map((item, i) =>
    Decoration.inline(item.docFrom, item.docTo, {
      class: "ai-suggest-error",
      // Index into the same `items` array App.tsx holds in React state. This
      // is what lets a click resolve back to the ORIGINAL, already-verified
      // docFrom/docTo instead of re-deriving a span from the DOM — see
      // aiSuggestionAt()'s comment for why that distinction matters.
      "data-ai-index": String(i),
      "data-ai-original": item.suggestion.original,
      "data-ai-suggestion": item.suggestion.suggestion,
      "data-ai-reason": item.suggestion.reason,
      "data-ai-category": item.suggestion.category,
    })
  );
  return DecorationSet.create(doc, decos);
}

/** The plugin's state: the items themselves alongside the rendered
 * decorations. The items have to be kept (rather than only the
 * DecorationSet) so they can be re-anchored across a document change and
 * handed back to App.tsx afterwards — see `remapItems`. */
interface AiSuggestState {
  items: AiSuggestionDeco[];
  set: DecorationSet;
}

/**
 * Re-anchor every suggestion across a document change, dropping any that no
 * longer clearly refer to the same words.
 *
 * This is what lets you accept one suggestion and keep the rest. Accepting a
 * fix almost always changes the paragraph's length ("meant are take" ->
 * "meant to take"), which shifts every later suggestion's position; before
 * this, the plugin dodged the problem by discarding the whole set on any
 * edit, so accepting one suggestion silently threw away the others.
 *
 * Two safeguards keep a remapped span honest:
 *  1. Positions go through `tr.mapping`, ProseMirror's own record of how the
 *     change moved every position. `from` associates forward and `to`
 *     backward, so a span whose contents were entirely replaced collapses
 *     rather than clinging to the new text — which is exactly how the
 *     just-accepted suggestion removes itself, with no special case.
 *  2. The remapped range is re-read from the new document and must still
 *     equal the suggestion's `original` text. Anything else — the user typed
 *     inside the span, an edit straddled its boundary, the mapping produced
 *     something unexpected — fails this check and the suggestion is dropped.
 *
 * So a surviving decoration is guaranteed to still cover exactly the text it
 * was computed against; it can never drift onto the wrong words.
 */
function remapItems(tr: any, items: AiSuggestionDeco[]): AiSuggestionDeco[] {
  const out: AiSuggestionDeco[] = [];
  for (const item of items) {
    const from = tr.mapping.map(item.docFrom, 1);
    const to = tr.mapping.map(item.docTo, -1);
    if (to <= from) continue; // collapsed — its text was replaced or deleted
    let current: string;
    try {
      current = tr.doc.textBetween(from, to);
    } catch {
      continue; // range no longer addressable in the new doc
    }
    if (current !== item.suggestion.original) continue;
    out.push({ ...item, docFrom: from, docTo: to });
  }
  return out;
}

/**
 * ProseMirror plugin rendering AI Grammar decorations. Unlike spellcheck,
 * there is no debounce timer here — checks are manual (a toolbar button
 * click, current-paragraph scope only), so decorations are set once per
 * check result via `setMeta(aiSuggestKey, items)`, and App.tsx uses that
 * same meta (with a filtered array) to remove a single dismissed suggestion
 * without touching the others.
 *
 * On a document change the surviving suggestions are re-anchored rather than
 * discarded — see `remapItems` for the guarantees that makes safe.
 */
export function createAiSuggestPlugin() {
  const plugin = new Plugin<AiSuggestState>({
    key: aiSuggestKey,
    state: {
      init() {
        return { items: [], set: DecorationSet.empty };
      },
      apply(tr, old) {
        const meta = tr.getMeta(aiSuggestKey);
        if (meta) {
          const items = meta as AiSuggestionDeco[];
          return { items, set: buildDecorations(tr.doc, items) };
        }
        if (tr.docChanged) {
          if (old.items.length === 0) {
            return { items: [], set: DecorationSet.empty };
          }
          const items = remapItems(tr, old.items);
          return { items, set: buildDecorations(tr.doc, items) };
        }
        return old;
      },
    },
    props: {
      decorations(state) {
        return aiSuggestKey.getState(state)?.set ?? DecorationSet.empty;
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
 * The suggestions currently anchored in the document, after any remapping.
 * App.tsx mirrors this into React state so its own array stays index-aligned
 * with the rendered decorations (a click resolves via `data-ai-index`).
 */
export function getAiItems(state: EditorState): AiSuggestionDeco[] {
  return aiSuggestKey.getState(state)?.items ?? [];
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
): {
  index: number;
  suggestion: AiSuggestion;
  from: number;
  to: number;
} | null {
  let el = target as HTMLElement | null;
  while (el && el.nodeType === 1) {
    if (el.classList?.contains("ai-suggest-error")) {
      const original = el.getAttribute("data-ai-original");
      const suggestion = el.getAttribute("data-ai-suggestion");
      const reason = el.getAttribute("data-ai-reason");
      const category = el.getAttribute("data-ai-category");
      const rawIndex = el.getAttribute("data-ai-index");
      if (original && suggestion != null && reason != null && category) {
        // `from`/`to` here are a DOM-derived FALLBACK only. posAtDOM(el, 0)
        // plus `original.length` is character arithmetic layered on top of a
        // DOM->doc position lookup, and it can land off by a position when
        // the decorated span sits next to other inline content — which
        // produced an Accept that cleared the highlights and replaced
        // nothing (2026-08-25). The caller should prefer `index` and read
        // the authoritative, already-verified span out of its own state.
        const from = view.posAtDOM(el, 0);
        const to = from + original.length;
        const index = rawIndex == null ? -1 : Number(rawIndex);
        return {
          index: Number.isInteger(index) ? index : -1,
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
