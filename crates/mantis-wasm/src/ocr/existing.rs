//! Whether a page already carries an OCR text layer: text drawn invisibly
//! (render mode 3) in a "GlyphLessFont" (Tesseract's font, which our own
//! layer embeds too), in the page's own content. Running OCR again on such
//! a page would stack a second layer and double every word for search.

use crate::page_content::original_contents;
use crate::rebuild::deref;
use crate::redact::Budget;
use crate::redact::interp::{content_ops, page_resources, page_resources_dict};
use lopdf::{Document, Object, ObjectId};

/// Show-text operators.
const SHOWS: [&str; 4] = ["Tj", "TJ", "'", "\""];

/// True when `page` shows text in render mode 3 with a GlyphLessFont.
/// Content that cannot be decoded within `budget` counts as no layer.
pub(crate) fn has_ocr_layer(doc: &Document, page: ObjectId, budget: &mut Budget) -> bool {
    let contents = doc.get_dictionary(page).ok().and_then(|d| d.get(b"Contents").ok());
    let Ok(ops) = content_ops(doc, &original_contents(doc, contents), budget) else {
        return false;
    };
    let fonts = page_resources_dict(doc, &page_resources(doc, page), b"Font");
    let glyphless = |name: &[u8]| {
        let font = fonts.get(name).ok().and_then(|f| deref(doc, f)).and_then(|f| f.as_dict().ok());
        let base = font.and_then(|f| f.get(b"BaseFont").ok()).and_then(|b| deref(doc, b)).and_then(|b| b.as_name().ok());
        // A subset prefix ("ABCDEF+") may precede the name.
        base.is_some_and(|b| b == b"GlyphLessFont" || b.ends_with(b"+GlyphLessFont"))
    };
    // Render mode and font are graphics state: saved by q, restored by Q.
    let mut state = (0i64, false);
    let mut saved = Vec::new();
    for op in &ops {
        match op.operator.as_str() {
            "q" => saved.push(state),
            "Q" => state = saved.pop().unwrap_or((0, false)),
            "Tr" => {
                if let Some(mode) = op.operands.first().and_then(|o| o.as_float().ok()) {
                    state.0 = mode as i64;
                }
            }
            "Tf" => {
                if let Some(Object::Name(name)) = op.operands.first() {
                    state.1 = glyphless(name);
                }
            }
            o if SHOWS.contains(&o) && state == (3, true) => return true,
            _ => {}
        }
    }
    false
}
