import nspell from "nspell";

/**
 * Wraps an nspell instance for the editor webview. nspell is pure JavaScript
 * (no WASM), reads the same Hunspell .aff/.dic the dictionary-en(-gb) packages
 * ship, and produces identical results regardless of OS or environment — which
 * is exactly what we need inside a VS Code webview.
 *
 * The dictionary bytes arrive from the extension host, so this module never
 * touches the filesystem.
 */
export class SpellChecker {
  private spell: ReturnType<typeof nspell> | null = null;
  private custom = new Set<string>();
  language = "";
  ready = false;

  /** Load (or reload) a dictionary from raw .aff/.dic strings + custom words. */
  async load(
    language: string,
    aff: string,
    dic: string,
    customWords: string[]
  ): Promise<void> {
    this.spell = nspell({ aff, dic });

    this.custom = new Set(customWords.map((w) => w.trim()).filter(Boolean));
    for (const w of this.custom) this.spell.add(w);

    this.language = language;
    this.ready = true;
  }

  /** True if the word is spelled correctly (or is a known custom word). */
  check(word: string): boolean {
    if (!this.spell) return true; // no dictionary → treat everything as fine
    if (this.custom.has(word)) return true;
    return this.spell.correct(word);
  }

  suggest(word: string): string[] {
    if (!this.spell) return [];
    return this.spell.suggest(word);
  }

  /** Add a word for the rest of this session (host persists it separately). */
  addWord(word: string): void {
    const w = word.trim();
    if (!w || !this.spell) return;
    this.custom.add(w);
    this.spell.add(w);
  }
}
