//! Verification: the redacted output is interpreted again and nothing that
//! could show removed content may remain under an area.

use super::forms::MAX_FORM_DEPTH;
use super::graphics::{quad_hit, shading_hit, unanalysed_paint};
use super::interp::{Event, IDENTITY, ImagePlacement as Image, ImageSource, Interp, Matrix, Paint, Rect, content_ops, decode_ops, page_resources, page_resources_dict};
use super::{Budget, JOB_DECODED, Unsupported};
use crate::page_content::{original_contents, owned_dict};
use crate::rebuild::{Decoded, MAX_STREAM_DECODED, deref, strict_content_in};
use lopdf::content::Operation;
use lopdf::{Dictionary, Document, Object, ObjectId};

/// Dictionary key carrying the job's tag on the images it drew (removed
/// from the delivered file).
pub(crate) const TAG_KEY: &str = "MantisRedactionTag";

/// A fresh random tag for one job's images.
pub(crate) fn new_tag() -> Result<Vec<u8>, String> {
    let mut tag = vec![0u8; 16];
    getrandom::fill(&mut tag).map_err(|_| "Could not generate a random tag".to_string())?;
    Ok(tag)
}

/// One event of a page as verification sees it.
struct Seen {
    event: Event,
    /// Drawn by the page content itself (not inside a form).
    top: bool,
    /// An image XObject carrying this job's tag.
    tagged: bool,
    /// For a soft mask: the resources in effect where it was set (its
    /// group, without /Resources of its own, reads those).
    context: Option<std::rc::Rc<Dictionary>>,
}

/// Every event of `page` (forms included, in user space) and the page's own
/// operators.
fn page_seen(doc: &Document, page: ObjectId, tag: &[u8]) -> Result<(Vec<Seen>, Vec<Operation>), Unsupported> {
    let mut budget = Budget::page(JOB_DECODED);
    let contents = doc.get_dictionary(page).ok().and_then(|d| d.get(b"Contents").ok());
    let ops = content_ops(doc, &original_contents(doc, contents), &mut budget)?;
    let mut seen = Vec::new();
    let resources = page_resources(doc, page);
    walk(doc, &ops, resources, IDENTITY, Paint::default(), &mut Vec::new(), &mut budget, tag, &mut seen)?;
    Ok((seen, ops))
}

/// Every event of `page`, its forms included (form events in user space).
#[cfg(test)]
pub(crate) fn page_events(doc: &Document, page: ObjectId) -> Result<Vec<Event>, Unsupported> {
    Ok(page_seen(doc, page, &[])?.0.into_iter().map(|s| s.event).collect())
}

/// Every glyph drawn by `page`, its forms included.
#[cfg(test)]
pub(crate) fn page_glyphs(doc: &Document, page: ObjectId) -> Result<Vec<super::interp::Glyph>, Unsupported> {
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
    tag: &[u8],
    out: &mut Vec<Seen>,
) -> Result<(), Unsupported> {
    let events = Interp::new(doc, resources.clone()).run_inherited(ops, ctm, paint, budget)?;
    let xobjects = page_resources_dict(doc, &resources, b"XObject");
    let top = forms.is_empty();
    for event in events {
        let mut tagged = false;
        if let Event::Image(Image { source: ImageSource::XObject(name), .. }) = &event {
            tagged = !tag.is_empty()
                && matches!(
                    xobjects.get(name).ok().and_then(|o| deref(doc, o)),
                    Some(Object::Stream(image)) if matches!(image.dict.get(TAG_KEY.as_bytes()), Ok(Object::String(t, _)) if t.as_slice() == tag)
                );
        }
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
            // A direct form still counts as a level.
            forms.push(id.unwrap_or((0, 0)));
            walk(doc, &decode_ops(&content)?, inner, f.matrix, f.paint, forms, budget, tag, out)?;
            forms.pop();
        }
        let context = matches!(event, Event::SoftMask(_)).then(|| std::rc::Rc::new(resources.clone()));
        out.push(Seen { event, top, tagged, context });
    }
    Ok(())
}

/// The op range of the fill boxes the engine appended to page content
/// `ops` for `boxes` areas (`q`, `r g b rg`, `x y w h re f` per box, `Q`),
/// None when the content does not end that way.
fn box_ops(ops: &[Operation], boxes: usize) -> Option<std::ops::Range<usize>> {
    let len = 2 * boxes + 3;
    let start = ops.len().checked_sub(len)?;
    let tail = &ops[start..];
    let op = |i: usize, name: &str, operands: usize| tail[i].operator == name && tail[i].operands.len() == operands;
    let shaped = op(0, "q", 0) && op(1, "rg", 3) && op(len - 1, "Q", 0) && (0..boxes).all(|k| op(2 + 2 * k, "re", 4) && op(3 + 2 * k, "f", 0));
    shaped.then_some(start..ops.len())
}

/// True when nothing on `page` (forms included) that could show removed
/// content lies under any of `rects`: no glyph, painted path, shading or
/// image, no Pattern painting, no soft mask group. Only what this job drew
/// is exempt, by identity: the fill boxes at the end of the page content
/// and the images carrying `tag`. Content that cannot be interpreted fails.
pub(crate) fn verify_page(doc: &Document, page: ObjectId, rects: &[Rect], tag: &[u8]) -> bool {
    let Ok((seen, ops)) = page_seen(doc, page, tag) else {
        return false;
    };
    let events: Vec<Event> = seen.iter().map(|s| s.event.clone()).collect();
    if unanalysed_paint(&events, rects).is_some() {
        return false;
    }
    let mut budget = Budget::page(JOB_DECODED);
    for s in &seen {
        if let (Event::SoftMask(m), context) = (&s.event, &s.context)
            && soft_mask_meets(doc, m, context.as_deref(), rects, &mut budget, &mut Vec::new())
        {
            return false;
        }
    }
    let boxes = box_ops(&ops, rects.len());
    let is_box = |s: &Seen| match (&s.event, &boxes) {
        (Event::Path(p), Some(range)) => s.top && range.contains(&p.op_range.start) && p.op_range.end <= range.end && p.op_range.len() == 2,
        _ => false,
    };
    !seen.iter().any(|s| !is_box(s) && !s.tagged && left_under(&s.event, rects))
}

/// True when `event` draws content under a rect: a glyph, a painted path,
/// a shading or an image.
fn left_under(event: &Event, rects: &[Rect]) -> bool {
    match event {
        Event::Glyph(g) => quad_hit(&g.box_user, rects),
        Event::Path(p) => p.painted && p.bbox_user.is_some_and(|b| rects.iter().any(|r| b.overlaps(r))),
        Event::Shading(s) => shading_hit(s, rects),
        Event::Image(i) => quad_hit(&i.quad_user, rects),
        _ => false,
    }
}

/// True when a rasterized `page` draws exactly one thing: the image this
/// job made (carrying `tag`), and nothing else at all.
pub(crate) fn verify_raster_page(doc: &Document, page: ObjectId, tag: &[u8]) -> bool {
    let Ok((seen, _)) = page_seen(doc, page, tag) else {
        return false;
    };
    matches!(seen.as_slice(), [only] if only.top && only.tagged)
}

/// True when the content of soft-mask group `group` (drawn with `matrix`;
/// without its own /Resources it uses `resources`, those in effect where
/// the mask was set) puts a glyph, a painted path, a shading or an image
/// under a rect, or paints anything we cannot analyse there, whatever its
/// /BBox: such content is drawn into the mask. Soft masks set inside it are
/// followed the same way. Fails closed: unreadable content, a cycle or more
/// than `MAX_FORM_DEPTH` levels count as meeting the rects.
pub(crate) fn group_meets(doc: &Document, group: ObjectId, matrix: Matrix, resources: &Dictionary, rects: &[Rect], budget: &mut Budget) -> bool {
    group_meets_within(doc, group, matrix, Some(resources), rects, budget, &mut Vec::new())
}

/// `group_meets` for soft mask `m` set where `context` was in effect.
fn soft_mask_meets(
    doc: &Document,
    m: &super::interp::SoftMaskSet,
    context: Option<&Dictionary>,
    rects: &[Rect],
    budget: &mut Budget,
    groups: &mut Vec<ObjectId>,
) -> bool {
    match m.group {
        Some((group, matrix)) => group_meets_within(doc, group, matrix, context, rects, budget, groups),
        None => true,
    }
}

fn group_meets_within(
    doc: &Document,
    group: ObjectId,
    matrix: Matrix,
    resources: Option<&Dictionary>,
    rects: &[Rect],
    budget: &mut Budget,
    groups: &mut Vec<ObjectId>,
) -> bool {
    if groups.contains(&group) || groups.len() >= MAX_FORM_DEPTH {
        return true;
    }
    let Ok(Object::Stream(form)) = doc.get_object(group) else {
        return true;
    };
    let mut charged = 0;
    let decoded = strict_content_in(Some(doc), form, MAX_STREAM_DECODED.min(budget.decoded), &mut charged);
    budget.decoded = budget.decoded.saturating_sub(charged);
    let Decoded::Content(content) = decoded else {
        return true;
    };
    let Ok(ops) = decode_ops(&content) else {
        return true;
    };
    let inner = match (form.dict.get(b"Resources"), resources) {
        (Ok(res), _) => owned_dict(doc, Some(res)),
        (Err(_), Some(context)) => context.clone(),
        (Err(_), None) => return true,
    };
    groups.push(group);
    let mut seen = Vec::new();
    let mut forms = groups.clone();
    let mut meets = walk(doc, &ops, inner, matrix, Paint::default(), &mut forms, budget, &[], &mut seen).is_err();
    if !meets {
        let events: Vec<Event> = seen.iter().map(|s| s.event.clone()).collect();
        meets = unanalysed_paint(&events, rects).is_some() || events.iter().any(|e| left_under(e, rects));
    }
    if !meets {
        meets = seen.iter().any(|s| match &s.event {
            Event::SoftMask(m) => soft_mask_meets(doc, m, s.context.as_deref(), rects, budget, groups),
            _ => false,
        });
    }
    groups.pop();
    meets
}
