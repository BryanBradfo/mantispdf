use crate::pdf_util::import_document;
use lopdf::{dictionary, Document, Object, ObjectId, Stream};
use std::collections::HashSet;

/// One page of the output document.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanEntry {
    /// Page `page` (1-based) of source `src`, rotated clockwise by an extra `rotate` degrees.
    Page { src: usize, page: u32, rotate: i64 },
    /// An empty page sized like its nearest neighbour.
    Blank,
}

const LETTER: [i64; 4] = [0, 0, 612, 792];

/// Decode the wire format: triples `(src, page, rotate)`; `src == -1` is a blank page.
pub fn decode_plan(flat: &[i32]) -> Result<Vec<PlanEntry>, String> {
    if flat.len() % 3 != 0 {
        return Err(format!("Malformed page plan ({} values is not a multiple of 3)", flat.len()));
    }
    flat.chunks(3)
        .map(|c| {
            let (src, page, rotate) = (c[0], c[1], c[2]);
            if src == -1 {
                return Ok(PlanEntry::Blank);
            }
            if src < 0 || page < 1 {
                return Err(format!("Invalid plan entry ({src}, {page}, {rotate})"));
            }
            if rotate % 90 != 0 {
                return Err(format!("Rotation must be a multiple of 90 degrees, got {rotate}"));
            }
            Ok(PlanEntry::Page { src: src as usize, page: page as u32, rotate: rotate as i64 })
        })
        .collect()
}

/// Build a new PDF whose pages follow `plan`, drawing pages from `sources`.
pub fn apply_plan(sources: &[&[u8]], plan: &[PlanEntry]) -> Result<Vec<u8>, String> {
    if !plan.iter().any(|e| matches!(e, PlanEntry::Page { .. })) {
        return Err("The result must contain at least one page from a document".to_string());
    }

    let mut out = Document::with_version("1.7");
    let pages_id = out.new_object_id();

    let mut leaves: Vec<Vec<ObjectId>> = Vec::with_capacity(sources.len());
    for (i, bytes) in sources.iter().enumerate() {
        let doc = Document::load_mem(bytes).map_err(|e| format!("Failed to parse PDF {}: {e}", i + 1))?;
        leaves.push(import_document(&mut out, &doc));
    }

    // Pass 1: pick an object for every Page entry. Extra uses of a leaf get a
    // clone of its dictionary, taken before any rotation is applied so each
    // copy starts from the original.
    let mut used: HashSet<ObjectId> = HashSet::new();
    let mut slots: Vec<Option<(ObjectId, i64)>> = Vec::with_capacity(plan.len());
    for entry in plan {
        match *entry {
            PlanEntry::Blank => slots.push(None),
            PlanEntry::Page { src, page, rotate } => {
                let src_leaves = leaves.get(src).ok_or_else(|| {
                    format!("Plan refers to document {} but only {} were given", src + 1, sources.len())
                })?;
                let leaf = *(page as usize).checked_sub(1).and_then(|i| src_leaves.get(i)).ok_or_else(|| {
                    format!("Page {page} is out of range (document {} has {} pages)", src + 1, src_leaves.len())
                })?;
                let id = if used.insert(leaf) {
                    leaf
                } else {
                    let dict = out.get_dictionary(leaf).map_err(|e| e.to_string())?.clone();
                    out.add_object(dict)
                };
                slots.push(Some((id, rotate)));
            }
        }
    }

    // Pass 2: rotations on top of the (materialized) existing /Rotate.
    for &(id, rotate) in slots.iter().flatten() {
        add_rotation(&mut out, id, rotate)?;
    }

    // Pass 3: blanks copy box + orientation from the nearest real page, previous first.
    let real: Vec<Option<ObjectId>> = slots.iter().map(|s| s.map(|(id, _)| id)).collect();
    let mut kids: Vec<ObjectId> = Vec::with_capacity(real.len());
    for (i, slot) in real.iter().enumerate() {
        match slot {
            Some(id) => kids.push(*id),
            None => {
                let reference = real[..i].iter().rev().chain(real[i + 1..].iter()).find_map(|k| *k);
                kids.push(add_blank_page(&mut out, reference));
            }
        }
    }

    for &id in &kids {
        if let Ok(dict) = out.get_object_mut(id).and_then(|o| o.as_dict_mut()) {
            dict.set("Parent", Object::Reference(pages_id));
        }
    }
    let count = kids.len() as i64;
    out.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => kids.into_iter().map(Object::Reference).collect::<Vec<_>>(),
            "Count" => count,
        }),
    );
    let catalog_id = out.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    out.trailer.set("Root", catalog_id);
    out.prune_objects();

    let mut buf = Vec::new();
    out.save_to(&mut buf).map_err(|e| format!("Failed to save PDF: {e}"))?;
    Ok(buf)
}

fn add_rotation(doc: &mut Document, id: ObjectId, delta: i64) -> Result<(), String> {
    let dict = doc
        .get_object_mut(id)
        .and_then(|o| o.as_dict_mut())
        .map_err(|e| format!("Cannot access page: {e}"))?;
    let current = dict.get(b"Rotate").and_then(|o| o.as_i64()).unwrap_or(0);
    let next = ((current + delta) % 360 + 360) % 360;
    if next == 0 {
        dict.remove(b"Rotate");
    } else {
        dict.set("Rotate", Object::Integer(next));
    }
    Ok(())
}

fn add_blank_page(doc: &mut Document, reference: Option<ObjectId>) -> ObjectId {
    let (media, rotate) = reference
        .and_then(|id| doc.get_dictionary(id).ok())
        .map(|d| (d.get(b"MediaBox").ok().cloned(), d.get(b"Rotate").ok().cloned()))
        .unwrap_or((None, None));
    let media = media.unwrap_or_else(|| Object::Array(LETTER.iter().map(|&v| Object::Integer(v)).collect()));
    let contents = doc.add_object(Stream::new(dictionary! {}, Vec::new()));
    let mut page = dictionary! {
        "Type" => "Page",
        "MediaBox" => media,
        "Resources" => dictionary! {},
        "Contents" => contents,
    };
    if let Some(r) = rotate {
        page.set("Rotate", r);
    }
    doc.add_object(page)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pdf_util::{get_inherited_attr, make_inherited_test_pdf_sized};
    use lopdf::content::{Content, Operation};

    /// One page per label, each drawing its label; leaf carries its own MediaBox.
    fn labeled_pdf(labels: &[&str], w: i64, h: i64) -> Vec<u8> {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let mut kids = Vec::new();
        for label in labels {
            let content = Content {
                operations: vec![
                    Operation::new("BT", vec![]),
                    Operation::new("Tj", vec![Object::string_literal(*label)]),
                    Operation::new("ET", vec![]),
                ],
            };
            let cid = doc.add_object(Stream::new(dictionary! {}, content.encode().unwrap()));
            let pid = doc.add_object(dictionary! {
                "Type" => "Page", "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), w.into(), h.into()],
                "Contents" => cid,
            });
            kids.push(Object::Reference(pid));
        }
        let n = kids.len() as i64;
        doc.objects.insert(pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => n }));
        let cat = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", cat);
        let mut buf = Vec::new();
        doc.save_to(&mut buf).unwrap();
        buf
    }

    struct PageInfo { label: String, rotate: i64, media: Vec<i64>, id: ObjectId }

    fn pages(bytes: &[u8]) -> Vec<PageInfo> {
        let doc = Document::load_mem(bytes).unwrap();
        doc.get_pages().into_values().map(|id| {
            let content = String::from_utf8_lossy(&doc.get_page_content(id).unwrap_or_default()).to_string();
            let label = content.split('(').nth(1).and_then(|s| s.split(')').next()).unwrap_or("").to_string();
            let rotate = get_inherited_attr(&doc, id, b"Rotate").and_then(|o| o.as_i64().ok()).unwrap_or(0);
            let media = get_inherited_attr(&doc, id, b"MediaBox")
                .and_then(|o| o.as_array().ok().cloned())
                .map(|a| a.iter().map(|v| v.as_i64().unwrap_or(-1)).collect())
                .unwrap_or_default();
            PageInfo { label, rotate, media, id }
        }).collect()
    }

    fn page(src: usize, page: u32) -> PlanEntry { PlanEntry::Page { src, page, rotate: 0 } }
    fn labels(bytes: &[u8]) -> Vec<String> { pages(bytes).into_iter().map(|p| p.label).collect() }

    #[test]
    fn reorders_across_sources_and_drops_unused_pages() {
        let a = labeled_pdf(&["A1", "A2", "A3"], 612, 792);
        let b = labeled_pdf(&["B1", "B2"], 842, 595);
        let out = apply_plan(&[&a, &b], &[page(1, 1), page(0, 3), page(0, 1)]).unwrap();
        assert_eq!(labels(&out), ["B1", "A3", "A1"]);
        let info = pages(&out);
        assert_eq!(info[0].media, [0, 0, 842, 595]);
        assert_eq!(info[1].media, [0, 0, 612, 792]);
    }

    #[test]
    fn duplicate_gets_its_own_page_object() {
        let a = labeled_pdf(&["A1"], 612, 792);
        let out = apply_plan(&[&a], &[page(0, 1), page(0, 1)]).unwrap();
        let info = pages(&out);
        assert_eq!(labels(&out), ["A1", "A1"]);
        assert_ne!(info[0].id, info[1].id);
    }

    #[test]
    fn duplicate_rotations_are_independent() {
        let a = labeled_pdf(&["A1"], 612, 792);
        let plan = [page(0, 1), PlanEntry::Page { src: 0, page: 1, rotate: 90 }];
        let info = pages(&apply_plan(&[&a], &plan).unwrap());
        assert_eq!((info[0].rotate, info[1].rotate), (0, 90));
    }

    #[test]
    fn rotation_adds_to_inherited_rotate_and_normalizes() {
        let src = make_inherited_test_pdf_sized(2, 595, 842);
        let mut doc = Document::load_mem(&src).unwrap();
        let pages_id = doc.catalog().unwrap().get(b"Pages").unwrap().as_reference().unwrap();
        doc.get_object_mut(pages_id).unwrap().as_dict_mut().unwrap().set("Rotate", 90);
        let mut src = Vec::new();
        doc.save_to(&mut src).unwrap();

        let plan = [
            PlanEntry::Page { src: 0, page: 1, rotate: 90 },
            PlanEntry::Page { src: 0, page: 2, rotate: -90 },
        ];
        let info = pages(&apply_plan(&[&src], &plan).unwrap());
        assert_eq!((info[0].rotate, info[1].rotate), (180, 0));
        assert_eq!(info[0].media, [0, 0, 595, 842], "inherited MediaBox must survive");
    }

    #[test]
    fn negative_rotation_wraps() {
        let a = labeled_pdf(&["A1"], 612, 792);
        let info = pages(&apply_plan(&[&a], &[PlanEntry::Page { src: 0, page: 1, rotate: -90 }]).unwrap());
        assert_eq!(info[0].rotate, 270);
    }

    #[test]
    fn blank_copies_previous_page_else_next() {
        let a = labeled_pdf(&["A1"], 612, 792);
        let b = labeled_pdf(&["B1"], 842, 595);
        let plan = [
            PlanEntry::Blank,
            PlanEntry::Page { src: 1, page: 1, rotate: 90 },
            PlanEntry::Blank,
            page(0, 1),
        ];
        let info = pages(&apply_plan(&[&a, &b], &plan).unwrap());
        assert_eq!(info.len(), 4);
        assert_eq!((info[0].media.clone(), info[0].rotate), (vec![0, 0, 842, 595], 90), "leading blank copies next page");
        assert_eq!((info[2].media.clone(), info[2].rotate), (vec![0, 0, 842, 595], 90), "middle blank copies previous page");
        assert_eq!(info[0].label, "");
    }

    #[test]
    fn errors() {
        let a = labeled_pdf(&["A1", "A2"], 612, 792);
        assert!(apply_plan(&[&a], &[]).is_err());
        assert!(apply_plan(&[&a], &[PlanEntry::Blank]).is_err());
        assert!(apply_plan(&[&a], &[page(0, 3)]).unwrap_err().contains("out of range"));
        assert!(apply_plan(&[&a], &[page(1, 1)]).unwrap_err().contains("document 2"));
        assert!(decode_plan(&[0, 1]).is_err());
        assert!(decode_plan(&[0, 1, 45]).unwrap_err().contains("multiple of 90"));
        assert!(decode_plan(&[0, 0, 0]).is_err());
    }

    #[test]
    fn decode_round_trip() {
        assert_eq!(
            decode_plan(&[0, 2, 90, -1, 0, 0, 1, 1, -90]).unwrap(),
            vec![
                PlanEntry::Page { src: 0, page: 2, rotate: 90 },
                PlanEntry::Blank,
                PlanEntry::Page { src: 1, page: 1, rotate: -90 },
            ]
        );
    }
}
