//! Redaction: remove the content under marked areas (text, images, vector
//! graphics) instead of only covering it.

// The engine lands piece by piece before the job that calls it; drop this
// once the redaction job is exported.
#![cfg_attr(not(test), allow(dead_code))]

#[cfg(test)]
mod content_tests;
pub(crate) mod fonts;
pub(crate) mod graphics;
#[cfg(test)]
mod image_tests;
pub(crate) mod images;
pub(crate) mod interp;
pub(crate) mod marked;
pub(crate) mod text;

use crate::rebuild;
use interp::{Event, Rect};
use lopdf::content::Operation;
use lopdf::Object;
use std::collections::{BTreeSet, HashMap, HashSet};

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
    let id = page.doc.add_object(image);
    let mut xobjects = interp::page_resources_dict(page.doc, page.resources, b"XObject");
    let name = (1..)
        .map(|n| format!("RedactedIm{n}").into_bytes())
        .find(|n| !xobjects.has(n))
        .unwrap_or_default();
    xobjects.set(name.clone(), id);
    page.resources.set("XObject", xobjects);
    name
}


/// `ops` without the glyphs, painted paths, shadings and image pixels of
/// `events` (their interpretation) that intersect any of `rects` (user
/// space). Images under a rect are redrawn from new objects added to
/// `page.doc` under new names in `page.resources`. Form XObjects are left
/// to their own pass.
pub(crate) fn redact_content(
    page: &mut PageEdit,
    ops: &[Operation],
    events: &[Event],
    rects: &[Rect],
) -> Result<(Vec<Operation>, Report), Unsupported> {
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
            Event::Shading(s) if graphics::shading_hit(s, rects) => {
                dropped.insert(s.op_index);
                report.shadings_removed += 1;
                touched.extend(s.marked);
            }
            Event::Image(img) if graphics::quad_hit(&img.quad_user, rects) => {
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
    report.glyphs_removed = edits.removed;
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
    Ok((out, report))
}

/// Resource categories whose names removed operators may have used.
const PRUNED: [&[u8]; 4] = [b"XObject", b"Font", b"Shading", b"Pattern"];

/// Remove from the page's resources every name the original content used
/// and the redacted content no longer does: a replaced image must not stay
/// reachable under its old name. Names the content never used stay (a form
/// without /Resources may draw from them). Shared dictionaries are copied,
/// never changed.
fn prune_resources(page: &mut PageEdit, before: &[Operation], after: &[Operation]) -> Result<(), Unsupported> {
    let scan = |ops: &[Operation]| {
        rebuild::scan_content(&interp::encode_ops(ops)).ok_or_else(|| Unsupported::new("redacted content cannot be scanned"))
    };
    let (old, new) = (scan(before)?, scan(after)?);
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
        for name in gone {
            entries.remove(name);
        }
        page.resources.set(category.to_vec(), entries);
    }
    Ok(())
}
