use lopdf::Document;

pub fn page_count(pdf_bytes: &[u8]) -> Result<u32, String> {
    let doc = Document::load_mem(pdf_bytes).map_err(|e| format!("Failed to parse PDF: {e}"))?;
    Ok(doc.get_pages().len() as u32)
}

pub fn extract_page_range(pdf_bytes: &[u8], start: u32, end: u32) -> Result<Vec<u8>, String> {
    let doc = Document::load_mem(pdf_bytes).map_err(|e| format!("Failed to parse PDF: {e}"))?;

    let total = doc.get_pages().len() as u32;
    if start < 1 || end < start || end > total {
        return Err(format!(
            "Invalid range {start}–{end} for a {total}-page document"
        ));
    }

    let pages_to_keep: Vec<u32> = (start..=end).collect();
    let pages_to_delete: Vec<u32> = (1..=total).filter(|p| !pages_to_keep.contains(p)).collect();

    let mut doc = doc;
    doc.delete_pages(&pages_to_delete);

    let mut buf = Vec::new();
    doc.save_to(&mut buf)
        .map_err(|e| format!("Failed to save PDF: {e}"))?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, content::Content, Object, Stream};

    /// Build a minimal in-memory PDF with `n` blank pages.
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
    fn test_page_count() {
        let pdf = make_test_pdf(5);
        assert_eq!(page_count(&pdf).unwrap(), 5);
    }

    #[test]
    fn test_page_count_single() {
        let pdf = make_test_pdf(1);
        assert_eq!(page_count(&pdf).unwrap(), 1);
    }

    #[test]
    fn test_extract_first_two_pages() {
        let pdf = make_test_pdf(5);
        let result = extract_page_range(&pdf, 1, 2).unwrap();
        assert_eq!(page_count(&result).unwrap(), 2);
    }

    #[test]
    fn test_extract_last_three_pages() {
        let pdf = make_test_pdf(5);
        let result = extract_page_range(&pdf, 3, 5).unwrap();
        assert_eq!(page_count(&result).unwrap(), 3);
    }

    #[test]
    fn test_extract_single_page() {
        let pdf = make_test_pdf(5);
        let result = extract_page_range(&pdf, 3, 3).unwrap();
        assert_eq!(page_count(&result).unwrap(), 1);
    }

    #[test]
    fn test_extract_all_pages() {
        let pdf = make_test_pdf(4);
        let result = extract_page_range(&pdf, 1, 4).unwrap();
        assert_eq!(page_count(&result).unwrap(), 4);
    }

    #[test]
    fn test_invalid_range_start_zero() {
        let pdf = make_test_pdf(3);
        assert!(extract_page_range(&pdf, 0, 2).is_err());
    }

    #[test]
    fn test_invalid_range_end_exceeds_total() {
        let pdf = make_test_pdf(3);
        assert!(extract_page_range(&pdf, 1, 10).is_err());
    }

    #[test]
    fn test_invalid_range_start_after_end() {
        let pdf = make_test_pdf(3);
        assert!(extract_page_range(&pdf, 3, 1).is_err());
    }

    #[test]
    fn test_invalid_pdf_bytes() {
        assert!(page_count(b"not a pdf").is_err());
        assert!(extract_page_range(b"not a pdf", 1, 1).is_err());
    }
}
