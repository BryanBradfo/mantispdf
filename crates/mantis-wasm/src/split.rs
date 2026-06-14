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
    // delete_pages updates /Kids+/Count but leaves the dropped pages' content,
    // fonts, and images as orphans. Prune them so the extracted file shrinks.
    doc.prune_objects();

    let mut buf = Vec::new();
    doc.save_to(&mut buf)
        .map_err(|e| format!("Failed to save PDF: {e}"))?;
    Ok(buf)
}

pub fn extract_range_from_doc(doc: &Document, total_pages: u32, start: u32, end: u32) -> Result<Vec<u8>, String> {
    if start < 1 || end < start || end > total_pages {
        return Err(format!("Invalid range {start}–{end} for a {total_pages}-page document"));
    }
    let pages_to_delete: Vec<u32> = (1..=total_pages).filter(|p| *p < start || *p > end).collect();
    let mut part = doc.clone();
    part.delete_pages(&pages_to_delete);
    // Prune orphaned objects from the dropped pages so each extracted range is
    // lean (this is also the real speed win for the parse-once optimization:
    // far less to serialize and transfer than the full cloned document).
    part.prune_objects();
    let mut buf = Vec::new();
    part.save_to(&mut buf).map_err(|e| format!("Failed to save PDF: {e}"))?;
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

    /// Benchmark: parse-once (WasmPdf path) vs re-parse-per-range (old path),
    /// both with pruning. Ignored by default — run with:
    ///   cargo test --release -- --ignored --nocapture bench_split_strategies
    #[test]
    #[ignore]
    fn bench_split_strategies() {
        use std::time::Instant;

        // A 100-page document; each page carries a ~5KB content stream so parsing
        // and cloning both have real work to do.
        const PAGES: u32 = 100;
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let mut page_ids = Vec::new();
        for _ in 0..PAGES {
            let content_id = doc.add_object(Stream::new(dictionary! {}, vec![b'x'; 5_000]));
            let page = dictionary! {
                "Type" => "Page", "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
                "Contents" => content_id,
            };
            page_ids.push(doc.add_object(page));
        }
        let kids: Vec<Object> = page_ids.iter().map(|&id| id.into()).collect();
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => PAGES as i64 }),
        );
        let catalog_id = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", catalog_id);
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();

        // Strategy A: re-parse the bytes for every single-page extract.
        let t0 = Instant::now();
        let mut total_a = 0usize;
        for p in 1..=PAGES {
            total_a += extract_page_range(&bytes, p, p).unwrap().len();
        }
        let dur_a = t0.elapsed();

        // Strategy B: parse once, clone+prune per range.
        let t1 = Instant::now();
        let parsed = Document::load_mem(&bytes).unwrap();
        let total_pages = parsed.get_pages().len() as u32;
        let mut total_b = 0usize;
        for p in 1..=PAGES {
            total_b += extract_range_from_doc(&parsed, total_pages, p, p).unwrap().len();
        }
        let dur_b = t1.elapsed();

        println!("split bench over {PAGES} single-page extracts ({} KB source):", bytes.len() / 1024);
        println!("  A re-parse-per-range : {dur_a:?}  (total {} KB out)", total_a / 1024);
        println!("  B parse-once+clone   : {dur_b:?}  (total {} KB out)", total_b / 1024);
        let ratio = dur_a.as_secs_f64() / dur_b.as_secs_f64();
        println!("  speedup (A/B)        : {ratio:.2}x");
        // Sanity: both strategies must produce identical-size single-page output.
        assert_eq!(total_a, total_b, "both strategies must produce equal output");
    }

    #[test]
    fn test_extract_prunes_other_pages_content() {
        // 5 pages, each with its own ~10KB content stream.
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let mut page_ids = Vec::new();
        for i in 0..5u32 {
            let big = vec![b' '; 10_000]; // distinct, page-unique content
            let mut stream = Stream::new(dictionary! {}, big);
            stream.dict.set("PageMarker", Object::Integer(i as i64));
            let content_id = doc.add_object(stream);
            let page = dictionary! {
                "Type" => "Page", "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
                "Contents" => content_id,
            };
            page_ids.push(doc.add_object(page));
        }
        let kids: Vec<Object> = page_ids.iter().map(|&id| id.into()).collect();
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => 5 }),
        );
        let catalog_id = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", catalog_id);
        let mut full = Vec::new();
        doc.save_to(&mut full).unwrap();

        let one_page = extract_page_range(&full, 1, 1).unwrap();
        assert_eq!(page_count(&one_page).unwrap(), 1);
        // Without pruning the output carries all 5 content streams (~50KB).
        // With pruning it carries ~1. Assert it dropped at least 3 pages' worth.
        assert!(
            one_page.len() < full.len() - 30_000,
            "pruned 1-page extract ({} bytes) should be far smaller than the 5-page source ({} bytes)",
            one_page.len(),
            full.len()
        );
    }
}
