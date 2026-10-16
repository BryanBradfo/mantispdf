use crate::pdf_util::import_document;
use lopdf::{Document, Object, ObjectId};

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

    // Drop orphaned objects copied from the sources — their catalogs, outlines,
    // and intermediate /Pages nodes are now unreachable from base's trailer.
    base.prune_objects();

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
    let leaves = import_document(base, source);
    for &page_id in &leaves {
        if let Ok(page_dict) = base.get_object_mut(page_id).and_then(|o| o.as_dict_mut()) {
            page_dict.set("Parent", Object::Reference(base_pages_id));
        }
    }
    let kids = base
        .get_object_mut(base_pages_id)
        .and_then(|o| o.as_dict_mut())
        .map_err(|e| format!("Cannot access base Pages: {e}"))?
        .get_mut(b"Kids")
        .and_then(Object::as_array_mut)
        .map_err(|e| format!("Cannot access Kids array: {e}"))?;
    kids.extend(leaves.into_iter().map(Object::Reference));
    Ok(())
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

    fn count_catalogs(doc: &Document) -> usize {
        doc.objects
            .values()
            .filter(|o| {
                o.as_dict()
                    .ok()
                    .and_then(|d| d.get(b"Type").ok())
                    .and_then(|t| t.as_name().ok())
                    .map(|n| n == b"Catalog")
                    .unwrap_or(false)
            })
            .count()
    }

    #[test]
    fn test_merge_preserves_inherited_attributes() {
        use crate::pdf_util::{get_inherited_attr, make_inherited_test_pdf_sized};

        // Base pages inherit Letter (612x792); source pages inherit A4-ish
        // (842x1190). After merge the source pages are reparented under base's
        // /Pages — without materializing inheritance they'd wrongly inherit the
        // base's 612x792. Assert each appended page still resolves to 842x1190.
        let base = make_inherited_test_pdf_sized(2, 612, 792);
        let src = make_inherited_test_pdf_sized(2, 842, 1190);
        let merged = merge_documents(&[&base, &src]).unwrap();
        assert_eq!(page_count(&merged), 4);

        let doc = Document::load_mem(&merged).unwrap();
        let widths: Vec<i64> = doc
            .get_pages()
            .values()
            .map(|&pid| {
                let mb = get_inherited_attr(&doc, pid, b"MediaBox")
                    .expect("every page must resolve a MediaBox");
                mb.as_array().unwrap()[2].as_i64().unwrap()
            })
            .collect();
        // Pages 1-2 from base (612), pages 3-4 from source (842).
        assert_eq!(widths, vec![612, 612, 842, 842], "got page widths {widths:?}");

        // Every appended page must resolve its Resources too (was inherited).
        for (_, page_id) in doc.get_pages() {
            assert!(
                get_inherited_attr(&doc, page_id, b"Resources").is_some(),
                "every merged page must resolve a Resources dict"
            );
        }
        assert_eq!(
            count_catalogs(&doc),
            1,
            "merged doc must have exactly one catalog (source catalog pruned)"
        );
    }
}
