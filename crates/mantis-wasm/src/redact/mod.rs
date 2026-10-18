//! Redaction: remove the content under marked areas (text, images, vector
//! graphics) instead of only covering it.

// The engine lands piece by piece before the job that calls it; drop this
// once the redaction job is exported.
#![cfg_attr(not(test), allow(dead_code))]

#[cfg(test)]
mod content_tests;
pub(crate) mod fonts;
pub(crate) mod forms;
pub(crate) mod graphics;
#[cfg(test)]
mod image_tests;
pub(crate) mod images;
pub(crate) mod interp;
pub(crate) mod marked;
pub(crate) mod page;
pub(crate) mod raster;
#[cfg(test)]
mod pipeline_tests;
pub(crate) mod text;
pub(crate) mod verify;

pub(crate) use page::{page_rects_user, plan_page, redact_page};
pub(crate) use raster::PageRaster;
#[cfg(test)]
pub(crate) use page::plant_leak_for_tests;

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
    pub(crate) glyphs_removed: usize,
    pub(crate) paths_removed: usize,
    pub(crate) images_redacted: usize,
    pub(crate) images_removed: usize,
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

/// Which pages with areas can be redacted in place.
pub(crate) fn redact_plan(pdf: &[u8], rects: &[RedactRect]) -> Result<Vec<PageStatus>, String> {
    let mut doc = load_pdf(pdf)?;
    let by_page = areas_by_page(rects, doc.get_pages().len())?;
    Ok(redact_pages(&mut doc, &by_page, Fill::Black, true)
        .into_iter()
        .map(|(page, _, result)| PageStatus { page, reason: result.err().map(|u| u.0) })
        .collect())
}

/// Redact `job.rects` from `pdf`: remove the content under them, rebuild
/// the document without hidden data, verify, and return the new bytes.
pub(crate) fn redact(pdf: &[u8], job: &RedactJob) -> Result<(Vec<u8>, RedactSummary), String> {
    let mut doc = load_pdf(pdf)?;
    let by_page = areas_by_page(&job.rects, doc.get_pages().len())?;
    let mut summary = RedactSummary::default();
    let mut checks = Vec::new();
    for (number, rects, result) in redact_pages(&mut doc, &by_page, job.fill, false) {
        let report = match result {
            Ok(report) => report,
            Err(Unsupported(reason)) => {
                let raster = job
                    .rasters
                    .iter()
                    .find(|r| r.page == number)
                    .ok_or_else(|| invalid(&format!("raster (page {number}: {reason})")))?;
                let page = doc.get_pages()[&number];
                raster::rasterize_page(&mut doc, page, raster, &by_page[&number], job.fill)?;
                summary.pages_rasterized.push(number);
                checks.push((number, rects, true));
                continue;
            }
        };
        summary.pages_redacted.push(number);
        summary.glyphs_removed += report.glyphs_removed;
        summary.paths_removed += report.paths_removed + report.shadings_removed;
        summary.images_redacted += report.images_redacted;
        summary.images_removed += report.images_removed.len();
        summary.forms_redacted += report.forms_redacted;
        summary.annotations_removed += report.annotations_removed;
        checks.push((number, rects, false));
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
    for (number, rects, rasterized) in checks {
        let ok = saved_pages.get(&number).is_some_and(|&page| {
            if rasterized {
                // A picture only: no text at all.
                verify::page_glyphs(&saved, page).is_ok_and(|glyphs| glyphs.is_empty())
            } else {
                verify::verify_page(&saved, page, &rects)
            }
        });
        if !ok {
            return Err(format!("Redaction verification failed on page {number}"));
        }
    }
    Ok((bytes, summary))
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

use crate::rebuild;
use interp::{Event, Rect};
use lopdf::content::Operation;
use lopdf::Object;
use crate::pdf_util::{load_pdf, save_pdf};
use crate::rebuild::{OutPage, Policy, rebuild_document};
use lopdf::Document;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

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
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Report {
    pub(crate) glyphs_removed: usize,
    pub(crate) paths_removed: usize,
    pub(crate) shadings_removed: usize,
    pub(crate) inline_images_removed: usize,
    /// Images (XObject or inline) redrawn with painted pixels.
    pub(crate) images_redacted: usize,
    /// Why each image under a rect was removed entirely instead.
    pub(crate) images_removed: Vec<&'static str>,
    /// Form XObjects drawn from redacted private copies.
    pub(crate) forms_redacted: usize,
    /// Annotations removed from the page.
    pub(crate) annotations_removed: usize,
    /// /Properties names of marked-content sequences around removed content:
    /// the page needs private copies of them without /ActualText, /Alt and
    /// /E (page assembly does that; inline property lists are rewritten
    /// here).
    pub(crate) named_properties: BTreeSet<Vec<u8>>,
}

/// The edit for an image placement under a rect.
fn redact_placed_image(page: &mut PageEdit, ops: &[Operation], img: &interp::ImagePlacement, rects: &[Rect]) -> images::ImageEdit {
    let stream = match &img.source {
        interp::ImageSource::XObject(name) => {
            let xobjects = interp::page_resources_dict(page.doc, page.resources, b"XObject");
            match xobjects.get(name).ok().and_then(|o| rebuild::deref(page.doc, o)) {
                Some(Object::Stream(s)) => s.clone(),
                _ => return images::ImageEdit::Removed("missing"),
            }
        }
        interp::ImageSource::Inline => match ops.get(img.op_index).and_then(|op| op.operands.first()) {
            Some(Object::Stream(s)) => images::inline_as_xobject(s),
            _ => return images::ImageEdit::Removed("corrupt"),
        },
    };
    images::redact_image(page.doc, &stream, page.resources, &img.quad_user, rects, page.fill, page.budget)
}

/// Add a redacted image (and its soft mask) as new objects under a fresh
/// name in the page's own /XObject dictionary; the original stays for other
/// users.
fn add_image(page: &mut PageEdit, mut image: lopdf::Stream, smask: Option<lopdf::Stream>) -> Vec<u8> {
    if let Some(smask) = smask {
        let id = page.doc.add_object(smask);
        image.dict.set("SMask", id);
    }
    add_xobject(page, image, verify::REDACTED_IMAGE_PREFIX)
}

/// Add `stream` as a new object under a fresh name (`prefix` + number) in
/// the page's own /XObject dictionary.
pub(crate) fn add_xobject(page: &mut PageEdit, stream: lopdf::Stream, prefix: &str) -> Vec<u8> {
    let id = page.doc.add_object(stream);
    let mut xobjects = interp::page_resources_dict(page.doc, page.resources, b"XObject");
    let name = (1..)
        .map(|n| format!("{prefix}{n}").into_bytes())
        .find(|n| !xobjects.has(n))
        .unwrap_or_default();
    xobjects.set(name.clone(), id);
    page.resources.set("XObject", xobjects);
    name
}

impl Report {
    /// Add the counts of a form's redaction to this content's.
    fn absorb(&mut self, other: Report) {
        self.glyphs_removed += other.glyphs_removed;
        self.paths_removed += other.paths_removed;
        self.shadings_removed += other.shadings_removed;
        self.inline_images_removed += other.inline_images_removed;
        self.images_redacted += other.images_redacted;
        self.images_removed.extend(other.images_removed);
        self.forms_redacted += other.forms_redacted;
        self.annotations_removed += other.annotations_removed;
    }
}


/// `ops` without the glyphs, painted paths, shadings and image pixels of
/// `events` (their interpretation) that intersect any of `rects` (user
/// space). Images under a rect are redrawn from new objects added to
/// `page.doc` under new names in `page.resources`; so are forms with
/// anything to remove (private copies, recursively).
pub(crate) fn redact_content(
    page: &mut PageEdit,
    ops: &[Operation],
    events: &[Event],
    rects: &[Rect],
) -> Result<(Vec<Operation>, Report), Unsupported> {
    if page::leak_planted() {
        return Ok((ops.to_vec(), Report::default()));
    }
    graphics::check_unanalysed_paint(events, rects)?;
    let mut report = Report::default();
    let mut dropped: HashSet<usize> = HashSet::new();
    let mut replaced: HashMap<usize, Vec<Operation>> = HashMap::new();
    let mut glyphs: Vec<(&interp::Glyph, bool)> = Vec::new();
    // Show operators with a removed glyph.
    let mut cut_shows: HashSet<usize> = HashSet::new();
    // Innermost sequences around removed content.
    let mut touched: Vec<usize> = Vec::new();
    for event in events {
        match event {
            _ => {}
        }
        match event {
            Event::Glyph(g) => {
                let removed = graphics::quad_hit(&g.box_user, rects);
                if removed {
                    cut_shows.insert(g.op_index);
                }
                glyphs.push((g, removed));
            }
            Event::Path(p) => match graphics::path_edit(p, rects)? {
                Some(graphics::PathEdit::Remove(range)) => {
                    dropped.extend(range);
                    report.paths_removed += 1;
                    touched.extend(p.marked);
                }
                Some(graphics::PathEdit::Unpaint(paint)) => {
                    replaced.insert(paint, vec![Operation::new("n", vec![])]);
                    report.paths_removed += 1;
                    touched.extend(p.marked);
                }
                None => {}
            },
            Event::Form(f) => {
                let (name, sub) = forms::redact_form(page, f, rects)?;
                report.absorb(sub);
                if let Some(name) = name {
                    replaced.insert(f.op_index, vec![Operation::new("Do", vec![Object::Name(name)])]);
                    report.forms_redacted += 1;
                    touched.extend(f.marked);
                }
            }
            Event::Shading(s) if graphics::shading_hit(s, rects) => {
                dropped.insert(s.op_index);
                report.shadings_removed += 1;
                touched.extend(s.marked);
            }
            // Planning: images never make a page unsupported (one that cannot
            // be redrawn is removed), so their pixels are left alone.
            Event::Image(img) if page.pixels && graphics::quad_hit(&img.quad_user, rects) => {
                let inline = img.source == interp::ImageSource::Inline;
                match redact_placed_image(page, ops, img, rects) {
                    images::ImageEdit::Untouched => continue,
                    images::ImageEdit::Replaced { image, smask } => {
                        let name = add_image(page, image, smask);
                        replaced.insert(img.op_index, vec![Operation::new("Do", vec![Object::Name(name)])]);
                        report.images_redacted += 1;
                    }
                    images::ImageEdit::Removed(reason) => {
                        dropped.insert(img.op_index);
                        report.images_removed.push(reason);
                        if inline {
                            report.inline_images_removed += 1;
                        }
                    }
                }
                touched.extend(img.marked);
            }
            _ => {}
        }
    }
    if glyphs.iter().any(|(g, _)| g.op_index >= ops.len()) {
        return Err(Unsupported::new("glyph outside the content"));
    }
    let edits = text::rewrite_text(ops, &glyphs)?;
    report.glyphs_removed += edits.removed;
    replaced.extend(edits.replaced);
    // Every glyph of a cut show counts as touched (a whole show may go).
    touched.extend(glyphs.iter().filter(|(g, _)| cut_shows.contains(&g.op_index)).filter_map(|(g, _)| g.marked));
    let stripped = marked::strip_replacement_text(ops, events, touched);
    report.named_properties = stripped.named_properties;
    replaced.extend(stripped.replaced);
    let mut out = Vec::with_capacity(ops.len());
    for (i, op) in ops.iter().enumerate() {
        if dropped.contains(&i) {
            continue;
        }
        match replaced.remove(&i) {
            Some(ops) => out.extend(ops),
            None => out.push(op.clone()),
        }
    }
    prune_resources(page, ops, &out)?;
    marked::strip_named_properties(page.doc, page.resources, &report.named_properties)?;
    Ok((out, report))
}

/// Resource categories whose names removed operators may have used.
const PRUNED: [&[u8]; 5] = [b"XObject", b"Font", b"Shading", b"Pattern", b"ExtGState"];

/// Remove from the page's resources every name the original content used
/// and the redacted content no longer does, and every other unused name for
/// the same objects: a replaced image must not stay reachable under its old
/// name or an alias. Names the content never used stay (a form
/// without /Resources may draw from them). Shared dictionaries are copied,
/// never changed.
fn prune_resources(page: &mut PageEdit, before: &[Operation], after: &[Operation]) -> Result<(), Unsupported> {
    let scan = |ops: &[Operation]| {
        rebuild::scan_content(&interp::encode_ops(ops)).ok_or_else(|| Unsupported::new("redacted content cannot be scanned"))
    };
    let (old, mut new) = (scan(before)?, scan(after)?);
    // Forms without /Resources draw from these: what they use stays.
    if let Some(inherited) = forms::inherited_usage(page, &new)? {
        new.merge(inherited);
    }
    for category in PRUNED {
        let gone: Vec<&Vec<u8>> = old
            .by_category
            .get(category)
            .into_iter()
            .flatten()
            .filter(|name| !new.contains(category, name))
            .collect();
        if gone.is_empty() || !page.resources.has(category) {
            continue;
        }
        let mut entries = interp::page_resources_dict(page.doc, page.resources, category);
        // Objects the dropped names led to: another name for the same object
        // (an alias) would keep the original reachable.
        let targets: HashSet<lopdf::ObjectId> =
            gone.iter().filter_map(|name| entries.get(name).ok()).filter_map(|o| terminal_id(page.doc, o)).collect();
        let aliases: Vec<Vec<u8>> = entries
            .iter()
            .filter(|(name, value)| !new.contains(category, name) && terminal_id(page.doc, value).is_some_and(|id| targets.contains(&id)))
            .map(|(name, _)| name.clone())
            .collect();
        for name in gone.into_iter().chain(&aliases) {
            entries.remove(name);
        }
        page.resources.set(category.to_vec(), entries);
    }
    Ok(())
}

/// The id of the object a reference chain starting at `obj` ends on.
fn terminal_id(doc: &Document, obj: &Object) -> Option<lopdf::ObjectId> {
    let mut id = obj.as_reference().ok()?;
    for _ in 0..32 {
        match doc.get_object(id) {
            Ok(Object::Reference(next)) => id = *next,
            Ok(_) => return Some(id),
            Err(_) => return None,
        }
    }
    None
}
