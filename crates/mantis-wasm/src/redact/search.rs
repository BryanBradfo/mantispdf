//! Text search in the engine, for marking areas to redact.
//!
//! Each page is interpreted like for redaction (forms included) with the
//! fonts' text (ToUnicode, else the encoding). Text is read in drawing
//! order; a space is assumed where a glyph starts more than 0.25 em after the
//! previous one ends, and a line break (also a space) where the baseline
//! moves. A match is marked by the union of its glyphs' boxes, one rect per
//! line: the very boxes the redaction removes, so a marked match never
//! leaves part of itself behind.

use super::interp::{Glyph, Quad, Rect};
use super::verify::page_text_glyphs;
use super::{Budget, JOB_DECODED, MAX_RECTS};
use crate::pdf_util::load_pdf;
use crate::stamp::geometry::VisibleBox;

/// Longest query, in characters.
pub(crate) const MAX_QUERY_CHARS: usize = 1000;

/// What to match.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct SearchOptions {
    pub(crate) whole_word: bool,
    pub(crate) case_sensitive: bool,
}

/// The matches on one page: one visible-space rect `[x, y, w, h]` per line
/// of each match.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PageHits {
    pub(crate) page: u32,
    pub(crate) rects: Vec<[f64; 4]>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct SearchResult {
    pub(crate) pages: Vec<PageHits>,
    /// Pages with text whose characters cannot be known (or that cannot be
    /// read at all): search may miss text there.
    pub(crate) undecodable_pages: Vec<u32>,
}

/// One character of a page's text: the glyph it comes from (None for an
/// assumed space) and its line.
struct Char {
    ch: char,
    glyph: Option<usize>,
}

fn fold(c: char, case_sensitive: bool) -> Vec<char> {
    if case_sensitive { vec![c] } else { c.to_lowercase().collect() }
}

/// The page text with assumed spaces and the line of each glyph.
fn page_text(glyphs: &[Glyph], case_sensitive: bool) -> (Vec<Char>, Vec<usize>) {
    let mut chars = Vec::new();
    let mut lines = Vec::with_capacity(glyphs.len());
    let mut line = 0;
    let mut previous: Option<&Glyph> = None;
    for (i, g) in glyphs.iter().enumerate() {
        if let Some(p) = previous {
            let (dx, dy) = (p.end.0 - p.origin.0, p.end.1 - p.origin.1);
            let length = dx.hypot(dy);
            let (ux, uy) = if length > 0.0 { (dx / length, dy / length) } else { (1.0, 0.0) };
            let (gx, gy) = (g.origin.0 - p.end.0, g.origin.1 - p.end.1);
            let along = gx * ux + gy * uy;
            let across = (gx * uy - gy * ux).abs();
            let em = g.em.max(p.em).max(f64::MIN_POSITIVE);
            if across > 0.5 * em || along < -0.5 * em {
                line += 1;
                chars.push(Char { ch: ' ', glyph: None });
            } else if along > 0.25 * em {
                chars.push(Char { ch: ' ', glyph: None });
            }
        }
        match &g.text {
            Some(text) => {
                for c in text.chars().flat_map(|c| fold(c, case_sensitive)) {
                    chars.push(Char { ch: c, glyph: Some(i) });
                }
            }
            // Unknown text: breaks any match across it.
            None => chars.push(Char { ch: '\u{FFFD}', glyph: Some(i) }),
        }
        lines.push(line);
        previous = Some(g);
    }
    (chars, lines)
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Visible space rect of a user space rect on a page.
fn to_visible(vb: &VisibleBox, r: &Rect) -> [f64; 4] {
    let m = vb.matrix();
    // Invert the visible-to-user matrix (a rotation by quarter turns).
    let det = m[0] * m[3] - m[1] * m[2];
    let inv = |x: f64, y: f64| {
        let (dx, dy) = (x - m[4], y - m[5]);
        ((dx * m[3] - dy * m[2]) / det, (m[0] * dy - m[1] * dx) / det)
    };
    let corners = [inv(r.x0, r.y0), inv(r.x1, r.y0), inv(r.x1, r.y1), inv(r.x0, r.y1)];
    let x0 = corners.iter().map(|c| c.0).fold(f64::INFINITY, f64::min);
    let y0 = corners.iter().map(|c| c.1).fold(f64::INFINITY, f64::min);
    let x1 = corners.iter().map(|c| c.0).fold(f64::NEG_INFINITY, f64::max);
    let y1 = corners.iter().map(|c| c.1).fold(f64::NEG_INFINITY, f64::max);
    [x0, y0, x1 - x0, y1 - y0]
}

fn union(quads: impl Iterator<Item = Quad>) -> Option<Rect> {
    quads.map(|q| q.bbox()).reduce(|a, b| Rect { x0: a.x0.min(b.x0), y0: a.y0.min(b.y0), x1: a.x1.max(b.x1), y1: a.y1.max(b.y1) })
}

/// Every match of `query` in `pdf`, page by page (at most `MAX_RECTS` rects).
pub(crate) fn redact_search(pdf: &[u8], query: &str, options: &SearchOptions) -> Result<SearchResult, String> {
    if query.chars().count() > MAX_QUERY_CHARS {
        return Err(super::invalid("query"));
    }
    let doc = load_pdf(pdf)?;
    let needle: Vec<char> = query.chars().flat_map(|c| fold(c, options.case_sensitive)).collect();
    let mut result = SearchResult::default();
    let mut total = 0;
    let mut decoded = JOB_DECODED;
    for (number, page) in doc.get_pages() {
        let mut budget = Budget::page(decoded);
        let glyphs = page_text_glyphs(&doc, page, &mut budget);
        decoded = budget.decoded;
        let Ok(glyphs) = glyphs else {
            result.undecodable_pages.push(number);
            continue;
        };
        if glyphs.iter().any(|g| g.text.is_none()) {
            result.undecodable_pages.push(number);
        }
        if needle.is_empty() || total >= MAX_RECTS {
            continue;
        }
        let (chars, lines) = page_text(&glyphs, options.case_sensitive);
        let vb = VisibleBox::of_page(&doc, page);
        let mut rects = Vec::new();
        let mut at = 0;
        while at + needle.len() <= chars.len() {
            let hit = chars[at..at + needle.len()].iter().zip(&needle).all(|(c, n)| c.ch == *n);
            let bounded = !options.whole_word
                || ((at == 0 || !is_word(chars[at - 1].ch)) && chars.get(at + needle.len()).is_none_or(|c| !is_word(c.ch)));
            if !(hit && bounded) {
                at += 1;
                continue;
            }
            let mut matched: Vec<usize> = chars[at..at + needle.len()].iter().filter_map(|c| c.glyph).collect();
            matched.dedup();
            let mut by_line: Vec<(usize, Vec<usize>)> = Vec::new();
            for g in matched {
                match by_line.iter_mut().find(|(l, _)| *l == lines[g]) {
                    Some((_, list)) => list.push(g),
                    None => by_line.push((lines[g], vec![g])),
                }
            }
            for (_, list) in by_line {
                if let Some(r) = union(list.iter().map(|&g| glyphs[g].box_user)) {
                    rects.push(to_visible(&vb, &r));
                }
            }
            at += needle.len();
            if total + rects.len() >= MAX_RECTS {
                break;
            }
        }
        if !rects.is_empty() {
            total += rects.len();
            result.pages.push(PageHits { page: number, rects });
        }
    }
    Ok(result)
}
