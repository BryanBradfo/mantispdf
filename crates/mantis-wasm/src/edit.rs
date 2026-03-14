use lopdf::{Document, Object, ObjectId};
use wasm_bindgen::prelude::*;

/// Reorder (and optionally delete) PDF pages.
///
/// `new_order` contains 1-indexed original page numbers in the desired final order.
/// Pages not present in `new_order` are deleted from the output.
#[wasm_bindgen]
pub fn reorder_pages(pdf_bytes: &[u8], new_order: &[u32]) -> Result<Vec<u8>, JsValue> {
    reorder_inner(pdf_bytes, new_order).map_err(|e| JsValue::from_str(&e))
}

fn reorder_inner(pdf_bytes: &[u8], new_order: &[u32]) -> Result<Vec<u8>, String> {
    if new_order.is_empty() {
        return Err("Cannot create a PDF with zero pages".to_string());
    }

    let mut doc = Document::load_mem(pdf_bytes)
        .map_err(|e| format!("Failed to parse PDF: {e}"))?;

    let pages_map: std::collections::BTreeMap<u32, ObjectId> = doc.get_pages();
    let total = pages_map.len() as u32;

    for &p in new_order {
        if p < 1 || p > total {
            return Err(format!(
                "Page {p} is out of range (document has {total} pages)"
            ));
        }
    }

    // Resolve root Pages object ID before mutably borrowing doc
    let pages_id = find_pages_id(&doc)?;

    // Build new flat Kids array in the requested order
    let new_kids: Vec<Object> = new_order
        .iter()
        .map(|&p| Object::Reference(pages_map[&p]))
        .collect();

    let new_count = new_kids.len() as i64;

    // Update root Pages node: replace Kids and Count
    let pages_dict = doc
        .get_object_mut(pages_id)
        .and_then(|o| o.as_dict_mut())
        .map_err(|e| format!("Cannot access Pages node: {e}"))?;

    pages_dict.set("Kids", Object::Array(new_kids));
    pages_dict.set("Count", Object::Integer(new_count));

    let mut buf = Vec::new();
    doc.save_to(&mut buf)
        .map_err(|e| format!("Failed to save edited PDF: {e}"))?;
    Ok(buf)
}

fn find_pages_id(doc: &Document) -> Result<ObjectId, String> {
    let catalog = doc.catalog().map_err(|e| format!("No catalog: {e}"))?;
    catalog
        .get(b"Pages")
        .and_then(Object::as_reference)
        .map_err(|e| format!("No Pages ref in catalog: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, content::Content, Stream};

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

    fn page_count(pdf_bytes: &[u8]) -> u32 {
        Document::load_mem(pdf_bytes).unwrap().get_pages().len() as u32
    }

    #[test]
    fn test_delete_middle_page() {
        let pdf = make_test_pdf(4);
        let result = reorder_inner(&pdf, &[1, 2, 4]).unwrap();
        assert_eq!(page_count(&result), 3);
    }

    #[test]
    fn test_keep_all_pages_same_order() {
        let pdf = make_test_pdf(3);
        let result = reorder_inner(&pdf, &[1, 2, 3]).unwrap();
        assert_eq!(page_count(&result), 3);
    }

    #[test]
    fn test_reverse_order() {
        let pdf = make_test_pdf(3);
        let result = reorder_inner(&pdf, &[3, 2, 1]).unwrap();
        assert_eq!(page_count(&result), 3);
    }

    #[test]
    fn test_single_page_kept() {
        let pdf = make_test_pdf(5);
        let result = reorder_inner(&pdf, &[3]).unwrap();
        assert_eq!(page_count(&result), 1);
    }

    #[test]
    fn test_empty_order_errors() {
        let pdf = make_test_pdf(3);
        assert!(reorder_inner(&pdf, &[]).is_err());
    }

    #[test]
    fn test_out_of_range_page() {
        let pdf = make_test_pdf(3);
        assert!(reorder_inner(&pdf, &[1, 5]).is_err());
    }

    #[test]
    fn test_delete_all_but_one() {
        let pdf = make_test_pdf(5);
        let result = reorder_inner(&pdf, &[2]).unwrap();
        assert_eq!(page_count(&result), 1);
    }
}
