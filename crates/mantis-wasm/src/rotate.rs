use lopdf::{Document, Object};
use wasm_bindgen::prelude::*;

/// Rotate PDF pages. `rotations` is a 0-indexed array of clockwise degrees
/// (0 / 90 / 180 / 270), one entry per page. Entries beyond page count are ignored.
#[wasm_bindgen]
pub fn rotate_pdf(pdf_bytes: &[u8], rotations: &[i32]) -> Result<Vec<u8>, JsValue> {
    let mut doc = Document::load_mem(pdf_bytes)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    // get_pages() → BTreeMap<u32 (1-based page num), ObjectId>
    let pages: std::collections::BTreeMap<u32, lopdf::ObjectId> = doc.get_pages();

    for (page_num, obj_id) in &pages {
        let idx = (*page_num - 1) as usize;
        if idx >= rotations.len() {
            continue;
        }
        let rot = ((rotations[idx] % 360) + 360) % 360;
        if let Some(Object::Dictionary(dict)) = doc.objects.get_mut(obj_id) {
            if rot == 0 {
                dict.remove(b"Rotate");
            } else {
                dict.set("Rotate", Object::Integer(rot as i64));
            }
        }
    }

    let mut buf = Vec::new();
    doc.save_to(&mut buf)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    Ok(buf)
}
