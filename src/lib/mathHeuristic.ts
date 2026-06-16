// Stage 2 (lightweight, heuristic) of the extraction engine — see
// docs/architecture/01-extraction-engine.md.
//
// LiteParse (Stage 1) gives us *where the text is* with per-item font metadata,
// but not *which regions are math*. This module flags text items that look like
// standalone mathematical formulas using cheap signals — no model required:
//   - high density of math symbols / Greek / operators
//   - a font family different from the page's dominant body font
//   - font-size outliers (e.g. an oversized summation sign)
//   - PDFium's "unreliable glyph" flags (font_is_buggy / unicode-map errors)
//   - centered + horizontally isolated geometry
//
// NOTE: this is the v1 spike placement. When Stage 3 (pix2tex via Candle) is
// built, the classifier moves into the Rust backend so it can crop and feed the
// model in-process; the signals here port directly.

/** Mirrors the JSON emitted by the Rust `extract_document` command. */
export interface ExtractedTextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  font_name?: string | null;
  font_size?: number | null;
  font_is_buggy?: boolean;
  has_unicode_map_error?: boolean;
}

export interface ExtractedPage {
  page_number: number;
  page_width: number;
  page_height: number;
  text: string;
  text_items: ExtractedTextItem[];
}

export interface ExtractionResult {
  text: string;
  pages: ExtractedPage[];
}

export interface MathRegion {
  page: number;
  bbox: { x: number; y: number; width: number; height: number };
  text: string;
  score: number;
  reasons: string[];
  itemCount: number;
}

// Characters that signal mathematics: operators, relations, Greek letters,
// script/blackboard letters, set/logic symbols, and structural marks.
const MATH_CHAR =
  /[=+\-−–*/^_(){}\[\]|<>±×÷·∑∏∫∮∂∇√∞≈≠≤≥≡∈∉∋⊂⊆⊃⊇∀∃∧∨¬→↦⇒⟨⟩‖∣αβγδεζηθικλμνξοπρστυφχψωΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩℒℛℝℕℤℚℂℋ𝓛]/u;

/** Fraction of non-space characters that are math symbols. */
export function symbolDensity(text: string): number {
  const chars = [...text].filter((c) => !/\s/.test(c));
  if (chars.length === 0) return 0;
  const math = chars.filter((c) => MATH_CHAR.test(c)).length;
  return math / chars.length;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** The font carrying the most total text on a page — our "body" baseline. */
function dominantFont(items: ExtractedTextItem[]): string | undefined {
  const totals = new Map<string, number>();
  for (const it of items) {
    if (!it.font_name) continue;
    totals.set(it.font_name, (totals.get(it.font_name) ?? 0) + it.text.length);
  }
  let best: string | undefined;
  let bestLen = -1;
  for (const [font, len] of totals) {
    if (len > bestLen) {
      best = font;
      bestLen = len;
    }
  }
  return best;
}

interface Scored extends ExtractedTextItem {
  _score: number;
  _reasons: string[];
}

/** Score a single item; >= MATH_THRESHOLD is treated as a math candidate. */
const MATH_THRESHOLD = 3;

function scoreItem(
  item: ExtractedTextItem,
  ctx: { bodyFont?: string; medianSize: number; pageWidth: number },
): Scored {
  let score = 0;
  const reasons: string[] = [];

  const density = symbolDensity(item.text);
  // Hard gate: math must actually contain math symbols. Without this, centered
  // size-outlier headings (e.g. a bold title) score on geometry/font alone.
  if (density < 0.12) {
    return { ...item, _score: 0, _reasons: ["no-math-symbols"] };
  }

  if (density >= 0.3) {
    score += 2;
    reasons.push(`symbol-density=${density.toFixed(2)}`);
  } else if (density >= 0.18) {
    score += 1;
    reasons.push(`symbol-density=${density.toFixed(2)}`);
  }

  if (item.font_is_buggy || item.has_unicode_map_error) {
    score += 2;
    reasons.push("unreliable-glyphs");
  }

  if (item.font_name && ctx.bodyFont && item.font_name !== ctx.bodyFont) {
    score += 1;
    reasons.push("non-body-font");
  }

  if (item.font_size && ctx.medianSize > 0 && item.font_size > 1.3 * ctx.medianSize) {
    score += 1;
    reasons.push("size-outlier");
  }

  // Centered + horizontally isolated (typical of a display equation).
  const centerX = item.x + item.width / 2;
  const pageCenter = ctx.pageWidth / 2;
  const isCentered = Math.abs(centerX - pageCenter) < ctx.pageWidth * 0.18;
  const isNarrow = item.width < ctx.pageWidth * 0.6;
  if (isCentered && isNarrow) {
    score += 1;
    reasons.push("centered-isolated");
  }

  return { ...item, _score: score, _reasons: reasons };
}

/**
 * Detect standalone math regions across all pages. Flagged items are clustered
 * vertically into blocks (a display equation can arrive as several fragments —
 * fraction numerator, summation sign, etc. — at nearly the same y).
 */
export function detectMathRegions(pages: ExtractedPage[]): MathRegion[] {
  const regions: MathRegion[] = [];

  for (const page of pages) {
    const sizes = page.text_items
      .map((i) => i.font_size ?? 0)
      .filter((s) => s > 0);
    const ctx = {
      bodyFont: dominantFont(page.text_items),
      medianSize: median(sizes),
      pageWidth: page.page_width,
    };

    const flagged = page.text_items
      .map((it) => scoreItem(it, ctx))
      .filter((s) => s._score >= MATH_THRESHOLD)
      .sort((a, b) => a.y - b.y);

    // Cluster vertically: items whose y-gap is small belong to one block.
    let current: Scored[] = [];
    const flush = () => {
      if (current.length === 0) return;
      const x = Math.min(...current.map((i) => i.x));
      const y = Math.min(...current.map((i) => i.y));
      const right = Math.max(...current.map((i) => i.x + i.width));
      const bottom = Math.max(...current.map((i) => i.y + i.height));
      regions.push({
        page: page.page_number,
        bbox: { x, y, width: right - x, height: bottom - y },
        text: current.map((i) => i.text).join(" ").trim(),
        score: Math.max(...current.map((i) => i._score)),
        reasons: [...new Set(current.flatMap((i) => i._reasons))],
        itemCount: current.length,
      });
      current = [];
    };

    for (const item of flagged) {
      if (current.length === 0) {
        current.push(item);
        continue;
      }
      const prev = current[current.length - 1];
      const gap = item.y - (prev.y + prev.height);
      // Same block if vertically adjacent (gap under ~1.4 line-heights).
      if (gap <= 1.4 * Math.max(prev.height, item.height)) {
        current.push(item);
      } else {
        flush();
        current.push(item);
      }
    }
    flush();
  }

  return regions;
}
