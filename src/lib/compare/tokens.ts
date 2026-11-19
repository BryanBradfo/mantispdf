import type { Token, Word } from "./types";

const SPACES = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g;
const INVISIBLE = /[\u00ad\u200b]/g;

/** NFKC, soft hyphens and zero-width spaces removed, exotic spaces to plain spaces, collapsed, trimmed. */
export function normalizeText(text: string): string {
  return text.normalize("NFKC").replace(INVISIBLE, "").replace(SPACES, " ").replace(/\s+/g, " ").trim();
}

/**
 * Normalize words, drop empties, keep the source index (`baseIndex` + position). A word holding
 * separators (NBSP, thin spaces...) yields one token per part, all pointing at the same source word.
 */
export function tokenize(words: Word[], baseIndex = 0): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < words.length; i++) {
    const text = normalizeText(words[i].text);
    if (!text) continue;
    for (const part of text.split(" ")) out.push({ text: part, index: baseIndex + i, page: words[i].page });
  }
  return out;
}
