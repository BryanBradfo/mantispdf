//! Crop: sets `/CropBox` from a rectangle given in visible page space. The
//! content outside stays in the file (hidden, not deleted).

use super::{apply, box_object, bounded, check_page, invalid, page_map, selected_numbers};
use crate::pdf_util::{load_pdf, save_pdf};
use crate::stamp::engine::PageSelection;
use crate::stamp::geometry::{VisibleBox, read_box};
use lopdf::{Document, ObjectId};
use std::collections::BTreeMap;

/// Crop entries one job may carry.
pub(crate) const MAX_PER_PAGE: usize = 10_000;

#[derive(Debug, Clone)]
pub struct CropJob {
    pub pages: PageSelection,
    /// Visible-space `[x, y, width, height]` for every page in `pages`.
    pub rect: Option<[f64; 4]>,
    /// `(page, [x, y, width, height])`: overrides `rect` for that page (which
    /// need not be in `pages`).
    pub per_page: Vec<(u32, [f64; 4])>,
    /// Also set `/MediaBox` to the crop, for viewers that ignore `/CropBox`.
    pub permanent: bool,
}

/// A page box key and its new value; None removes the key.
type BoxWrite = (&'static [u8], Option<[f64; 4]>);

pub fn crop_pages(pdf: &[u8], job: &CropJob) -> Result<Vec<u8>, String> {
    if job.rect.is_some_and(|r| !bounded(&r)) {
        return Err(invalid("rect"));
    }
    if job.per_page.len() > MAX_PER_PAGE || job.per_page.iter().any(|(_, r)| !bounded(r)) {
        return Err(invalid("per_page"));
    }
    let mut doc = load_pdf(pdf)?;
    let pages = page_map(&doc);
    let total = pages.len() as u32;

    // Page number -> visible rect; per_page entries override `rect`.
    let mut rects: BTreeMap<u32, [f64; 4]> = BTreeMap::new();
    let selected = selected_numbers(&job.pages, total)?;
    if let Some(rect) = job.rect {
        rects.extend(selected.into_iter().map(|n| (n, rect)));
    }
    for &(n, rect) in &job.per_page {
        check_page(n, total)?;
        rects.insert(n, rect);
    }

    // Compute every box first, so an error leaves nothing half-written. A
    // page object listed twice in the tree keeps its last crop.
    let mut writes: BTreeMap<ObjectId, Vec<BoxWrite>> = BTreeMap::new();
    for (n, rect) in rects {
        let id = pages[&n];
        let crop = user_crop(&doc, id, rect).ok_or_else(|| {
            format!("The crop area on page {n} is outside the page or smaller than 1 pt")
        })?;
        let mut boxes: Vec<BoxWrite> = vec![(b"CropBox", Some(crop))];
        for key in [&b"TrimBox"[..], b"ArtBox", b"BleedBox"] {
            if let Some(current) = read_box(&doc, id, key) {
                boxes.push((key, intersect(current, crop)));
            }
        }
        if job.permanent {
            boxes.push((b"MediaBox", Some(crop)));
        }
        writes.insert(id, boxes);
    }

    // Boxes are written as direct arrays on the leaf: a /Pages node or a box
    // object shared by reference is never edited.
    for (id, boxes) in writes {
        let page = doc.get_dictionary_mut(id).map_err(|e| format!("Page {id:?} not found: {e}"))?;
        for (key, value) in boxes {
            match value {
                Some(b) => page.set(key, box_object(b)),
                None => {
                    page.remove(key);
                }
            }
        }
    }
    save_pdf(&mut doc)
}

/// The user-space crop box of visible `[x, y, w, h]` on page `id`, clamped
/// to the visible page; None when under 1 pt wide or high.
fn user_crop(doc: &Document, id: ObjectId, [x, y, w, h]: [f64; 4]) -> Option<[f64; 4]> {
    let vb = VisibleBox::of_page(doc, id);
    let (x0, x1) = (x.min(x + w).max(0.0), x.max(x + w).min(vb.width()));
    let (y0, y1) = (y.min(y + h).max(0.0), y.max(y + h).min(vb.height()));
    // A negative extent is not a crop the user drew.
    if w < 0.0 || h < 0.0 || x1 - x0 < 1.0 || y1 - y0 < 1.0 {
        return None;
    }
    let m = vb.matrix();
    let (ax, ay) = apply(m, x0, y0);
    let (bx, by) = apply(m, x1, y1);
    Some([ax.min(bx), ay.min(by), ax.max(bx), ay.max(by)])
}

/// Intersection of two normalized boxes; None when empty.
fn intersect(a: [f64; 4], b: [f64; 4]) -> Option<[f64; 4]> {
    let r = [a[0].max(b[0]), a[1].max(b[1]), a[2].min(b[2]), a[3].min(b[3])];
    (r[2] > r[0] && r[3] > r[1]).then_some(r)
}

#[cfg(test)]
mod tests {
    use super::super::fixture::{Fixture, nums, pages, read_nums};
    use super::*;
    use lopdf::{Dictionary, Document, dictionary};

    const MEDIA: [f64; 4] = [0.0, 0.0, 600.0, 800.0];

    fn one_page(entries: Dictionary) -> Vec<u8> {
        let mut f = Fixture::new();
        f.page(entries, "BT /F1 12 Tf 72 700 Td (Hello) Tj ET");
        f.finish(Dictionary::new())
    }

    fn rotated(rotate: i64) -> Vec<u8> {
        one_page(dictionary! { "MediaBox" => nums(&MEDIA), "Rotate" => rotate })
    }

    fn job(rect: [f64; 4]) -> CropJob {
        CropJob { pages: PageSelection::All, rect: Some(rect), per_page: vec![], permanent: false }
    }

    fn crop(pdf: &[u8], job: &CropJob) -> Document {
        Document::load_mem(&crop_pages(pdf, job).unwrap()).unwrap()
    }

    fn leaf(doc: &Document, n: usize) -> &Dictionary {
        doc.get_dictionary(pages(doc)[n]).unwrap()
    }

    // MediaBox 0 0 600 800; visible rect x=100 y=200 w=300 h=400, so the
    // visible corners are (100, 200) and (400, 600). user = (a*vx + c*vy + e,
    // b*vx + d*vy + f) with the VisibleBox matrix of each rotation.
    #[test]
    fn rotate_0_maps_visible_rect_to_user_cropbox() {
        // [1 0 0 1 0 0]: the identity.
        let doc = crop(&rotated(0), &job([100.0, 200.0, 300.0, 400.0]));
        assert_eq!(read_nums(leaf(&doc, 0), b"CropBox"), [100.0, 200.0, 400.0, 600.0]);
    }

    #[test]
    fn rotate_90_maps_visible_rect_to_user_cropbox() {
        // [0 1 -1 0 x1=600 y0=0]: user = (600 - vy, vx).
        // (100, 200) -> (400, 100); (400, 600) -> (0, 400).
        // Normalized: [0 100 400 400].
        let doc = crop(&rotated(90), &job([100.0, 200.0, 300.0, 400.0]));
        assert_eq!(read_nums(leaf(&doc, 0), b"CropBox"), [0.0, 100.0, 400.0, 400.0]);
    }

    #[test]
    fn rotate_180_maps_visible_rect_to_user_cropbox() {
        // [-1 0 0 -1 x1=600 y1=800]: user = (600 - vx, 800 - vy).
        // (100, 200) -> (500, 600); (400, 600) -> (200, 200).
        let doc = crop(&rotated(180), &job([100.0, 200.0, 300.0, 400.0]));
        assert_eq!(read_nums(leaf(&doc, 0), b"CropBox"), [200.0, 200.0, 500.0, 600.0]);
    }

    #[test]
    fn rotate_270_maps_visible_rect_to_user_cropbox() {
        // [0 -1 1 0 x0=0 y1=800]: user = (vy, 800 - vx).
        // (100, 200) -> (200, 700); (400, 600) -> (600, 400).
        // Normalized: [200 400 600 700].
        let doc = crop(&rotated(270), &job([100.0, 200.0, 300.0, 400.0]));
        assert_eq!(read_nums(leaf(&doc, 0), b"CropBox"), [200.0, 400.0, 600.0, 700.0]);
    }

    #[test]
    fn rect_is_clamped_to_the_visible_page() {
        let doc = crop(&rotated(0), &job([-50.0, 700.0, 1000.0, 500.0]));
        assert_eq!(read_nums(leaf(&doc, 0), b"CropBox"), [0.0, 700.0, 600.0, 800.0]);
    }

    #[test]
    fn rect_is_relative_to_an_existing_cropbox() {
        let pdf = one_page(dictionary! {
            "MediaBox" => nums(&MEDIA), "CropBox" => nums(&[50.0, 50.0, 550.0, 750.0]),
        });
        let doc = crop(&pdf, &job([10.0, 20.0, 100.0, 100.0]));
        assert_eq!(read_nums(leaf(&doc, 0), b"CropBox"), [60.0, 70.0, 160.0, 170.0]);
    }

    #[test]
    fn too_small_after_clamping_is_an_error() {
        assert!(crop_pages(&rotated(0), &job([599.5, 0.0, 100.0, 100.0])).is_err());
        assert!(crop_pages(&rotated(0), &job([10.0, 10.0, 0.5, 100.0])).is_err());
        assert!(crop_pages(&rotated(0), &job([10.0, 10.0, 100.0, -5.0])).is_err());
    }

    #[test]
    fn invalid_values_are_refused() {
        let e = crop_pages(&rotated(0), &job([f64::NAN, 0.0, 10.0, 10.0])).unwrap_err();
        assert_eq!(e, "Invalid geometry settings: rect");
        let e = crop_pages(&rotated(0), &job([0.0, 0.0, 2e6, 10.0])).unwrap_err();
        assert_eq!(e, "Invalid geometry settings: rect");
        let mut j = job([0.0, 0.0, 10.0, 10.0]);
        j.per_page = vec![(1, [0.0, f64::INFINITY, 10.0, 10.0])];
        assert_eq!(crop_pages(&rotated(0), &j).unwrap_err(), "Invalid geometry settings: per_page");
        j.per_page = vec![(1, [0.0, 0.0, 10.0, 10.0]); MAX_PER_PAGE + 1];
        assert_eq!(crop_pages(&rotated(0), &j).unwrap_err(), "Invalid geometry settings: per_page");
        j.per_page = vec![(2, [0.0, 0.0, 10.0, 10.0])];
        assert!(crop_pages(&rotated(0), &j).unwrap_err().contains("Page 2 does not exist"));
        let j = CropJob { pages: PageSelection::List(vec![0]), ..job([0.0, 0.0, 10.0, 10.0]) };
        assert!(crop_pages(&rotated(0), &j).is_err());
    }

    fn three_pages() -> Vec<u8> {
        let mut f = Fixture::new();
        for _ in 0..3 {
            f.page(dictionary! { "MediaBox" => nums(&MEDIA) }, "BT /F1 12 Tf 72 700 Td (Hi) Tj ET");
        }
        f.finish(Dictionary::new())
    }

    #[test]
    fn only_selected_pages_change_and_per_page_overrides() {
        let j = CropJob {
            pages: PageSelection::List(vec![1, 2]),
            rect: Some([0.0, 0.0, 100.0, 100.0]),
            per_page: vec![(2, [10.0, 10.0, 50.0, 50.0]), (3, [20.0, 20.0, 30.0, 30.0])],
            permanent: false,
        };
        let doc = crop(&three_pages(), &j);
        assert_eq!(read_nums(leaf(&doc, 0), b"CropBox"), [0.0, 0.0, 100.0, 100.0]);
        assert_eq!(read_nums(leaf(&doc, 1), b"CropBox"), [10.0, 10.0, 60.0, 60.0]);
        assert_eq!(read_nums(leaf(&doc, 2), b"CropBox"), [20.0, 20.0, 50.0, 50.0]);

        // per_page alone: unlisted pages keep no CropBox.
        let j = CropJob { pages: PageSelection::All, rect: None, ..j };
        let doc = crop(&three_pages(), &j);
        assert!(leaf(&doc, 0).get(b"CropBox").is_err());
        assert_eq!(read_nums(leaf(&doc, 1), b"CropBox"), [10.0, 10.0, 60.0, 60.0]);
    }

    #[test]
    fn inherited_mediabox_and_shared_pages_node_unchanged() {
        let mut f = Fixture::new();
        f.page(Dictionary::new(), "BT /F1 12 Tf 72 700 Td (A) Tj ET");
        f.page(Dictionary::new(), "BT /F1 12 Tf 72 700 Td (B) Tj ET");
        let pdf = f.finish(dictionary! {
            "MediaBox" => nums(&[0.0, 0.0, 300.0, 400.0]), "Rotate" => 90,
        });
        let before = Document::load_mem(&pdf).unwrap();
        let parent_id = leaf(&before, 0).get(b"Parent").unwrap().as_reference().unwrap();
        let parent_before = before.get_dictionary(parent_id).unwrap().clone();

        let j = CropJob { permanent: true, ..job([0.0, 0.0, 100.0, 50.0]) };
        let doc = crop(&pdf, &j);
        // Visible 400 x 300 (rotated 90): user = (300 - vy, vx).
        // (0, 0) -> (300, 0); (100, 50) -> (250, 100).
        for n in 0..2 {
            assert_eq!(read_nums(leaf(&doc, n), b"CropBox"), [250.0, 0.0, 300.0, 100.0]);
            assert_eq!(read_nums(leaf(&doc, n), b"MediaBox"), [250.0, 0.0, 300.0, 100.0]);
        }
        assert_eq!(doc.get_dictionary(parent_id).unwrap(), &parent_before);
    }

    #[test]
    fn permanent_sets_mediabox_and_default_does_not() {
        let doc = crop(&rotated(0), &job([100.0, 200.0, 300.0, 400.0]));
        assert_eq!(read_nums(leaf(&doc, 0), b"MediaBox"), MEDIA);
        let doc = crop(&rotated(0), &CropJob { permanent: true, ..job([100.0, 200.0, 300.0, 400.0]) });
        assert_eq!(read_nums(leaf(&doc, 0), b"MediaBox"), [100.0, 200.0, 400.0, 600.0]);
    }

    #[test]
    fn trim_art_bleed_are_intersected_or_removed() {
        let pdf = one_page(dictionary! {
            "MediaBox" => nums(&MEDIA),
            "TrimBox" => nums(&[50.0, 50.0, 250.0, 250.0]),
            "BleedBox" => nums(&[0.0, 0.0, 600.0, 800.0]),
            "ArtBox" => nums(&[500.0, 700.0, 550.0, 750.0]),
        });
        let doc = crop(&pdf, &job([100.0, 100.0, 300.0, 300.0]));
        let page = leaf(&doc, 0);
        assert_eq!(read_nums(page, b"TrimBox"), [100.0, 100.0, 250.0, 250.0]);
        assert_eq!(read_nums(page, b"BleedBox"), [100.0, 100.0, 400.0, 400.0]);
        assert!(page.get(b"ArtBox").is_err(), "disjoint ArtBox is removed");
    }

    #[test]
    fn shared_box_object_is_not_mutated() {
        let mut f = Fixture::new();
        let shared = f.doc.add_object(nums(&MEDIA));
        f.page(dictionary! { "MediaBox" => shared, "CropBox" => shared }, "q Q");
        f.page(dictionary! { "MediaBox" => shared, "CropBox" => shared }, "q Q");
        let pdf = f.finish(Dictionary::new());
        let j = CropJob { pages: PageSelection::List(vec![1]), permanent: true, ..job([0.0, 0.0, 10.0, 10.0]) };
        let doc = crop(&pdf, &j);
        let second = leaf(&doc, 1);
        let id = second.get(b"CropBox").unwrap().as_reference().unwrap();
        let shared: Vec<f64> =
            doc.get_object(id).unwrap().as_array().unwrap().iter().map(|o| o.as_float().unwrap() as f64).collect();
        assert_eq!(shared, MEDIA);
        assert_eq!(read_nums(leaf(&doc, 0), b"CropBox"), [0.0, 0.0, 10.0, 10.0]);
    }

    #[test]
    fn box_order_invariant_holds() {
        let doc = crop(&rotated(90), &CropJob { permanent: true, ..job([37.0, 11.0, 200.0, 150.0]) });
        let page = leaf(&doc, 0);
        let media = read_nums(page, b"MediaBox");
        let crop = read_nums(page, b"CropBox");
        assert!(media[0] <= crop[0] && media[1] <= crop[1] && media[2] >= crop[2] && media[3] >= crop[3]);
    }
}
