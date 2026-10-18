//! Verification: the redacted output is interpreted again and nothing that
//! could show removed content may remain under an area.

use super::forms::MAX_FORM_DEPTH;
use super::graphics::{quad_hit, shading_hit, unanalysed_paint};
use super::interp::{Event, Glyph, IDENTITY, ImageSource, Interp, Matrix, Paint, Rect, content_ops, decode_ops, page_resources, page_resources_dict};
use super::{Budget, JOB_DECODED, Unsupported};
use crate::page_content::{original_contents, owned_dict};
use crate::rebuild::{Decoded, MAX_STREAM_DECODED, deref, strict_content_in};
use lopdf::content::Operation;
use lopdf::{Dictionary, Document, Object, ObjectId};

/// Every event of `page`, its forms included (form events in user space).
pub(crate) fn page_events(doc: &Document, page: ObjectId) -> Result<Vec<Event>, Unsupported> {
    let mut budget = Budget::page(JOB_DECODED);
    let contents = doc.get_dictionary(page).ok().and_then(|d| d.get(b"Contents").ok());
    let ops = content_ops(doc, &original_contents(doc, contents), &mut budget)?;
    let mut events = Vec::new();
    let resources = page_resources(doc, page);
    walk(doc, &ops, resources, IDENTITY, Paint::default(), &mut Vec::new(), &mut budget, &mut events)?;
    Ok(events)
}

/// Every glyph drawn by `page`, its forms included.
pub(crate) fn page_glyphs(doc: &Document, page: ObjectId) -> Result<Vec<Glyph>, Unsupported> {
    Ok(page_events(doc, page)?
        .into_iter()
        .filter_map(|e| match e {
            Event::Glyph(g) => Some(g),
            _ => None,
        })
        .collect())
}

#[allow(clippy::too_many_arguments)]
fn walk(
    doc: &Document,
    ops: &[Operation],
    resources: Dictionary,
    ctm: Matrix,
    paint: Paint,
    forms: &mut Vec<ObjectId>,
    budget: &mut Budget,
    out: &mut Vec<Event>,
) -> Result<(), Unsupported> {
    let events = Interp::new(doc, resources.clone()).run_inherited(ops, ctm, paint, budget)?;
    let xobjects = page_resources_dict(doc, &resources, b"XObject");
    for event in events {
        if let Event::Form(f) = &event {
            let entry = xobjects.get(&f.name).map_err(|_| Unsupported::new("form XObject not found"))?;
            let id = entry.as_reference().ok();
            if id.is_some_and(|id| forms.contains(&id)) || forms.len() >= MAX_FORM_DEPTH {
                return Err(Unsupported::new("form XObjects nest too deep"));
            }
            let Some(Object::Stream(form)) = deref(doc, entry) else {
                return Err(Unsupported::new("form XObject not found"));
            };
            let mut charged = 0;
            let decoded = strict_content_in(Some(doc), form, MAX_STREAM_DECODED.min(budget.decoded), &mut charged);
            budget.decoded = budget.decoded.saturating_sub(charged);
            let Decoded::Content(content) = decoded else {
                return Err(Unsupported::new("form content cannot be decoded"));
            };
            let inner = match form.dict.get(b"Resources") {
                Ok(res) => owned_dict(doc, Some(res)),
                Err(_) => resources.clone(),
            };
            forms.extend(id);
            walk(doc, &decode_ops(&content)?, inner, f.matrix, f.paint, forms, budget, out)?;
            if id.is_some() {
                forms.pop();
            }
        }
        out.push(event);
    }
    Ok(())
}

/// True when nothing on `page` (forms included) that could show removed
/// content lies under any of `rects`: no glyph, painted path, shading or
/// unredacted image, no Pattern painting, no soft mask group. Content that cannot be interpreted fails.
pub(crate) fn verify_page(doc: &Document, page: ObjectId, rects: &[Rect]) -> bool {
    let Ok(events) = page_events(doc, page) else {
        return false;
    };
    if unanalysed_paint(&events, rects).is_some() {
        return false;
    }
    !events.iter().any(|e| left_under(e, rects))
}

/// True when path bounds `b` are the redaction box drawn over `r` (its
/// coordinates went through single precision).
fn is_box(b: &Rect, r: &Rect) -> bool {
    let close = |a: f64, c: f64| (a - c).abs() <= 1e-4 + c.abs() * 1e-6;
    close(b.x0, r.x0) && close(b.y0, r.y0) && close(b.x1, r.x1) && close(b.y1, r.y1)
}

/// Prefix of the names redacted images are drawn under.
pub(crate) const REDACTED_IMAGE_PREFIX: &str = "RedactedIm";
const REDACTED_IMAGE: &[u8] = REDACTED_IMAGE_PREFIX.as_bytes();

/// True when `event` still draws original content under a rect: a glyph, a
/// painted path, a shading, or an image other than a redacted copy.
fn left_under(event: &Event, rects: &[Rect]) -> bool {
    match event {
        Event::Glyph(g) => quad_hit(&g.box_user, rects),
        Event::Path(p) => {
            p.painted && p.bbox_user.is_some_and(|b| rects.iter().any(|r| b.overlaps(r)) && !rects.iter().any(|r| is_box(&b, r)))
        }
        Event::Shading(s) => shading_hit(s, rects),
        Event::Image(i) => {
            let redacted = matches!(&i.source, ImageSource::XObject(name) if name.starts_with(REDACTED_IMAGE));
            !redacted && quad_hit(&i.quad_user, rects)
        }
        _ => false,
    }
}
