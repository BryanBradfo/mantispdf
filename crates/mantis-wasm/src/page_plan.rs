use crate::rebuild::{OutPage, PAGE_TOOLS, rebuild_document};
use lopdf::{Document, ObjectId};

/// One page of the output document.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanEntry {
    /// Page `page` (1-based) of source `src`, rotated clockwise by an extra `rotate` degrees.
    Page { src: usize, page: u32, rotate: i64 },
    /// An empty page sized like its nearest neighbour.
    Blank,
}

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
/// Pages are rebuilt from an allowlist, so dropped pages leave nothing behind.
pub fn apply_plan(sources: &[&[u8]], plan: &[PlanEntry]) -> Result<Vec<u8>, String> {
    if !plan.iter().any(|e| matches!(e, PlanEntry::Page { .. })) {
        return Err("The result must contain at least one page from a document".to_string());
    }

    let docs: Vec<Document> = sources
        .iter()
        .enumerate()
        .map(|(i, bytes)| {
            crate::pdf_util::load_pdf_n(bytes, i + 1)
        })
        .collect::<Result<_, _>>()?;
    let leaves: Vec<Vec<ObjectId>> = docs
        .iter()
        .map(|d| d.get_pages().into_values().collect())
        .collect();

    let pages: Vec<OutPage> = plan
        .iter()
        .map(|entry| match *entry {
            PlanEntry::Blank => Ok(OutPage::Blank),
            PlanEntry::Page { src, page, rotate } => {
                let src_leaves = leaves.get(src).ok_or_else(|| {
                    format!("Plan refers to document {} but only {} were given", src + 1, sources.len())
                })?;
                let leaf = *(page as usize).checked_sub(1).and_then(|i| src_leaves.get(i)).ok_or_else(|| {
                    format!("Page {page} is out of range (document {} has {} pages)", src + 1, src_leaves.len())
                })?;
                Ok(OutPage::Page { src, page: leaf, rotate })
            }
        })
        .collect::<Result<_, String>>()?;

    let (mut out, _report) = rebuild_document(&docs, &pages, &PAGE_TOOLS)?;
    crate::pdf_util::save_pdf(&mut out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pdf_util::{get_inherited_attr, make_inherited_test_pdf_sized};
    use lopdf::content::{Content, Operation};
    use lopdf::{dictionary, Object, Stream};

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

    fn contains(hay: &[u8], needle: &str) -> bool {
        hay.windows(needle.len()).any(|w| w == needle.as_bytes())
    }

    fn pages_node_count(bytes: &[u8]) -> usize {
        let doc = Document::load_mem(bytes).unwrap();
        doc.objects
            .values()
            .filter(|o| o.as_dict().ok().and_then(|d| d.get(b"Type").ok()).and_then(|t| t.as_name().ok()) == Some(b"Pages".as_slice()))
            .count()
    }

    /// Source whose page 1 carries a Link annotation with /Dest pointing at page 2.
    fn linked_pdf() -> Vec<u8> {
        let src = labeled_pdf(&["KEEPPAGE", "SECRETPAGE"], 612, 792);
        let mut doc = Document::load_mem(&src).unwrap();
        let ids: Vec<ObjectId> = doc.get_pages().into_values().collect();
        let annot = doc.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Link", "P" => ids[0],
            "Rect" => vec![0.into(), 0.into(), 10.into(), 10.into()],
            "Dest" => vec![Object::Reference(ids[1]), Object::Name(b"Fit".to_vec())],
        });
        doc.get_object_mut(ids[0]).unwrap().as_dict_mut().unwrap().set("Annots", vec![Object::Reference(annot)]);
        let mut buf = Vec::new();
        doc.save_to(&mut buf).unwrap();
        buf
    }

    #[test]
    fn dropped_page_reachable_via_link_dest_is_removed() {
        let src = linked_pdf();
        let out = apply_plan(&[&src], &[page(0, 1), page(0, 1)]).unwrap();
        assert!(!contains(&out, "SECRETPAGE"), "dropped page content must not survive");
        assert_eq!(pages_node_count(&out), 1, "only the new /Pages node may remain");
    }

    #[test]
    fn plain_drop_removes_page_content() {
        let a = labeled_pdf(&["KEEPPAGE", "DROPTWO", "DROPTHREE"], 612, 792);
        let out = apply_plan(&[&a], &[page(0, 1)]).unwrap();
        assert!(contains(&out, "KEEPPAGE"));
        assert!(!contains(&out, "DROPTWO") && !contains(&out, "DROPTHREE"));
        assert_eq!(pages_node_count(&out), 1);
    }

    #[test]
    fn unused_source_leaves_nothing_behind() {
        let a = labeled_pdf(&["KEEPPAGE"], 612, 792);
        let b = labeled_pdf(&["UNUSEDONE", "UNUSEDTWO"], 842, 595);
        let out = apply_plan(&[&a, &b], &[page(0, 1)]).unwrap();
        assert!(!contains(&out, "UNUSEDONE") && !contains(&out, "UNUSEDTWO"));
        assert_eq!(pages_node_count(&out), 1);
    }

    #[test]
    fn hostile_and_fractional_rotate_values_are_normalized() {
        let a = labeled_pdf(&["A1", "A2", "A3"], 612, 792);
        let mut doc = Document::load_mem(&a).unwrap();
        let ids: Vec<ObjectId> = doc.get_pages().into_values().collect();
        let set = |doc: &mut Document, id: ObjectId, v: Object| {
            doc.get_object_mut(id).unwrap().as_dict_mut().unwrap().set("Rotate", v);
        };
        set(&mut doc, ids[0], Object::Real(90.0));
        set(&mut doc, ids[1], Object::Integer(100));
        set(&mut doc, ids[2], Object::Integer(i64::MAX));
        let mut src = Vec::new();
        doc.save_to(&mut src).unwrap();
        let out = apply_plan(&[&src], &[page(0, 1), page(0, 2), PlanEntry::Page { src: 0, page: 3, rotate: 90 }]).unwrap();
        let r: Vec<i64> = pages(&out).iter().map(|p| p.rotate).collect();
        assert!(r.iter().all(|v| [0, 90, 180, 270].contains(v)), "got {r:?}");
        assert_eq!(&r[..2], [90, 90]);
    }

    /// Page 1: a widget (field A) whose parent field also owns a widget on page 2 (field B,
    /// with a value and appearance), plus a reply annotation pointing at a note on page 2.
    fn form_and_reply_pdf() -> Vec<u8> {
        let src = labeled_pdf(&["KEEPPAGE", "DROPPAGE"], 612, 792);
        let mut doc = Document::load_mem(&src).unwrap();
        let ids: Vec<ObjectId> = doc.get_pages().into_values().collect();
        let rect = || vec![Object::from(0), 0.into(), 10.into(), 10.into()];
        let ap = |doc: &mut Document, text: &str| {
            let s = doc.add_object(Stream::new(
                dictionary! { "Type" => "XObject", "Subtype" => "Form", "BBox" => rect() },
                text.as_bytes().to_vec(),
            ));
            dictionary! { "N" => s }
        };
        let form = doc.new_object_id();
        let ap_a = ap(&mut doc, "(KEEPAP) Tj");
        let widget_a = doc.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Widget", "FT" => "Tx", "Rect" => rect(),
            "Parent" => form, "AP" => ap_a,
        });
        let ap_b = ap(&mut doc, "(SECRETAP) Tj");
        let widget_b = doc.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Widget", "FT" => "Tx", "Rect" => rect(),
            "Parent" => form, "V" => Object::string_literal("SECRETVALUE"), "AP" => ap_b,
        });
        doc.objects.insert(form, Object::Dictionary(dictionary! {
            "FT" => "Tx", "T" => Object::string_literal("form"),
            "Kids" => vec![Object::Reference(widget_a), Object::Reference(widget_b)],
        }));
        let note = doc.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Text", "Rect" => rect(),
            "Contents" => Object::string_literal("SECRETNOTE"),
        });
        let reply = doc.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Text", "Rect" => rect(),
            "IRT" => note, "Popup" => note, "Contents" => Object::string_literal("reply"),
        });
        let set_annots = |doc: &mut Document, page: ObjectId, a: Vec<ObjectId>| {
            doc.get_object_mut(page).unwrap().as_dict_mut().unwrap()
                .set("Annots", a.into_iter().map(Object::Reference).collect::<Vec<_>>());
        };
        set_annots(&mut doc, ids[0], vec![widget_a, reply]);
        set_annots(&mut doc, ids[1], vec![widget_b, note]);
        let mut buf = Vec::new();
        doc.save_to(&mut buf).unwrap();
        buf
    }

    #[test]
    fn kept_annotations_do_not_leak_dropped_pages_via_form_tree_or_replies() {
        let src = form_and_reply_pdf();
        let out = apply_plan(&[&src], &[page(0, 1)]).unwrap();
        for secret in ["SECRETVALUE", "SECRETAP", "SECRETNOTE", "DROPPAGE"] {
            assert!(!contains(&out, secret), "{secret} must not survive");
        }
        let doc = Document::load_mem(&out).unwrap();
        assert_eq!(doc.get_pages().len(), 1);
        assert!(contains(&out, "KEEPAP"), "the kept widget's own appearance survives");
    }

    /// Two-page source; page 1's /Annots holds one INLINE widget whose /Parent field also
    /// owns a SECRETVALUE widget on page 2. With `indirect_subtype`, /Subtype is a reference.
    fn inline_widget_pdf(indirect_subtype: bool) -> Vec<u8> {
        let src = labeled_pdf(&["KEEPPAGE", "DROPPAGE"], 612, 792);
        let mut doc = Document::load_mem(&src).unwrap();
        let ids: Vec<ObjectId> = doc.get_pages().into_values().collect();
        let rect = || vec![Object::from(0), 0.into(), 10.into(), 10.into()];
        let form = doc.new_object_id();
        let widget_b = doc.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Widget", "FT" => "Tx", "Rect" => rect(),
            "Parent" => form, "V" => Object::string_literal("SECRETVALUE"),
        });
        doc.objects.insert(form, Object::Dictionary(dictionary! {
            "FT" => "Tx", "Kids" => vec![Object::Reference(widget_b)],
        }));
        let subtype: Object = if indirect_subtype {
            Object::Reference(doc.add_object(Object::Name(b"Widget".to_vec())))
        } else {
            Object::Name(b"Widget".to_vec())
        };
        let inline = dictionary! {
            "Type" => "Annot", "Subtype" => subtype, "FT" => "Tx", "Rect" => rect(), "Parent" => form,
        };
        let page1 = doc.get_object_mut(ids[0]).unwrap().as_dict_mut().unwrap();
        if indirect_subtype {
            // Same, but as a referenced annotation rather than an inline one.
            let id = doc.add_object(inline);
            doc.get_object_mut(ids[0]).unwrap().as_dict_mut().unwrap().set("Annots", vec![Object::Reference(id)]);
        } else {
            page1.set("Annots", vec![Object::Dictionary(inline)]);
        }
        doc.get_object_mut(ids[1]).unwrap().as_dict_mut().unwrap().set("Annots", vec![Object::Reference(widget_b)]);
        let mut buf = Vec::new();
        doc.save_to(&mut buf).unwrap();
        buf
    }

    #[test]
    fn inline_annotation_parent_link_is_cut() {
        let out = apply_plan(&[&inline_widget_pdf(false)], &[page(0, 1)]).unwrap();
        assert!(!contains(&out, "SECRETVALUE") && !contains(&out, "DROPPAGE"));
    }

    #[test]
    fn indirect_subtype_annotation_parent_link_is_cut() {
        let out = apply_plan(&[&inline_widget_pdf(true)], &[page(0, 1)]).unwrap();
        assert!(!contains(&out, "SECRETVALUE") && !contains(&out, "DROPPAGE"));
    }

    #[test]
    fn link_to_duplicated_page_targets_its_first_copy() {
        let src = linked_pdf();
        let out = apply_plan(&[&src], &[page(0, 2), page(0, 1), page(0, 2)]).unwrap();
        let doc = Document::load_mem(&out).unwrap();
        let ids: Vec<ObjectId> = doc.get_pages().into_values().collect();
        let arr = doc.get_dictionary(ids[1]).unwrap().get(b"Annots").unwrap().as_array().unwrap().clone();
        let link = doc.get_dictionary(arr[0].as_reference().unwrap()).unwrap();
        let dest = link.get(b"Dest").unwrap().as_array().unwrap();
        assert_eq!(dest[0].as_reference().unwrap(), ids[0]);
    }

    #[test]
    fn duplicate_gets_its_own_annotations() {
        let src = linked_pdf();
        // Page 2 stays so the link on page 1 has a target and survives.
        let out = apply_plan(&[&src], &[page(0, 1), page(0, 1), page(0, 2)]).unwrap();
        let doc = Document::load_mem(&out).unwrap();
        let ids: Vec<ObjectId> = doc.get_pages().into_values().collect();
        let mut annots = Vec::new();
        for &pid in &ids[..2] {
            let arr = doc.get_dictionary(pid).unwrap().get(b"Annots").unwrap().as_array().unwrap().clone();
            assert_eq!(arr.len(), 1);
            let aid = arr[0].as_reference().unwrap();
            let p = doc.get_dictionary(aid).unwrap().get(b"P").unwrap().as_reference().unwrap();
            assert_eq!(p, pid, "annotation /P must point at its own page");
            annots.push(aid);
        }
        assert_ne!(annots[0], annots[1]);
    }
}
