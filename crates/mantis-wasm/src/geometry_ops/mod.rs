//! Geometry tools: crop (page boxes in visible space) and resize (new sheet
//! size, content re-fitted). Both edit only the selected leaf pages and never
//! a page-tree node or an object another page shares.

// The WASM bindings that call these entry points come with the geometry job
// parser; until then the module is reachable from its tests only.
#![allow(dead_code)]

pub(crate) mod crop;
pub(crate) mod resize;

use crate::stamp::engine::{MAX_COORD, PageSelection};
use lopdf::{Document, Object, ObjectId};
use std::collections::BTreeMap;

/// Error for a job field outside its bounds.
pub(crate) fn invalid(field: &str) -> String {
    format!("Invalid geometry settings: {field}")
}

/// Finite and within the coordinate bound.
pub(crate) fn bounded(values: &[f64]) -> bool {
    values.iter().all(|v| v.is_finite() && v.abs() <= MAX_COORD)
}

/// Rejects a page number outside `1..=total`.
pub(crate) fn check_page(page: u32, total: u32) -> Result<(), String> {
    if page == 0 || page > total {
        return Err(format!("Page {page} does not exist (the document has {total} pages)"));
    }
    Ok(())
}

/// Selected page numbers (1-based, ascending), validated against the document.
pub(crate) fn selected_numbers(selection: &PageSelection, total: u32) -> Result<Vec<u32>, String> {
    match selection {
        PageSelection::All => Ok((1..=total).collect()),
        PageSelection::List(list) => {
            for &p in list {
                check_page(p, total)?;
            }
            let mut v = list.clone();
            v.sort_unstable();
            v.dedup();
            Ok(v)
        }
    }
}

/// Page number -> page object, in document order.
pub(crate) fn page_map(doc: &Document) -> BTreeMap<u32, ObjectId> {
    doc.get_pages()
}

/// `[a b c d e f]` applied to a point (row-vector convention, as in PDF).
pub(crate) fn apply(m: [f64; 6], x: f64, y: f64) -> (f64, f64) {
    let [a, b, c, d, e, f] = m;
    (a * x + c * y + e, b * x + d * y + f)
}

/// The matrix applying `first`, then `then`.
pub(crate) fn concat(first: [f64; 6], then: [f64; 6]) -> [f64; 6] {
    let [a1, b1, c1, d1, e1, f1] = first;
    let [a2, b2, c2, d2, e2, f2] = then;
    [
        a1 * a2 + b1 * c2,
        a1 * b2 + b1 * d2,
        c1 * a2 + d1 * c2,
        c1 * b2 + d1 * d2,
        e1 * a2 + f1 * c2 + e2,
        e1 * b2 + f1 * d2 + f2,
    ]
}

/// Inverse of an invertible affine matrix (the visible-box matrices are
/// rotations by a multiple of 90 degrees plus a translation).
pub(crate) fn invert(m: [f64; 6]) -> [f64; 6] {
    let [a, b, c, d, e, f] = m;
    let det = a * d - b * c;
    [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det]
}

/// A PDF number: an Integer when `v` is integral (exact and short), a Real
/// otherwise.
pub(crate) fn number(v: f64) -> Object {
    if v.fract() == 0.0 && v.abs() < 1e9 {
        Object::Integer(v as i64)
    } else {
        Object::Real(v as f32)
    }
}

pub(crate) fn box_object(b: [f64; 4]) -> Object {
    Object::Array(b.iter().map(|&v| number(v)).collect())
}

#[cfg(test)]
pub(crate) mod fixture {
    use lopdf::{Dictionary, Document, Object, ObjectId, Stream, dictionary};

    /// A document under construction; pages hang from one /Pages node whose
    /// extra entries (inheritable attributes) are set by `finish`.
    pub(crate) struct Fixture {
        pub doc: Document,
        pub pages_id: ObjectId,
        pub kids: Vec<Object>,
        pub font_id: ObjectId,
    }

    impl Fixture {
        pub fn new() -> Self {
            let mut doc = Document::with_version("1.7");
            let pages_id = doc.new_object_id();
            let font_id = doc.add_object(dictionary! {
                "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica",
                "Encoding" => "WinAnsiEncoding",
            });
            Fixture { doc, pages_id, kids: vec![], font_id }
        }

        /// A leaf page with `entries`, `/Resources {Font {F1}}` and one
        /// content stream holding `content` (none when empty).
        pub fn page(&mut self, entries: Dictionary, content: &str) -> ObjectId {
            let mut page = dictionary! {
                "Type" => "Page", "Parent" => self.pages_id,
                "Resources" => dictionary! { "Font" => dictionary! { "F1" => self.font_id } },
            };
            if !content.is_empty() {
                let c = self.doc.add_object(Stream::new(Dictionary::new(), content.as_bytes().to_vec()));
                page.set("Contents", c);
            }
            for (k, v) in entries {
                page.set(k, v);
            }
            let id = self.doc.add_object(page);
            self.kids.push(id.into());
            id
        }

        pub fn finish(mut self, pages_extra: Dictionary) -> Vec<u8> {
            let count = self.kids.len() as i64;
            let mut pages = dictionary! { "Type" => "Pages", "Kids" => self.kids, "Count" => count };
            for (k, v) in pages_extra {
                pages.set(k, v);
            }
            self.doc.objects.insert(self.pages_id, Object::Dictionary(pages));
            let cat = self.doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => self.pages_id });
            self.doc.trailer.set("Root", cat);
            let mut buf = Vec::new();
            self.doc.save_to(&mut buf).unwrap();
            buf
        }
    }

    pub(crate) fn nums(v: &[f64]) -> Object {
        Object::Array(v.iter().map(|&n| Object::Real(n as f32)).collect())
    }

    /// The numbers of array `key` on dictionary `dict` (direct values).
    pub(crate) fn read_nums(dict: &Dictionary, key: &[u8]) -> Vec<f64> {
        dict.get(key)
            .unwrap_or_else(|_| panic!("missing /{}", String::from_utf8_lossy(key)))
            .as_array()
            .unwrap()
            .iter()
            .map(|o| o.as_float().unwrap() as f64)
            .collect()
    }

    pub(crate) fn pages(doc: &Document) -> Vec<ObjectId> {
        doc.get_pages().values().copied().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concat_applies_first_then_second() {
        let rot90 = [0.0, 1.0, -1.0, 0.0, 600.0, 0.0];
        let scale = [2.0, 0.0, 0.0, 2.0, 10.0, 20.0];
        let m = concat(rot90, scale);
        let (x, y) = apply(rot90, 3.0, 5.0);
        assert_eq!(apply(m, 3.0, 5.0), apply(scale, x, y));
    }

    #[test]
    fn invert_round_trips() {
        for m in [
            [1.0, 0.0, 0.0, 1.0, 10.0, 20.0],
            [0.0, 1.0, -1.0, 0.0, 600.0, 0.0],
            [-1.0, 0.0, 0.0, -1.0, 600.0, 800.0],
            [0.0, -1.0, 1.0, 0.0, 0.0, 800.0],
        ] {
            assert_eq!(concat(m, invert(m)), [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
        }
    }

    #[test]
    fn numbers_are_integers_when_integral() {
        assert_eq!(number(600.0), Object::Integer(600));
        assert_eq!(number(-3.0), Object::Integer(-3));
        assert_eq!(number(0.5), Object::Real(0.5));
    }
}
