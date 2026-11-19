/**
 * Raw palette classes banned in src/**\/*.tsx (spec section 4). Shared by the guard test.
 * `accent` only counts as a class (accent-soft, accent/30, bg-accent, ...), not as an English word;
 * colour names need a word boundary before them, so `colored-1` or `sublime-3` are not `red-1` / `lime-3`.
 */
export const BANNED_COLOR_PATTERN =
  /mantis-\d|(?:[\s"'`:-])accent(?:-(?:soft|deep)|\/\d+|(?=[\s"'`]))|\b(?:gray|zinc|neutral|slate|green|emerald|lime|violet|amber|yellow|blue|red|orange)-\d|\[#[0-9a-fA-F]{3,8}\]/;
