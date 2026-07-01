import matter from "gray-matter";
import type { ParsedDoc } from "../shared/types";

/**
 * Thin wrapper around gray-matter so the rest of the codebase deals in a
 * simple { frontmatter, body } shape and we control serialization options
 * in one place.
 */

export function parseDoc<T = Record<string, unknown>>(raw: string): ParsedDoc<T> {
  const parsed = matter(raw);
  return {
    frontmatter: parsed.data as T,
    body: parsed.content.replace(/^\n+/, ""),
  };
}

export function serializeDoc(
  frontmatter: Record<string, unknown>,
  body: string
): string {
  // gray-matter's stringify emits `---\n<yaml>---\n<body>`. We add a blank
  // line after the closing fence for readability, matching the templates.
  const out = matter.stringify(body.replace(/^\n+/, ""), frontmatter, {
    // keep key order stable-ish; gray-matter uses js-yaml under the hood
  });
  return out;
}

/** kebab-case a display name into a safe filename stem (no extension). */
export function toSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    || "untitled";
}
