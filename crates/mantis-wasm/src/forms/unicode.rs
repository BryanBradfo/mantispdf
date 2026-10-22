//! Text field values in embedded (Noto) fonts: values the standard fonts
//! cannot encode get appearances laid out by `unifont` (the field's Noto
//! family from its /DA style, with per-character fallback) and drawn with
//! subset Type0 fonts, one per face for the whole document.

use super::appearance::{COMB_PADDING, Frame, LEADING, Layout, MAX_AUTO_SIZE, MIN_AUTO_SIZE, PADDING, color_op, da_components, frame_content};
use super::invalid;
use super::tree::DefaultAppearance;
use crate::edit_ops::Align;
use crate::page_content::fmt_num;
use crate::unifont::{Embedder, Face, LayoutError, LayoutParams, Line, ShapeBudget, is_mark, layout_text, load_faces};
use lopdf::{Dictionary, Document, Object, ObjectId};
use std::collections::HashMap;

/// Width given to the layout of a line that never wraps (points).
const UNWRAPPED: f64 = 1.0e6;

/// The fonts of a fill job: font files, and for each field (by id) the faces
/// its values are drawn with.
#[derive(Debug, Clone, Default)]
pub struct FormFonts {
    pub files: Vec<Vec<u8>>,
    pub fields: HashMap<u32, FieldFont>,
}

/// A field's fonts: indices into `FormFonts::files`, family first; the
/// `fake_bold` ones are stroked (bold asked, no Bold file).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FieldFont {
    pub faces: Vec<usize>,
    pub fake_bold: Vec<usize>,
}

fn layout_error(e: LayoutError) -> String {
    match e {
        LayoutError::Budget | LayoutError::TooLong => invalid("value"),
        _ => invalid("font"),
    }
}

/// The faces of a job, an embedder writing their fonts, a shaping budget.
pub(crate) struct UnicodeFields<'f, 'a> {
    faces: &'f [Face<'a>],
    embedder: Embedder<'f, 'a>,
    budget: ShapeBudget,
}

/// Parses the job's font files (limits checked).
pub(crate) fn load(fonts: &FormFonts) -> Result<Vec<Face<'_>>, String> {
    let refs: Vec<&[u8]> = fonts.files.iter().map(Vec::as_slice).collect();
    load_faces(&refs).map_err(|_| invalid("font"))
}

impl<'f, 'a> UnicodeFields<'f, 'a> {
    pub(crate) fn new(faces: &'f [Face<'a>]) -> Self {
        UnicodeFields { faces, embedder: Embedder::new(faces), budget: ShapeBudget::per_job() }
    }

    /// Writes the fonts used (call once, after every appearance).
    pub(crate) fn finish(self, doc: &mut Document) -> Result<(), String> {
        self.embedder.finish(doc).map_err(layout_error)
    }

    fn lay(&mut self, chain: &[usize], text: &str, size: f64, width: f64, align: Align) -> Result<Vec<Line>, String> {
        let faces: Vec<&Face> = chain.iter().map(|&i| &self.faces[i]).collect();
        let params = LayoutParams { size, width, align: Some(align), line_height: LEADING };
        let mut layout = layout_text(&faces, text, &params, &mut self.budget).map_err(layout_error)?;
        // Runs index the job's faces.
        for line in &mut layout.lines {
            for run in &mut line.runs {
                run.face = chain[run.face];
            }
        }
        Ok(layout.lines)
    }

    /// Width of `text` on one line at `size`.
    fn width(&mut self, chain: &[usize], text: &str, size: f64) -> Result<f64, String> {
        Ok(self.lay(chain, text, size, UNWRAPPED, Align::Left)?.iter().map(|l| l.width).fold(0.0, f64::max))
    }

    /// Ascent and descent (points, descent negative) of the family at `size`.
    fn metrics(&self, chain: &[usize], size: f64) -> (f64, f64) {
        let family = &self.faces[chain[0]];
        let k = size / family.units_per_em();
        (family.ascender() * k, f64::from(family.hb.descender()) * k)
    }

    /// Content of a text field (or combo box) showing `text` in `font`'s
    /// faces, laid out like the standard-font appearance (`text_appearance`).
    /// The fonts drawn are added to `resources` (a /Font dictionary).
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn text_appearance(
        &mut self,
        doc: &mut Document,
        frame: &Frame,
        da: &DefaultAppearance,
        align: u8,
        layout: Layout,
        text: &str,
        font: &FieldFont,
        resources: &mut Dictionary,
    ) -> Result<Vec<u8>, String> {
        let chain = font.faces.as_slice();
        if chain.is_empty() || chain.iter().any(|&i| i >= self.faces.len()) {
            return Err(invalid("font"));
        }
        let (w, h) = (frame.width, frame.height);
        // (line, pen origin) pairs and the size they are drawn at.
        let mut placed: Vec<(Line, (f64, f64))> = Vec::new();
        let size;
        match layout {
            Layout::Single => {
                size = if da.size > 0.0 {
                    da.size
                } else {
                    let unit = self.width(chain, text, 10.0)? / 10.0;
                    let by_height = h * 0.75;
                    let by_width = if unit > 0.0 { (w - 2.0 * PADDING) / unit } else { f64::INFINITY };
                    by_height.min(by_width).max(MIN_AUTO_SIZE.min(by_height))
                };
                let (asc, desc) = self.metrics(chain, size);
                let y = (h - (asc - desc)) / 2.0 - desc;
                for line in self.lay(chain, text, size, UNWRAPPED, Align::Left)? {
                    let x = aligned_x(align, w, line.width, PADDING);
                    placed.push((line, (x, y)));
                }
            }
            Layout::Comb(cells) => {
                let cells = cells.max(1);
                let cell = w / f64::from(cells);
                let graphemes: Vec<&str> = graphemes(text).into_iter().take(cells as usize).collect();
                size = if da.size > 0.0 {
                    da.size
                } else {
                    let mut widest: f64 = 0.0;
                    for g in &graphemes {
                        widest = widest.max(self.width(chain, g, 10.0)? / 10.0);
                    }
                    let by_width = if widest > 0.0 { (cell - 2.0 * COMB_PADDING) / widest } else { f64::INFINITY };
                    (h * 0.75).min(by_width).max(MIN_AUTO_SIZE.min(h * 0.75))
                };
                let (asc, desc) = self.metrics(chain, size);
                let y = (h - (asc - desc)) / 2.0 - desc;
                for (i, g) in graphemes.iter().enumerate() {
                    for line in self.lay(chain, g, size, UNWRAPPED, Align::Left)? {
                        let x = i as f64 * cell + (cell - line.width) / 2.0;
                        placed.push((line, (x, y)));
                    }
                }
            }
            Layout::Multiline => {
                let avail = w - 2.0 * PADDING;
                let q = match align {
                    1 => Align::Center,
                    2 => Align::Right,
                    _ => Align::Left,
                };
                let (s, lines) = if da.size > 0.0 {
                    (da.size, self.lay(chain, text, da.size, avail, q)?)
                } else {
                    let mut chosen = None;
                    let mut s = MAX_AUTO_SIZE;
                    while s >= MIN_AUTO_SIZE {
                        let lines = self.lay(chain, text, s, avail, q)?;
                        let (_, desc) = self.metrics(chain, s);
                        let bottom = lines.last().map_or(0.0, |l| l.baseline_y) - desc;
                        if 2.0 * PADDING + bottom <= h {
                            chosen = Some((s, lines));
                            break;
                        }
                        s -= 1.0;
                    }
                    match chosen {
                        Some(c) => c,
                        None => (MIN_AUTO_SIZE, self.lay(chain, text, MIN_AUTO_SIZE, avail, q)?),
                    }
                };
                size = s;
                for line in lines {
                    let origin = (PADDING + line.x, h - PADDING - line.baseline_y);
                    placed.push((line, origin));
                }
            }
        }

        let fill = color_op(&da_components(da.color), false).unwrap_or_else(|| "0 g".into());
        let stroke = color_op(&da_components(da.color), true).unwrap_or_else(|| "0 G".into());
        let mut names: HashMap<ObjectId, String> = HashMap::new();
        let mut body = String::new();
        for (line, origin) in &placed {
            if line.runs.is_empty() {
                continue;
            }
            let mut name = |_: usize, id: ObjectId| {
                names
                    .entry(id)
                    .or_insert_with(|| {
                        let n = format!("NF{}", resources.len() + 1);
                        resources.set(n.clone(), Object::Reference(id));
                        n
                    })
                    .clone()
            };
            let shown = self
                .embedder
                .show_line(doc, line, *origin, size, &|f| font.fake_bold.contains(&f), &mut name)
                .map_err(layout_error)?;
            body.push_str(&shown);
        }
        let mut out = frame_content(frame);
        out.extend(
            format!("/Tx BMC\nq\n1 1 {} {} re W n\n{fill}\n{stroke}\n{body}Q\nEMC\n", fmt_num(w - 2.0), fmt_num(h - 2.0))
                .into_bytes(),
        );
        Ok(out)
    }
}

fn aligned_x(align: u8, width: f64, line_width: f64, padding: f64) -> f64 {
    match align {
        1 => (width - line_width) / 2.0,
        2 => width - padding - line_width,
        _ => padding,
    }
}

/// `text` cut into user-perceived characters for comb cells: each character
/// with the combining marks and joiners after it (an approximation of
/// extended grapheme clusters: emoji sequences and Hangul jamo are not
/// joined).
pub(crate) fn graphemes(text: &str) -> Vec<&str> {
    let mut out: Vec<&str> = Vec::new();
    let mut start = None;
    let mut joined = false;
    for (i, c) in text.char_indices() {
        let attaches = is_mark(c) || matches!(c, '\u{200C}' | '\u{200D}' | '\u{FE00}'..='\u{FE0F}') || joined;
        joined = c == '\u{200D}' || (c == '\u{094D}');
        match start {
            Some(_) if attaches => {}
            Some(s) => {
                out.push(&text[s..i]);
                start = Some(i);
            }
            None => start = Some(i),
        }
    }
    if let Some(s) = start {
        out.push(&text[s..]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn graphemes_keep_marks_and_conjuncts() {
        assert_eq!(graphemes("abc"), ["a", "b", "c"]);
        assert_eq!(graphemes("e\u{301}x"), ["e\u{301}", "x"]);
        // Devanagari: a virama joins the next consonant (क्ष is one cell).
        assert_eq!(graphemes("क्षमा"), ["क्ष", "मा"]);
        assert_eq!(graphemes("ที่นี่"), ["ที่", "นี่"]);
        assert_eq!(graphemes(""), Vec::<&str>::new());
    }
}
