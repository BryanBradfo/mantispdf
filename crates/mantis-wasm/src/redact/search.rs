//! Text search in the engine, for marking areas to redact.
//!
//! Each page is interpreted like for redaction (forms included) with the
//! fonts' text (ToUnicode, else the encoding). Text is read in drawing
//! order; a space is assumed where a glyph starts more than 0.25 em after the
//! previous one ends, and a line break (also a space) where the baseline
//! moves. A match is marked by the union of its glyphs' boxes, one rect per
//! line: the very boxes the redaction removes, so a marked match never
//! leaves part of itself behind. A kerned neighbour whose box overlaps a
//! matched glyph's goes too (over-coverage, never under-coverage).

use super::interp::{Glyph, Quad, Rect};
use super::unicode::TextCache;
use super::verify::page_text_glyphs;
use std::cell::RefCell;
use std::rc::Rc;
use super::{Budget, JOB_DECODED, MAX_RECTS};
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
    /// read at all, or have too much text): search may miss text there.
    pub(crate) undecodable_pages: Vec<u32>,
    /// Matches stopped at `MAX_RECTS` rects.
    pub(crate) truncated: bool,
    /// Pages not fully searched because of that.
    pub(crate) unsearched_pages: Vec<u32>,
}

/// Characters of one page's text searched at most.
const MAX_PAGE_CHARS: usize = 2_000_000;

/// One character of a page's text: the glyph it comes from (None for an
/// assumed space) and its line.
struct Char {
    ch: char,
    glyph: Option<usize>,
}

/// The characters `c` reads as: ligatures (U+FB00..=U+FB06) as their
/// letters, any whitespace as a space, lower case unless `case_sensitive`.
fn fold(c: char, case_sensitive: bool) -> Vec<char> {
    let letters: &str = match c {
        '\u{FB00}' => "ff",
        '\u{FB01}' => "fi",
        '\u{FB02}' => "fl",
        '\u{FB03}' => "ffi",
        '\u{FB04}' => "ffl",
        '\u{FB05}' | '\u{FB06}' => "st",
        c if c.is_whitespace() => " ",
        _ => "",
    };
    let chars: Vec<char> = if letters.is_empty() { vec![c] } else { letters.chars().collect() };
    if case_sensitive { chars } else { chars.into_iter().flat_map(char::to_lowercase).collect() }
}

/// `query` as the page text reads: folded, whitespace runs as one space.
fn needle(query: &str, case_sensitive: bool) -> Vec<char> {
    let mut out: Vec<char> = Vec::new();
    for c in query.chars().flat_map(|c| fold(c, case_sensitive)) {
        if c == ' ' && out.last() == Some(&' ') {
            continue;
        }
        out.push(c);
    }
    out
}

/// Add `ch` (from `glyph`) to the page text; a space after a space is
/// dropped (whitespace runs read as one space).
fn push(chars: &mut Vec<Char>, ch: char, glyph: Option<usize>) {
    if ch == ' ' && chars.last().is_some_and(|c| c.ch == ' ') {
        return;
    }
    chars.push(Char { ch, glyph });
}

/// The page text with assumed spaces and the line of each glyph; None past
/// `MAX_PAGE_CHARS` characters.
fn page_text(glyphs: &[Glyph], case_sensitive: bool) -> Option<(Vec<Char>, Vec<usize>)> {
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
                push(&mut chars, ' ', None);
            } else if along > 0.25 * em {
                push(&mut chars, ' ', None);
            }
        }
        match &g.text {
            Some(text) => {
                for c in text.chars().flat_map(|c| fold(c, case_sensitive)) {
                    push(&mut chars, c, Some(i));
                }
            }
            // Unknown text: breaks any match across it.
            None => chars.push(Char { ch: '\u{FFFD}', glyph: Some(i) }),
        }
        lines.push(line);
        previous = Some(g);
        if chars.len() > MAX_PAGE_CHARS {
            return None;
        }
    }
    Some((chars, lines))
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
    // Zero-size text (font size or scaling 0) still gets an area redaction
    // accepts: at least 1 pt each way, centred on it.
    let grow = |lo: f64, len: f64| if len < MIN_SIDE { (lo - (MIN_SIDE - len) / 2.0, MIN_SIDE) } else { (lo, len) };
    let (x, w) = grow(x0, x1 - x0);
    let (y, h) = grow(y0, y1 - y0);
    [x, y, w, h]
}

/// Smallest side of a match rect, in points.
const MIN_SIDE: f64 = 1.0;

fn union(quads: impl Iterator<Item = Quad>) -> Option<Rect> {
    quads.map(|q| q.bbox()).reduce(|a, b| Rect { x0: a.x0.min(b.x0), y0: a.y0.min(b.y0), x1: a.x1.max(b.x1), y1: a.y1.max(b.y1) })
}

/// Every match of `query` in `pdf`, page by page. A match that would take
/// the rects past `MAX_RECTS` is dropped whole and the search stops there,
/// saying so (`truncated`; that page and every later one in
/// `unsearched_pages`).
pub(crate) fn redact_search(pdf: &[u8], query: &str, options: &SearchOptions) -> Result<SearchResult, String> {
    redact_search_within(pdf, query, options, MAX_JOB_CHARS)
}

/// Characters of page text one search job reads at most; later pages are
/// reported unsearched.
const MAX_JOB_CHARS: usize = 20_000_000;

/// The start of every non-overlapping match of `needle` in `text` (whole
/// words only when asked), left to right, in linear time (Knuth-Morris-Pratt).
fn find_starts(text: &[Char], needle: &[char], whole_word: bool) -> Vec<usize> {
    let m = needle.len();
    if m == 0 {
        return Vec::new();
    }
    // fail[i]: length of the longest proper border of needle[..=i].
    let mut fail = vec![0usize; m];
    let mut k = 0;
    for i in 1..m {
        while k > 0 && needle[i] != needle[k] {
            k = fail[k - 1];
        }
        if needle[i] == needle[k] {
            k += 1;
        }
        fail[i] = k;
    }
    let mut starts = Vec::new();
    let mut k = 0;
    for (i, c) in text.iter().enumerate() {
        while k > 0 && c.ch != needle[k] {
            k = fail[k - 1];
        }
        if c.ch == needle[k] {
            k += 1;
        }
        if k == m {
            let start = i + 1 - m;
            let bounded = !whole_word
                || ((start == 0 || !is_word(text[start - 1].ch)) && text.get(i + 1).is_none_or(|c| !is_word(c.ch)));
            if bounded {
                starts.push(start);
                // Non-overlapping: start afresh after a match.
                k = 0;
            } else {
                k = fail[k - 1];
            }
        }
    }
    starts
}

/// `redact_search` reading at most `max_chars` characters of page text.
pub(crate) fn redact_search_within(pdf: &[u8], query: &str, options: &SearchOptions, max_chars: usize) -> Result<SearchResult, String> {
    if query.chars().count() > MAX_QUERY_CHARS || query.contains('\u{FFFD}') {
        return Err(super::invalid("query"));
    }
    let doc = super::load_prepared(pdf)?;
    let needle = needle(query, options.case_sensitive);
    let mut result = SearchResult::default();
    let mut total = 0;
    let mut read = 0usize;
    let mut decoded = JOB_DECODED;
    // Fonts' text maps, shared by every page of the job.
    let cache = Rc::new(RefCell::new(TextCache::new(decoded)));
    for (number, page) in doc.get_pages() {
        // Past the limit (or once it is reached): not searched at all.
        if result.truncated || (total >= MAX_RECTS && !needle.is_empty()) {
            result.truncated = true;
            result.unsearched_pages.push(number);
            continue;
        }
        cache.borrow_mut().set_limit(decoded);
        let before = cache.borrow().charged();
        let mut budget = Budget::page(decoded);
        let glyphs = page_text_glyphs(&doc, page, &mut budget, &cache);
        decoded = budget.decoded.saturating_sub(cache.borrow().charged() - before);
        let Ok(glyphs) = glyphs else {
            result.undecodable_pages.push(number);
            continue;
        };
        let Some((chars, lines)) = page_text(&glyphs, options.case_sensitive) else {
            result.undecodable_pages.push(number);
            continue;
        };
        if glyphs.iter().any(|g| g.text.is_none()) {
            result.undecodable_pages.push(number);
        }
        if needle.is_empty() {
            continue;
        }
        read += chars.len();
        if read > max_chars {
            result.truncated = true;
            result.unsearched_pages.push(number);
            continue;
        }
        let vb = VisibleBox::of_page(&doc, page);
        let mut rects = Vec::new();
        for at in find_starts(&chars, &needle, options.whole_word) {
            let mut matched: Vec<usize> = chars[at..at + needle.len()].iter().filter_map(|c| c.glyph).collect();
            matched.dedup();
            let mut by_line: Vec<(usize, Vec<usize>)> = Vec::new();
            for g in matched {
                match by_line.iter_mut().find(|(l, _)| *l == lines[g]) {
                    Some((_, list)) => list.push(g),
                    None => by_line.push((lines[g], vec![g])),
                }
            }
            let found: Vec<[f64; 4]> = by_line
                .into_iter()
                .filter_map(|(_, list)| union(list.iter().map(|&g| glyphs[g].box_user)))
                .map(|r| to_visible(&vb, &r))
                .collect();
            // A match is marked whole or not at all.
            if total + rects.len() + found.len() > MAX_RECTS {
                result.truncated = true;
                result.unsearched_pages.push(number);
                break;
            }
            rects.extend(found);
        }
        if !rects.is_empty() {
            total += rects.len();
            result.pages.push(PageHits { page: number, rects });
        }
    }
    Ok(result)
}
