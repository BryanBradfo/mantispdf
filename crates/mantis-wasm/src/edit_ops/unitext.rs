//! Text boxes with embedded (Noto) fonts: the `unifont` layout placed in a
//! box, clipped to its height like the standard-font boxes, and the same
//! layout handed to the editor preview (`preview_layout`), so the preview's
//! lines are the PDF's lines.

use super::{Align, MAX_FONT_SIZE, MAX_LINE_HEIGHT, MAX_TEXT_CHARS, MIN_FONT_SIZE, MIN_LINE_HEIGHT, invalid};
use crate::stamp::engine::MAX_COORD;
use crate::unifont::{Face, LayoutParams, Line, ShapeBudget, layout_text, load_faces};

/// One line of a box, with the PDF origin of its pen (visible space).
#[derive(Debug, Clone)]
pub(crate) struct PlacedLine {
    pub origin: (f64, f64),
    pub line: Line,
}

/// Lines of `text` laid out in `rect` (`[x, y, w, h]`, visible space) with
/// `chain` (family first). The first line is always kept; a later one whose
/// descender would go below the box bottom is dropped, with every line after
/// it (as for the standard fonts). Empty lines are not returned.
pub(crate) fn place_lines(
    chain: &[&Face],
    rect: [f64; 4],
    text: &str,
    size: f64,
    align: Option<Align>,
    line_height: f64,
    budget: &mut ShapeBudget,
) -> Result<Vec<PlacedLine>, String> {
    let [x, y, w, h] = rect;
    let (lines, _) = visible_lines(chain, text, size, w, h, align, line_height, budget)?;
    let top = y + h;
    Ok(lines
        .into_iter()
        .filter(|l| !l.runs.is_empty())
        .map(|line| PlacedLine { origin: (x + line.x, top - line.baseline_y), line })
        .collect())
}

/// The layout's lines that fit a box `height` tall (see `place_lines`), and
/// the characters no font covers.
#[allow(clippy::too_many_arguments)]
fn visible_lines(
    chain: &[&Face],
    text: &str,
    size: f64,
    width: f64,
    height: f64,
    align: Option<Align>,
    line_height: f64,
    budget: &mut ShapeBudget,
) -> Result<(Vec<Line>, Vec<char>), String> {
    let family = chain.first().ok_or_else(|| invalid("font"))?;
    let params = LayoutParams { size, width, align, line_height };
    let layout = layout_text(chain, text, &params, budget).map_err(|e| invalid(e.field()))?;
    let descent = f64::from(family.hb.descender()) * size / family.units_per_em();
    let mut out = Vec::new();
    for (i, line) in layout.lines.into_iter().enumerate() {
        if i > 0 && line.baseline_y - descent > height {
            break;
        }
        out.push(line);
    }
    Ok((out, layout.missing))
}

/// One run of a preview line: drawn with font `face` (index into the fonts
/// given), `text` in reading order, starting `x` points from the box's left
/// edge and `width` wide.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PreviewRun {
    pub face: usize,
    pub rtl: bool,
    pub x: f64,
    pub width: f64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PreviewLine {
    /// From the box's top down to the baseline.
    pub baseline_y: f64,
    pub runs: Vec<PreviewRun>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) struct PreviewLayout {
    pub lines: Vec<PreviewLine>,
    /// Characters no font covers, once each.
    pub missing: String,
}

/// The lines the PDF will hold for a box `width` x `height` (points), for the
/// editor preview: `fonts` in chain order (family first). Same checks and
/// limits as an edit job's text item.
#[allow(clippy::too_many_arguments)]
pub(crate) fn preview_layout(
    fonts: &[&[u8]],
    text: &str,
    size: f64,
    width: f64,
    height: f64,
    align: Option<Align>,
    line_height: f64,
) -> Result<PreviewLayout, String> {
    let dimension = |v: f64| v.is_finite() && v > 0.0 && v <= MAX_COORD;
    if !dimension(width) || !dimension(height) {
        return Err(invalid("rect"));
    }
    if !(MIN_FONT_SIZE..=MAX_FONT_SIZE).contains(&size) {
        return Err(invalid("size"));
    }
    if !(MIN_LINE_HEIGHT..=MAX_LINE_HEIGHT).contains(&line_height) {
        return Err(invalid("line_height"));
    }
    if text.chars().nth(MAX_TEXT_CHARS).is_some() {
        return Err(invalid("text"));
    }
    let faces = load_faces(fonts).map_err(|e| invalid(e.field()))?;
    let chain: Vec<&Face> = faces.iter().collect();
    let mut budget = ShapeBudget::per_job();
    let (lines, missing) = visible_lines(&chain, text, size, width, height, align, line_height, &mut budget)?;
    let missing: String = missing.into_iter().collect();
    let lines = lines
        .into_iter()
        .filter(|l| !l.runs.is_empty())
        .map(|line| {
            let mut x = line.x;
            let runs = line
                .runs
                .iter()
                .map(|run| {
                    let width: f64 = run.glyphs.iter().map(|g| g.x_advance).sum();
                    let texts = run.glyphs.iter().map(|g| g.cluster_text.as_str());
                    let text: String = if run.rtl { texts.rev().collect() } else { texts.collect() };
                    let out = PreviewRun { face: run.face, rtl: run.rtl, x, width, text };
                    x += width;
                    out
                })
                .collect();
            PreviewLine { baseline_y: line.baseline_y, runs }
        })
        .collect();
    Ok(PreviewLayout { lines, missing })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SANS: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fonts/NotoSans-subset.ttf"));
    const HEBREW: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fonts/NotoSansHebrew-subset.ttf"));
    const SC: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fonts/NotoSansSC-subset.ttf"));

    #[test]
    fn preview_is_the_placed_layout() {
        let fonts = [SANS, HEBREW, SC];
        let text = "Hi שלום 你好\nПривет мир Привет мир Привет мир";
        let preview = preview_layout(&fonts, text, 12.0, 120.0, 200.0, None, 1.2).unwrap();
        let faces = load_faces(&fonts).unwrap();
        let chain: Vec<&Face> = faces.iter().collect();
        let placed = place_lines(&chain, [10.0, 20.0, 120.0, 200.0], text, 12.0, None, 1.2, &mut ShapeBudget::per_job()).unwrap();
        assert_eq!(preview.lines.len(), placed.len());
        for (p, l) in preview.lines.iter().zip(&placed) {
            assert!((220.0 - p.baseline_y - l.origin.1).abs() < 1e-9);
            assert!((10.0 + p.runs[0].x - l.origin.0).abs() < 1e-9);
            assert_eq!(p.runs.len(), l.line.runs.len());
        }
        // Runs in visual order with their text in reading order and their face.
        let first = &preview.lines[0].runs;
        let texts: Vec<(&str, usize, bool)> = first.iter().map(|r| (r.text.as_str(), r.face, r.rtl)).collect();
        // The space between Hebrew and CJK resolves left-to-right: a run of its own.
        assert_eq!(texts, [("Hi ", 0, false), ("שלום", 1, true), (" ", 1, false), ("你好", 2, false)]);
        // Each run starts where the one before it ends.
        assert!((first[1].x - (first[0].x + first[0].width)).abs() < 1e-9);
        assert!(preview.missing.is_empty());
    }

    #[test]
    fn preview_reports_missing_and_checks_its_input() {
        let preview = preview_layout(&[SANS], "a😀", 12.0, 100.0, 100.0, Some(Align::Left), 1.2).unwrap();
        assert_eq!(preview.missing, "😀");
        assert_eq!(preview_layout(&[SANS], "a", 3.0, 100.0, 100.0, None, 1.2).unwrap_err(), "Invalid edit settings: size");
        assert_eq!(preview_layout(&[SANS], "a", 12.0, 0.0, 100.0, None, 1.2).unwrap_err(), "Invalid edit settings: rect");
        assert_eq!(preview_layout(&[SANS], "a", 12.0, 10.0, 10.0, None, 9.0).unwrap_err(), "Invalid edit settings: line_height");
        assert_eq!(preview_layout(&[b"junk"], "a", 12.0, 10.0, 10.0, None, 1.2).unwrap_err(), "Invalid edit settings: font");
        assert_eq!(preview_layout(&[], "a", 12.0, 10.0, 10.0, None, 1.2).unwrap_err(), "Invalid edit settings: font");
        let long = "a".repeat(MAX_TEXT_CHARS + 1);
        assert_eq!(preview_layout(&[SANS], &long, 12.0, 10.0, 10.0, None, 1.2).unwrap_err(), "Invalid edit settings: text");
    }
}
