import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorView } from "@tiptap/pm/view";
import type { SpellChecker } from "./spellchecker";

export const spellcheckKey = new PluginKey("flowSpellcheck");

// Split text into word tokens with their absolute positions in the doc.
// Words are letter sequences (with apostrophes), so contractions stay intact.
const WORD_RE = /[A-Za-z\u00C0-\u024F]+(?:'[A-Za-z\u00C0-\u024F]+)*/g;

interface WordHit {
  from: number;
  to: number;
  word: string;
}

function collectWords(doc: any): WordHit[] {
  const hits: WordHit[] = [];
  doc.descendants((node: any, pos: number) => {
    if (!node.isText || !node.text) return;
    const text: string = node.text;
    let m: RegExpExecArray | null;
    WORD_RE.lastIndex = 0;
    while ((m = WORD_RE.exec(text)) !== null) {
      hits.push({
        from: pos + m.index,
        to: pos + m.index + m[0].length,
        word: m[0],
      });
    }
  });
  return hits;
}

function buildDecorations(doc: any, checker: SpellChecker): DecorationSet {
  if (!checker.ready) return DecorationSet.empty;
  const decos: Decoration[] = [];
  for (const hit of collectWords(doc)) {
    // Skip all-caps acronyms and words with digits (already excluded by regex).
    if (hit.word.length < 2) continue;
    if (!checker.check(hit.word)) {
      decos.push(
        Decoration.inline(hit.from, hit.to, {
          class: "spell-error",
          // stash the word so the context menu can read it
          "data-word": hit.word,
        })
      );
    }
  }
  return DecorationSet.create(doc, decos);
}

/**
 * ProseMirror plugin that underlines misspelled words. Checking is debounced:
 * decorations recompute a short delay after the last change, not on every
 * keystroke. Call `refresh(view)` after the dictionary loads/changes.
 */
export function createSpellcheckPlugin(
  checker: SpellChecker,
  onReady: (refresh: (view: EditorView) => void) => void
) {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const plugin = new Plugin({
    key: spellcheckKey,
    state: {
      init() {
        return DecorationSet.empty;
      },
      apply(tr, old) {
        // If we asked for a recompute via meta, rebuild now.
        const meta = tr.getMeta(spellcheckKey);
        if (meta === "recompute") {
          return buildDecorations(tr.doc, checker);
        }
        // Otherwise just map existing decorations through the change.
        return old.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
    },
    view(view) {
      // Debounced recompute on document changes.
      const schedule = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          view.dispatch(view.state.tr.setMeta(spellcheckKey, "recompute"));
        }, 400);
      };
      // Expose a manual refresh (used after dictionary load).
      onReady((v) => {
        v.dispatch(v.state.tr.setMeta(spellcheckKey, "recompute"));
      });
      return {
        update(_v, prev) {
          if (!prev.doc.eq(_v.state.doc)) schedule();
        },
        destroy() {
          if (timer) clearTimeout(timer);
        },
      };
    },
  });

  return plugin;
}

/** Given a DOM position, find the misspelled word span under it, if any. */
export function misspelledWordAt(target: EventTarget | null): {
  word: string;
  el: HTMLElement;
} | null {
  let el = target as HTMLElement | null;
  while (el && el.nodeType === 1) {
    if (el.classList?.contains("spell-error")) {
      const word = el.getAttribute("data-word");
      if (word) return { word, el };
    }
    el = el.parentElement;
  }
  return null;
}
