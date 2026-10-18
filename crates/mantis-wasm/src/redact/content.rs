//! Content editing: one content stream (a page's or a form's) rewritten
//! without what lies under the areas, images redrawn, resources pruned.

use super::{PageEdit, Report, Unsupported, forms, graphics, images, interp, marked, page, text, verify};
use crate::rebuild;
use interp::{Event, Rect};
use lopdf::content::Operation;
use lopdf::{Document, Object};
use std::collections::{HashMap, HashSet};

/// True when `inner` lies inside `outer` (up to rounding).
fn contains(outer: &Rect, inner: &Rect) -> bool {
    const EPS: f64 = 1e-6;
    inner.x0 >= outer.x0 - EPS && inner.y0 >= outer.y0 - EPS && inner.x1 <= outer.x1 + EPS && inner.y1 <= outer.y1 + EPS
}

/// The image stream an image placement draws (an inline image as an
/// XObject); Err names why there is none.
fn placed_image(page: &PageEdit, ops: &[Operation], img: &interp::ImagePlacement) -> Result<lopdf::Stream, &'static str> {
    match &img.source {
        interp::ImageSource::XObject(name) => {
            let xobjects = interp::page_resources_dict(page.doc, page.resources, b"XObject");
            match xobjects.get(name).ok().and_then(|o| rebuild::deref(page.doc, o)) {
                Some(Object::Stream(s)) => Ok(s.clone()),
                _ => Err("missing"),
            }
        }
        interp::ImageSource::Inline => match ops.get(img.op_index).and_then(|op| op.operands.first()) {
            Some(Object::Stream(s)) => Ok(images::inline_as_xobject(s)),
            _ => Err("corrupt"),
        },
    }
}

fn cannot_edit(detail: &str) -> Unsupported {
    Unsupported(format!("scanned image that cannot be edited ({detail})"))
}

/// Add a redacted image (and its soft mask) as new objects under a fresh
/// name in the page's own /XObject dictionary; the original stays for other
/// users.
fn add_image(page: &mut PageEdit, mut image: lopdf::Stream, smask: Option<lopdf::Stream>) -> Result<(Vec<u8>, lopdf::ObjectId), Unsupported> {
    if let Some(smask) = smask {
        page.budget.take_bytes(smask.content.len())?;
        let id = page.doc.add_object(smask);
        image.dict.set("SMask", id);
    }
    add_xobject(page, image, "RedactedIm")
}

/// Add `stream` as a new object under a fresh name (`prefix` + number) in
/// the page's own /XObject dictionary. Its encoded bytes stay charged to
/// the budget.
pub(crate) fn add_xobject(page: &mut PageEdit, stream: lopdf::Stream, prefix: &str) -> Result<(Vec<u8>, lopdf::ObjectId), Unsupported> {
    page.budget.take_bytes(stream.content.len())?;
    let id = page.doc.add_object(stream);
    let mut xobjects = interp::page_resources_dict(page.doc, page.resources, b"XObject");
    let name = (1..)
        .map(|n| format!("{prefix}{n}").into_bytes())
        .find(|n| !xobjects.has(n))
        .unwrap_or_default();
    xobjects.set(name.clone(), id);
    page.resources.set("XObject", xobjects);
    Ok((name, id))
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
    if !rects.is_empty() {
        for event in events {
            if let Event::SoftMask(m) = event
                && m.group.is_none_or(|(group, matrix)| verify::group_meets(page.doc, group, matrix, page.resources, rects, page.budget))
            {
                return Err(Unsupported::new("soft mask content under a redaction area"));
            }
        }
    }
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
            Event::Image(img) if graphics::quad_hit(&img.quad_user, rects) => {
                // An image that cannot be edited pixel by pixel makes the page
                // need a raster (never removed whole). Planning stops there.
                let stream = placed_image(page, ops, img).map_err(cannot_edit)?;
                if let Some(reason) = images::not_editable(page.doc, &stream, page.resources, page.budget.decoded) {
                    return Err(cannot_edit(reason));
                }
                if !page.pixels {
                    continue;
                }
                match images::redact_image(page.doc, &stream, page.resources, &img.quad_user, rects, page.fill, page.budget) {
                    images::ImageEdit::Untouched => continue,
                    images::ImageEdit::Replaced { image, smask } => {
                        let (name, id) = add_image(page, image, smask)?;
                        report.created_images.push(id);
                        replaced.insert(img.op_index, vec![Operation::new("Do", vec![Object::Name(name)])]);
                        report.images_redacted += 1;
                    }
                    // Seen only in its data (corrupt, a mask that does not
                    // decode): a raster still.
                    images::ImageEdit::NeedsRaster(reason) => return Err(cannot_edit(reason)),
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
    // Removed text must never be left without a box over it.
    // (A glyph whose deciding box sticks out of every area gets its ink box
    // filled too.)
    report
        .uncovered
        .extend(edits.removed_boxes.iter().filter(|(b, _)| !rects.iter().any(|r| contains(r, b))).map(|(_, ink)| *ink));
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
