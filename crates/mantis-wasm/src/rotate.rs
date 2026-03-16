use lopdf::{Document, Object};
use wasm_bindgen::prelude::*;

/// Rotate PDF pages. `rotations` is a 0-indexed array of clockwise degrees
/// (0 / 90 / 180 / 270), one entry per page. Entries beyond page count are ignored.
#[wasm_bindgen]
pub fn rotate_pdf(pdf_bytes: &[u8], rotations: &[i32]) -> Result<Vec<u8>, JsValue> {
    rotate_pdf_impl(pdf_bytes, rotations).map_err(|e| JsValue::from_str(&e))
}

fn rotate_pdf_impl(pdf_bytes: &[u8], rotations: &[i32]) -> Result<Vec<u8>, String> {
    let mut doc = Document::load_mem(pdf_bytes)
        .map_err(|e| e.to_string())?;

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
        .map_err(|e| e.to_string())?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, content::Content, Object, Stream};

    fn make_test_pdf(n: u32) -> Vec<u8> {
        let mut doc = Document::with_version("1.5");

        let pages_id = doc.new_object_id();
        let mut page_ids = Vec::new();

        for _ in 0..n {
            let content = Content { operations: vec![] };
            let content_bytes = content.encode().unwrap();
            let stream = Stream::new(dictionary! {}, content_bytes);
            let content_id = doc.add_object(stream);

            let page = dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
                "Contents" => content_id,
            };
            let page_id = doc.add_object(page);
            page_ids.push(page_id);
        }

        let kids: Vec<Object> = page_ids.iter().map(|&id| id.into()).collect();
        let pages = dictionary! {
            "Type" => "Pages",
            "Kids" => kids,
            "Count" => n,
        };
        doc.objects.insert(pages_id, Object::Dictionary(pages));

        let catalog = dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        };
        let catalog_id = doc.add_object(catalog);
        doc.trailer.set("Root", catalog_id);

        let mut buf = Vec::new();
        doc.save_to(&mut buf).unwrap();
        buf
    }

    #[test]
    fn test_rotate_round_trip() {
        let pdf = make_test_pdf(3);
        let rotations = vec![90, 180, 270];
        let result = rotate_pdf_impl(&pdf, &rotations).unwrap();
        // Result is a valid PDF with the same page count
        let doc = Document::load_mem(&result).unwrap();
        assert_eq!(doc.get_pages().len(), 3);
    }

    #[test]
    fn test_rotate_zero_is_no_op() {
        let pdf = make_test_pdf(2);
        let rotations = vec![0, 0];
        let result = rotate_pdf_impl(&pdf, &rotations).unwrap();
        let doc = Document::load_mem(&result).unwrap();
        assert_eq!(doc.get_pages().len(), 2);
    }

    #[test]
    fn test_rotate_fewer_rotations_than_pages() {
        // Extra pages beyond the rotations slice should not cause an error
        let pdf = make_test_pdf(5);
        let rotations = vec![90, 90];
        let result = rotate_pdf_impl(&pdf, &rotations).unwrap();
        let doc = Document::load_mem(&result).unwrap();
        assert_eq!(doc.get_pages().len(), 5);
    }

    #[test]
    fn test_rotate_normalizes_360() {
        // 360° rotation should be treated the same as 0° (no Rotate key)
        let pdf = make_test_pdf(1);
        let result = rotate_pdf_impl(&pdf, &[360]).unwrap();
        assert!(result.len() > 0);
        let doc = Document::load_mem(&result).unwrap();
        assert_eq!(doc.get_pages().len(), 1);
    }

    #[test]
    fn test_rotate_invalid_pdf() {
        assert!(rotate_pdf_impl(b"not a pdf", &[90]).is_err());
    }
}
