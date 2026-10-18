//! Verification: the redacted output is interpreted again and no glyph may
//! remain under an area.

use super::forms::MAX_FORM_DEPTH;
use super::graphics::quad_hit;
use super::interp::{Event, Glyph, IDENTITY, Interp, Matrix, Rect, content_ops, decode_ops, page_resources, page_resources_dict};
use super::{Budget, JOB_DECODED, Unsupported};
use crate::page_content::original_contents;
use crate::rebuild::{Decoded, MAX_STREAM_DECODED, deref, strict_content_in};
use lopdf::content::Operation;
use lopdf::{Dictionary, Document, Object, ObjectId};

/// Every glyph drawn by `page`, its forms included.
pub(crate) fn page_glyphs(doc: &Document, page: ObjectId) -> Result<Vec<Glyph>, Unsupported> {
    let mut budget = Budget::page(JOB_DECODED);
    let contents = doc.get_dictionary(page).ok().and_then(|d| d.get(b"Contents").ok());
    let ops = content_ops(doc, &original_contents(doc, contents), &mut budget)?;
    let mut glyphs = Vec::new();
    walk(doc, &ops, page_resources(doc, page), IDENTITY, &mut Vec::new(), &mut budget, &mut glyphs)?;
    Ok(glyphs)
}

fn walk(
    doc: &Document,
    ops: &[Operation],
    resources: Dictionary,
    ctm: Matrix,
    forms: &mut Vec<ObjectId>,
    budget: &mut Budget,
    glyphs: &mut Vec<Glyph>,
) -> Result<(), Unsupported> {
    let events = Interp::new(doc, resources.clone()).run(ops, ctm, budget)?;
    let xobjects = page_resources_dict(doc, &resources, b"XObject");
    for event in events {
        match event {
            Event::Glyph(g) => glyphs.push(g),
            Event::Form(f) => {
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
                    Ok(res) => crate::page_content::owned_dict(doc, Some(res)),
                    Err(_) => resources.clone(),
                };
                forms.extend(id);
                walk(doc, &decode_ops(&content)?, inner, f.matrix, forms, budget, glyphs)?;
                if id.is_some() {
                    forms.pop();
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// Ok when no glyph of `page` (forms included) lies under any of `rects`.
pub(crate) fn verify_page(doc: &Document, page: ObjectId, rects: &[Rect]) -> bool {
    page_glyphs(doc, page).is_ok_and(|glyphs| !glyphs.iter().any(|g| quad_hit(&g.box_user, rects)))
}
