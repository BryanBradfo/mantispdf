//! Stage 2 — math-region heuristic (ADR 01/02), ported from the TypeScript
//! `src/lib/mathHeuristic.ts` so cropping and classification share one
//! coordinate space in the Rust backend.
//!
//! Flags standalone math regions with cheap signals (symbol density, non-body
//! font, font-size outliers, PDFium glyph-error flags, centered/isolated
//! geometry), then clusters flagged items vertically into display-equation
//! blocks. No model required — this just decides *which* boxes Stage 3 OCRs.

use liteparse::types::{ParsedPage, TextItem};

/// A bounding box in viewport points (top-left origin, 72 DPI) — same space as
/// LiteParse `TextItem`s, so it maps to raster pixels by `* (dpi / 72)`.
#[derive(Debug, Clone)]
pub struct BBox {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Debug, Clone)]
pub struct MathRegion {
    pub page: usize,
    pub bbox: BBox,
    pub text: String,
    pub score: i32,
}

const MATH_THRESHOLD: i32 = 3;

// Mirrors the MATH_CHAR class in mathHeuristic.ts: operators/relations, Greek,
// script/blackboard letters, set/logic symbols, structural marks.
const MATH_ASCII: &str = "=+-*/^_(){}[]|<>";
const MATH_UNICODE: &str = "−–±×÷·∑∏∫∮∂∇√∞≈≠≤≥≡∈∉∋⊂⊆⊃⊇∀∃∧∨¬→↦⇒⟨⟩‖∣\
αβγδεζηθικλμνξοπρστυφχψω\
ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩℒℛℝℕℤℚℂℋ𝓛";

fn is_math_char(c: char) -> bool {
    MATH_ASCII.contains(c) || MATH_UNICODE.contains(c)
}

/// Fraction of non-space characters that are math symbols.
pub fn symbol_density(text: &str) -> f32 {
    let chars: Vec<char> = text.chars().filter(|c| !c.is_whitespace()).collect();
    if chars.is_empty() {
        return 0.0;
    }
    let math = chars.iter().filter(|&&c| is_math_char(c)).count();
    math as f32 / chars.len() as f32
}

fn median(mut xs: Vec<f32>) -> f32 {
    if xs.is_empty() {
        return 0.0;
    }
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mid = xs.len() / 2;
    if xs.len() % 2 == 1 {
        xs[mid]
    } else {
        (xs[mid - 1] + xs[mid]) / 2.0
    }
}

/// The font carrying the most total text on a page — the "body" baseline.
fn dominant_font(items: &[TextItem]) -> Option<String> {
    use std::collections::HashMap;
    let mut totals: HashMap<&str, usize> = HashMap::new();
    for it in items {
        if let Some(f) = &it.font_name {
            *totals.entry(f.as_str()).or_insert(0) += it.text.chars().count();
        }
    }
    totals
        .into_iter()
        .max_by_key(|&(_, len)| len)
        .map(|(f, _)| f.to_string())
}

struct Ctx {
    body_font: Option<String>,
    median_size: f32,
    page_width: f32,
}

/// Score a single item; >= MATH_THRESHOLD is a math candidate. Returns 0 if the
/// item has no math symbols (hard gate, mirrors the TS density<0.12 short-out).
fn score_item(item: &TextItem, ctx: &Ctx) -> i32 {
    let density = symbol_density(&item.text);
    if density < 0.12 {
        return 0;
    }
    let mut score = 0;
    if density >= 0.3 {
        score += 2;
    } else if density >= 0.18 {
        score += 1;
    }
    if item.font_is_buggy || item.has_unicode_map_error {
        score += 2;
    }
    if let (Some(f), Some(body)) = (&item.font_name, &ctx.body_font) {
        if f != body {
            score += 1;
        }
    }
    if let Some(fs) = item.font_size {
        if ctx.median_size > 0.0 && fs > 1.3 * ctx.median_size {
            score += 1;
        }
    }
    let center_x = item.x + item.width / 2.0;
    let page_center = ctx.page_width / 2.0;
    let is_centered = (center_x - page_center).abs() < ctx.page_width * 0.18;
    let is_narrow = item.width < ctx.page_width * 0.6;
    if is_centered && is_narrow {
        score += 1;
    }
    score
}

/// Detect standalone math regions across all pages, clustering flagged items
/// vertically into display-equation blocks.
pub fn detect_math_regions(pages: &[ParsedPage]) -> Vec<MathRegion> {
    let mut regions = Vec::new();

    for page in pages {
        let sizes: Vec<f32> = page
            .text_items
            .iter()
            .filter_map(|i| i.font_size)
            .filter(|&s| s > 0.0)
            .collect();
        let ctx = Ctx {
            body_font: dominant_font(&page.text_items),
            median_size: median(sizes),
            page_width: page.page_width,
        };

        // Flag and sort by y (reading order).
        let mut flagged: Vec<(&TextItem, i32)> = page
            .text_items
            .iter()
            .map(|it| (it, score_item(it, &ctx)))
            .filter(|&(_, s)| s >= MATH_THRESHOLD)
            .collect();
        flagged.sort_by(|a, b| a.0.y.partial_cmp(&b.0.y).unwrap());

        // Cluster vertically: items within ~1.4 line-heights belong to one block.
        let mut current: Vec<(&TextItem, i32)> = Vec::new();
        let flush = |current: &mut Vec<(&TextItem, i32)>, regions: &mut Vec<MathRegion>| {
            if current.is_empty() {
                return;
            }
            let x = current.iter().map(|(i, _)| i.x).fold(f32::INFINITY, f32::min);
            let y = current.iter().map(|(i, _)| i.y).fold(f32::INFINITY, f32::min);
            let right = current
                .iter()
                .map(|(i, _)| i.x + i.width)
                .fold(f32::NEG_INFINITY, f32::max);
            let bottom = current
                .iter()
                .map(|(i, _)| i.y + i.height)
                .fold(f32::NEG_INFINITY, f32::max);
            let text = current
                .iter()
                .map(|(i, _)| i.text.as_str())
                .collect::<Vec<_>>()
                .join(" ")
                .trim()
                .to_string();
            let score = current.iter().map(|(_, s)| *s).max().unwrap_or(0);
            regions.push(MathRegion {
                page: page.page_number,
                bbox: BBox {
                    x,
                    y,
                    width: right - x,
                    height: bottom - y,
                },
                text,
                score,
            });
            current.clear();
        };

        for (item, score) in flagged {
            if let Some((prev, _)) = current.last() {
                let gap = item.y - (prev.y + prev.height);
                if gap > 1.4 * prev.height.max(item.height) {
                    flush(&mut current, &mut regions);
                }
            }
            current.push((item, score));
        }
        flush(&mut current, &mut regions);
    }

    regions
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn density_detects_math() {
        assert!(symbol_density("α=β+γ") > 0.5);
        assert!(symbol_density("the quick brown fox") < 0.12);
    }
}
