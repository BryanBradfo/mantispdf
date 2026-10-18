//! The e2e fixture (`e2e/fixtures/redact.pdf`, from
//! `scripts/make-redact-fixtures.py`) behaves as the e2e test expects.

use super::search::{SearchOptions, redact_search};
use super::verify::page_glyphs;
use super::*;
use crate::pdf_util::load_pdf;

fn fixture() -> Vec<u8> {
    std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../e2e/fixtures/redact.pdf")).unwrap()
}

fn area(page: u32, x: f64, y: f64, w: f64, h: f64) -> RedactRect {
    RedactRect { page, rect: [x, y, w, h] }
}

fn text(doc: &lopdf::Document, page: u32) -> String {
    let id = doc.get_pages()[&page];
    page_glyphs(doc, id).unwrap().iter().map(|g| char::from_u32(g.code).unwrap()).collect()
}

const OPTIONS: SearchOptions = SearchOptions { whole_word: false, case_sensitive: false };

#[test]
fn only_the_type3_page_needs_a_raster() {
    let plan = redact_plan(
        &fixture(),
        &[area(1, 72.0, 520.0, 80.0, 80.0), area(2, 72.0, 600.0, 50.0, 10.0), area(3, 72.0, 500.0, 10.0, 10.0), area(4, 72.0, 600.0, 20.0, 20.0)],
    )
    .unwrap();
    assert_eq!(plan.iter().map(|p| (p.page, p.reason.is_none())).collect::<Vec<_>>(), vec![(1, true), (2, true), (3, true), (4, false)]);
    assert!(plan[3].reason.as_deref().unwrap().contains("Type3"));
}

#[test]
fn search_finds_the_fixture_text() {
    let pdf = fixture();
    let smith = redact_search(&pdf, "SMITH", &OPTIONS).unwrap();
    assert_eq!(smith.pages.iter().map(|p| (p.page, p.rects.len())).collect::<Vec<_>>(), vec![(1, 1)]);
    let secret = redact_search(&pdf, "confidential", &OPTIONS).unwrap();
    assert_eq!(secret.pages.iter().map(|p| p.page).collect::<Vec<_>>(), vec![2, 3]);
    // The Type3 page cannot be read.
    assert_eq!(secret.undecodable_pages, vec![4]);
}

#[test]
fn the_fixture_redacts_end_to_end() {
    let pdf = fixture();
    let smith = redact_search(&pdf, "SMITH", &OPTIONS).unwrap();
    let mut rects: Vec<RedactRect> = smith.pages[0].rects.iter().map(|r| RedactRect { page: 1, rect: *r }).collect();
    // The left (red) half of the JPEG, the form text on page 2, the Type3 page.
    rects.push(area(1, 72.0, 520.0, 80.0, 80.0));
    let secret = redact_search(&pdf, "confidential", &OPTIONS).unwrap();
    rects.extend(secret.pages.iter().filter(|p| p.page == 2).flat_map(|p| p.rects.iter().map(|r| RedactRect { page: 2, rect: *r })));
    rects.push(area(4, 72.0, 590.0, 80.0, 40.0));
    let raster = PageRaster { page: 4, width: 612, height: 792, dpi: 72.0, rgba: vec![255; 612 * 792 * 4] };
    let job = RedactJob { rects, fill: Fill::Black, remove_metadata: true, rasters: vec![raster] };
    let (out, summary) = redact(&pdf, job).unwrap();
    assert_eq!((summary.pages_redacted.clone(), summary.pages_rasterized.clone()), (vec![1, 2], vec![4]));
    assert_eq!(summary.images_redacted, 1);
    let out = load_pdf(&out).unwrap();
    let page1 = text(&out, 1);
    assert!(page1.contains("JOHN") && !page1.contains("SMITH") && page1.contains("Public line stays"), "{page1}");
    assert!(!text(&out, 2).contains("CONFIDENTIAL"));
    assert!(text(&out, 3).contains("CONFIDENTIAL"), "the shared form is untouched elsewhere");
    assert_eq!(text(&out, 4), "");
}

#[test]
fn a_real_scan_with_a_ccitt_mask_needs_a_raster() {
    let path = "/home/wingleet/Téléchargements/form_337.pdf";
    let Ok(pdf) = std::fs::read(path) else {
        eprintln!("skipped: {path} not found");
        return;
    };
    let plan = redact_plan(&pdf, &[area(1, 100.0, 400.0, 200.0, 12.0)]).unwrap();
    let reason = plan[0].reason.clone().unwrap_or_default();
    assert!(reason.contains("image that cannot be edited"), "{reason:?}");
}
