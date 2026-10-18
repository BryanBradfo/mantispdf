//! One page: areas mapped to user space, content (and forms) redacted into
//! a new content stream with private resources, annotations under an area
//! removed, page-level hidden data dropped.

use super::graphics::quad_hit;
use super::interp::{IDENTITY, Interp, Quad, Rect, apply, content_ops, encode_ops, page_resources};
use super::{Budget, Fill, PageEdit, RedactRect, Report, Unsupported, redact_content};
use crate::page_content::original_contents;
use crate::rebuild::{deref, save_balance};
use lopdf::content::Operation;
use crate::stamp::geometry::VisibleBox;
use flate2::{Compression, write::ZlibEncoder};
use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use std::io::Write;

/// Page keys that may carry a picture or data of the original page.
const PAGE_HIDDEN_DATA: [&[u8]; 3] = [b"Thumb", b"PieceInfo", b"Metadata"];

/// The user-space rects of the areas (on `page`; their page numbers are not
/// looked at) with the page's crop and rotation applied.
pub(crate) fn page_rects_user(doc: &Document, page: ObjectId, areas: &[RedactRect]) -> Vec<Rect> {
    let m = VisibleBox::of_page(doc, page).matrix();
    areas
        .iter()
        .map(|a| {
            let [x, y, w, h] = a.rect;
            let (ax, ay) = apply(&m, x, y);
            let (bx, by) = apply(&m, x + w, y + h);
            Rect { x0: ax.min(bx), y0: ay.min(by), x1: ax.max(bx), y1: ay.max(by) }
        })
        .collect()
}

/// A Flate-compressed stream of `content` with `dict`.
pub(crate) fn flate_stream(mut dict: Dictionary, content: &[u8]) -> Stream {
    let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
    // Writing to a Vec cannot fail.
    let compressed = enc.write_all(content).and_then(|()| enc.finish());
    match compressed {
        Ok(bytes) => {
            dict.set("Filter", "FlateDecode");
            Stream::new(dict, bytes).with_compression(false)
        }
        Err(_) => Stream::new(dict, content.to_vec()).with_compression(false),
    }
}

/// Redact `rects` (user space) from `page` in `doc`, never changing an
/// object another page may share: the page gets a new content stream and
/// its own resources; forms and images it changes are private copies.
pub(crate) fn redact_page(doc: &mut Document, page: ObjectId, rects: &[Rect], fill: Fill, budget: &mut Budget) -> Result<Report, Unsupported> {
    edit_page(doc, page, rects, fill, budget, true)
}

/// Whether `page` can be redacted in place: the same analysis as
/// `redact_page` without redrawing images (it still changes `doc`).
pub(crate) fn plan_page(doc: &mut Document, page: ObjectId, rects: &[Rect], budget: &mut Budget) -> Result<(), Unsupported> {
    edit_page(doc, page, rects, Fill::Black, budget, false).map(|_| ())
}

fn edit_page(doc: &mut Document, page: ObjectId, rects: &[Rect], fill: Fill, budget: &mut Budget, pixels: bool) -> Result<Report, Unsupported> {
    if covers_page(doc, page, rects) {
        return blank_page(doc, page, rects, fill, budget);
    }
    let page_dict = doc.get_dictionary(page).map_err(|_| Unsupported::new("page not found"))?.clone();
    let mut resources = page_resources(doc, page);
    let items = original_contents(doc, page_dict.get(b"Contents").ok());
    let ops = content_ops(doc, &items, budget)?;
    let events = Interp::new(doc, resources.clone()).run(&ops, IDENTITY, budget)?;
    let mut edit = PageEdit::new(doc, &mut resources, fill, budget);
    edit.pixels = pixels;
    let (new_ops, mut report) = redact_content(&mut edit, &ops, &events, rects)?;
    report.annotations_removed = drop_annotations(doc, page, rects);
    // Removed text reaching past its area gets its own box too: the reader
    // must never lose text with no box over it.
    report.uncovered = merge_boxes(std::mem::take(&mut report.uncovered));
    let boxes: Vec<Rect> = rects.iter().chain(&report.uncovered).copied().collect();
    let content = flate_stream(Dictionary::new(), &with_boxes(new_ops, &boxes, fill)?);
    budget.take_bytes(content.content.len())?;
    let content = doc.add_object(content);
    let dict = doc.get_dictionary_mut(page).map_err(|_| Unsupported::new("page not found"))?;
    dict.set("Contents", content);
    dict.set("Resources", Object::Dictionary(resources));
    for key in PAGE_HIDDEN_DATA {
        dict.remove(key);
    }
    Ok(report)
}

/// How far (points) an area may fall short of the visible box and still
/// count as covering it: rounding in the UI's page geometry.
const WHOLE_PAGE_SLACK: f64 = 1e-3;

/// Whether one of `rects` (user space) covers the whole visible box.
fn covers_page(doc: &Document, page: ObjectId, rects: &[Rect]) -> bool {
    let vb = VisibleBox::of_page(doc, page);
    rects.iter().any(|r| {
        r.x0 <= vb.x0 + WHOLE_PAGE_SLACK
            && r.y0 <= vb.y0 + WHOLE_PAGE_SLACK
            && r.x1 >= vb.x1 - WHOLE_PAGE_SLACK
            && r.y1 >= vb.y1 - WHOLE_PAGE_SLACK
    })
}

/// Page keys that set geometry, kept (resolved through inheritance) on a
/// blanked page.
const GEOMETRY: [&[u8]; 7] = [b"MediaBox", b"CropBox", b"BleedBox", b"TrimBox", b"ArtBox", b"Rotate", b"UserUnit"];

/// `page` replaced by a blank page of the same geometry with the fill boxes
/// over `rects`: nothing of the original content, resources or annotations
/// is kept, whatever they hold (no analysis, so no raster is ever needed).
fn blank_page(doc: &mut Document, page: ObjectId, rects: &[Rect], fill: Fill, budget: &mut Budget) -> Result<Report, Unsupported> {
    let old = doc.get_dictionary(page).map_err(|_| Unsupported::new("page not found"))?;
    let annotations_removed = old
        .get(b"Annots")
        .ok()
        .and_then(|a| deref(doc, a))
        .and_then(|a| a.as_array().ok())
        .map_or(0, Vec::len);
    let mut dict = Dictionary::new();
    dict.set("Type", Object::Name(b"Page".to_vec()));
    if let Ok(parent) = old.get(b"Parent") {
        dict.set("Parent", parent.clone());
    }
    for key in GEOMETRY {
        if let Some(value) = crate::pdf_util::get_inherited_attr(doc, page, key).and_then(|v| deref(doc, &v).cloned()) {
            dict.set(key, value);
        }
    }
    if !dict.has(b"MediaBox") {
        let vb = VisibleBox::of_page(doc, page);
        dict.set("MediaBox", [vb.x0, vb.y0, vb.x1, vb.y1].map(|v| Object::Real(v as f32)).to_vec());
    }
    let content = flate_stream(Dictionary::new(), &with_boxes(Vec::new(), rects, fill)?);
    budget.take_bytes(content.content.len())?;
    let content = doc.add_object(content);
    dict.set("Contents", content);
    dict.set("Resources", Dictionary::new());
    doc.objects.insert(page, Object::Dictionary(dict));
    Ok(Report { annotations_removed, ..Report::default() })
}

/// `boxes` with every two that overlap or touch joined into their union,
/// repeatedly (few in practice: the glyphs at the edges of areas).
fn merge_boxes(mut boxes: Vec<Rect>) -> Vec<Rect> {
    let touch = |a: &Rect, b: &Rect| a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
    let mut merged = true;
    while merged {
        merged = false;
        let mut out: Vec<Rect> = Vec::with_capacity(boxes.len());
        for b in boxes {
            match out.iter_mut().find(|o| touch(o, &b)) {
                Some(o) => {
                    *o = Rect { x0: o.x0.min(b.x0), y0: o.y0.min(b.y0), x1: o.x1.max(b.x1), y1: o.y1.max(b.y1) };
                    merged = true;
                }
                None => out.push(b),
            }
        }
        boxes = out;
    }
    boxes
}

/// Content bytes of `ops` followed by a box of the fill colour over each
/// rect, drawn in default user space: the page content runs inside `q`/`Q`
/// deep enough that its own `Q` never pops past it, every `q` it leaves
/// open closed first.
fn with_boxes(ops: Vec<Operation>, rects: &[Rect], fill: Fill) -> Result<Vec<u8>, Unsupported> {
    // The content may pop more than it pushes (`excess`) and leave some open:
    // enough `q` before it that it never reaches the page level, and a `Q`
    // for every one still open after it. Content whose balance cannot be
    // counted is Unsupported (the page then needs a raster).
    let (open, excess) = save_balance(&encode_ops(&ops)).ok_or_else(|| Unsupported::new("redacted content cannot be parsed"))?;
    let mut all = Vec::with_capacity(ops.len() + rects.len() * 2 + excess + open + 8);
    all.extend((0..=excess).map(|_| Operation::new("q", vec![])));
    all.extend(ops);
    all.extend((0..=open).map(|_| Operation::new("Q", vec![])));
    all.push(Operation::new("q", vec![]));
    let [r, g, b] = fill.rgb().map(|c| Object::Integer(i64::from(c / 255)));
    all.push(Operation::new("rg", vec![r, g, b]));
    for rect in rects {
        let n = |v: f64| Object::Real(v as f32);
        // One path per box: verification recognises each by its bounds.
        all.push(Operation::new("re", vec![n(rect.x0), n(rect.y0), n(rect.x1 - rect.x0), n(rect.y1 - rect.y0)]));
        all.push(Operation::new("f", vec![]));
    }
    all.push(Operation::new("Q", vec![]));
    Ok(encode_ops(&all))
}

/// Remove the page's annotations whose /Rect meets a rect (any subtype; one
/// without a usable /Rect goes too). Returns how many went.
fn drop_annotations(doc: &mut Document, page: ObjectId, rects: &[Rect]) -> usize {
    let Some(annots) = doc
        .get_dictionary(page)
        .ok()
        .and_then(|d| d.get(b"Annots").ok())
        .and_then(|a| deref(doc, a))
        .and_then(|a| a.as_array().ok())
        .cloned()
    else {
        return 0;
    };
    let hits = |annot: &Object| -> bool {
        let Some(Object::Dictionary(d)) = deref(doc, annot) else {
            return false;
        };
        let corners: Option<Vec<f64>> = match d.get(b"Rect").ok().and_then(|r| deref(doc, r)) {
            Some(Object::Array(items)) if items.len() == 4 => items
                .iter()
                .map(|n| deref(doc, n).and_then(|n| n.as_float().ok()).map(f64::from).filter(|v| v.is_finite()))
                .collect(),
            _ => None,
        };
        let Some(c) = corners else {
            return true;
        };
        let (x0, y0, x1, y1) = (c[0].min(c[2]), c[1].min(c[3]), c[0].max(c[2]), c[1].max(c[3]));
        quad_hit(&Quad([(x0, y0), (x1, y0), (x1, y1), (x0, y1)]), rects)
    };
    let kept: Vec<Object> = annots.iter().filter(|a| !hits(a)).cloned().collect();
    let removed = annots.len() - kept.len();
    if removed > 0
        && let Ok(dict) = doc.get_dictionary_mut(page)
    {
        dict.set("Annots", kept);
    }
    removed
}

#[cfg(test)]
thread_local! {
    static LEAK: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Test hook: when set, glyphs are never removed, so the final
/// verification must catch them.
#[cfg(test)]
pub(crate) fn plant_leak_for_tests(on: bool) {
    LEAK.with(|l| l.set(on));
}

#[cfg(test)]
pub(crate) fn leak_planted() -> bool {
    LEAK.with(|l| l.get())
}

#[cfg(not(test))]
pub(crate) fn leak_planted() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_whose_saves_cannot_be_counted_is_unsupported() {
        // An operator the content parser stops at: the q/Q balance is unknown.
        let ops = vec![Operation::new("a)b", vec![])];
        assert!(with_boxes(ops, &[], Fill::Black).is_err());
        assert!(with_boxes(vec![Operation::new("q", vec![])], &[], Fill::Black).is_ok());
    }

    #[test]
    fn the_new_content_stream_stays_charged_to_the_budget() {
        let mut doc = Document::with_version("1.7");
        let content = doc.add_object(Stream::new(Dictionary::new(), b"0 0 10 10 re f 100 100 10 10 re f".to_vec()));
        let page = doc.add_object(lopdf::dictionary! { "Type" => "Page", "Contents" => content, "Resources" => Dictionary::new() });
        let start = 1 << 20;
        let mut budget = Budget::page(start);
        let rect = Rect { x0: 0.0, y0: 0.0, x1: 20.0, y1: 20.0 };
        redact_page(&mut doc, page, &[rect], Fill::Black, &mut budget).unwrap();
        let written = doc.get_dictionary(page).unwrap().get(b"Contents").unwrap().as_reference().unwrap();
        let written = doc.get_object(written).unwrap().as_stream().unwrap().content.len();
        let source = b"0 0 10 10 re f 100 100 10 10 re f".len();
        assert_eq!(budget.decoded, start - source - written);
        // Too little left for it: Unsupported, not over budget.
        let mut tight = Budget::page(source + 1);
        let mut doc2 = doc.clone();
        doc2.get_dictionary_mut(page).unwrap().set("Contents", content);
        assert!(redact_page(&mut doc2, page, &[rect], Fill::Black, &mut tight).is_err());
    }
}
