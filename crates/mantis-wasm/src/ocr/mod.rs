//! OCR text layer: recognised words added to scanned pages as invisible,
//! selectable and searchable text, the way Tesseract's own PDF renderer
//! does it (render mode 3 text in the glyphless font, each word stretched
//! with `Tz` over the box it was read from).
//!
//! Words are given in visible page space (see `stamp::geometry`). The new
//! text goes in an isolated `q .. Q` appended to each page with its own
//! resources (`stamp::page_writer`); the original content and anything
//! other pages share are left as they are.

pub(crate) mod binding;
pub(crate) mod existing;
pub(crate) mod font;
pub(crate) mod job;
pub(crate) mod layer;
#[cfg(test)]
mod tests;

use crate::pdf_util::{load_pdf, save_pdf};
use crate::stamp::engine::MAX_COORD;
use crate::stamp::geometry::VisibleBox;
use crate::stamp::page_writer::DocWriter;
use font::Cids;
use lopdf::ObjectId;
use std::collections::HashMap;

/// Page entries per job.
pub(crate) const MAX_PAGES: usize = 2000;
/// Words per page entry.
pub(crate) const MAX_WORDS: usize = 200_000;
/// Words per job, all pages together.
pub(crate) const MAX_JOB_WORDS: usize = 2_000_000;
/// Smallest box width and height (points): a word's font size and `Tz`
/// stay positive numbers.
pub(crate) const MIN_BOX: f64 = 0.01;
/// UTF-16 units of one word's text.
pub(crate) const MAX_WORD_UNITS: usize = 200;

/// One recognised word. `[x, y, w, h]` is its box in visible page space
/// (points, origin bottom-left); `baseline` its baseline's y there, when
/// the recogniser knows it.
#[derive(Debug, Clone, PartialEq)]
pub struct OcrWord {
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub baseline: Option<f64>,
    /// A space follows on the same line: a space glyph is drawn from the
    /// word's end to the next word's start (0.25 em when that gap is not
    /// known), so extractors and search read the words apart.
    pub space_after: bool,
    /// The word's baseline is turned this many degrees counter-clockwise
    /// (visible space) about its box's bottom-left corner `(x, y)`; the box
    /// `w` x `h` is the word's own size along and across that baseline
    /// (a deskewed word). None: upright.
    pub angle: Option<f64>,
}

/// The words of one page (1-based).
#[derive(Debug, Clone, PartialEq)]
pub struct OcrPage {
    pub page: u32,
    pub words: Vec<OcrWord>,
}

pub(crate) fn invalid(field: &str) -> String {
    format!("Invalid OCR settings: {field}")
}

/// What `add_text_layer_report` did.
#[derive(Debug, Clone, PartialEq)]
pub struct TextLayerResult {
    pub bytes: Vec<u8>,
    /// Pages with words that were left alone: they already had an OCR layer.
    pub already_ocr_pages: Vec<u32>,
}

/// `pdf` with the words of `pages` added as an invisible text layer (the
/// tests' shorthand for `add_text_layer_report`).
#[cfg(test)]
pub fn add_text_layer(pdf: &[u8], pages: &[OcrPage]) -> Result<Vec<u8>, String> {
    add_text_layer_report(pdf, pages).map(|r| r.bytes)
}

/// `pdf` with the words of `pages` added as an invisible text layer.
/// Words with blank text are skipped; pages without words are not touched,
/// nor are pages that already have an OCR layer (`existing`): those are
/// listed in `already_ocr_pages`.
pub fn add_text_layer_report(pdf: &[u8], pages: &[OcrPage]) -> Result<TextLayerResult, String> {
    validate_shape(pages)?;
    let mut doc = load_pdf(pdf)?;
    let page_ids: Vec<ObjectId> = doc.get_pages().into_values().collect();
    validate(pages, page_ids.len())?;
    let mut already_ocr_pages = Vec::new();
    let mut budget = crate::redact::Budget::page(crate::redact::JOB_DECODED);

    // Encode every word first: the document's one font maps every code any
    // page uses. A page object listed more than once in the tree gets one
    // plan with the words of each of its entries.
    let mut cids = Cids::default();
    let mut plans: Vec<(ObjectId, Vec<layer::Placed>)> = Vec::new();
    let mut plan_of: HashMap<ObjectId, usize> = HashMap::new();
    for entry in pages {
        let page_id = page_ids[entry.page as usize - 1];
        let matrix = VisibleBox::of_page(&doc, page_id).matrix();
        let words: Vec<&OcrWord> = entry.words.iter().filter(|w| !w.text.trim().is_empty()).collect();
        if words.is_empty() {
            continue;
        }
        // Checked on the document as loaded (nothing is written before every page is planned).
        if existing::has_ocr_layer(&doc, page_id, &mut budget) {
            already_ocr_pages.push(entry.page);
            continue;
        }
        if words.iter().any(|w| w.space_after) {
            cids.encode(" ");
        }
        let mut placed: Vec<layer::Placed> = words
            .iter()
            .enumerate()
            .map(|(i, w)| layer::place(w, cids.encode(&w.text), words.get(i + 1).copied(), &matrix))
            .collect();
        if placed.is_empty() {
            continue;
        }
        let i = *plan_of.entry(page_id).or_insert_with(|| {
            plans.push((page_id, Vec::new()));
            plans.len() - 1
        });
        plans[i].1.append(&mut placed);
    }
    if plans.is_empty() {
        return Ok(TextLayerResult { bytes: save_pdf(&mut doc)?, already_ocr_pages });
    }

    let font_id = font::add_font(&mut doc, &cids);
    let mut writer = DocWriter::new();
    for (page_id, words) in &plans {
        let mut pw = writer.page(&doc, *page_id)?;
        let name = pw.font_object(font_id, "FOcr");
        layer::write_ops(&name, words, &mut pw.ops);
        pw.finish_compressed(&mut doc, &mut writer)?;
    }
    Ok(TextLayerResult { bytes: save_pdf(&mut doc)?, already_ocr_pages })
}

/// The limits that do not need the document: checked before parsing it.
fn validate_shape(pages: &[OcrPage]) -> Result<(), String> {
    job::check_counts(pages.len(), pages.iter().map(|p| p.words.len()))
}

fn validate(pages: &[OcrPage], total: usize) -> Result<(), String> {
    let coord = |v: f64| v.is_finite() && v.abs() <= MAX_COORD;
    let size = |v: f64| v.is_finite() && (MIN_BOX..=2.0 * MAX_COORD).contains(&v);
    let mut seen = std::collections::HashSet::new();
    for p in pages {
        if !(1..=total).contains(&(p.page as usize)) || !seen.insert(p.page) {
            return Err(invalid("page"));
        }
        for w in &p.words {
            if w.text.encode_utf16().count() > MAX_WORD_UNITS {
                return Err(invalid("text"));
            }
            if !(coord(w.x) && coord(w.y) && size(w.w) && size(w.h)) {
                return Err(invalid("box"));
            }
            if w.baseline.is_some_and(|b| !coord(b)) {
                return Err(invalid("baseline"));
            }
            if w.angle.is_some_and(|a| !(a.is_finite() && (-180.0..=180.0).contains(&a))) {
                return Err(invalid("angle"));
            }
        }
    }
    Ok(())
}
