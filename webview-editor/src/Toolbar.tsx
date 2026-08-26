import type { Editor } from "@tiptap/react";
import { SECTIONS, type SectionDef } from "./bridge";
import type { AiStatus, EditorKind } from "../../src/shared/types";

interface Props {
  editor: Editor;
  kind: EditorKind;
  onInsertSection: (s: SectionDef) => void;
  aiStatus: AiStatus;
  aiBusy: boolean;
  hasAiEditorNotes: boolean;
  onAiGrammar: () => void;
  onAiEditor: () => void;
  onShowAiEditorNotes: () => void;
}

function Btn({
  active,
  disabled,
  onClick,
  title,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`tb__btn${active ? " active" : ""}`}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      title={title}
      type="button"
    >
      {children}
    </button>
  );
}

export function Toolbar({
  editor,
  kind,
  onInsertSection,
  aiStatus,
  aiBusy,
  hasAiEditorNotes,
  onAiGrammar,
  onAiEditor,
  onShowAiEditorNotes,
}: Props) {
  const heading = (level: 1 | 2 | 3 | 4 | 5 | 6) => (
    <Btn
      key={level}
      active={editor.isActive("heading", { level })}
      onClick={() => editor.chain().focus().toggleHeading({ level }).run()}
      title={`Heading ${level}`}
    >
      H{level}
    </Btn>
  );

  return (
    <div className="tb">
      <div className="tb__group">
        <Btn
          active={editor.isActive("bold")}
          onClick={() => editor.chain().focus().toggleBold().run()}
          title="Bold (Ctrl/Cmd+B)"
        >
          <strong>B</strong>
        </Btn>
        <Btn
          active={editor.isActive("italic")}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          title="Italic (Ctrl/Cmd+I)"
        >
          <em>I</em>
        </Btn>
        <Btn
          active={editor.isActive("underline")}
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          title="Underline (Ctrl/Cmd+U)"
        >
          <span style={{ textDecoration: "underline" }}>U</span>
        </Btn>
        <Btn
          active={editor.isActive("strike")}
          onClick={() => editor.chain().focus().toggleStrike().run()}
          title="Strikethrough"
        >
          <s>S</s>
        </Btn>
        <Btn
          active={editor.isActive("code")}
          onClick={() => editor.chain().focus().toggleCode().run()}
          title="Inline code"
        >
          {"</>"}
        </Btn>
      </div>

      <div className="tb__group">{([1, 2, 3, 4, 5, 6] as const).map(heading)}</div>

      <div className="tb__group">
        <Btn
          active={editor.isActive("bulletList")}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          title="Bullet list"
        >
          • List
        </Btn>
        <Btn
          active={editor.isActive("orderedList")}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          title="Numbered list"
        >
          1. List
        </Btn>
        <Btn
          active={editor.isActive("blockquote")}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          title="Blockquote"
        >
          ❝
        </Btn>
        <Btn
          onClick={() => editor.chain().focus().setHorizontalRule().run()}
          title="Divider"
        >
          —
        </Btn>
      </div>

      <div className="tb__group">
        <Btn
          disabled={!editor.can().undo()}
          onClick={() => editor.chain().focus().undo().run()}
          title="Undo"
        >
          ↺
        </Btn>
        <Btn
          disabled={!editor.can().redo()}
          onClick={() => editor.chain().focus().redo().run()}
          title="Redo"
        >
          ↻
        </Btn>
      </div>

      <div className="tb__group tb__group--ai">
        <Btn
          disabled={aiStatus !== "ready" || aiBusy}
          onClick={onAiGrammar}
          title="AI Grammar — review the current paragraph for grammar, clarity, tone, and wordiness"
        >
          AI Grammar
        </Btn>
        <Btn
          disabled={aiStatus !== "ready" || aiBusy}
          onClick={onAiEditor}
          title="AI Editor — developmental notes on the current paragraph (pacing, showing vs. telling, sensory detail, tension, POV)"
        >
          AI Editor
        </Btn>
        <Btn
          disabled={!hasAiEditorNotes}
          onClick={onShowAiEditorNotes}
          title="Reopen AI Editor notes"
        >
          ▤
        </Btn>
        {aiBusy ? (
          <span
            className="tb__spinner"
            role="status"
            aria-label="AI review in progress"
            title="AI review in progress…"
          />
        ) : null}
      </div>

      <div className="tb__group tb__group--sections">
        <span className="tb__label">Insert section:</span>
        {SECTIONS[kind].map((s) => (
          <button
            key={s.label}
            type="button"
            className="tb__section"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onInsertSection(s)}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
