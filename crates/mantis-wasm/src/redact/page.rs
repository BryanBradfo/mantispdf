//! One page: areas mapped to user space, content (and forms) redacted into
//! a new content stream with private resources, annotations under an area
//! removed, page-level hidden data dropped.

use super::graphics::quad_hit;
use super::interp::{IDENTITY, Interp, Quad, Rect, apply, content_ops, encode_ops, page_resources};
use super::{Budget, Fill, PageEdit, RedactRect, Report, Unsupported, redact_content};
use crate::page_content::original_contents;
use crate::rebuild::deref;
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
    let page_dict = doc.get_dictionary(page).map_err(|_| Unsupported::new("page not found"))?.clone();
    let mut resources = page_resources(doc, page);
    let items = original_contents(doc, page_dict.get(b"Contents").ok());
    let ops = content_ops(doc, &items, budget)?;
    let events = Interp::new(doc, resources.clone()).run(&ops, IDENTITY, budget)?;
    let (new_ops, mut report) = redact_content(&mut PageEdit::new(doc, &mut resources, fill, budget), &ops, &events, rects)?;
    report.annotations_removed = drop_annotations(doc, page, rects);
    let content = doc.add_object(flate_stream(Dictionary::new(), &encode_ops(&new_ops)));
    let dict = doc.get_dictionary_mut(page).map_err(|_| Unsupported::new("page not found"))?;
    dict.set("Contents", content);
    dict.set("Resources", Object::Dictionary(resources));
    for key in PAGE_HIDDEN_DATA {
        dict.remove(key);
    }
    Ok(report)
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
