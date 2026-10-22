//! Lines of positioned glyph runs: fallback, bidi, shaping, breaking and
//! placement put together.
//!
//! Per paragraph: each character gets a face; the paragraph is shaped once in
//! logical runs (same face, same direction) to measure cluster widths; lines
//! are broken on those widths; each line is then reordered (bidi) and shaped
//! again in visual runs, so line edges get their own forms.

use super::bidi::Paragraph;
use super::breaks::break_lines;
use super::shape::{ShapedGlyph, shape};
use super::{Face, Glyph, Layout, LayoutError, LayoutParams, Line, Run, ShapeBudget};
use crate::edit_ops::Align;
use std::ops::Range;

/// Characters that end a paragraph (CR LF counts once).
const PARAGRAPH_SEPARATORS: [char; 7] = ['\n', '\r', '\u{B}', '\u{C}', '\u{85}', '\u{2028}', '\u{2029}'];

/// Lays `text` out in a box `p.width` wide with `faces` (family first, then
/// fallbacks). Lines are not clipped to a box height; the caller decides.
pub(crate) fn layout_text(
    faces: &[Face],
    text: &str,
    p: &LayoutParams,
    budget: &mut ShapeBudget,
) -> Result<Layout, LayoutError> {
    let valid = p.size.is_finite()
        && p.size > 0.0
        && p.width.is_finite()
        && p.width >= 0.0
        && p.line_height.is_finite()
        && p.line_height > 0.0;
    if !valid {
        return Err(LayoutError::Params);
    }
    let family = faces.first().ok_or(LayoutError::BadFont(0))?;
    let first_baseline = family.ascender() * p.size / family.units_per_em();
    let mut layout = Layout::default();
    let normalized = text.replace("\r\n", "\n");
    for raw in normalized.split(PARAGRAPH_SEPARATORS) {
        // Tabs and other ASCII controls show as spaces (same byte length).
        let para: String = raw.chars().map(|c| if c.is_ascii_control() { ' ' } else { c }).collect();
        for line in layout_paragraph(faces, &para, p, budget, &mut layout.missing)? {
            let baseline_y = first_baseline + layout.lines.len() as f64 * p.line_height * p.size;
            layout.lines.push(Line { baseline_y, ..line });
        }
    }
    Ok(layout)
}

/// Lines of one paragraph, `baseline_y` left at 0.
fn layout_paragraph(
    faces: &[Face],
    para: &str,
    p: &LayoutParams,
    budget: &mut ShapeBudget,
    missing: &mut Vec<char>,
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
        for g in shape(&faces[face], para, run, 0..para.len(), rtl, budget)? {
            if let (Some(a), Some(s)) = (advance.get_mut(g.cluster), cluster_start.get_mut(g.cluster)) {
                *a += f64::from(g.x_advance) * scale(face);
                *s = true;
            }
        }
    }

    let mut lines = Vec::new();
    for range in break_lines(para, &advance, &cluster_start, p.width) {
        let mut runs = Vec::new();
        for (visual, rtl) in bidi.visual_runs(range.clone()) {
            let mut pieces = split_runs(para, visual, |b| face_at[b]);
            if rtl {
                pieces.reverse();
            }
            for piece in pieces {
                let face = face_at[piece.start];
                let shaped = shape(&faces[face], para, piece.clone(), range.clone(), rtl, budget)?;
                runs.push(Run { face, rtl, glyphs: to_glyphs(para, piece, &shaped, rtl, scale(face)) });
            }
        }
        let width: f64 = runs.iter().flat_map(|r| r.glyphs.iter()).map(|g| g.x_advance).sum();
        let align = p.align.unwrap_or(if bidi.rtl() { Align::Right } else { Align::Left });
        let x = match align {
            Align::Left => 0.0,
            Align::Center => (p.width - width) / 2.0,
            Align::Right => p.width - width,
        };
        lines.push(Line { x, baseline_y: 0.0, width, rtl: bidi.rtl(), runs });
    }
    Ok(lines)
}

/// The face of each byte of `para` (the bytes of one character share it).
///
/// A character goes to the first face that covers it (spec 1.2), except that
/// whitespace, combining marks and invisible format characters stay in the
/// previous character's face when it covers them (or when nothing does), so a
/// mark shapes with its base and a space stays inside its word run.
/// Characters no face covers use the previous face, else face 0, and are
/// added to `missing` (format characters excepted: they draw nothing).
fn assign_faces(faces: &[Face], para: &str, missing: &mut Vec<char>) -> Vec<usize> {
    let mut out = Vec::with_capacity(para.len());
    let mut prev: Option<usize> = None;
    for c in para.chars() {
        let sticky = c.is_whitespace() || is_mark(c) || is_format(c);
        let first_cover = faces.iter().position(|f| f.covers(c));
        let face = match prev {
            Some(p) if sticky && (faces[p].covers(c) || first_cover.is_none()) => p,
            _ => match first_cover {
                Some(i) => i,
                None => {
                    if !is_format(c) && !c.is_whitespace() && !missing.contains(&c) {
                        missing.push(c);
                    }
                    prev.unwrap_or(0)
                }
            },
        };
        prev = Some(face);
        out.extend(std::iter::repeat_n(face, c.len_utf8()));
    }
    out
}

/// Nonspacing and enclosing marks (bidi class NSM covers Mn and Me).
fn is_mark(c: char) -> bool {
    unicode_bidi::bidi_class(c) == unicode_bidi::BidiClass::NSM
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
