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
import type { EditorKind } from "../../src/shared/types";

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

interface SuggestBox {
  x: number;
  y: number;
  word: string;
  from: number;
  to: number;
  suggestions: string[];
}

interface DocState {
  nodeId: string;
  kind: EditorKind;
  frontmatter: Record<string, unknown>;
  body: string;
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

export default function App() {
  const [doc, setDoc] = useState<DocState | null>(null);
  const [fm, setFm] = useState<Record<string, unknown>>({});
  const [saved, setSaved] = useState<"idle" | "saving" | "saved">("idle");
  const [suggest, setSuggest] = useState<SuggestBox | null>(null);
  const loadingRef = useRef(false);

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

  if (!doc || !editor) {
    return <div className="loading">Loading…</div>;
  }

  const fields = FIELDS[doc.kind];

  return (
    <div className="editor">
      <header className="fm">
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
      </header>

      <Toolbar editor={editor} kind={doc.kind} onInsertSection={insertSection} />

      <div className="editor__content" onContextMenu={onContextMenu}>
        <EditorContent editor={editor} />
      </div>

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
