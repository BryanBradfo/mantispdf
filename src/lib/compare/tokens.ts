import type { Token, Word } from "./types";

const SPACES = /[   -   　]/g;

export function normalizeText(text: string): string {
  return text.normalize("NFKC").replace(SPACES, " ").replace(/\s+/g, " ").trim();
}

/** Normalize words (NFKC, exotic spaces, trim), drop empties, keep the source index. */
export function tokenize(words: Word[]): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < words.length; i++) {
    const text = normalizeText(words[i].text);
    if (text) out.push({ text, index: i, page: words[i].page });
  }
  return out;
}
