//! Redaction: remove the content under marked areas (text, images, vector
//! graphics) instead of only covering it.

mod codec;
mod content;
#[cfg(test)]
mod content_tests;
#[cfg(test)]
mod fixture_tests;
pub(crate) mod fonts;
pub(crate) mod forms;
pub(crate) mod graphics;
#[cfg(test)]
mod image_tests;
pub(crate) mod images;
pub(crate) mod interp;
pub(crate) mod marked;
pub(crate) mod binding;
pub(crate) mod page;
pub(crate) mod raster;
pub(crate) mod search;
#[cfg(test)]
mod search_tests;
#[cfg(test)]
mod pipeline_tests;
pub(crate) mod text;
pub(crate) mod unicode;
pub(crate) mod verify;

pub(crate) use content::{add_xobject, redact_content};
pub(crate) use page::{page_rects_user, plan_page, redact_page};
pub(crate) use raster::PageRaster;
#[cfg(test)]
pub(crate) use page::plant_leak_for_tests;

use crate::pdf_util::{load_pdf, save_pdf};
use crate::rebuild::{self, OutPage, Policy, rebuild_document};
use interp::Rect;
use lopdf::{Document, Object};
use std::collections::{BTreeMap, BTreeSet};

/// Most areas one job may mark.
pub(crate) const MAX_RECTS: usize = 10_000;
/// Largest coordinate magnitude of an area (visible space, points).
pub(crate) const MAX_COORD: f64 = 1e6;
/// Decoded bytes one job may produce (content, forms, images).
pub(crate) const JOB_DECODED: usize = 512 << 20;

/// One area to redact: `[x, y, width, height]` in the visible space of
/// 1-based `page` (origin bottom-left, rotation applied).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RedactRect {
    pub(crate) page: u32,
    pub(crate) rect: [f64; 4],
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RedactJob {
    pub(crate) rects: Vec<RedactRect>,
    pub(crate) fill: Fill,
    /// Drop the document information dictionary too (XMP always goes).
    pub(crate) remove_metadata: bool,
    /// Renderings of the pages `redact_plan` reported as unsupported.
    pub(crate) rasters: Vec<PageRaster>,
}

/// Whether a page with areas can be redacted by rewriting its content;
/// `reason` says why not (it then needs a raster).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PageStatus {
    pub(crate) page: u32,
    pub(crate) reason: Option<String>,
}

/// What a redaction job did, for the UI.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct RedactSummary {
    pub(crate) pages_redacted: Vec<u32>,
    /// Pages replaced by their raster.
    pub(crate) pages_rasterized: Vec<u32>,
    /// Pages whose fill was widened to cover removed text reaching past an
    /// area ("Box widened to cover removed text on page N").
    pub(crate) pages_widened: Vec<u32>,
    pub(crate) glyphs_removed: usize,
    pub(crate) paths_removed: usize,
    pub(crate) images_redacted: usize,
    pub(crate) forms_redacted: usize,
    pub(crate) annotations_removed: usize,
}

fn invalid(field: &str) -> String {
    format!("Invalid redact settings: {field}")
}

/// The areas grouped by page (1-based), after checking every setting
/// against a document of `page_count` pages.
fn areas_by_page(rects: &[RedactRect], page_count: usize) -> Result<BTreeMap<u32, Vec<RedactRect>>, String> {
    if rects.len() > MAX_RECTS {
        return Err(invalid("rects"));
    }
    let mut by_page: BTreeMap<u32, Vec<RedactRect>> = BTreeMap::new();
    for (i, area) in rects.iter().enumerate() {
        let field = |name: &str| invalid(&format!("rects[{i}].{name}"));
        if area.page == 0 || area.page as usize > page_count {
            return Err(field("page"));
        }
        let [x, y, w, h] = area.rect;
        let coord = |v: f64| v.is_finite() && v.abs() <= MAX_COORD;
        let size = |v: f64| v.is_finite() && v > 0.0 && v <= 2.0 * MAX_COORD;
        if !coord(x) {
            return Err(field("x"));
        }
        if !coord(y) {
            return Err(field("y"));
        }
        if !size(w) {
            return Err(field("width"));
        }
        if !size(h) {
            return Err(field("height"));
        }
        by_page.entry(area.page).or_default().push(area.clone());
    }
    Ok(by_page)
}

/// Redact every page with areas in `doc` (sharing one job budget); one
/// result per page, in page order.
/// `plan`: only find out whether each page can be redacted (no pixel work).
fn redact_pages(
    doc: &mut Document,
    by_page: &BTreeMap<u32, Vec<RedactRect>>,
    fill: Fill,
    plan: bool,
) -> Vec<(u32, Vec<Rect>, Result<Report, Unsupported>)> {
    let pages = doc.get_pages();
    let mut decoded = JOB_DECODED;
    let mut out = Vec::new();
    for (&number, areas) in by_page {
        let Some(&page) = pages.get(&number) else {
            continue;
        };
        let rects = page_rects_user(doc, page, areas);
        let mut budget = Budget::page(decoded);
        let result = if plan {
            plan_page(doc, page, &rects, &mut budget).map(|()| Report::default())
        } else {
            redact_page(doc, page, &rects, fill, &mut budget)
        };
        decoded = budget.decoded;
        out.push((number, rects, result));
    }
    out
}

/// `pdf` parsed and prepared for redaction and search: every visible
/// widget's appearance flattened into its page (hidden ones dropped), as
/// the output would flatten them anyway. The engine then sees, finds and
/// removes form field content like any other, and the fill boxes stay the
/// last thing each page draws.
pub(crate) fn load_prepared(pdf: &[u8]) -> Result<Document, String> {
    let mut doc = load_pdf(pdf)?;
    crate::forms::flatten::flatten_document(&mut doc)?;
    Ok(doc)
}

/// The bytes the UI renders rasters from: `load_prepared` (widget
/// appearances flattened into the pages, their optional content kept) with
/// every annotation but links dropped, so a rasterized page shows what the
/// redacted file shows (form values included, no comments).
pub(crate) fn redact_prepare(pdf: &[u8]) -> Result<Vec<u8>, String> {
    let mut doc = load_prepared(pdf)?;
    for page in doc.get_pages().into_values().collect::<Vec<_>>() {
        let Some(annots) = doc
            .get_dictionary(page)
            .ok()
            .and_then(|d| d.get(b"Annots").ok())
            .and_then(|a| rebuild::deref(&doc, a))
            .and_then(|a| a.as_array().ok())
            .cloned()
        else {
            continue;
        };
        let links: Vec<Object> = annots
            .into_iter()
            .filter(|a| {
                rebuild::deref(&doc, a).and_then(|a| a.as_dict().ok()).and_then(|d| rebuild::name_of(d, b"Subtype")) == Some(b"Link")
            })
            .collect();
        if let Ok(dict) = doc.get_dictionary_mut(page) {
            if links.is_empty() {
                dict.remove(b"Annots");
            } else {
                dict.set("Annots", links);
            }
        }
    }
    save_pdf(&mut doc)
}

/// Which pages with areas can be redacted in place.
pub(crate) fn redact_plan(pdf: &[u8], rects: &[RedactRect]) -> Result<Vec<PageStatus>, String> {
    let mut doc = load_prepared(pdf)?;
    let by_page = areas_by_page(rects, doc.get_pages().len())?;
    Ok(redact_pages(&mut doc, &by_page, Fill::Black, true)
        .into_iter()
        .map(|(page, _, result)| PageStatus { page, reason: result.err().map(|u| u.0) })
        .collect())
}

/// Redact `job.rects` from `pdf`: remove the content under them, rebuild
/// the document without hidden data, verify, and return the new bytes.
pub(crate) fn redact(pdf: &[u8], mut job: RedactJob) -> Result<(Vec<u8>, RedactSummary), String> {
    let mut doc = load_prepared(pdf)?;
    let by_page = areas_by_page(&job.rects, doc.get_pages().len())?;
    let mut summary = RedactSummary::default();
    let mut checks = Vec::new();
    let mut created = Vec::new();
    // Pages that need a raster the job did not bring (the plan should have
    // reported them; listed together so the UI can ask for them).
    let mut needs_raster = Vec::new();
    for (number, rects, result) in redact_pages(&mut doc, &by_page, job.fill, false) {
        let report = match result {
            Ok(report) => report,
            Err(Unsupported(_)) => {
                let Some(index) = job.rasters.iter().position(|r| r.page == number) else {
                    needs_raster.push(number);
                    continue;
                };
                // Taken, not copied: rasters are large.
                let raster = job.rasters.swap_remove(index);
                let page = doc.get_pages()[&number];
                created.push(raster::rasterize_page(&mut doc, page, raster, &by_page[&number], job.fill)?);
                summary.pages_rasterized.push(number);
                checks.push((number, rects, 0, true));
                continue;
            }
        };
        summary.pages_redacted.push(number);
        summary.glyphs_removed += report.glyphs_removed;
        summary.paths_removed += report.paths_removed + report.shadings_removed;
        summary.images_redacted += report.images_redacted;
        summary.forms_redacted += report.forms_redacted;
        summary.annotations_removed += report.annotations_removed;
        created.extend(report.created_images);
        if !report.uncovered.is_empty() {
            summary.pages_widened.push(number);
        }
        checks.push((number, rects, report.uncovered.len(), false));
    }
    if !needs_raster.is_empty() {
        let list: Vec<String> = needs_raster.iter().map(u32::to_string).collect();
        return Err(invalid(&format!("needs raster [{}]", list.join(","))));
    }
    // Images this job drew carry a random tag through the rebuild, so
    // verification can tell them from any source image by identity.
    let tag = verify::new_tag()?;
    for id in &created {
        if let Ok(Object::Stream(image)) = doc.get_object_mut(*id) {
            image.dict.set(verify::TAG_KEY, Object::String(tag.clone(), lopdf::StringFormat::Hexadecimal));
        }
    }
    let pages: Vec<OutPage> =
        doc.get_pages().into_values().map(|page| OutPage::Page { src: 0, page, rotate: 0 }).collect();
    let policy = Policy { keep_links: true, keep_comments: false, strip_image_metadata: true };
    let sources = [doc];
    let (mut out, _) = rebuild_document(&sources, &pages, &policy)?;
    if !job.remove_metadata {
        copy_info(&sources[0], &mut out);
    }
    let bytes = save_pdf(&mut out)?;
    // Verify what a reader will see: the saved file, parsed again.
    let saved = load_pdf(&bytes)?;
    let saved_pages = saved.get_pages();
    for (number, rects, extra_boxes, rasterized) in checks {
        let ok = saved_pages.get(&number).is_some_and(|&page| {
            if rasterized {
                verify::verify_raster_page(&saved, page, &tag)
            } else {
                verify::verify_page(&saved, page, &rects, rects.len() + extra_boxes, &tag)
            }
        });
        if !ok {
            return Err(format!("Redaction verification failed on page {number}"));
        }
    }
    // The tag served its purpose: the delivered file does not carry it.
    for object in out.objects.values_mut() {
        if let Object::Stream(stream) = object {
            stream.dict.remove(verify::TAG_KEY.as_bytes());
        }
    }
    let delivered = save_pdf(&mut out)?;
    check_delivered(&delivered, saved_pages.len())?;
    Ok((delivered, summary))
}

/// The delivered bytes parse, have the verified page count, and carry no
/// verification tag.
fn check_delivered(bytes: &[u8], pages: usize) -> Result<(), String> {
    let doc = load_pdf(bytes)?;
    let tagged = doc.objects.values().any(|o| matches!(o, Object::Stream(s) if s.dict.has(verify::TAG_KEY.as_bytes())));
    if doc.get_pages().len() != pages || tagged {
        return Err("Redaction verification failed on the saved file".to_string());
    }
    Ok(())
}

/// Copy the text entries of the source's document information dictionary.
fn copy_info(source: &Document, out: &mut Document) {
    let Some(Object::Dictionary(info)) = source.trailer.get(b"Info").ok().and_then(|i| rebuild::deref(source, i)) else {
        return;
    };
    let mut copy = lopdf::Dictionary::new();
    for key in [&b"Title"[..], b"Author", b"Subject", b"Keywords", b"Creator", b"Producer", b"CreationDate", b"ModDate"] {
        if let Some(Object::String(text, format)) = info.get(key).ok().and_then(|v| rebuild::deref(source, v)) {
            copy.set(key.to_vec(), Object::String(text.clone(), *format));
        }
    }
    if !copy.is_empty() {
        let id = out.add_object(copy);
        out.trailer.set("Info", id);
    }
}


/// Why a page cannot be redacted by rewriting its content (the page is then
/// rasterized instead).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Unsupported(pub(crate) String);

impl Unsupported {
    pub(crate) fn new(reason: impl Into<String>) -> Unsupported {
        Unsupported(reason.into())
    }
}

/// Content operators one page may run, its form XObjects included.
pub(crate) const MAX_PAGE_OPS: usize = 2_000_000;
/// Events (glyphs, paths, images, ...) one page may produce.
pub(crate) const MAX_PAGE_EVENTS: usize = 1_000_000;

/// What is left of one page's allowance. Shared by the page content and the
/// forms it draws, so nesting cannot multiply the work.
#[derive(Debug, Clone)]
pub(crate) struct Budget {
    pub(crate) ops: usize,
    pub(crate) events: usize,
    /// Decoded content bytes still allowed (the job's remaining share).
    pub(crate) decoded: usize,
}

impl Budget {
    /// A fresh page allowance drawing on `decoded` bytes of the job budget.
    pub(crate) fn page(decoded: usize) -> Budget {
        Budget { ops: MAX_PAGE_OPS, events: MAX_PAGE_EVENTS, decoded }
    }

    pub(crate) fn take_op(&mut self) -> Result<(), Unsupported> {
        self.ops = self.ops.checked_sub(1).ok_or_else(|| Unsupported::new("too many content operators"))?;
        Ok(())
    }

    /// Charge `bytes` the job keeps for good (a stream it writes).
    pub(crate) fn take_bytes(&mut self, bytes: usize) -> Result<(), Unsupported> {
        self.decoded = self.decoded.checked_sub(bytes).ok_or_else(|| Unsupported::new("redacted content too large"))?;
        Ok(())
    }

    pub(crate) fn take_event(&mut self) -> Result<(), Unsupported> {
        self.events = self.events.checked_sub(1).ok_or_else(|| Unsupported::new("too much content"))?;
        Ok(())
    }
}

/// Colour painted over redacted image pixels (and of the boxes drawn later).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Fill {
    Black,
    White,
}

impl Fill {
    pub(crate) fn rgb(self) -> [u8; 3] {
        match self {
            Fill::Black => [0, 0, 0],
            Fill::White => [255, 255, 255],
        }
    }
}

/// The page being redacted: new image objects go into `doc`, their names
/// into `resources` (the page's own copy, inheritance resolved).
pub(crate) struct PageEdit<'a> {
    pub(crate) doc: &'a mut lopdf::Document,
    pub(crate) resources: &'a mut lopdf::Dictionary,
    pub(crate) fill: Fill,
    pub(crate) budget: &'a mut Budget,
    /// Form XObjects being redacted around this content (cycle and depth
    /// guard).
    pub(crate) forms: Vec<lopdf::ObjectId>,
    /// Redraw images under an area (false when only planning).
    pub(crate) pixels: bool,
}

impl<'a> PageEdit<'a> {
    pub(crate) fn new(doc: &'a mut lopdf::Document, resources: &'a mut lopdf::Dictionary, fill: Fill, budget: &'a mut Budget) -> Self {
        PageEdit { doc, resources, fill, budget, forms: Vec::new(), pixels: true }
    }
}

/// What `redact_content` removed.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Report {
    pub(crate) glyphs_removed: usize,
    pub(crate) paths_removed: usize,
    pub(crate) shadings_removed: usize,
    /// Images (XObject or inline) redrawn with painted pixels.
    pub(crate) images_redacted: usize,
    /// Form XObjects drawn from redacted private copies.
    pub(crate) forms_redacted: usize,
    /// Annotations removed from the page.
    pub(crate) annotations_removed: usize,
    /// Image objects this redaction drew (verification knows them by id).
    pub(crate) created_images: Vec<lopdf::ObjectId>,
    /// Boxes (user space) of removed text not entirely inside an area: the
    /// fill must cover them too.
    pub(crate) uncovered: Vec<Rect>,
    /// /Properties names of marked-content sequences around removed content:
    /// the page needs private copies of them without /ActualText, /Alt and
    /// /E (page assembly does that; inline property lists are rewritten
    /// here).
    pub(crate) named_properties: BTreeSet<Vec<u8>>,
}

impl Report {
    /// Add the counts of a form's redaction to this content's.
    fn absorb(&mut self, other: Report) {
        self.glyphs_removed += other.glyphs_removed;
        self.paths_removed += other.paths_removed;
        self.shadings_removed += other.shadings_removed;
        self.images_redacted += other.images_redacted;
        self.forms_redacted += other.forms_redacted;
        self.annotations_removed += other.annotations_removed;
        self.created_images.extend(other.created_images);
        self.uncovered.extend(other.uncovered);
    }
}
