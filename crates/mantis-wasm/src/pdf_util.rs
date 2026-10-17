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

/// Object types lopdf's writer silently skips (the same test it uses): the
/// source's object and cross-reference streams and its linearization dict.
const UNWRITTEN_TYPES: [&[u8]; 3] = [b"ObjStm", b"XRef", b"Linearized"];

/// Trailer keys that only describe the source file's own cross-reference
/// sections (incremental chain, hybrid stream, xref-stream dictionary).
const STALE_TRAILER_KEYS: [&[u8]; 8] =
    [b"Prev", b"XRefStm", b"Type", b"W", b"Index", b"Filter", b"DecodeParms", b"Length"];

/// Make `doc` safe to serialize as a fresh, single-section file:
/// - drop the trailer keys of the source's cross-reference sections;
/// - drop the objects lopdf would skip while writing;
/// - number the remaining objects 1..=N in their current order, so the xref
///   has no gaps, and point references to missing objects at `null`.
///
/// lopdf writes one xref subsection per run of present object numbers, and
/// Poppler treats a number missing from the table as a broken xref: looking
/// one up makes it re-read and then try to rebuild the table ("Couldn't find
/// trailer dictionary", "Invalid XRef entry 0"). Gaps come from the skipped
/// objects above (every object-stream source has them) and from objects a
/// tool deletes. Idempotent; a document without gaps keeps its numbers.
pub(crate) fn prepare_for_save(doc: &mut Document) {
    for key in STALE_TRAILER_KEYS {
        doc.trailer.remove(key);
    }
    doc.objects.retain(|_, o| !o.type_name().is_ok_and(|t| UNWRITTEN_TYPES.contains(&t)));
    let map: BTreeMap<ObjectId, ObjectId> =
        doc.objects.keys().enumerate().map(|(i, &id)| (id, (i as u32 + 1, id.1))).collect();
    let objects = std::mem::take(&mut doc.objects);
    for (id, mut object) in objects {
        renumber_references(&mut object, &map);
        doc.objects.insert(map[&id], object);
    }
    for (_, value) in doc.trailer.iter_mut() {
        renumber_references(value, &map);
    }
    doc.max_id = doc.objects.len() as u32;
}

/// `remap_references` for a complete renumbering: a reference to an object
/// absent from `map` (dangling, or dropped) becomes `null`, its meaning in
/// PDF.
fn renumber_references(object: &mut Object, map: &BTreeMap<ObjectId, ObjectId>) {
    match object {
        Object::Reference(id) => match map.get(id) {
            Some(&new_id) => *id = new_id,
            None => *object = Object::Null,
        },
        Object::Array(items) => items.iter_mut().for_each(|o| renumber_references(o, map)),
        Object::Dictionary(dict) => dict.iter_mut().for_each(|(_, o)| renumber_references(o, map)),
        Object::Stream(stream) => stream.dict.iter_mut().for_each(|(_, o)| renumber_references(o, map)),
        _ => {}
    }
}

/// Serialize a document: the one save path of every tool (see
/// `prepare_for_save`).
pub(crate) fn save_pdf(doc: &mut Document) -> Result<Vec<u8>, String> {
    save_pdf_with_capacity(doc, 0)
}

/// `save_pdf` into a buffer reserved up front, so a large output is not grown
/// (and copied) by doubling.
pub(crate) fn save_pdf_with_capacity(doc: &mut Document, capacity: usize) -> Result<Vec<u8>, String> {
    prepare_for_save(doc);
    let mut buf = Vec::with_capacity(capacity);
    doc.save_to(&mut buf).map_err(|e| format!("Failed to save PDF: {e}"))?;
    Ok(buf)
}

/// A one-page "hybrid-reference" PDF laid out like Microsoft Word's: a first
/// section with a classic xref table for objects 0-4, then an empty update
/// section whose trailer chains to it (`/Prev`) and to a cross-reference
/// stream (`/XRefStm`, object 7) for the rest; the document info (object 6)
/// lives in an object stream (object 5).
#[cfg(test)]
pub fn make_hybrid_xref_pdf() -> Vec<u8> {
    fn obj(out: &mut Vec<u8>, offsets: &mut Vec<usize>, body: &[u8]) {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n", offsets.len()).as_bytes());
        out.extend_from_slice(body);
        out.extend_from_slice(b"\nendobj\n");
    }
    fn stream(dict: &str, data: &[u8]) -> Vec<u8> {
        let mut v = format!("<<{dict}/Length {}>>\nstream\n", data.len()).into_bytes();
        v.extend_from_slice(data);
        v.extend_from_slice(b"\nendstream");
        v
    }
    let mut out = b"%PDF-1.5\n%\xe2\xe3\xcf\xd3\n".to_vec();
    let mut offsets = vec![];
    obj(&mut out, &mut offsets, b"<</Type/Catalog/Pages 2 0 R>>");
    obj(&mut out, &mut offsets, b"<</Type/Pages/Kids[3 0 R]/Count 1>>");
    obj(&mut out, &mut offsets, b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R>>");
    obj(&mut out, &mut offsets, &stream("", b"0 0 m 100 100 l S"));
    let info = b"<</Producer(Hybrid fixture)>>";
    obj(&mut out, &mut offsets, &stream("/Type/ObjStm/N 1/First 4", &[b"6 0 ".as_slice(), info].concat()));
    let xref_stream_at = out.len();
    let mut entries = vec![];
    for (kind, field2, field3) in [(1u8, offsets[4] as u32, 0u16), (2, 5, 0), (1, xref_stream_at as u32, 0)] {
        entries.push(kind);
        entries.extend_from_slice(&field2.to_be_bytes());
        entries.extend_from_slice(&field3.to_be_bytes());
    }
    out.extend_from_slice(b"7 0 obj\n");
    out.extend_from_slice(&stream("/Type/XRef/Size 8/W[1 4 2]/Index[5 3]/Root 1 0 R", &entries));
    out.extend_from_slice(b"\nendobj\n");
    let first_xref = out.len();
    out.extend_from_slice(b"xref\n0 5\n0000000000 65535 f \n");
    for off in &offsets[..4] {
        out.extend_from_slice(format!("{off:010} 00000 n \n").as_bytes());
    }
    let trailer = "/Size 8/Root 1 0 R/Info 6 0 R/ID[<0102><0102>]";
    out.extend_from_slice(format!("trailer\n<<{trailer}>>\nstartxref\n{xref_stream_at}\n%%EOF\n").as_bytes());
    let last_xref = out.len();
    out.extend_from_slice(
        format!(
            "xref\n0 0\ntrailer\n<<{trailer}/Prev {first_xref}/XRefStm {xref_stream_at}>>\nstartxref\n{last_xref}\n%%EOF\n"
        )
        .as_bytes(),
    );
    out
}

/// The subsections `(first, count)` of the classic xref table `startxref`
/// points to, and the trailer dictionary that follows it, as written.
#[cfg(test)]
pub fn xref_table_of(pdf: &[u8]) -> (Vec<(u32, u32)>, String) {
    let tail = pdf.windows(9).rposition(|w| w == b"startxref").unwrap() + 9;
    let at: usize = String::from_utf8_lossy(&pdf[tail..]).split_whitespace().next().unwrap().parse().unwrap();
    let table = String::from_utf8_lossy(&pdf[at..]);
    assert!(table.starts_with("xref"), "startxref does not point to an xref table");
    let mut lines = table.lines().skip(1);
    let mut sections = vec![];
    while let Some(line) = lines.next() {
        if line.starts_with("trailer") {
            break;
        }
        let mut it = line.split_whitespace().map(|v| v.parse::<u32>().unwrap());
        let (first, count) = (it.next().unwrap(), it.next().unwrap());
        sections.push((first, count));
        lines.by_ref().take(count as usize).for_each(drop);
    }
    let trailer = &table[table.find("trailer").unwrap() + 7..table.rfind("startxref").unwrap()];
    (sections, trailer.trim().to_string())
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
    fn hybrid_xref_fixture_loads_compressed_info() {
        let doc = load_pdf(&make_hybrid_xref_pdf()).unwrap();
        assert_eq!(doc.get_pages().len(), 1);
        let info = doc.trailer.get(b"Info").unwrap().as_reference().unwrap();
        let producer = doc.get_dictionary(info).unwrap().get(b"Producer").unwrap();
        assert_eq!(producer.as_str().unwrap(), b"Hybrid fixture");
    }

    /// Poppler re-reads the xref and then tries (and fails) to rebuild it
    /// when it looks up an object number missing from the table: lopdf
    /// leaves such a gap for every object it drops while writing (object
    /// and xref streams) and for objects a tool deleted.
    /// The cross-reference data of `out` is one gapless section and its
    /// trailer carries no key of the source's cross-reference sections.
    fn assert_clean_xref(tool: &str, out: &[u8]) {
        let tail = out.windows(9).rposition(|w| w == b"startxref").unwrap() + 9;
        let at: usize = String::from_utf8_lossy(&out[tail..]).split_whitespace().next().unwrap().parse().unwrap();
        if out[at..].starts_with(b"xref") {
            let (sections, trailer) = xref_table_of(out);
            let size: u32 = trailer.split("/Size").nth(1).unwrap().split(|c: char| !c.is_ascii_digit() && c != ' ')
                .next().unwrap().trim().parse().unwrap();
            assert_eq!(sections, vec![(0, size)], "{tool}: xref must be one gapless section");
            for key in ["/Prev", "/XRefStm", "/Type", "/W", "/Index", "/Filter", "/DecodeParms", "/Length"] {
                assert!(!trailer.contains(key), "{tool}: stale {key} in trailer {trailer}");
            }
        } else {
            // A cross-reference stream: one /Index run up to /Size.
            let head = &out[at..];
            let dict = String::from_utf8_lossy(&head[..head.windows(6).position(|w| w == b"stream").unwrap()]);
            let ints = |key: &str| -> Vec<i64> {
                let rest = &dict[dict.find(key).unwrap() + key.len()..];
                let rest = rest.trim_start().trim_start_matches('[');
                let end = if key == "/Index" { rest.find(']').unwrap() } else { rest.find(|c: char| !c.is_ascii_digit()).unwrap() };
                rest[..end].split_whitespace().map(|v| v.parse().unwrap()).collect()
            };
            let (size, index) = (ints("/Size")[0], ints("/Index"));
            assert!(index.len() == 2 && index[0] + index[1] == size, "{tool}: gaps in /Index {index:?} ({dict})");
            assert!(!dict.contains("/Prev") && !dict.contains("/XRefStm"), "{tool}: stale keys in {dict}");
        }
    }

    #[test]
    fn every_tool_writes_a_clean_xref_for_a_hybrid_source() {
        use crate::stamp::engine::{Anchor, PageSelection, StampJob, TextStamp, apply_stamps};
        let src = make_hybrid_xref_pdf();
        let job = StampJob {
            pages: PageSelection::All,
            texts: vec![TextStamp {
                template: "{n}".into(),
                font: crate::stamp::fonts::StdFont::Helvetica,
                size: 10.0,
                color: [0.0; 3],
                opacity: 1.0,
                anchor: Anchor::BottomCenter,
                margin_x: 20.0,
                margin_y: 20.0,
                at: None,
                page_only: None,
            }],
            images: vec![],
            number_start: 1,
            bates: None,
        };
        let meta = crate::doc_tools::Metadata { title: "T".into(), ..Default::default() };
        let outputs: Vec<(&str, Vec<u8>)> = vec![
            ("stamp", apply_stamps(&src, &job).unwrap().bytes),
            ("watermark", crate::watermark::add_watermark_impl(&src, "W", 20, 0.5, 45, 0.0, 0.0, 0.0).unwrap()),
            ("rotate", crate::rotate::rotate_pdf_impl(&src, &[90]).unwrap()),
            ("compress", crate::compress::compress_pdf_impl(&src, 80).unwrap()),
            ("metadata", crate::doc_tools::set_metadata(&src, &meta).unwrap()),
            ("remove-metadata", crate::doc_tools::remove_metadata(&src).unwrap()),
            ("merge", crate::merge::merge_documents(&[&src, &src]).unwrap()),
            ("reorder", crate::edit::reorder_inner(&src, &[1]).unwrap()),
            ("split", crate::split::extract_page_range(&src, 1, 1).unwrap()),
            ("encrypt", crate::encrypt::encrypt_pdf_impl(&src, "pw", "owner").unwrap()),
        ];
        for (tool, out) in &outputs {
            assert_clean_xref(tool, out);
        }
        // Renumbering happened before encryption: the output decrypts.
        let enc = &outputs.last().unwrap().1;
        let doc = Document::load_mem_with_password(enc, "pw").unwrap();
        assert_eq!(doc.get_pages().len(), 1);
        let info = doc.trailer.get(b"Info").unwrap().as_reference().unwrap();
        let producer = doc.get_dictionary(info).unwrap().get(b"Producer").unwrap();
        assert_eq!(producer.as_str().unwrap(), b"Hybrid fixture");
    }

    #[test]
    fn save_pdf_writes_one_gapless_xref_and_a_clean_trailer() {
        let mut doc = load_pdf(&make_hybrid_xref_pdf()).unwrap();
        // Stale keys a loaded trailer may carry.
        doc.trailer.set("Prev", 9);
        doc.trailer.set("XRefStm", 9);
        doc.trailer.set("Type", "XRef");
        doc.trailer.set("W", vec![1.into(), 4.into(), 2.into()]);
        doc.trailer.set("Index", vec![0.into(), 8.into()]);
        doc.trailer.set("DecodeParms", lopdf::dictionary! { "Columns" => 5 });
        // And a gap left by a deleted object.
        let doomed = doc.add_object(Object::Integer(1));
        doc.add_object(Object::Integer(2));
        doc.objects.remove(&doomed);
        doc.reference_table.cross_reference_type = lopdf::xref::XrefType::CrossReferenceTable;

        let out = save_pdf(&mut doc).unwrap();
        let (sections, trailer) = xref_table_of(&out);
        let size: u32 = trailer.split("/Size").nth(1).unwrap().split(|c: char| !c.is_ascii_digit() && c != ' ')
            .next().unwrap().trim().parse().unwrap();
        assert_eq!(sections, vec![(0, size)], "xref must be one gapless section");
        for key in ["/Prev", "/XRefStm", "/Type", "/W", "/Index", "/Filter", "/DecodeParms", "/Length"] {
            assert!(!trailer.contains(key), "stale {key} in trailer {trailer}");
        }

        let back = load_pdf(&out).unwrap();
        assert_eq!(back.get_pages().len(), 1);
        let info = back.trailer.get(b"Info").unwrap().as_reference().unwrap();
        let producer = back.get_dictionary(info).unwrap().get(b"Producer").unwrap();
        assert_eq!(producer.as_str().unwrap(), b"Hybrid fixture");
    }

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
