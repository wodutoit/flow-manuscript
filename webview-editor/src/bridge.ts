import type { EditorToHost, HostToEditor, NodeKind } from "../../src/shared/types";

interface VsCodeApi {
  postMessage(msg: EditorToHost): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
export const vscode = acquireVsCodeApi();

export function post(msg: EditorToHost) {
  vscode.postMessage(msg);
}

export function onHostMessage(handler: (msg: HostToEditor) => void) {
  const listener = (e: MessageEvent<HostToEditor>) => handler(e.data);
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}

// --- header fields shown above the editor, per node kind -------------------

export interface FieldDef {
  key: string;
  label: string;
  type: "text" | "select";
  options?: string[];
}

export const FIELDS: Record<string, FieldDef[]> = {
  overview: [
    { key: "title", label: "Title", type: "text" },
    { key: "author", label: "Author", type: "text" },
    { key: "genre", label: "Genre", type: "text" },
    { key: "pov", label: "POV", type: "text" },
    { key: "tense", label: "Tense", type: "text" },
    {
      key: "language",
      label: "Language",
      type: "select",
      options: ["en_US", "en_GB"],
    },
  ],
  scene: [
    { key: "name", label: "Scene name", type: "text" },
    { key: "pov", label: "POV", type: "text" },
    { key: "goal", label: "Goal", type: "text" },
    {
      key: "status",
      label: "Status",
      type: "select",
      options: ["outline", "drafted", "revised", "final"],
    },
  ],
  character: [
    { key: "name", label: "Name", type: "text" },
    {
      key: "role",
      label: "Role",
      type: "select",
      options: ["protagonist", "antagonist", "supporting", "minor"],
    },
    {
      key: "status",
      label: "Status",
      type: "select",
      options: ["sketch", "developed", "locked"],
    },
  ],
  place: [
    { key: "name", label: "Name", type: "text" },
    {
      key: "type",
      label: "Type",
      type: "select",
      options: ["city", "building", "room", "landscape", "other"],
    },
    {
      key: "status",
      label: "Status",
      type: "select",
      options: ["sketch", "developed", "locked"],
    },
  ],
};

// --- insertable sections, per node kind ------------------------------------
// Each entry is a markdown snippet appended at the cursor / end of doc.

export interface SectionDef {
  label: string;
  markdown: string;
}

export const SECTIONS: Record<string, SectionDef[]> = {
  overview: [
    { label: "Logline", markdown: "\n## Logline\n\n" },
    { label: "Premise", markdown: "\n## Premise\n\n" },
    { label: "Theme", markdown: "\n## Theme\n\n" },
    { label: "Target audience", markdown: "\n## Target audience\n\n" },
    { label: "Comparable titles", markdown: "\n## Comparable titles\n\n" },
    { label: "Status", markdown: "\n## Status\n\n" },
  ],
  scene: [
    { label: "Visual beats", markdown: "\n## Visual beats\n\n- Beat\n" },
    {
      label: "Structure",
      markdown:
        "\n## Structure\n\n### Start\n\n### Trigger\n\n### Goal\n\n### Disaster\n\n### Shift / Sequel\n",
    },
    { label: "Prose", markdown: "\n## Prose\n\n" },
  ],
  character: [
    { label: "Snapshot", markdown: "\n## Snapshot\n\n" },
    { label: "Role in the story", markdown: "\n## Role in the story\n\n" },
    {
      label: "Core psychology",
      markdown:
        "\n## The Core Psychology\n\n### Goal / Want\n\n### Need\n\n### The Lie They Believe\n\n#### Wound / Backstory\n",
    },
    {
      label: "Friction & Dynamics",
      markdown:
        "\n## Friction & Dynamics\n\n### The Core Contradiction\n\n### The Breaking Point\n\n### The Social Mask vs. The Secret Self\n",
    },
    { label: "Arc", markdown: "\n## Arc\n\n" },
    { label: "Voice", markdown: "\n## Voice\n\n" },
    { label: "Relationships", markdown: "\n## Relationships\n\n- Relationship\n" },
  ],
  place: [
    { label: "Snapshot", markdown: "\n## Snapshot\n\n" },
    { label: "Sensory", markdown: "\n## Sensory\n\n" },
    { label: "Significance", markdown: "\n## Significance\n\n" },
    { label: "History", markdown: "\n## History\n\n" },
    { label: "Notes", markdown: "\n## Notes\n\n" },
  ],
};
