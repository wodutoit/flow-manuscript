import { useCallback, useEffect, useRef, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import { Toolbar } from "./Toolbar";
import {
  post,
  onHostMessage,
  FIELDS,
  type SectionDef,
} from "./bridge";
import { SpellChecker } from "./spellchecker";
import {
  createSpellcheckPlugin,
  misspelledWordAt,
} from "./spellcheckPlugin";
import {
  createAiSuggestPlugin,
  setAiDecorations,
  aiSuggestionAt,
  findCurrentParagraph,
  getAiItems,
  type AiSuggestionDeco,
} from "./aiSuggestPlugin";
import type {
  AiEditorNote,
  AiStatus,
  AiSuggestion,
  EditorKind,
  EditorActRef,
} from "../../src/shared/types";

// Module-level singletons: one checker for the webview, and a holder for the
// plugin's manual-refresh function so we can re-run checking after load.
const checker = new SpellChecker();
let refreshDecorations: ((view: any) => void) | null = null;

const SpellcheckExtension = Extension.create({
  name: "flowSpellcheck",
  addProseMirrorPlugins() {
    return [
      createSpellcheckPlugin(checker, (refresh) => {
        refreshDecorations = refresh;
      }),
    ];
  },
});

const AiSuggestExtension = Extension.create({
  name: "flowAiSuggest",
  addProseMirrorPlugins() {
    return [createAiSuggestPlugin()];
  },
});

interface SuggestBox {
  x: number;
  y: number;
  word: string;
  from: number;
  to: number;
  suggestions: string[];
}

/** AI Grammar's popover — separate from `SuggestBox` above: a different
 * interaction shape (click-to-open on a specific decorated range, per-span
 * reason/category) rather than spellcheck's right-click/flat-word-list. */
interface AiSuggestBox {
  x: number;
  y: number;
  from: number;
  to: number;
  suggestion: AiSuggestion;
}

interface DocState {
  nodeId: string;
  kind: EditorKind;
  frontmatter: Record<string, unknown>;
  body: string;
  actId?: string;
  acts?: EditorActRef[];
}

function useDebouncedCallback<T extends (...a: any[]) => void>(fn: T, ms: number) {
  const t = useRef<ReturnType<typeof setTimeout>>();
  return useCallback(
    (...args: Parameters<T>) => {
      if (t.current) clearTimeout(t.current);
      t.current = setTimeout(() => fn(...args), ms);
    },
    [fn, ms]
  );
}

function aiStatusLabel(status: AiStatus): string {
  switch (status) {
    case "disabled":
      return "AI: off";
    case "downloading":
      return "AI: downloading model…";
    case "loading":
      return "AI: loading model…";
    case "ready":
      return "AI: ready";
    case "error":
      return "AI: error";
  }
}

/** An AI Editor note plus whether the user has ticked it off as addressed.
 * The checkbox is purely a local, per-viewing "worked through this" mark —
 * it's not sent back to the host and doesn't survive a re-run: a fresh
 * `aiEditorNotes` response always replaces the whole list (see the plan's
 * "replaces wholesale, never appends" rule), so every note starts unchecked
 * again each time a review actually runs. */
interface AiEditorNoteItem extends AiEditorNote {
  checked: boolean;
}

/**
 * Floating, draggable panel of AI Editor (developmental-craft) notes.
 * Deliberately NOT a backdrop-modal like `.suggest`/`.ai-suggest` — no
 * click-outside-to-close — the point is it survives clicking back into the
 * editor to make an edit while working through the list. "Always on top"
 * here means a high z-index within the webview's own stacking context; it
 * floats above the toolbar/editor content but is not an OS-level window and
 * can't float above other VS Code panes or other applications.
 */
/** Floors on how small a drag/resize can shrink the panel — small enough to
 * still show the header and a line or two of a note, not so small it can be
 * dragged into uselessness. */
const AI_NOTES_MIN_WIDTH = 220;
const AI_NOTES_MIN_HEIGHT = 160;

/** One row in the notes list — shared by both the "Needs improvement" and
 * "Strengths" groups below, so the checkbox/tag/quote markup isn't
 * duplicated. `index` is the note's position in the *original* flat `notes`
 * array (not its position within its group), since `onToggle` and React's
 * `key` both need the stable original index. */
function AiNoteRow({
  note,
  index,
  onToggle,
}: {
  note: AiEditorNoteItem;
  index: number;
  onToggle: (index: number) => void;
}) {
  return (
    <label
      className={`ai-notes__item${
        note.checked ? " ai-notes__item--checked" : ""
      }`}
    >
      <input
        type="checkbox"
        className="ai-notes__checkbox"
        checked={note.checked}
        onChange={() => onToggle(index)}
      />
      <div className="ai-notes__item-content">
        <span className={`ai-notes__tag ai-notes__tag--${note.category}`}>
          {note.category}
        </span>
        <div className="ai-notes__text">{note.note}</div>
        {note.quote ? (
          <div className="ai-notes__quote">“{note.quote}”</div>
        ) : null}
      </div>
    </label>
  );
}

function AiNotesPanel({
  notes,
  position,
  size,
  onDrag,
  onResize,
  onClose,
  onToggle,
}: {
  notes: AiEditorNoteItem[];
  position: { x: number; y: number };
  size: { width: number; height: number };
  onDrag: (pos: { x: number; y: number }) => void;
  onResize: (size: { width: number; height: number }) => void;
  onClose: () => void;
  onToggle: (index: number) => void;
}) {
  // Strengths default collapsed — the point of grouping is to let the author
  // focus on what needs work; praise is a click away, not competing for
  // attention at the top of the list.
  const [strengthsOpen, setStrengthsOpen] = useState(false);
  const dragState = useRef<{
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  const onHeaderMouseDown = (e: React.MouseEvent) => {
    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: position.x,
      origY: position.y,
    };
    const onMove = (ev: MouseEvent) => {
      if (!dragState.current) return;
      onDrag({
        x: dragState.current.origX + (ev.clientX - dragState.current.startX),
        y: dragState.current.origY + (ev.clientY - dragState.current.startY),
      });
    };
    const onUp = () => {
      dragState.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const resizeState = useRef<{
    startX: number;
    startY: number;
    origW: number;
    origH: number;
  } | null>(null);

  const onResizeHandleMouseDown = (e: React.MouseEvent) => {
    // Don't let this bubble up into the header's own drag handler — resizing
    // and moving are different gestures, from different corners.
    e.stopPropagation();
    resizeState.current = {
      startX: e.clientX,
      startY: e.clientY,
      origW: size.width,
      origH: size.height,
    };
    const onMove = (ev: MouseEvent) => {
      if (!resizeState.current) return;
      onResize({
        width: Math.max(
          AI_NOTES_MIN_WIDTH,
          resizeState.current.origW + (ev.clientX - resizeState.current.startX)
        ),
        height: Math.max(
          AI_NOTES_MIN_HEIGHT,
          resizeState.current.origH + (ev.clientY - resizeState.current.startY)
        ),
      });
    };
    const onUp = () => {
      resizeState.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Group by sentiment, keeping each note's original array index (needed by
  // onToggle/key) rather than its position within the group.
  const improvementIdx: number[] = [];
  const strengthIdx: number[] = [];
  notes.forEach((n, i) =>
    (n.sentiment === "strength" ? strengthIdx : improvementIdx).push(i)
  );

  return (
    <div
      className="ai-notes"
      style={{
        left: position.x,
        top: position.y,
        width: size.width,
        height: size.height,
      }}
    >
      <div className="ai-notes__header" onMouseDown={onHeaderMouseDown}>
        <span>AI Editor notes</span>
        <button
          className="ai-notes__close"
          onClick={onClose}
          title="Close"
          type="button"
        >
          ×
        </button>
      </div>
      <div className="ai-notes__body">
        {notes.length === 0 ? (
          <div className="ai-notes__empty">No notes for this paragraph.</div>
        ) : (
          <>
            <div className="ai-notes__group ai-notes__group--improvement">
              <div className="ai-notes__group-header">
                Needs improvement ({improvementIdx.length})
              </div>
              {improvementIdx.length === 0 ? (
                <div className="ai-notes__empty">
                  Nothing flagged — see Strengths below.
                </div>
              ) : (
                improvementIdx.map((i) => (
                  <AiNoteRow
                    key={i}
                    note={notes[i]}
                    index={i}
                    onToggle={onToggle}
                  />
                ))
              )}
            </div>

            {strengthIdx.length > 0 ? (
              <div className="ai-notes__group ai-notes__group--strengths">
                <button
                  type="button"
                  className="ai-notes__group-header ai-notes__group-header--toggle"
                  onClick={() => setStrengthsOpen((v) => !v)}
                  aria-expanded={strengthsOpen}
                >
                  <span
                    className={`ai-notes__chevron${
                      strengthsOpen ? " ai-notes__chevron--open" : ""
                    }`}
                  >
                    ▸
                  </span>
                  Strengths ({strengthIdx.length})
                </button>
                {strengthsOpen
                  ? strengthIdx.map((i) => (
                      <AiNoteRow
                        key={i}
                        note={notes[i]}
                        index={i}
                        onToggle={onToggle}
                      />
                    ))
                  : null}
              </div>
            ) : null}
          </>
        )}
      </div>
      <div
        className="ai-notes__resize"
        onMouseDown={onResizeHandleMouseDown}
        title="Drag to resize"
      />
    </div>
  );
}

export default function App() {
  const [doc, setDoc] = useState<DocState | null>(null);
  const [fm, setFm] = useState<Record<string, unknown>>({});
  const [saved, setSaved] = useState<"idle" | "saving" | "saved">("idle");
  const [suggest, setSuggest] = useState<SuggestBox | null>(null);
  const loadingRef = useRef(false);

  // --- AI Grammar / AI Editor state ---------------------------------------
  const [aiStatus, setAiStatus] = useState<AiStatus>("disabled");
  // Both buttons share one busy flag: the host serializes AI Grammar and AI
  // Editor requests through a single queue (see aiAssist.ts), so there is no
  // real "run both at once" state — disabling both while either is in
  // flight is the honest UI, not a distinct "queued" state.
  const [aiBusy, setAiBusy] = useState(false);
  const [aiSuggest, setAiSuggest] = useState<AiSuggestBox | null>(null);
  const [aiGrammarItems, setAiGrammarItems] = useState<AiSuggestionDeco[]>([]);
  // The paragraph's doc-start position captured at request time, so the
  // response (which carries offsets relative to the paragraph text) can be
  // converted back to absolute doc positions once it arrives.
  const aiGrammarRequestFrom = useRef<number | null>(null);
  // `null` = no review has run yet (the reopen button stays disabled);
  // once set, a re-run always *replaces* it wholesale, never appends — see
  // AiEditorNoteItem's doc comment for why that also resets every checkbox.
  const [aiEditorNotes, setAiEditorNotes] = useState<
    AiEditorNoteItem[] | null
  >(null);
  const [aiEditorPanelOpen, setAiEditorPanelOpen] = useState(false);
  const [aiEditorPanelPos, setAiEditorPanelPos] = useState(() => ({
    x: Math.max(20, window.innerWidth - 340),
    y: 80,
  }));
  const [aiEditorPanelSize, setAiEditorPanelSize] = useState(() => ({
    width: 320,
    height: 380,
  }));

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] } }),
      Underline,
      Markdown.configure({
        html: false,
        transformPastedText: true,
        transformCopiedText: true,
      }),
      Placeholder.configure({ placeholder: "Start writing…" }),
      SpellcheckExtension,
      AiSuggestExtension,
    ],
    editorProps: {
      attributes: {
        // Our Hunspell plugin draws the underlines; disable the native checker
        // so words aren't double-underlined.
        spellcheck: "false",
        class: "prose",
      },
    },
    onUpdate: ({ editor }) => {
      // Mirror the plugin's post-remap item list into React state. The
      // plugin re-anchors surviving suggestions across every doc change
      // (see remapItems in aiSuggestPlugin.ts); this keeps our array
      // index-aligned with the rendered decorations, which matters because
      // a click resolves through the decoration's data-ai-index.
      setAiGrammarItems((prev) => {
        const next = getAiItems(editor.state);
        // Avoid a state update (and re-render) when nothing changed — this
        // fires on every keystroke.
        if (prev.length === 0 && next.length === 0) return prev;
        return next;
      });
      if (loadingRef.current || !doc) return;
      setSaved("saving");
      const md = (editor.storage as any).markdown.getMarkdown() as string;
      debouncedSaveBody(doc.nodeId, md);
    },
  });

  const debouncedSaveBody = useDebouncedCallback((nodeId: string, body: string) => {
    post({ type: "saveBody", nodeId, body });
    setSaved("saved");
    setTimeout(() => setSaved("idle"), 1200);
  }, 600);

  const debouncedSaveFm = useDebouncedCallback(
    (nodeId: string, frontmatter: Record<string, unknown>) => {
      post({ type: "saveFrontmatter", nodeId, frontmatter });
    },
    500
  );

  useEffect(() => {
    const off = onHostMessage((msg) => {
      if (msg.type === "doc" && editor) {
        loadingRef.current = true;
        const next: DocState = {
          nodeId: msg.nodeId,
          kind: msg.kind,
          frontmatter: msg.frontmatter,
          body: msg.body,
          actId: msg.actId,
          acts: msg.acts,
        };
        setDoc(next);
        setFm(msg.frontmatter);
        // tiptap-markdown parses a raw markdown string passed to setContent.
        editor.commands.setContent(msg.body);
        // Re-run spellcheck against the freshly loaded content.
        if (refreshDecorations) refreshDecorations(editor.view);
        setTimeout(() => (loadingRef.current = false), 0);
      } else if (msg.type === "dictionary" && editor) {
        // Load the Hunspell dictionary, then trigger a recompute.
        checker
          .load(msg.language, msg.aff, msg.dic, msg.customWords)
          .then(() => {
            if (refreshDecorations) refreshDecorations(editor.view);
          })
          .catch((e) => console.error("spellcheck load failed", e));
      } else if (msg.type === "aiStatus") {
        setAiStatus(msg.status);
      } else if (msg.type === "aiGrammarSuggestions" && editor) {
        setAiBusy(false);
        const capturedFrom = aiGrammarRequestFrom.current;
        if (capturedFrom == null) return;
        const items: AiSuggestionDeco[] = [];
        for (const s of msg.suggestions) {
          const docFrom = capturedFrom + s.start;
          const docTo = capturedFrom + s.end;
          // Staleness guard: the user may have kept typing while the slow
          // local inference was running — re-verify the span still holds
          // the exact text the suggestion was computed against before
          // trusting it, same shape of check as the host's own indexOf-
          // not-found handling.
          let current: string;
          try {
            current = editor.state.doc.textBetween(docFrom, docTo);
          } catch {
            console.warn("[AI Grammar] dropped: doc position no longer exists", {
              docFrom,
              docTo,
              original: s.original,
            });
            continue; // position no longer exists in the doc at all
          }
          if (current !== s.original) {
            // Logged rather than dropped silently: a mismatch here means
            // either the user genuinely edited mid-review (the case this
            // guard exists for) or the host's offsets disagree with the
            // doc's — very different problems that used to look identical
            // from the outside (nothing highlights, no explanation).
            console.warn("[AI Grammar] dropped: span no longer matches", {
              docFrom,
              docTo,
              expected: s.original,
              found: current,
            });
            continue;
          }
          items.push({ docFrom, docTo, suggestion: s });
        }
        if (msg.suggestions.length > 0 && items.length === 0) {
          console.warn(
            `[AI Grammar] all ${msg.suggestions.length} suggestion(s) from the host ` +
              `were dropped by the staleness guard — nothing will highlight.`
          );
        }
        setAiGrammarItems(items);
        setAiDecorations(editor.view, items);
      } else if (msg.type === "aiEditorNotes") {
        setAiBusy(false);
        // Always replaces wholesale — a re-run is meant to show the fresh
        // notes, never append to the previous list — which is also why
        // every checkbox starts unticked again on each new review.
        setAiEditorNotes(msg.notes.map((n) => ({ ...n, checked: false })));
        // Re-running is meant to show you the fresh notes, not silently
        // update a closed panel — force it open.
        setAiEditorPanelOpen(true);
      }
    });
    post({ type: "ready" });
    post({ type: "requestDictionary" });
    return off;
  }, [editor]);

  const onField = (key: string, value: string) => {
    if (!doc) return;
    const nextFm = { ...fm, [key]: value };
    setFm(nextFm);
    debouncedSaveFm(doc.nodeId, { [key]: value });
  };

  const insertSection = (s: SectionDef) => {
    if (!editor) return;
    // Append the section's markdown at the end of the document. tiptap-markdown
    // parses markdown passed to insertContentAt, so headings/lists become real
    // nodes rather than literal text.
    const end = editor.state.doc.content.size;
    editor.chain().focus().insertContentAt(end, s.markdown).run();
  };

  // Right-click on a misspelled word shows our suggestion menu instead of the
  // native one. Right-clicks elsewhere keep the normal text menu.
  const onContextMenu = (e: React.MouseEvent) => {
    if (!editor) return;
    const hit = misspelledWordAt(e.target);
    if (!hit) return; // let the native menu appear
    e.preventDefault();
    // Find the word's document range from the DOM position.
    const pos = editor.view.posAtDOM(hit.el, 0);
    const from = pos;
    const to = pos + hit.word.length;
    setSuggest({
      x: e.clientX,
      y: e.clientY,
      word: hit.word,
      from,
      to,
      suggestions: checker.suggest(hit.word).slice(0, 8),
    });
  };

  const applySuggestion = (replacement: string) => {
    if (!editor || !suggest) return;
    editor
      .chain()
      .focus()
      .insertContentAt({ from: suggest.from, to: suggest.to }, replacement)
      .run();
    setSuggest(null);
  };

  const addToDictionary = () => {
    if (!suggest) return;
    checker.addWord(suggest.word);
    post({ type: "addCustomWord", word: suggest.word });
    if (editor && refreshDecorations) refreshDecorations(editor.view);
    setSuggest(null);
  };

  // --- AI Grammar / AI Editor handlers ------------------------------------

  const onAiGrammar = () => {
    if (!editor || !doc || aiBusy || aiStatus !== "ready") return;
    const para = findCurrentParagraph(editor.state);
    if (!para) return; // cursor isn't in a plain paragraph — silently no-op
    // Start every run from a clean slate: clear the previous run's
    // highlights and any open popover before requesting new ones. Otherwise
    // stale decorations from the last check stay on screen during the new
    // one and — if the new check returns nothing — linger afterwards,
    // leaving the editor showing results that no longer correspond to
    // anything the model just said.
    setAiSuggest(null);
    setAiGrammarItems([]);
    setAiDecorations(editor.view, []);
    aiGrammarRequestFrom.current = para.from;
    setAiBusy(true);
    post({
      type: "requestAiReview",
      mode: "grammar",
      nodeId: doc.nodeId,
      text: para.text,
      from: para.from,
    });
  };

  const onAiEditor = () => {
    if (!editor || !doc || aiBusy || aiStatus !== "ready") return;
    const para = findCurrentParagraph(editor.state);
    if (!para) return;
    setAiBusy(true);
    post({
      type: "requestAiReview",
      mode: "editor",
      nodeId: doc.nodeId,
      text: para.text,
      from: para.from,
    });
  };

  const onShowAiEditorNotes = () => {
    // Just redisplays what's already in memory — no model call, so it works
    // even mid-review or if AI status has since gone stale.
    setAiEditorPanelOpen(true);
  };

  const toggleAiEditorNote = (index: number) => {
    setAiEditorNotes((prev) => {
      if (!prev) return prev;
      const next = prev.slice();
      next[index] = { ...next[index], checked: !next[index].checked };
      return next;
    });
  };

  // Left-click on an AI Grammar decoration opens its popover; clicks
  // elsewhere are left alone so normal cursor placement still works.
  const onEditorClick = (e: React.MouseEvent) => {
    if (!editor) return;
    const hit = aiSuggestionAt(editor.view, e.target);
    if (!hit) return;
    e.preventDefault();
    // Prefer the span recorded in state when the decoration carries a usable
    // index. Those positions were verified against the live document when
    // the results arrived; the DOM-derived pair on `hit` is only a fallback
    // for a decoration rendered before this index existed.
    const tracked =
      hit.index >= 0 && hit.index < aiGrammarItems.length
        ? aiGrammarItems[hit.index]
        : undefined;
    setAiSuggest({
      x: e.clientX,
      y: e.clientY,
      from: tracked ? tracked.docFrom : hit.from,
      to: tracked ? tracked.docTo : hit.to,
      suggestion: tracked ? tracked.suggestion : hit.suggestion,
    });
  };

  const acceptAiSuggestion = () => {
    if (!editor || !aiSuggest) return;
    const { from, to } = aiSuggest;
    const replacement = aiSuggest.suggestion.suggestion;

    // Verify the span still holds what we think it does before replacing it.
    // Accept previously trusted a DOM-derived range and called
    // insertContentAt() blind: when the range was off, it silently replaced
    // nothing while still clearing every highlight, so the click looked like
    // it had done something and hadn't (reported 2026-08-25).
    let current = "";
    try {
      current = editor.state.doc.textBetween(from, to);
    } catch {
      current = "";
    }
    if (current !== aiSuggest.suggestion.original) {
      console.warn("[AI Grammar] accept aborted: span no longer matches", {
        from,
        to,
        expected: aiSuggest.suggestion.original,
        found: current,
      });
      setAiSuggest(null);
      return;
    }

    // insertText, not insertContentAt: the replacement is plain text, and
    // insertContentAt runs it through the HTML/content parser, which can
    // mangle or drop a string containing characters like < or &.
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.insertText(replacement, from, to);
        return true;
      })
      .run();

    // The remaining suggestions survive this edit: the plugin re-anchors
    // them through the change and drops any whose text no longer matches
    // (see remapItems in aiSuggestPlugin.ts). The accepted one removes
    // itself that way too — its span now holds the replacement, not the
    // original. Read the survivors back so this component's array stays
    // index-aligned with the decorations still on screen.
    setAiGrammarItems(getAiItems(editor.state));
    setAiSuggest(null);
  };

  const dismissAiSuggestion = () => {
    if (!editor || !aiSuggest) return;
    // No doc edit here, so the other decorations' positions are still
    // valid — just drop this one and re-render the rest.
    const remaining = aiGrammarItems.filter(
      (item) =>
        !(item.docFrom === aiSuggest.from && item.docTo === aiSuggest.to)
    );
    setAiGrammarItems(remaining);
    setAiDecorations(editor.view, remaining);
    setAiSuggest(null);
  };

  if (!doc || !editor) {
    return <div className="loading">Loading…</div>;
  }

  const fields = FIELDS[doc.kind];

  return (
    <div className="editor">
      <header className="fm">
        {doc.kind === "scene" && doc.acts ? (
          <label className="fm__field" key="__act">
            <span className="fm__label">Act</span>
            <select
              value={doc.actId ?? ""}
              onChange={(e) => {
                const actId = e.target.value;
                if (actId && actId !== doc.actId) {
                  post({
                    type: "moveSceneToAct",
                    sceneId: doc.nodeId,
                    actId,
                  });
                }
              }}
            >
              {!doc.actId ? (
                <option value="" disabled>
                  —
                </option>
              ) : null}
              {doc.acts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.order}. {a.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {fields.map((f) => (
          <label className="fm__field" key={f.key}>
            <span className="fm__label">{f.label}</span>
            {f.type === "select" ? (
              <select
                value={String(fm[f.key] ?? "")}
                onChange={(e) => onField(f.key, e.target.value)}
              >
                <option value="" disabled>
                  —
                </option>
                {f.options!.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={String(fm[f.key] ?? "")}
                onChange={(e) => onField(f.key, e.target.value)}
                onBlur={(e) => {
                  // Renaming the name field renames the file; do it on blur.
                  if (f.key === "name" && e.target.value.trim()) {
                    post({
                      type: "renameNode",
                      nodeId: doc.nodeId,
                      newName: e.target.value.trim(),
                    });
                  }
                }}
              />
            )}
          </label>
        ))}
        <div className="fm__status">
          {saved === "saving" ? "Saving…" : saved === "saved" ? "Saved" : ""}
        </div>
        <div className={`ai-status ai-status--${aiStatus}`}>
          {aiStatusLabel(aiStatus)}
        </div>
      </header>

      <Toolbar
        editor={editor}
        kind={doc.kind}
        onInsertSection={insertSection}
        aiStatus={aiStatus}
        aiBusy={aiBusy}
        hasAiEditorNotes={aiEditorNotes !== null}
        onAiGrammar={onAiGrammar}
        onAiEditor={onAiEditor}
        onShowAiEditorNotes={onShowAiEditorNotes}
      />

      <div
        className="editor__content"
        onContextMenu={onContextMenu}
        onClick={onEditorClick}
      >
        <EditorContent editor={editor} />
      </div>

      {aiEditorPanelOpen && aiEditorNotes ? (
        <AiNotesPanel
          notes={aiEditorNotes}
          position={aiEditorPanelPos}
          size={aiEditorPanelSize}
          onDrag={setAiEditorPanelPos}
          onResize={setAiEditorPanelSize}
          onClose={() => setAiEditorPanelOpen(false)}
          onToggle={toggleAiEditorNote}
        />
      ) : null}

      {aiSuggest ? (
        <>
          <div
            className="suggest__backdrop"
            onClick={() => setAiSuggest(null)}
          />
          <div
            className="ai-suggest"
            style={{ left: aiSuggest.x, top: aiSuggest.y }}
            role="menu"
          >
            <div className="ai-suggest__category">
              {aiSuggest.suggestion.category}
            </div>
            <div className="ai-suggest__diff">
              <span className="ai-suggest__original">
                {aiSuggest.suggestion.original}
              </span>
              <span className="ai-suggest__arrow">→</span>
              <span className="ai-suggest__replacement">
                {aiSuggest.suggestion.suggestion}
              </span>
            </div>
            <div className="ai-suggest__reason">
              {aiSuggest.suggestion.reason}
            </div>
            <div className="ai-suggest__actions">
              <button className="suggest__item" onClick={acceptAiSuggestion}>
                Accept
              </button>
              <button className="suggest__item" onClick={dismissAiSuggestion}>
                Dismiss
              </button>
            </div>
          </div>
        </>
      ) : null}

      {suggest ? (
        <>
          <div className="suggest__backdrop" onClick={() => setSuggest(null)} />
          <div
            className="suggest"
            style={{ left: suggest.x, top: suggest.y }}
            role="menu"
          >
            {suggest.suggestions.length ? (
              suggest.suggestions.map((s) => (
                <button
                  key={s}
                  className="suggest__item"
                  onClick={() => applySuggestion(s)}
                >
                  {s}
                </button>
              ))
            ) : (
              <div className="suggest__empty">No suggestions</div>
            )}
            <div className="suggest__sep" />
            <button className="suggest__item" onClick={addToDictionary}>
              Add “{suggest.word}” to dictionary
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
