//! Form XObjects: redacted through a private copy per placement (other
//! users keep the original), recursively.

use super::interp::{FormPlacement, Interp, Rect, decode_ops, encode_ops, page_resources_dict};
use super::page::flate_stream;
use super::{PageEdit, Report, Unsupported, add_xobject, redact_content};
use crate::page_content::owned_dict;
use crate::rebuild::{Decoded, MAX_STREAM_DECODED, deref, strict_content_in};
use lopdf::content::Operation;
use lopdf::{Object, Stream};

/// Deepest form nesting redacted.
pub(crate) const MAX_FORM_DEPTH: usize = 16;

/// Form dictionary keys a redacted copy drops: metadata and private data
/// may repeat the removed content, and a reference XObject points elsewhere.
const DROPPED_KEYS: [&[u8]; 8] =
    [b"Filter", b"DecodeParms", b"Length", b"Metadata", b"PieceInfo", b"Ref", b"StructParents", b"OPI"];

/// Redact the form drawn by `placement`. Returns the name of a private
/// redacted copy (None when nothing in it changes) and what was removed.
pub(crate) fn redact_form(page: &mut PageEdit, placement: &FormPlacement, rects: &[Rect]) -> Result<(Option<Vec<u8>>, Report), Unsupported> {
    let xobjects = page_resources_dict(page.doc, page.resources, b"XObject");
    let entry = xobjects.get(&placement.name).map_err(|_| Unsupported::new("form XObject not found"))?;
    let id = entry.as_reference().ok();
    if let Some(id) = id
        && page.forms.contains(&id)
    {
        return Err(Unsupported::new("form XObject cycle"));
    }
    if page.forms.len() >= MAX_FORM_DEPTH {
        return Err(Unsupported::new("form XObjects nest too deep"));
    }
    let Some(Object::Stream(form)) = deref(page.doc, entry) else {
        return Err(Unsupported::new("form XObject not found"));
    };
    let form: Stream = form.clone();
    let mut charged = 0;
    let decoded = strict_content_in(Some(page.doc), &form, MAX_STREAM_DECODED.min(page.budget.decoded), &mut charged);
    page.budget.decoded = page.budget.decoded.saturating_sub(charged);
    let content = match decoded {
        Decoded::Content(bytes) => bytes,
        Decoded::TooLarge => return Err(Unsupported::new("form content too large")),
        Decoded::Failed => return Err(Unsupported::new("form content cannot be decoded")),
    };
    let ops: Vec<Operation> = decode_ops(&content)?;
    // A form without /Resources draws from those of the content around it.
    let mut resources = match form.dict.get(b"Resources") {
        Ok(res) => owned_dict(page.doc, Some(res)),
        Err(_) => page.resources.clone(),
    };
    let events = Interp::new(page.doc, resources.clone()).run(&ops, placement.matrix, page.budget)?;
    let mut forms = page.forms.clone();
    forms.extend(id);
    let mut inner = PageEdit { doc: &mut *page.doc, resources: &mut resources, fill: page.fill, budget: &mut *page.budget, forms };
    let (new_ops, report) = redact_content(&mut inner, &ops, &events, rects)?;
    if report == Report::default() {
        return Ok((None, report));
    }
    let mut dict = form.dict.clone();
    for key in DROPPED_KEYS {
        dict.remove(key);
    }
    dict.set("Resources", Object::Dictionary(resources));
    let name = add_xobject(page, flate_stream(dict, &encode_ops(&new_ops)), "RedactedFm");
    Ok((Some(name), report))
}
