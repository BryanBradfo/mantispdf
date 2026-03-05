use lopdf::{Document, Object, ObjectId};
use std::collections::BTreeMap;

/// Merge multiple PDF documents into one.
///
/// Copies all objects from each source document into the first one,
/// remapping object IDs to avoid collisions, then appends pages
/// to the base document's page tree.
pub fn merge_documents(pdfs: &[&[u8]]) -> Result<Vec<u8>, String> {
    if pdfs.is_empty() {
        return Err("No documents to merge".to_string());
    }
    if pdfs.len() == 1 {
        return Ok(pdfs[0].to_vec());
    }

    let mut base =
        Document::load_mem(pdfs[0]).map_err(|e| format!("Failed to parse PDF 1: {e}"))?;

    // Find the base document's Pages object ID
    let base_pages_id = find_pages_id(&base)?;

    for (i, pdf_bytes) in pdfs.iter().enumerate().skip(1) {
        let source = Document::load_mem(pdf_bytes)
            .map_err(|e| format!("Failed to parse PDF {}: {e}", i + 1))?;

        append_document(&mut base, &source, base_pages_id)
            .map_err(|e| format!("Failed to merge PDF {}: {e}", i + 1))?;
    }

    // Update the page count in the base Pages dict
    let total_pages = base.get_pages().len() as i64;
    if let Ok(pages_dict) = base.get_object_mut(base_pages_id).and_then(|o| o.as_dict_mut()) {
        pages_dict.set("Count", Object::Integer(total_pages));
    }

    let mut buf = Vec::new();
    base.save_to(&mut buf)
        .map_err(|e| format!("Failed to save merged PDF: {e}"))?;
    Ok(buf)
}

fn find_pages_id(doc: &Document) -> Result<ObjectId, String> {
    let catalog = doc.catalog().map_err(|e| format!("No catalog: {e}"))?;
    catalog
        .get(b"Pages")
        .and_then(Object::as_reference)
        .map_err(|e| format!("No Pages ref in catalog: {e}"))
}

fn append_document(
    base: &mut Document,
    source: &Document,
    base_pages_id: ObjectId,
) -> Result<(), String> {
    // Build a mapping from source object IDs to new IDs in the base
    let mut id_map: BTreeMap<ObjectId, ObjectId> = BTreeMap::new();
    for &old_id in source.objects.keys() {
        let new_id = base.new_object_id();
        id_map.insert(old_id, new_id);
    }

    // Copy all objects from source into base with remapped IDs
    for (&old_id, object) in &source.objects {
        let new_id = id_map[&old_id];
        let mut new_obj = object.clone();
        remap_references(&mut new_obj, &id_map);
        base.objects.insert(new_id, new_obj);
    }

    // Get source's page object IDs (sorted by page number) and remap them
    let source_pages: Vec<ObjectId> = source
        .get_pages()
        .into_iter()
        .collect::<BTreeMap<_, _>>()
        .values()
        .map(|&old_id| id_map[&old_id])
        .collect();

    // Update each copied page's Parent to point to base's Pages node
    for &page_id in &source_pages {
        if let Ok(page_dict) = base.get_object_mut(page_id).and_then(|o| o.as_dict_mut()) {
            page_dict.set("Parent", Object::Reference(base_pages_id));
        }
    }

    // Append page references to the base Pages Kids array
    let base_pages = base
        .get_object_mut(base_pages_id)
        .and_then(|o| o.as_dict_mut())
        .map_err(|e| format!("Cannot access base Pages: {e}"))?;

    let kids = base_pages
        .get_mut(b"Kids")
        .and_then(Object::as_array_mut)
        .map_err(|e| format!("Cannot access Kids array: {e}"))?;

    for page_id in source_pages {
        kids.push(Object::Reference(page_id));
    }

    Ok(())
}

/// Recursively remap all Object::Reference values using the ID map.
fn remap_references(object: &mut Object, id_map: &BTreeMap<ObjectId, ObjectId>) {
    match object {
        Object::Reference(id) => {
            if let Some(&new_id) = id_map.get(id) {
                *id = new_id;
            }
        }
        Object::Array(arr) => {
            for item in arr.iter_mut() {
                remap_references(item, id_map);
            }
        }
        Object::Dictionary(dict) => {
            for (_, val) in dict.iter_mut() {
                remap_references(val, id_map);
            }
        }
        Object::Stream(stream) => {
            for (_, val) in stream.dict.iter_mut() {
                remap_references(val, id_map);
            }
        }
        _ => {}
    }
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
    fn test_merge_two_documents() {
        let a = make_test_pdf(3);
        let b = make_test_pdf(2);
        let merged = merge_documents(&[&a, &b]).unwrap();
        assert_eq!(page_count(&merged), 5);
    }

    #[test]
    fn test_merge_three_documents() {
        let a = make_test_pdf(1);
        let b = make_test_pdf(2);
        let c = make_test_pdf(3);
        let merged = merge_documents(&[&a, &b, &c]).unwrap();
        assert_eq!(page_count(&merged), 6);
    }

    #[test]
    fn test_merge_single_document() {
        let a = make_test_pdf(4);
        let merged = merge_documents(&[&a]).unwrap();
        assert_eq!(page_count(&merged), 4);
    }

    #[test]
    fn test_merge_empty_list() {
        assert!(merge_documents(&[]).is_err());
    }

    #[test]
    fn test_merge_invalid_pdf() {
        let good = make_test_pdf(2);
        let bad = b"not a pdf";
        assert!(merge_documents(&[&good, bad]).is_err());
    }

    #[test]
    fn test_merge_many_single_page_docs() {
        let docs: Vec<Vec<u8>> = (0..5).map(|_| make_test_pdf(1)).collect();
        let slices: Vec<&[u8]> = docs.iter().map(|d| d.as_slice()).collect();
        let merged = merge_documents(&slices).unwrap();
        assert_eq!(page_count(&merged), 5);
    }
}
