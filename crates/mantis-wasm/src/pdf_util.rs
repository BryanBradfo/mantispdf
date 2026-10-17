use lopdf::{Document, Object, ObjectId};
use std::collections::{BTreeMap, HashSet};

/// Parse untrusted PDF bytes, refusing one that still needs a user password:
/// lopdf then returns Ok with an empty page tree and /Encrypt left in the
/// trailer. Owner-only encrypted files (empty user password) load fine.
pub(crate) fn load_pdf(bytes: &[u8]) -> Result<Document, String> {
    let mut doc = Document::load_mem(bytes).map_err(|e| format!("Failed to parse PDF: {e}"))?;
    if doc.is_encrypted() {
        return Err("This PDF is password-protected. Unlock it first.".to_string());
    }
    widen_page_boxes(&mut doc);
    Ok(doc)
}

const PAGE_BOXES: [&[u8]; 5] = [b"MediaBox", b"CropBox", b"BleedBox", b"TrimBox", b"ArtBox"];

/// Apply `widen_box_edge` to every page box on page and page-tree nodes, so
/// f32 rounding never moves a box edge inward. A box shared by reference is
/// widened once.
fn widen_page_boxes(doc: &mut Document) {
    let nodes: Vec<ObjectId> = doc
        .objects
        .iter()
        .filter(|(_, o)| {
            o.as_dict()
                .ok()
                .and_then(|d| d.get(b"Type").ok()?.as_name().ok())
                .is_some_and(|t| t == b"Page" || t == b"Pages")
        })
        .map(|(id, _)| *id)
        .collect();
    let mut shared = HashSet::new();
    for id in nodes {
        for key in PAGE_BOXES {
            let Ok(dict) = doc.get_dictionary_mut(id) else {
                continue;
            };
            let target = match dict.get_mut(key) {
                Ok(Object::Array(edges)) => {
                    widen_box(edges);
                    continue;
                }
                Ok(Object::Reference(target)) => *target,
                _ => continue,
            };
            if shared.insert(target)
                && let Some(Object::Array(edges)) = doc.objects.get_mut(&target)
            {
                widen_box(edges);
            }
        }
    }
}

/// Widen the Real edges of `[x0 y0 x1 y1]` (in either order) outward.
fn widen_box(edges: &mut [Object]) {
    if edges.len() != 4 {
        return;
    }
    for (a, b) in [(0, 2), (1, 3)] {
        let (Ok(va), Ok(vb)) = (edges[a].as_float(), edges[b].as_float()) else {
            continue;
        };
        let (low, high) = if va <= vb { (a, b) } else { (b, a) };
        for (i, up) in [(low, false), (high, true)] {
            if let Object::Real(v) = edges[i] {
                edges[i] = Object::Real(widen_box_edge(v, up));
            }
        }
    }
}

/// Shortest decimal text of an f32 with at least this many significant
/// digits cannot be the value the file wrote: the parse rounded it.
const ROUNDED_DIGITS: usize = 8;

/// Page box edge `v` moved one f32 step outward (`up` for a max edge, down
/// for a min edge) when it was rounded on parse AND the rounding went
/// inward. lopdf stores reals as f32, so `764.15094` comes back as
/// 764.15093994..., a hair inside the page, and renderers then snap the last
/// pixel row or column differently. Values with fewer digits (`595.32`) were
/// exact enough, and values rounded outward (`841.92004` as a max edge) are
/// already safe: moving either changes rendering for the worse.
fn widen_box_edge(v: f32, up: bool) -> f32 {
    if !v.is_finite() {
        return v;
    }
    let text = format!("{v}");
    let digits = text
        .bytes()
        .filter(u8::is_ascii_digit)
        .skip_while(|&d| d == b'0')
        .count();
    if digits < ROUNDED_DIGITS {
        return v;
    }
    let Ok(written) = text.parse::<f64>() else {
        return v;
    };
    let exact = f64::from(v);
    match up {
        true if exact < written => v.next_up(),
        false if exact > written => v.next_down(),
        _ => v,
    }
}

/// `load_pdf` with the 1-based document number in its errors (merge, plan).
pub(crate) fn load_pdf_n(bytes: &[u8], n: usize) -> Result<Document, String> {
    load_pdf(bytes).map_err(|e| match e.strip_prefix("Failed to parse PDF: ") {
        Some(rest) => format!("Failed to parse PDF {n}: {rest}"),
        None => format!("PDF {n} is password-protected. Unlock it first."),
    })
}

/// Resolve an inheritable page attribute (`/MediaBox`, `/Resources`, `/Rotate`,
/// `/CropBox`) by walking the `/Parent` chain starting at `page_id`. Returns the
/// first value found (the leaf's own value if present, else an ancestor's),
/// cloned so it can be written onto the leaf. Cycle-guarded like lopdf's own
/// `get_page_resources`, so a malformed `/Parent` loop returns `None` instead of
/// hanging the WASM module.
pub fn get_inherited_attr(doc: &Document, page_id: ObjectId, key: &[u8]) -> Option<Object> {
    let mut current = page_id;
    let mut seen = HashSet::new();
    loop {
        if !seen.insert(current) {
            return None; // /Parent cycle
        }
        let dict = doc.get_dictionary(current).ok()?;
        if let Ok(value) = dict.get(key) {
            return Some(value.clone());
        }
        match dict.get(b"Parent").and_then(Object::as_reference) {
            Ok(parent) => current = parent,
            Err(_) => return None,
        }
    }
}

/// Copy every object of `source` into `base` under fresh ids and return the
/// imported page leaves in page order. Inherited `/MediaBox`, `/Resources`,
/// `/CropBox` and `/Rotate` are materialized onto each leaf, so a leaf still
/// renders correctly once it is reparented. `/Parent` is left as imported:
/// callers wire the leaves into their own page tree.
pub fn import_document(base: &mut Document, source: &Document) -> Vec<ObjectId> {
    let mut id_map: BTreeMap<ObjectId, ObjectId> = BTreeMap::new();
    for &old_id in source.objects.keys() {
        let new_id = base.new_object_id();
        id_map.insert(old_id, new_id);
    }
    for (&old_id, object) in &source.objects {
        let mut new_obj = object.clone();
        remap_references(&mut new_obj, &id_map);
        base.objects.insert(id_map[&old_id], new_obj);
    }

    let inheritable: [&[u8]; 4] = [b"MediaBox", b"Resources", b"CropBox", b"Rotate"];
    let source_leaves: Vec<ObjectId> = source.get_pages().into_values().collect();
    for &src_leaf in &source_leaves {
        let new_leaf = id_map[&src_leaf];
        for key in inheritable {
            let leaf_has = source
                .get_dictionary(src_leaf)
                .map(|d| d.get(key).is_ok())
                .unwrap_or(false);
            if leaf_has {
                continue;
            }
            if let Some(mut value) = get_inherited_attr(source, src_leaf, key) {
                remap_references(&mut value, &id_map);
                if let Ok(dict) = base.get_object_mut(new_leaf).and_then(|o| o.as_dict_mut()) {
                    dict.set(key.to_vec(), value);
                }
            }
        }
    }
    source_leaves.iter().map(|id| id_map[id]).collect()
}

/// Recursively remap all `Object::Reference` values using `id_map`.
pub fn remap_references(object: &mut Object, id_map: &BTreeMap<ObjectId, ObjectId>) {
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

/// Build a PDF whose `n` pages do NOT carry `/MediaBox` or `/Resources` on the
/// leaf — they inherit both from the intermediate `/Pages` node. This reproduces
/// the real-world inheritance that the older `make_test_pdf` helpers (which set
/// `/MediaBox` on every leaf) cannot. Defined at module level (not inside the
/// `tests` submodule) so other modules' `#[cfg(test)]` code can import it via
/// `crate::pdf_util::make_inherited_test_pdf`.
/// Convenience wrapper: an inherited-attribute PDF with US-Letter pages.
#[cfg(test)]
pub fn make_inherited_test_pdf(n: u32) -> Vec<u8> {
    make_inherited_test_pdf_sized(n, 612, 792)
}

/// Build a PDF whose `n` pages do NOT carry `/MediaBox` or `/Resources` on the
/// leaf — they inherit both from the intermediate `/Pages` node, which is sized
/// `width`×`height`. Parameterizing the size lets merge tests give the base and
/// the appended source *different* page sizes, so a regression test can prove
/// appended pages keep the source's size (not the base's).
#[cfg(test)]
pub fn make_inherited_test_pdf_sized(n: u32, width: i64, height: i64) -> Vec<u8> {
    use lopdf::{Stream, content::Content, dictionary};

    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();

    // A shared resource dictionary lives on the /Pages node.
    let font_id = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Helvetica",
    });
    let shared_resources = dictionary! {
        "Font" => dictionary! { "F1" => font_id },
    };

    let mut page_ids = Vec::new();
    for _ in 0..n {
        let content = Content { operations: vec![] };
        let content_id = doc.add_object(Stream::new(dictionary! {}, content.encode().unwrap()));
        // Leaf page: NO MediaBox, NO Resources — inherited from /Pages.
        let page = dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "Contents" => content_id,
        };
        page_ids.push(doc.add_object(page));
    }

    let kids: Vec<Object> = page_ids.iter().map(|&id| id.into()).collect();
    let pages = dictionary! {
        "Type" => "Pages",
        "Kids" => kids,
        "Count" => n,
        "MediaBox" => vec![0.into(), 0.into(), width.into(), height.into()],
        "Resources" => shared_resources,
    };
    doc.objects.insert(pages_id, Object::Dictionary(pages));

    let catalog_id = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog_id);

    let mut buf = Vec::new();
    doc.save_to(&mut buf).unwrap();
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inherited_mediabox_resolves_from_parent() {
        let pdf = make_inherited_test_pdf(2);
        let doc = Document::load_mem(&pdf).unwrap();
        let first_page = *doc.get_pages().get(&1).unwrap();
        // The leaf has no MediaBox; the helper must find it on /Pages.
        let mb = get_inherited_attr(&doc, first_page, b"MediaBox");
        assert!(mb.is_some(), "MediaBox should be resolved from the parent");
        let arr = mb.unwrap();
        let arr = arr.as_array().unwrap();
        assert_eq!(arr.len(), 4);
        // 612.into() is stored as an Integer in this fixture.
        assert_eq!(arr[2].as_i64().unwrap(), 612);
    }

    #[test]
    fn missing_attr_returns_none() {
        let pdf = make_inherited_test_pdf(1);
        let doc = Document::load_mem(&pdf).unwrap();
        let first_page = *doc.get_pages().get(&1).unwrap();
        assert!(get_inherited_attr(&doc, first_page, b"CropBox").is_none());
    }

    #[test]
    fn every_tool_refuses_user_password_pdf_but_accepts_owner_only() {
        use crate::{WasmPdf, compress, edit, encrypt, merge, page_plan, rotate, split, watermark};
        let plain = make_inherited_test_pdf(2);
        let locked = encrypt::encrypt_pdf_impl(&plain, "u", "o").unwrap();
        let owner_only = encrypt::encrypt_pdf_impl(&plain, "", "o").unwrap();
        let plan = |_: ()| {
            vec![page_plan::PlanEntry::Page {
                src: 0,
                page: 1,
                rotate: 0,
            }]
        };

        type Op = Box<dyn Fn(&[u8]) -> Result<(), String>>;
        let ops: Vec<(&str, Op)> = vec![
            ("page_count", Box::new(|b| split::page_count(b).map(|_| ()))),
            (
                "extract_page_range",
                Box::new(|b| split::extract_page_range(b, 1, 1).map(|_| ())),
            ),
            (
                "apply_plan",
                Box::new(move |b| page_plan::apply_plan(&[b], &plan(())).map(|_| ())),
            ),
            (
                "merge_first",
                Box::new(|b| merge::merge_documents(&[b, b]).map(|_| ())),
            ),
            (
                "compress",
                Box::new(|b| compress::compress_pdf_impl(b, 50).map(|_| ())),
            ),
            (
                "rotate",
                Box::new(|b| rotate::rotate_pdf_impl(b, &[90, 0]).map(|_| ())),
            ),
            (
                "watermark",
                Box::new(|b| {
                    watermark::add_watermark_impl(b, "X", 24, 0.5, 45, 0.5, 0.5, 0.5).map(|_| ())
                }),
            ),
            (
                "reorder",
                Box::new(|b| edit::reorder_inner(b, &[1, 2]).map(|_| ())),
            ),
            (
                "encrypt",
                Box::new(|b| encrypt::encrypt_pdf_impl(b, "a", "b").map(|_| ())),
            ),
            (
                "WasmPdf::new",
                Box::new(|b| WasmPdf::from_bytes(b).map(|_| ())),
            ),
        ];
        for (name, op) in &ops {
            let err = op(&locked).expect_err(name);
            assert!(err.contains("password-protected"), "{name}: {err}");
            op(&owner_only).unwrap_or_else(|e| panic!("{name} owner-only: {e}"));
        }
        // merge: second document locked keeps its number
        let err = merge::merge_documents(&[&plain, &locked]).unwrap_err();
        assert_eq!(err, "PDF 2 is password-protected. Unlock it first.");
        let err = page_plan::apply_plan(
            &[&plain, &locked],
            &[page_plan::PlanEntry::Page {
                src: 0,
                page: 1,
                rotate: 0,
            }],
        )
        .unwrap_err();
        assert_eq!(err, "PDF 2 is password-protected. Unlock it first.");
    }

    #[test]
    fn long_box_edges_rounded_inward_move_one_f32_step_outward() {
        let up = widen_box_edge(764.15094, true);
        assert!(up > 764.15094_f32, "max edge pushed up");
        assert_eq!(up, f32::from_bits(764.15094_f32.to_bits() + 1));
        let down = widen_box_edge(12.345678, false);
        assert!(down < 12.345678_f32, "min edge pushed down");
        assert_eq!(
            widen_box_edge(595.32, true),
            595.32,
            "short value unchanged"
        );
        assert_eq!(widen_box_edge(0.0, false), 0.0);
        // 841.92004 parses to 841.9200439...: already outside its text as a
        // max edge, so pushing it further only moves the page (found on a
        // real file whose pages all shifted by a pixel).
        assert_eq!(widen_box_edge(841.92004, true), 841.92004);
        assert!(widen_box_edge(841.92004, false) < 841.92004_f32);
    }

    #[test]
    fn load_widens_long_page_box_edges() {
        use lopdf::dictionary;
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let page = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id,
            "MediaBox" => vec![0.into(), Object::Real(12.345678), Object::Real(595.32), Object::Real(764.15094)],
        });
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1,
                "CropBox" => vec![0.into(), 0.into(), Object::Real(595.32), Object::Real(764.15094)],
            }),
        );
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", catalog);
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();

        let doc = load_pdf(&bytes).unwrap();
        let reals = |id: ObjectId, key: &[u8]| -> Vec<f32> {
            doc.get_dictionary(id)
                .unwrap()
                .get(key)
                .unwrap()
                .as_array()
                .unwrap()
                .iter()
                .map(|o| o.as_float().unwrap())
                .collect()
        };
        let mb = reals(page, b"MediaBox");
        assert!(mb[1] < 12.345678_f32);
        assert_eq!(mb[2], 595.32);
        assert!(mb[3] > 764.15094_f32);
        assert!(reals(pages_id, b"CropBox")[3] > 764.15094_f32);
    }
}
