//! Whether a page already carries an OCR text layer: invisible text
//! (render mode 3, or 7: clip only) in a "GlyphLessFont" (Tesseract's font,
//! which our own layer embeds too), in the page's content or in the form
//! XObjects it draws. Running OCR again on such a page would stack a second
//! layer and double every word for search.

use crate::page_content::{original_contents, owned_dict};
use crate::rebuild::deref;
use crate::redact::Budget;
use crate::redact::forms::{MAX_FORM_DEPTH, form_content};
use crate::redact::interp::{content_ops, decode_ops, page_resources, page_resources_dict};
use lopdf::content::Operation;
use lopdf::{Dictionary, Document, Object, ObjectId};

/// Show-text operators.
const SHOWS: [&str; 4] = ["Tj", "TJ", "'", "\""];

/// Render mode and whether the current font is a GlyphLessFont: graphics
/// state, saved by `q` and restored by `Q` (and around a form).
type State = (i64, bool);

/// True when `page` shows invisible text with a GlyphLessFont. Content that
/// cannot be decoded within `budget` counts as no layer.
pub(crate) fn has_ocr_layer(doc: &Document, page: ObjectId, budget: &mut Budget) -> bool {
    let contents = doc.get_dictionary(page).ok().and_then(|d| d.get(b"Contents").ok());
    let Ok(ops) = content_ops(doc, &original_contents(doc, contents), budget) else {
        return false;
    };
    scan(doc, &ops, &page_resources(doc, page), (0, false), &mut Vec::new(), budget)
}

fn glyphless(doc: &Document, fonts: &Dictionary, name: &[u8]) -> bool {
    let font = fonts.get(name).ok().and_then(|f| deref(doc, f)).and_then(|f| f.as_dict().ok());
    let base = font.and_then(|f| f.get(b"BaseFont").ok()).and_then(|b| deref(doc, b)).and_then(|b| b.as_name().ok());
    // A subset prefix ("ABCDEF+") may precede the name.
    base.is_some_and(|b| b == b"GlyphLessFont" || b.ends_with(b"+GlyphLessFont"))
}

/// `ops` (with `resources`) shows invisible GlyphLessFont text, forms
/// included; `forms` are the forms being drawn (for loops and depth).
fn scan(doc: &Document, ops: &[Operation], resources: &Dictionary, start: State, forms: &mut Vec<ObjectId>, budget: &mut Budget) -> bool {
    let fonts = page_resources_dict(doc, resources, b"Font");
    let xobjects = page_resources_dict(doc, resources, b"XObject");
    let mut state = start;
    let mut saved = Vec::new();
    for op in ops {
        match op.operator.as_str() {
            "q" => saved.push(state),
            "Q" => state = saved.pop().unwrap_or(start),
            "Tr" => {
                if let Some(mode) = op.operands.first().and_then(|o| o.as_float().ok()) {
                    state.0 = mode as i64;
                }
            }
            "Tf" => {
                if let Some(Object::Name(name)) = op.operands.first() {
                    state.1 = glyphless(doc, &fonts, name);
                }
            }
            o if SHOWS.contains(&o) && matches!(state, (3 | 7, true)) => return true,
            "Do" => {
                let Some(Object::Name(name)) = op.operands.first() else { continue };
                let Ok(entry) = xobjects.get(name) else { continue };
                let id = entry.as_reference().ok();
                if id.is_some_and(|id| forms.contains(&id)) || forms.len() >= MAX_FORM_DEPTH {
                    continue;
                }
                let Some(Object::Stream(form)) = deref(doc, entry) else { continue };
                if !matches!(form.dict.get(b"Subtype").ok().and_then(|s| s.as_name().ok()), Some(b"Form")) {
                    continue;
                }
                let Ok(inner_ops) = form_content(doc, form, budget).and_then(|c| decode_ops(&c)) else { continue };
                // A form without /Resources uses its caller's.
                let inner = match form.dict.get(b"Resources") {
                    Ok(res) => owned_dict(doc, Some(res)),
                    Err(_) => resources.clone(),
                };
                if let Some(id) = id {
                    forms.push(id);
                }
                // The form runs on a copy of the caller's state (an implicit q ... Q).
                let found = scan(doc, &inner_ops, &inner, state, forms, budget);
                if id.is_some() {
                    forms.pop();
                }
                if found {
                    return true;
                }
            }
            _ => {}
        }
    }
    false
}
