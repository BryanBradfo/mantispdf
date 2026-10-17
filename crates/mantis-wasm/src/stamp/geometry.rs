//! Visible page space: the displayed page (CropBox clamped to MediaBox,
//! `/Rotate` applied) with its origin at the bottom-left, in points.

use crate::pdf_util::get_inherited_attr;
use crate::rebuild::{add_rotation, deref};
use lopdf::{Document, Object, ObjectId};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VisibleBox {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
    /// Normalized page rotation in {0, 90, 180, 270}.
    pub rotate: i64,
}

const DEFAULT_BOX: [f64; 4] = [0.0, 0.0, 612.0, 792.0];

/// `[x0 y0 x1 y1]` of an inherited box, normalized so x0 <= x1, y0 <= y1.
pub(crate) fn read_box(doc: &Document, page: ObjectId, key: &[u8]) -> Option<[f64; 4]> {
    let attr = get_inherited_attr(doc, page, key)?;
    let Object::Array(items) = deref(doc, &attr)? else {
        return None;
    };
    if items.len() != 4 {
        return None;
    }
    let mut v = [0.0; 4];
    for (slot, item) in v.iter_mut().zip(items) {
        let n = deref(doc, item)?.as_float().ok()? as f64;
        if !n.is_finite() {
            return None;
        }
        *slot = n;
    }
    Some([v[0].min(v[2]), v[1].min(v[3]), v[0].max(v[2]), v[1].max(v[3])])
}

impl VisibleBox {
    pub fn of_page(doc: &Document, page: ObjectId) -> VisibleBox {
        let media = read_box(doc, page, b"MediaBox")
            .filter(|m| m[2] > m[0] && m[3] > m[1])
            .unwrap_or(DEFAULT_BOX);
        let [x0, y0, x1, y1] = match read_box(doc, page, b"CropBox") {
            Some(c) => {
                let clamped = [c[0].max(media[0]), c[1].max(media[1]), c[2].min(media[2]), c[3].min(media[3])];
                if clamped[2] > clamped[0] && clamped[3] > clamped[1] { clamped } else { media }
            }
            None => media,
        };
        let rotate_attr = get_inherited_attr(doc, page, b"Rotate");
        let rotate = add_rotation(rotate_attr.as_ref().and_then(|r| deref(doc, r)), 0);
        VisibleBox { x0, y0, x1, y1, rotate }
    }

    pub fn width(&self) -> f64 {
        if self.rotate % 180 == 0 { self.x1 - self.x0 } else { self.y1 - self.y0 }
    }

    pub fn height(&self) -> f64 {
        if self.rotate % 180 == 0 { self.y1 - self.y0 } else { self.x1 - self.x0 }
    }

    /// Matrix taking visible space to default user space.
    pub fn matrix(&self) -> [f64; 6] {
        match self.rotate {
            90 => [0.0, 1.0, -1.0, 0.0, self.x1, self.y0],
            180 => [-1.0, 0.0, 0.0, -1.0, self.x1, self.y1],
            270 => [0.0, -1.0, 1.0, 0.0, self.x0, self.y1],
            _ => [1.0, 0.0, 0.0, 1.0, self.x0, self.y0],
        }
    }

    /// Test helper: the user-space point of a visible-space point.
    #[cfg(test)]
    pub fn to_user(&self, vx: f64, vy: f64) -> (f64, f64) {
        let [a, b, c, d, e, f] = self.matrix();
        (a * vx + c * vy + e, b * vx + d * vy + f)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::dictionary;

    fn reals(v: [f64; 4]) -> Object {
        Object::Array(v.iter().map(|n| Object::Real(*n as f32)).collect())
    }

    /// One page under a Pages node; `page`/`pages` entries are set per test.
    fn doc_with(
        page_extra: Vec<(&str, Object)>,
        pages_extra: Vec<(&str, Object)>,
    ) -> (Document, ObjectId) {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let mut page = dictionary! { "Type" => "Page", "Parent" => pages_id };
        for (k, v) in page_extra {
            page.set(k, v);
        }
        let page_id = doc.add_object(page);
        let mut pages = dictionary! {
            "Type" => "Pages", "Kids" => vec![page_id.into()], "Count" => 1
        };
        for (k, v) in pages_extra {
            pages.set(k, v);
        }
        doc.objects.insert(pages_id, Object::Dictionary(pages));
        (doc, page_id)
    }

    fn vb(rotate: Object) -> VisibleBox {
        let (doc, page) = doc_with(
            vec![("MediaBox", reals([10.0, 20.0, 610.0, 820.0])), ("Rotate", rotate)],
            vec![],
        );
        VisibleBox::of_page(&doc, page)
    }

    #[test]
    fn rotate_0() {
        let b = vb(Object::Integer(0));
        assert_eq!((b.width(), b.height()), (600.0, 800.0));
        assert_eq!(b.to_user(0.0, 0.0), (10.0, 20.0));
        assert_eq!(b.to_user(600.0, 800.0), (610.0, 820.0));
    }

    #[test]
    fn rotate_90() {
        let b = vb(Object::Integer(90));
        assert_eq!((b.width(), b.height()), (800.0, 600.0));
        assert_eq!(b.to_user(0.0, 0.0), (610.0, 20.0));
        assert_eq!(b.to_user(800.0, 600.0), (10.0, 820.0));
    }

    #[test]
    fn rotate_180() {
        let b = vb(Object::Integer(180));
        assert_eq!((b.width(), b.height()), (600.0, 800.0));
        assert_eq!(b.to_user(0.0, 0.0), (610.0, 820.0));
        assert_eq!(b.to_user(600.0, 800.0), (10.0, 20.0));
    }

    #[test]
    fn rotate_270() {
        let b = vb(Object::Integer(270));
        assert_eq!(b.to_user(0.0, 0.0), (10.0, 820.0));
        assert_eq!(b.to_user(800.0, 600.0), (610.0, 20.0));
    }

    #[test]
    fn rotate_negative_real_and_odd_values_snap() {
        assert_eq!(vb(Object::Integer(-90)).rotate, 270);
        assert_eq!(vb(Object::Real(90.0)).rotate, 90);
        assert_eq!(vb(Object::Integer(80)).rotate, 90);
        assert_eq!(vb(Object::Integer(450)).rotate, 90);
    }

    #[test]
    fn cropbox_larger_than_mediabox_is_clamped() {
        let (doc, page) = doc_with(
            vec![
                ("MediaBox", reals([0.0, 0.0, 600.0, 800.0])),
                ("CropBox", reals([-50.0, -50.0, 700.0, 500.0])),
            ],
            vec![],
        );
        let b = VisibleBox::of_page(&doc, page);
        assert_eq!((b.x0, b.y0, b.x1, b.y1), (0.0, 0.0, 600.0, 500.0));
    }

    #[test]
    fn cropbox_smaller_is_used() {
        let (doc, page) = doc_with(
            vec![
                ("MediaBox", reals([0.0, 0.0, 600.0, 800.0])),
                ("CropBox", reals([100.0, 100.0, 500.0, 700.0])),
            ],
            vec![],
        );
        let b = VisibleBox::of_page(&doc, page);
        assert_eq!((b.width(), b.height()), (400.0, 600.0));
        assert_eq!(b.to_user(0.0, 0.0), (100.0, 100.0));
    }

    #[test]
    fn missing_cropbox_uses_mediabox() {
        let (doc, page) = doc_with(vec![("MediaBox", reals([0.0, 0.0, 300.0, 400.0]))], vec![]);
        let b = VisibleBox::of_page(&doc, page);
        assert_eq!((b.x0, b.y0, b.x1, b.y1, b.rotate), (0.0, 0.0, 300.0, 400.0, 0));
    }

    #[test]
    fn inherited_mediabox_and_rotate_via_parent() {
        let (doc, page) = doc_with(
            vec![],
            vec![("MediaBox", reals([0.0, 0.0, 300.0, 400.0])), ("Rotate", Object::Integer(90))],
        );
        let b = VisibleBox::of_page(&doc, page);
        assert_eq!((b.width(), b.height(), b.rotate), (400.0, 300.0, 90));
    }

    #[test]
    fn disjoint_cropbox_falls_back_to_mediabox() {
        let (doc, page) = doc_with(
            vec![
                ("MediaBox", reals([0.0, 0.0, 100.0, 100.0])),
                ("CropBox", reals([500.0, 500.0, 600.0, 600.0])),
            ],
            vec![],
        );
        let b = VisibleBox::of_page(&doc, page);
        assert_eq!((b.x1, b.y1), (100.0, 100.0));
    }
}
