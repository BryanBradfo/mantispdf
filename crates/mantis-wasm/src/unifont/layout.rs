//! Lines of positioned glyph runs: fallback, bidi, shaping, breaking and
//! placement put together.
//!
//! Per paragraph: each character gets a face; the paragraph is shaped once in
//! logical runs (same face, same direction) to measure cluster widths; lines
//! are broken on those widths; each line is then reordered (bidi) and shaped
//! again in visual runs, so line edges get their own forms; a reshaped line
//! wider than the box (edge forms are wider than the measured middle forms)
//! is shortened until it fits, keeping at least one cluster.

use super::bidi::Paragraph;
use super::breaks::{Breaker, EPS};
use super::marks::is_mark;
use super::shape::{ShapedGlyph, shape};
use super::{Face, Glyph, Layout, LayoutError, LayoutParams, Line, MAX_LAYOUT_CHARS, Run, ShapeBudget};
use crate::edit_ops::Align;
use std::borrow::Borrow;
use std::collections::HashSet;
use std::ops::Range;

/// Characters that end a paragraph (CR LF counts once).
const PARAGRAPH_SEPARATORS: [char; 7] = ['\n', '\r', '\u{B}', '\u{C}', '\u{85}', '\u{2028}', '\u{2029}'];

/// Lays `text` out in a box `p.width` wide with `faces` (family first, then
/// fallbacks). Lines are not clipped to a box height; the caller decides.
/// The first baseline sits the tallest ascender of the faces on the first
/// line below the top (the family's for an empty line), the others
/// `line_height * size` apart.
pub(crate) fn layout_text<'a, F: Borrow<Face<'a>>>(
    faces: &[F],
    text: &str,
    p: &LayoutParams,
    budget: &mut ShapeBudget,
) -> Result<Layout, LayoutError> {
    let faces: Vec<&Face> = faces.iter().map(Borrow::borrow).collect();
    let faces = faces.as_slice();
    if text.chars().nth(MAX_LAYOUT_CHARS).is_some() {
        return Err(LayoutError::TooLong);
    }
    let valid = p.size.is_finite()
        && p.size > 0.0
        && p.width.is_finite()
        && p.width >= 0.0
        && p.line_height.is_finite()
        && p.line_height > 0.0;
    if !valid {
        return Err(LayoutError::Params);
    }
    if faces.is_empty() {
        return Err(LayoutError::BadFont(0));
    }
    let mut layout = Layout::default();
    let mut missing = Missing::default();
    let normalized = text.replace("\r\n", "\n");
    for raw in normalized.split(PARAGRAPH_SEPARATORS) {
        // Tabs and other ASCII controls show as spaces (same byte length).
        let para: String = raw.chars().map(|c| if c.is_ascii_control() { ' ' } else { c }).collect();
        layout.lines.extend(layout_paragraph(faces, &para, p, budget, &mut missing)?);
    }
    let ascent = |f: usize| faces[f].ascender() * p.size / faces[f].units_per_em();
    let first_runs = layout.lines.first().map_or(&[][..], |l| l.runs.as_slice());
    let first_baseline = first_runs.iter().map(|r| ascent(r.face)).fold(None, |m: Option<f64>, a| Some(m.map_or(a, |m| m.max(a))));
    let first_baseline = first_baseline.unwrap_or_else(|| ascent(0));
    for (i, line) in layout.lines.iter_mut().enumerate() {
        line.baseline_y = first_baseline + i as f64 * p.line_height * p.size;
    }
    layout.missing = missing.order;
    Ok(layout)
}

/// Characters no face covers, once each, in text order.
#[derive(Default)]
struct Missing {
    seen: HashSet<char>,
    order: Vec<char>,
}

impl Missing {
    fn add(&mut self, c: char) {
        if self.seen.insert(c) {
            self.order.push(c);
        }
    }
}

/// Lines of one paragraph, `baseline_y` left at 0.
fn layout_paragraph(
    faces: &[&Face],
    para: &str,
    p: &LayoutParams,
    budget: &mut ShapeBudget,
    missing: &mut Missing,
) -> Result<Vec<Line>, LayoutError> {
    let bidi = Paragraph::new(para);
    let face_at = assign_faces(faces, para, missing);
    let scale = |face: usize| p.size / faces[face].units_per_em();

    // Measure: shape logical runs, note each cluster's width.
    let mut advance = vec![0.0; para.len()];
    let mut cluster_start = vec![false; para.len()];
    for run in split_runs(para, 0..para.len(), |b| (face_at[b], bidi.rtl_at(b))) {
        let (face, rtl) = (face_at[run.start], bidi.rtl_at(run.start));
        cluster_start[run.start] = true;
        for g in shape(faces[face], para, run, 0..para.len(), rtl, budget)? {
            if let (Some(a), Some(s)) = (advance.get_mut(g.cluster), cluster_start.get_mut(g.cluster)) {
                *a += f64::from(g.x_advance) * scale(face);
                *s = true;
            }
        }
    }

    let breaker = Breaker::new(para, &advance, &cluster_start, p.width);
    let mut lines = Vec::new();
    let mut from = 0;
    loop {
        let (mut range, mut next) = breaker.next_line(from);
        let mut runs = shape_line(faces, para, &bidi, &face_at, range.clone(), p, budget)?;
        // Edge forms can make the reshaped line wider than measured.
        while runs_width(&runs) > p.width + EPS {
            let Some(cut) = breaker.shorter(&range) else { break };
            range = range.start..breaker.trim(range.start, cut);
            next = breaker.skip_blanks(cut);
            runs = shape_line(faces, para, &bidi, &face_at, range.clone(), p, budget)?;
        }
        let width = runs_width(&runs);
        let align = p.align.unwrap_or(if bidi.rtl() { Align::Right } else { Align::Left });
        let x = match align {
            Align::Left => 0.0,
            Align::Center => (p.width - width) / 2.0,
            Align::Right => p.width - width,
        };
        lines.push(Line { x, baseline_y: 0.0, width, rtl: bidi.rtl(), runs });
        if next >= para.len() || next <= from {
            break;
        }
        from = next;
    }
    Ok(lines)
}

fn runs_width(runs: &[Run]) -> f64 {
    runs.iter().flat_map(|r| r.glyphs.iter()).map(|g| g.x_advance).sum()
}

/// The runs of the line `range` of `para`: bidi visual runs, split by face,
/// each shaped with the line as context. Visual order, left to right.
fn shape_line(
    faces: &[&Face],
    para: &str,
    bidi: &Paragraph,
    face_at: &[usize],
    range: Range<usize>,
    p: &LayoutParams,
    budget: &mut ShapeBudget,
) -> Result<Vec<Run>, LayoutError> {
    let mut runs = Vec::new();
    for (visual, rtl) in bidi.visual_runs(range.clone()) {
        let mut pieces = split_runs(para, visual, |b| face_at[b]);
        if rtl {
            pieces.reverse();
        }
        for piece in pieces {
            let face = face_at[piece.start];
            let shaped = shape(faces[face], para, piece.clone(), range.clone(), rtl, budget)?;
            let scale = p.size / faces[face].units_per_em();
            runs.push(Run { face, rtl, glyphs: to_glyphs(para, piece, &shaped, rtl, scale) });
        }
    }
    Ok(runs)
}

/// The face of each byte of `para` (the bytes of one character share it).
///
/// A character goes to the first face that covers it (spec 1.2), except:
/// - a combining mark (Mn, Mc, Me) stays with its base's face when that face
///   has it; otherwise its base (with the marks before it) moves to the
///   first face that has them all; failing that, the mark goes to the first
///   face that has it;
/// - whitespace and invisible format characters stay in the previous
///   character's face when it covers them (or when nothing does), so a space
///   stays inside its word run.
///
/// Characters no face covers use the previous face, else face 0, and are
/// added to `missing` (whitespace and format characters excepted).
fn assign_faces(faces: &[&Face], para: &str, missing: &mut Missing) -> Vec<usize> {
    let mut out: Vec<usize> = Vec::with_capacity(para.len());
    let mut prev: Option<usize> = None;
    // The current base character and its marks so far, from byte `cluster_at`.
    let mut cluster: Vec<char> = Vec::new();
    let mut cluster_at = 0;
    for (at, c) in para.char_indices() {
        let mark = is_mark(c);
        let first_cover = || faces.iter().position(|f| f.covers(c));
        let uncovered = |missing: &mut Missing, fallback: usize| {
            if !is_format(c) && !c.is_whitespace() {
                missing.add(c);
            }
            fallback
        };
        let face = match prev {
            Some(p) if mark && !cluster.is_empty() => {
                if faces[p].covers(c) {
                    p
                } else if let Some(f) = faces.iter().position(|f| f.covers(c) && cluster.iter().all(|&b| f.covers(b))) {
                    out[cluster_at..].fill(f);
                    f
                } else {
                    first_cover().unwrap_or_else(|| uncovered(missing, p))
                }
            }
            Some(p) if (c.is_whitespace() || is_format(c)) && (faces[p].covers(c) || first_cover().is_none()) => p,
            _ => first_cover().unwrap_or_else(|| uncovered(missing, prev.unwrap_or(0))),
        };
        if mark && !cluster.is_empty() {
            cluster.push(c);
        } else {
            cluster.clear();
            cluster.push(c);
            cluster_at = at;
        }
        prev = Some(face);
        out.extend(std::iter::repeat_n(face, c.len_utf8()));
    }
    out
}

/// Invisible format characters that join, select variants or steer bidi.
fn is_format(c: char) -> bool {
    matches!(c, '\u{AD}' | '\u{34F}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2069}'
        | '\u{FE00}'..='\u{FE0F}' | '\u{FEFF}' | '\u{E0100}'..='\u{E01EF}')
}

/// Splits `range` of `text` into maximal ranges whose characters share `key(byte)`.
fn split_runs<K: PartialEq>(text: &str, range: Range<usize>, key: impl Fn(usize) -> K) -> Vec<Range<usize>> {
    let mut runs = Vec::new();
    let mut current: Option<(K, usize)> = None;
    for (i, _) in text[range.clone()].char_indices() {
        let at = range.start + i;
        let k = key(at);
        if current.as_ref().is_some_and(|(ck, _)| *ck == k) {
            continue;
        }
        if let Some((_, start)) = current.replace((k, at)) {
            runs.push(start..at);
        }
    }
    if let Some((_, start)) = current {
        runs.push(start..range.end);
    }
    runs
}

/// Shaped glyphs of `piece` in points, each cluster's text on its first glyph
/// in logical order (the last in visual order for RTL).
fn to_glyphs(text: &str, piece: Range<usize>, shaped: &[ShapedGlyph], rtl: bool, scale: f64) -> Vec<Glyph> {
    let mut starts: Vec<usize> = shaped.iter().map(|g| g.cluster).filter(|c| piece.contains(c)).collect();
    starts.sort_unstable();
    starts.dedup();
    let mut glyphs: Vec<Glyph> = shaped
        .iter()
        .map(|g| Glyph {
            gid: g.gid,
            x_advance: f64::from(g.x_advance) * scale,
            x_offset: f64::from(g.x_offset) * scale,
            y_offset: f64::from(g.y_offset) * scale,
            cluster_text: String::new(),
        })
        .collect();
    let mut given = vec![false; starts.len()];
    let mut give = |i: usize| {
        let c = shaped[i].cluster;
        let Ok(k) = starts.binary_search(&c) else { return };
        if given[k] || !text.is_char_boundary(c) {
            return;
        }
        given[k] = true;
        // The first cluster also takes any leading bytes, so the texts cover the piece.
        let begin = if k == 0 { piece.start } else { c };
        let end = starts.get(k + 1).copied().unwrap_or(piece.end);
        glyphs[i].cluster_text = text[begin..end].to_string();
    };
    if rtl {
        (0..shaped.len()).rev().for_each(&mut give);
    } else {
        (0..shaped.len()).for_each(&mut give);
    }
    glyphs
}
