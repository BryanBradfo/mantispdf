//! Resize: puts each selected page on a new sheet size. The visible page is
//! scaled (Fit) or only shrunk when needed (Extend), centered, and drawn
//! upright: `/Rotate` and the old boxes are dropped and the content is
//! wrapped in `q <C> cm ... Q`, C mapping user space to the new sheet.

use super::{apply, concat, invalid, invert, number, page_map, selected_numbers};
use crate::page_content::{BalanceScanner, fmt_num, original_contents, plain_stream};
use crate::pdf_util::{get_inherited_attr, load_pdf, save_pdf};
use crate::rebuild::deref;
use crate::stamp::engine::PageSelection;
use crate::stamp::geometry::VisibleBox;
use lopdf::{Dictionary, Document, Object, ObjectId};
use std::collections::{BTreeMap, HashMap, HashSet};

/// Sheet side bounds, in points (PDF minimum 1 in, maximum 200 in).
pub(crate) const MIN_SHEET: f64 = 36.0;
pub(crate) const MAX_SHEET: f64 = 14_400.0;
/// 200 mm in points.
pub(crate) const MAX_MARGIN: f64 = 200.0 * 72.0 / 25.4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Orientation {
    /// Landscape sheet for a landscape visible page, portrait otherwise.
    Auto,
    Portrait,
    Landscape,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResizeMode {
    /// Scale uniformly to fill the sheet inside the margin.
    Fit,
    /// Keep the size; scale down only content larger than the sheet.
    Extend,
}

#[derive(Debug, Clone)]
pub struct ResizeJob {
    pub pages: PageSelection,
    /// Sheet `[width, height]` in points, portrait (width <= height).
    pub size: [f64; 2],
    pub orientation: Orientation,
    pub mode: ResizeMode,
    /// Points kept free on every side of the sheet.
    pub margin: f64,
}

pub fn resize_pages(pdf: &[u8], job: &ResizeJob) -> Result<Vec<u8>, String> {
    let [w, h] = job.size;
    if ![w, h].iter().all(|v| v.is_finite() && (MIN_SHEET..=MAX_SHEET).contains(v)) {
        return Err(invalid("size"));
    }
    let (short, long) = (w.min(h), w.max(h));
    let m = job.margin;
    if !(m.is_finite() && (0.0..=MAX_MARGIN).contains(&m)) || short - 2.0 * m <= 0.0 {
        return Err(invalid("margin"));
    }
    let mut doc = load_pdf(pdf)?;
    let pages = page_map(&doc);
    let selected = selected_numbers(&job.pages, pages.len() as u32)?;
    let users = annotation_users(&doc, pages.values().copied());
    let mut scanner = BalanceScanner::new();
    // A page object listed twice in the tree is resized once.
    let mut done: HashSet<ObjectId> = HashSet::new();
    for n in selected {
        let id = pages[&n];
        if done.insert(id) {
            resize_page(&mut doc, id, job, (short, long), &users, &mut scanner)?;
        }
    }
    save_pdf(&mut doc)
}

fn resize_page(
    doc: &mut Document,
    id: ObjectId,
    job: &ResizeJob,
    (short, long): (f64, f64),
    users: &HashMap<ObjectId, usize>,
    scanner: &mut BalanceScanner,
) -> Result<(), String> {
    let vb = VisibleBox::of_page(doc, id);
    let (vw, vh) = (vb.width(), vb.height());
    let landscape = match job.orientation {
        Orientation::Auto => vw > vh,
        Orientation::Portrait => false,
        Orientation::Landscape => true,
    };
    let (sw, sh) = if landscape { (long, short) } else { (short, long) };
    let fit = ((sw - 2.0 * job.margin) / vw).min((sh - 2.0 * job.margin) / vh);
    let s = match job.mode {
        ResizeMode::Fit => fit,
        ResizeMode::Extend => fit.min(1.0),
    };
    let place = [s, 0.0, 0.0, s, (sw - s * vw) / 2.0, (sh - s * vh) / 2.0];
    // User space -> visible space -> the sheet.
    let c = concat(invert(vb.matrix()), place);

    let page = doc.get_dictionary(id).map_err(|e| format!("Page {id:?} not found: {e}"))?;
    let original = original_contents(doc, page.get(b"Contents").ok());
    let annots: Option<Vec<Object>> = match page.get(b"Annots").ok().and_then(|a| deref(doc, a)) {
        Some(Object::Array(items)) => Some(items.clone()),
        _ => None,
    };

    // The original content runs inside `q C cm ... Q`; the `q` it leaves
    // open are closed before the wrapper's own `Q` (as the stamp engine does).
    let contents = if original.is_empty() {
        None
    } else {
        // A stray `Q` in the original would pop the wrapper's `q` and drop
        // `C cm`: as many extra `q` after it absorb them.
        let (open, excess) = scanner.balance(doc, &original);
        let mut head = format!("q {} cm\n", c.map(fmt_num).join(" "));
        if excess > 0 {
            head.push_str(&vec!["q"; excess].join(" "));
            head.push('\n');
        }
        let tail = format!("\nQ\n{}", "Q\n".repeat(open));
        let mut items = Vec::with_capacity(original.len() + 2);
        items.push(Object::Reference(doc.add_object(plain_stream(head.into_bytes()))));
        items.extend(original);
        items.push(Object::Reference(doc.add_object(plain_stream(tail.into_bytes()))));
        Some(items)
    };

    // On a turned page, appearances turn with the content (see
    // `turn_appearances`); the translation does not matter there.
    let turn = (vb.rotate != 0).then(|| {
        let [a, b, c, d, _, _] = invert(vb.matrix());
        [a, b, c, d, 0.0, 0.0]
    });
    let annots = annots.map(|items| {
        // An annotation listed twice on the page is transformed once.
        let mut seen: HashMap<ObjectId, Object> = HashMap::new();
        items
            .into_iter()
            .map(|item| match item.as_reference() {
                Ok(aid) => match seen.get(&aid) {
                    Some(done) => done.clone(),
                    None => {
                        let done = transform_annotation(doc, id, item, c, turn, users);
                        seen.insert(aid, done.clone());
                        done
                    }
                },
                Err(_) => transform_annotation(doc, id, item, c, turn, users),
            })
            .collect::<Vec<_>>()
    });

    let sheet = Object::Array(vec![0.into(), 0.into(), number(sw), number(sh)]);
    let page = doc.get_dictionary_mut(id).map_err(|e| format!("Page {id:?} not found: {e}"))?;
    page.set("MediaBox", sheet.clone());
    for key in [&b"CropBox"[..], b"TrimBox", b"BleedBox", b"ArtBox", b"Rotate"] {
        page.remove(key);
    }
    if let Some(items) = contents {
        page.set("Contents", items);
    }
    if let Some(items) = annots {
        page.set("Annots", items);
    }
    // A /Rotate or /CropBox still inherited from a page-tree node would turn
    // or cut the new sheet: override it on the leaf.
    let inherited_rotate = get_inherited_attr(doc, id, b"Rotate").is_some();
    let inherited_crop = get_inherited_attr(doc, id, b"CropBox").is_some();
    let page = doc.get_dictionary_mut(id).map_err(|e| format!("Page {id:?} not found: {e}"))?;
    if inherited_rotate {
        page.set("Rotate", 0);
    }
    if inherited_crop {
        page.set("CropBox", sheet);
    }
    Ok(())
}

/// Annotation object -> number of distinct pages listing it in /Annots.
fn annotation_users(doc: &Document, pages: impl Iterator<Item = ObjectId>) -> HashMap<ObjectId, usize> {
    let mut users: HashMap<ObjectId, usize> = HashMap::new();
    let distinct: BTreeMap<ObjectId, ()> = pages.map(|p| (p, ())).collect();
    for page in distinct.keys() {
        let Ok(dict) = doc.get_dictionary(*page) else { continue };
        let Some(Object::Array(items)) = dict.get(b"Annots").ok().and_then(|a| deref(doc, a)) else {
            continue;
        };
        let refs: HashSet<ObjectId> = items.iter().filter_map(|i| i.as_reference().ok()).collect();
        for r in refs {
            *users.entry(r).or_default() += 1;
        }
    }
    users
}

/// One /Annots entry with its geometry mapped by `c`. An annotation listed by
/// one page is edited in place (form fields and popups keep pointing at it);
/// one shared with another page is copied, with `/P` set to `page`.
fn transform_annotation(
    doc: &mut Document,
    page: ObjectId,
    item: Object,
    c: [f64; 6],
    turn: Option<[f64; 6]>,
    users: &HashMap<ObjectId, usize>,
) -> Object {
    match item {
        Object::Reference(aid) => {
            let Ok(dict) = doc.get_dictionary(aid) else { return item };
            let mut dict = dict.clone();
            transform_geometry(doc, &mut dict, c);
            turn_appearances(doc, &mut dict, turn);
            if users.get(&aid).copied().unwrap_or(0) > 1 {
                dict.set("P", Object::Reference(page));
                Object::Reference(doc.add_object(dict))
            } else {
                doc.objects.insert(aid, Object::Dictionary(dict));
                item
            }
        }
        Object::Dictionary(mut dict) => {
            transform_geometry(doc, &mut dict, c);
            turn_appearances(doc, &mut dict, turn);
            Object::Dictionary(dict)
        }
        other => other,
    }
}

/// Annotation flag: keep the annotation upright when the page is rotated.
const NO_ROTATE: i64 = 16;

/// A viewer fits an appearance onto /Rect by scaling and translating its
/// transformed /BBox only (ISO 32000 12.5.5), so on a page whose /Rotate was
/// folded into the content the appearance itself must turn: each stream of
/// /AP (N, R, D and their per-state entries) is replaced by an owned copy
/// whose /Matrix is followed by `turn`. NoRotate annotations already stood
/// upright on screen and are left alone.
fn turn_appearances(doc: &mut Document, dict: &mut Dictionary, turn: Option<[f64; 6]>) {
    let Some(turn) = turn else { return };
    let flags = dict.get(b"F").ok().and_then(|f| deref(doc, f)).and_then(|f| f.as_i64().ok()).unwrap_or(0);
    if flags & NO_ROTATE != 0 {
        return;
    }
    let Some(Object::Dictionary(ap)) = dict.get(b"AP").ok().and_then(|a| deref(doc, a)).cloned() else {
        return;
    };
    // One copy per original stream, reused across the entries of this /AP.
    let mut copies: HashMap<ObjectId, ObjectId> = HashMap::new();
    let mut owned = Dictionary::new();
    for (key, value) in ap.iter() {
        let turned = match deref(doc, value) {
            Some(Object::Dictionary(states)) => {
                let states = states.clone();
                let mut out = Dictionary::new();
                for (state, stream) in states.iter() {
                    out.set(state.clone(), turned_stream(doc, stream, turn, &mut copies));
                }
                Object::Dictionary(out)
            }
            _ => turned_stream(doc, value, turn, &mut copies),
        };
        owned.set(key.clone(), turned);
    }
    dict.set("AP", owned);
}

/// A reference to an owned copy of appearance stream `obj` with `turn`
/// appended to its /Matrix; anything else is returned unchanged.
fn turned_stream(
    doc: &mut Document,
    obj: &Object,
    turn: [f64; 6],
    copies: &mut HashMap<ObjectId, ObjectId>,
) -> Object {
    let Ok(id) = obj.as_reference() else { return obj.clone() };
    if let Some(copy) = copies.get(&id) {
        return Object::Reference(*copy);
    }
    let Ok(Object::Stream(stream)) = doc.get_object(id) else { return obj.clone() };
    let mut stream = stream.clone();
    let current = numbers(doc, stream.dict.get(b"Matrix").ok())
        .and_then(|v| <[f64; 6]>::try_from(v).ok())
        .unwrap_or([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
    let m = concat(current, turn);
    stream.dict.set("Matrix", Object::Array(m.map(number).to_vec()));
    let copy = doc.add_object(stream);
    copies.insert(id, copy);
    Object::Reference(copy)
}

/// Maps /Rect (to the bounding box of its transformed corners), /QuadPoints,
/// /InkList, /Vertices and /L. Malformed entries are left as they are.
fn transform_geometry(doc: &Document, dict: &mut Dictionary, c: [f64; 6]) {
    if let Some([x0, y0, x1, y1]) = numbers(doc, dict.get(b"Rect").ok()).and_then(|v| <[f64; 4]>::try_from(v).ok()) {
        let corners = [apply(c, x0, y0), apply(c, x1, y0), apply(c, x0, y1), apply(c, x1, y1)];
        let xs = corners.map(|p| p.0);
        let ys = corners.map(|p| p.1);
        let min = |v: [f64; 4]| v.into_iter().fold(f64::INFINITY, f64::min);
        let max = |v: [f64; 4]| v.into_iter().fold(f64::NEG_INFINITY, f64::max);
        let rect = [min(xs), min(ys), max(xs), max(ys)];
        dict.set("Rect", Object::Array(rect.map(number).to_vec()));
    }
    for key in [&b"QuadPoints"[..], b"Vertices", b"L"] {
        if let Some(points) = transformed_points(doc, dict.get(key).ok(), c) {
            dict.set(key, points);
        }
    }
    let ink = match dict.get(b"InkList").ok().and_then(|o| deref(doc, o)) {
        Some(Object::Array(paths)) => {
            paths.iter().map(|p| transformed_points(doc, Some(p), c)).collect::<Option<Vec<_>>>()
        }
        _ => None,
    };
    if let Some(paths) = ink {
        dict.set("InkList", paths);
    }
}

/// The numbers of array `obj` (elements may be indirect); None when any is
/// not a finite number.
fn numbers(doc: &Document, obj: Option<&Object>) -> Option<Vec<f64>> {
    let Object::Array(items) = deref(doc, obj?)? else { return None };
    items
        .iter()
        .map(|i| deref(doc, i)?.as_float().ok().map(f64::from).filter(|v| v.is_finite()))
        .collect()
}

/// An x y x y ... array with every point mapped by `c`.
fn transformed_points(doc: &Document, obj: Option<&Object>, c: [f64; 6]) -> Option<Object> {
    let v = numbers(doc, obj)?;
    if v.len() % 2 != 0 {
        return None;
    }
    let out = v
        .chunks_exact(2)
        .flat_map(|p| {
            let (x, y) = apply(c, p[0], p[1]);
            [number(x), number(y)]
        })
        .collect();
    Some(Object::Array(out))
}

#[cfg(test)]
mod tests {
    use super::super::fixture::{Fixture, nums, pages, read_nums};
    use super::*;
    use lopdf::dictionary;

    const LETTER: [f64; 4] = [0.0, 0.0, 612.0, 792.0];
    const A4: [f64; 2] = [595.276, 841.89];
    const HELLO: &str = "BT /F1 12 Tf 72 700 Td (Hello) Tj ET";

    fn job(size: [f64; 2], mode: ResizeMode) -> ResizeJob {
        ResizeJob { pages: PageSelection::All, size, orientation: Orientation::Auto, mode, margin: 0.0 }
    }

    fn one_page(entries: Dictionary, content: &str) -> Vec<u8> {
        let mut f = Fixture::new();
        f.page(entries, content);
        f.finish(Dictionary::new())
    }

    fn letter(rotate: i64) -> Vec<u8> {
        one_page(dictionary! { "MediaBox" => nums(&LETTER), "Rotate" => rotate }, HELLO)
    }

    fn resize(pdf: &[u8], job: &ResizeJob) -> Document {
        Document::load_mem(&resize_pages(pdf, job).unwrap()).unwrap()
    }

    fn leaf(doc: &Document, n: usize) -> &Dictionary {
        doc.get_dictionary(pages(doc)[n]).unwrap()
    }

    /// Decoded content streams of page `n`, in order.
    fn streams(doc: &Document, n: usize) -> Vec<String> {
        let items = match leaf(doc, n).get(b"Contents").unwrap() {
            Object::Array(items) => items.clone(),
            other => vec![other.clone()],
        };
        items
            .iter()
            .map(|o| {
                let s = doc.get_object(o.as_reference().unwrap()).unwrap().as_stream().unwrap();
                String::from_utf8(s.decompressed_content().unwrap_or_else(|_| s.content.clone())).unwrap()
            })
            .collect()
    }

    /// The `cm` matrix the wrapper stream of page `n` opens with.
    fn wrap_matrix(doc: &Document, n: usize) -> (String, [f64; 6]) {
        let first = streams(doc, n).remove(0);
        let body = first.trim().strip_prefix("q ").unwrap().strip_suffix(" cm").unwrap().to_string();
        let v: Vec<f64> = body.split(' ').map(|t| t.parse().unwrap()).collect();
        (body, [v[0], v[1], v[2], v[3], v[4], v[5]])
    }

    /// Within the error of a matrix written with 6 decimals applied to page-size
    /// coordinates.
    fn close(a: (f64, f64), b: (f64, f64)) -> bool {
        (a.0 - b.0).abs() < 1e-3 && (a.1 - b.1).abs() < 1e-3
    }

    #[test]
    fn letter_to_a4_fit_scales_and_centers() {
        // s = min(595.276 / 612, 841.89 / 792) = 595.276 / 612 = 0.97267320...
        // tx = (595.276 - 612 s) / 2 = 0; ty = (841.89 - 792 s) / 2 = 35.76641176...
        let doc = resize(&letter(0), &job(A4, ResizeMode::Fit));
        assert_eq!(wrap_matrix(&doc, 0).0, "0.972673 0 0 0.972673 0 35.766412");
        let page = leaf(&doc, 0);
        assert_eq!(read_nums(page, b"MediaBox"), [0.0, 0.0, 595.276f32 as f64, 841.89f32 as f64]);
        for key in [&b"CropBox"[..], b"TrimBox", b"BleedBox", b"ArtBox", b"Rotate"] {
            assert!(page.get(key).is_err());
        }
        let s = streams(&doc, 0);
        assert_eq!(s.len(), 3);
        assert_eq!(s[1], HELLO);
        assert_eq!(s[2].matches('Q').count(), 1);
    }

    #[test]
    fn rotated_page_gets_a_landscape_sheet_and_upright_content() {
        // Visible page 792 x 612 (Letter turned by /Rotate 90), so Auto picks a
        // landscape sheet 841.89 x 595.276.
        // s = min(841.89 / 792, 595.276 / 612) = 0.97267320...;
        // tx = (841.89 - 792 s) / 2 = 35.76641176...; ty = (595.276 - 612 s) / 2 = 0.
        // VisibleBox matrix V = [0 1 -1 0 612 0]; inverse(V) = [0 -1 1 0 0 612]
        // (user (x, y) -> visible (y, 612 - x)). C = inverse(V) then
        // [s 0 0 s tx ty] = [0 -s s 0 tx 612 s] = [0 -s s 0 35.766412 595.276].
        let doc = resize(&letter(90), &job(A4, ResizeMode::Fit));
        let (text, m) = wrap_matrix(&doc, 0);
        assert_eq!(text, "0 -0.972673 0.972673 0 35.766412 595.276");
        assert_eq!(read_nums(leaf(&doc, 0), b"MediaBox"), [0.0, 0.0, 841.89f32 as f64, 595.276f32 as f64]);
        assert!(leaf(&doc, 0).get(b"Rotate").is_err());
        // The text origin (72, 700) shows at visible (700, 540) on the
        // rotated page: on the new sheet it is (700 s + tx, 540 s).
        let s = 595.276 / 612.0;
        assert!(close(apply(m, 72.0, 700.0), (700.0 * s + 35.766412, 540.0 * s)));
        // Visible corners land on the sheet's printable area corners.
        assert!(close(apply(m, 612.0, 0.0), (35.766412, 0.0)));
        assert!(close(apply(m, 0.0, 792.0), (841.89 - 35.766412, 595.276)));
    }

    #[test]
    fn rotations_180_and_270_map_corners_upright() {
        for rotate in [180, 270] {
            let doc = resize(&letter(rotate), &job(A4, ResizeMode::Fit));
            let (_, m) = wrap_matrix(&doc, 0);
            let vb_doc = Document::load_mem(&letter(rotate)).unwrap();
            let vb = VisibleBox::of_page(&vb_doc, pages(&vb_doc)[0]);
            let [w, h] = [vb.width(), vb.height()];
            let sheet = read_nums(leaf(&doc, 0), b"MediaBox");
            let s = (sheet[2] / w).min(sheet[3] / h);
            let (tx, ty) = ((sheet[2] - s * w) / 2.0, (sheet[3] - s * h) / 2.0);
            // Visible (0, 0) and (w, h) go to the bottom-left and top-right of
            // the scaled area.
            let (ux, uy) = vb.to_user(0.0, 0.0);
            assert!(close(apply(m, ux, uy), (tx, ty)), "{rotate}");
            let (ux, uy) = vb.to_user(w, h);
            assert!(close(apply(m, ux, uy), (tx + s * w, ty + s * h)), "{rotate}");
        }
    }

    #[test]
    fn extend_never_upscales_and_shrinks_oversized_pages() {
        // A5 (420 x 595) on A4: Fit would upscale; Extend keeps s = 1.
        // tx = (595.276 - 420) / 2 = 87.638; ty = (841.89 - 595) / 2 = 123.445.
        let a5 = one_page(dictionary! { "MediaBox" => nums(&[0.0, 0.0, 420.0, 595.0]) }, HELLO);
        let doc = resize(&a5, &job(A4, ResizeMode::Extend));
        assert_eq!(wrap_matrix(&doc, 0).0, "1 0 0 1 87.638 123.445");
        let doc = resize(&a5, &job(A4, ResizeMode::Fit));
        assert!(wrap_matrix(&doc, 0).1[0] > 1.0);
        // Letter on A5 sheet [420 595]: s = min(1, 420 / 612, 595 / 792) = 420 / 612.
        let doc = resize(&letter(0), &job([420.0, 595.0], ResizeMode::Extend));
        assert_eq!(wrap_matrix(&doc, 0).1[0], fmt_num(420.0 / 612.0).parse::<f64>().unwrap());
    }

    #[test]
    fn margin_shrinks_the_available_area() {
        // Sheet 612 x 792 with margin 36: available 540 x 720,
        // s = min(540 / 612, 720 / 792) = 0.88235294...; tx = (612 - 612 s) / 2 = 36;
        // ty = (792 - 792 s) / 2 = 46.58823529...
        let j = ResizeJob { margin: 36.0, ..job([612.0, 792.0], ResizeMode::Fit) };
        let doc = resize(&letter(0), &j);
        assert_eq!(wrap_matrix(&doc, 0).0, "0.882353 0 0 0.882353 36 46.588235");
    }

    #[test]
    fn explicit_orientation_overrides_auto() {
        let j = ResizeJob { orientation: Orientation::Landscape, ..job(A4, ResizeMode::Fit) };
        let doc = resize(&letter(0), &j);
        assert_eq!(read_nums(leaf(&doc, 0), b"MediaBox"), [0.0, 0.0, 841.89f32 as f64, 595.276f32 as f64]);
        let j = ResizeJob { orientation: Orientation::Portrait, ..job(A4, ResizeMode::Fit) };
        let doc = resize(&letter(90), &j);
        assert_eq!(read_nums(leaf(&doc, 0), b"MediaBox"), [0.0, 0.0, 595.276f32 as f64, 841.89f32 as f64]);
    }

    #[test]
    fn invalid_settings_are_refused() {
        let pdf = letter(0);
        let bad = |j: ResizeJob| resize_pages(&pdf, &j).unwrap_err();
        assert_eq!(bad(job([35.0, 800.0], ResizeMode::Fit)), "Invalid geometry settings: size");
        assert_eq!(bad(job([600.0, 14_401.0], ResizeMode::Fit)), "Invalid geometry settings: size");
        assert_eq!(bad(job([f64::NAN, 800.0], ResizeMode::Fit)), "Invalid geometry settings: size");
        let m = |margin| ResizeJob { margin, ..job(A4, ResizeMode::Fit) };
        assert_eq!(bad(m(-1.0)), "Invalid geometry settings: margin");
        assert_eq!(bad(m(567.0)), "Invalid geometry settings: margin");
        assert_eq!(bad(m(f64::INFINITY)), "Invalid geometry settings: margin");
        // 36 pt sheet with 18 pt margins leaves nothing.
        let j = ResizeJob { margin: 18.0, ..job([36.0, 36.0], ResizeMode::Fit) };
        assert_eq!(bad(j), "Invalid geometry settings: margin");
        let j = ResizeJob { pages: PageSelection::List(vec![2]), ..job(A4, ResizeMode::Fit) };
        assert!(bad(j).contains("Page 2 does not exist"));
    }

    #[test]
    fn unbalanced_q_in_the_original_is_closed() {
        let pdf = one_page(dictionary! { "MediaBox" => nums(&LETTER) }, "q q 1 0 0 1 5 5 cm");
        let doc = resize(&pdf, &job(A4, ResizeMode::Fit));
        let s = streams(&doc, 0);
        assert_eq!(s.last().unwrap().matches('Q').count(), 3);
    }

    #[test]
    fn content_array_and_shared_streams_are_kept_unmutated() {
        let mut f = Fixture::new();
        let shared = f.doc.add_object(lopdf::Stream::new(Dictionary::new(), HELLO.as_bytes().to_vec()));
        let array = f.doc.add_object(vec![Object::Reference(shared)]);
        f.page(dictionary! { "MediaBox" => nums(&LETTER), "Contents" => array }, "");
        f.page(dictionary! { "MediaBox" => nums(&LETTER), "Contents" => shared }, "");
        let pdf = f.finish(Dictionary::new());
        let j = ResizeJob { pages: PageSelection::List(vec![1]), ..job(A4, ResizeMode::Fit) };
        let doc = resize(&pdf, &j);
        assert_eq!(streams(&doc, 0)[1], HELLO);
        assert_eq!(streams(&doc, 1), [HELLO]);
        assert_eq!(read_nums(leaf(&doc, 1), b"MediaBox"), LETTER);
        let arr = doc.get_object(array).unwrap().as_array().unwrap();
        assert_eq!(arr, &vec![Object::Reference(shared)]);
    }

    #[test]
    fn page_without_content_only_changes_size() {
        let pdf = one_page(dictionary! { "MediaBox" => nums(&LETTER) }, "");
        let doc = resize(&pdf, &job(A4, ResizeMode::Fit));
        assert!(leaf(&doc, 0).get(b"Contents").is_err());
        assert_eq!(read_nums(leaf(&doc, 0), b"MediaBox"), [0.0, 0.0, 595.276f32 as f64, 841.89f32 as f64]);
    }

    #[test]
    fn inherited_rotate_and_cropbox_are_neutralized() {
        let mut f = Fixture::new();
        f.page(Dictionary::new(), HELLO);
        let pdf = f.finish(dictionary! {
            "MediaBox" => nums(&LETTER), "CropBox" => nums(&[10.0, 10.0, 602.0, 782.0]), "Rotate" => 90,
        });
        let before = Document::load_mem(&pdf).unwrap();
        let parent_id = leaf(&before, 0).get(b"Parent").unwrap().as_reference().unwrap();
        let parent_before = before.get_dictionary(parent_id).unwrap().clone();

        let doc = resize(&pdf, &job(A4, ResizeMode::Fit));
        let page = leaf(&doc, 0);
        assert_eq!(page.get(b"Rotate").unwrap(), &Object::Integer(0));
        let sheet = [0.0, 0.0, 841.89f32 as f64, 595.276f32 as f64];
        assert_eq!(read_nums(page, b"MediaBox"), sheet);
        assert_eq!(read_nums(page, b"CropBox"), sheet);
        assert_eq!(doc.get_dictionary(parent_id).unwrap(), &parent_before);
        let vb = VisibleBox::of_page(&doc, pages(&doc)[0]);
        assert_eq!((vb.rotate, vb.x1 as f32, vb.y1 as f32), (0, 841.89, 595.276));
    }

    fn annotated(shared_with_second: bool) -> (Vec<u8>, ObjectId) {
        let mut f = Fixture::new();
        let annot = f.doc.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Ink",
            "Rect" => nums(&[100.0, 100.0, 200.0, 150.0]),
            "QuadPoints" => nums(&[100.0, 150.0, 200.0, 150.0, 100.0, 100.0, 200.0, 100.0]),
            "InkList" => vec![nums(&[100.0, 100.0, 200.0, 150.0])],
            "Vertices" => nums(&[100.0, 100.0, 200.0, 150.0]),
            "L" => nums(&[100.0, 100.0, 200.0, 150.0]),
        });
        f.page(dictionary! { "MediaBox" => nums(&LETTER), "Annots" => vec![annot.into()] }, HELLO);
        let second = if shared_with_second { vec![annot.into()] } else { vec![] };
        f.page(dictionary! { "MediaBox" => nums(&LETTER), "Annots" => second }, HELLO);
        (f.finish(Dictionary::new()), annot)
    }

    #[test]
    fn annotation_geometry_is_transformed() {
        let (pdf, annot) = annotated(false);
        let j = ResizeJob { pages: PageSelection::List(vec![1]), ..job([306.0, 396.0], ResizeMode::Fit) };
        // Half size: C = [0.5 0 0 0.5 0 0].
        let doc = resize(&pdf, &j);
        let annots = leaf(&doc, 0).get(b"Annots").unwrap().as_array().unwrap();
        assert_eq!(annots, &vec![Object::Reference(annot)], "an unshared annotation is edited in place");
        let a = doc.get_dictionary(annot).unwrap();
        assert_eq!(read_nums(a, b"Rect"), [50.0, 50.0, 100.0, 75.0]);
        assert_eq!(read_nums(a, b"QuadPoints"), [50.0, 75.0, 100.0, 75.0, 50.0, 50.0, 100.0, 50.0]);
        assert_eq!(read_nums(a, b"Vertices"), [50.0, 50.0, 100.0, 75.0]);
        assert_eq!(read_nums(a, b"L"), [50.0, 50.0, 100.0, 75.0]);
        let ink = a.get(b"InkList").unwrap().as_array().unwrap()[0].as_array().unwrap();
        let ink: Vec<f64> = ink.iter().map(|o| o.as_float().unwrap() as f64).collect();
        assert_eq!(ink, [50.0, 50.0, 100.0, 75.0]);
    }

    #[test]
    fn rotated_annotation_rect_is_the_bounding_box() {
        // Rotate 90 Letter on a Letter-landscape sheet [612 792] -> 792 x 612, s = 1:
        // C = inverse(V) = [0 -1 1 0 0 612]: (x, y) -> (y, 612 - x).
        // Rect corners (100, 100) .. (200, 150) -> x in [100, 150], y in [412, 512].
        let mut f = Fixture::new();
        let annot = f.doc.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Square", "Rect" => nums(&[100.0, 100.0, 200.0, 150.0]),
        });
        f.page(
            dictionary! { "MediaBox" => nums(&LETTER), "Rotate" => 90, "Annots" => vec![annot.into()] },
            HELLO,
        );
        let doc = resize(&f.finish(Dictionary::new()), &job([612.0, 792.0], ResizeMode::Fit));
        assert_eq!(read_nums(doc.get_dictionary(annot).unwrap(), b"Rect"), [100.0, 412.0, 150.0, 512.0]);
    }

    #[test]
    fn shared_annotation_is_copied_not_mutated() {
        let (pdf, annot) = annotated(true);
        let j = ResizeJob { pages: PageSelection::List(vec![1]), ..job([306.0, 396.0], ResizeMode::Fit) };
        let doc = resize(&pdf, &j);
        assert_eq!(read_nums(doc.get_dictionary(annot).unwrap(), b"Rect"), [100.0, 100.0, 200.0, 150.0]);
        let first = pages(&doc)[0];
        let annots = leaf(&doc, 0).get(b"Annots").unwrap().as_array().unwrap();
        let copy = annots[0].as_reference().unwrap();
        assert_ne!(copy, annot);
        let c = doc.get_dictionary(copy).unwrap();
        assert_eq!(read_nums(c, b"Rect"), [50.0, 50.0, 100.0, 75.0]);
        assert_eq!(c.get(b"P").unwrap(), &Object::Reference(first));
        let second = leaf(&doc, 1).get(b"Annots").unwrap().as_array().unwrap();
        assert_eq!(second, &vec![Object::Reference(annot)]);
    }

    #[test]
    fn text_stays_extractable() {
        let doc = resize(&letter(90), &job(A4, ResizeMode::Fit));
        assert!(doc.extract_text(&[1]).unwrap().contains("Hello"));
    }

    #[test]
    fn duplicate_page_object_is_wrapped_once() {
        let mut f = Fixture::new();
        let id = f.page(dictionary! { "MediaBox" => nums(&LETTER) }, HELLO);
        f.kids.push(id.into());
        let doc = resize(&f.finish(Dictionary::new()), &job(A4, ResizeMode::Fit));
        assert_eq!(streams(&doc, 0).len(), 3);
    }

    #[test]
    fn stray_restore_in_the_original_keeps_the_wrap_transform() {
        // "Q Q" pops two levels below its start: two extra `q` after `C cm`
        // absorb them, and the tail closes the remaining levels plus the wrap.
        let pdf = one_page(dictionary! { "MediaBox" => nums(&LETTER) }, "Q Q q");
        let doc = resize(&pdf, &job(A4, ResizeMode::Fit));
        let s = streams(&doc, 0);
        assert_eq!(s[0], "q 0.972673 0 0 0.972673 0 35.766412 cm\nq q\n");
        // Depth after the original: 2 extra q - 2 Q + 1 q = 1 open, then the wrap.
        assert_eq!(s.last().unwrap().matches('Q').count(), 2);
    }

    #[test]
    fn annotation_listed_twice_on_a_page_is_transformed_once() {
        let mut f = Fixture::new();
        let annot = f.doc.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Square", "Rect" => nums(&[100.0, 100.0, 200.0, 150.0]),
        });
        f.page(
            dictionary! { "MediaBox" => nums(&LETTER), "Annots" => vec![annot.into(), annot.into()] },
            HELLO,
        );
        let doc = resize(&f.finish(Dictionary::new()), &job([306.0, 396.0], ResizeMode::Fit));
        assert_eq!(read_nums(doc.get_dictionary(annot).unwrap(), b"Rect"), [50.0, 50.0, 100.0, 75.0]);
    }

    /// Bounding box of `bbox` under `m`.
    fn mapped_bbox(m: [f64; 6], b: [f64; 4]) -> [f64; 4] {
        let pts = [apply(m, b[0], b[1]), apply(m, b[2], b[1]), apply(m, b[0], b[3]), apply(m, b[2], b[3])];
        let xs = pts.map(|p| p.0);
        let ys = pts.map(|p| p.1);
        let lo = |v: [f64; 4]| v.into_iter().fold(f64::INFINITY, f64::min);
        let hi = |v: [f64; 4]| v.into_iter().fold(f64::NEG_INFINITY, f64::max);
        [lo(xs), lo(ys), hi(xs), hi(ys)]
    }

    fn appearance_matrix(doc: &Document, annot: &Dictionary) -> ([f64; 6], ObjectId) {
        let ap = annot.get(b"AP").unwrap().as_dict().unwrap();
        let id = ap.get(b"N").unwrap().as_reference().unwrap();
        let stream = doc.get_object(id).unwrap().as_stream().unwrap();
        let m = match stream.dict.get(b"Matrix") {
            Ok(_) => {
                let v = read_nums(&stream.dict, b"Matrix");
                [v[0], v[1], v[2], v[3], v[4], v[5]]
            }
            Err(_) => [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        };
        (m, id)
    }

    /// A rotated page with a 200 x 20 FreeText whose appearance stream is
    /// also used by an annotation on an unselected second page.
    fn rotated_free_text(flags: i64) -> (Vec<u8>, ObjectId, ObjectId) {
        let mut f = Fixture::new();
        let ap = f.doc.add_object(lopdf::Stream::new(
            dictionary! { "Type" => "XObject", "Subtype" => "Form", "BBox" => nums(&[0.0, 0.0, 200.0, 20.0]) },
            b"BT /F1 12 Tf 2 5 Td (Note) Tj ET".to_vec(),
        ));
        let annot = f.doc.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "FreeText", "F" => flags,
            "Rect" => nums(&[100.0, 100.0, 300.0, 120.0]),
            "AP" => dictionary! { "N" => ap, "D" => dictionary! { "On" => ap } },
        });
        let other = f.doc.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "FreeText",
            "Rect" => nums(&[100.0, 100.0, 300.0, 120.0]), "AP" => dictionary! { "N" => ap },
        });
        f.page(dictionary! { "MediaBox" => nums(&LETTER), "Rotate" => 90, "Annots" => vec![annot.into()] }, HELLO);
        f.page(dictionary! { "MediaBox" => nums(&LETTER), "Annots" => vec![other.into()] }, HELLO);
        (f.finish(Dictionary::new()), annot, ap)
    }

    #[test]
    fn rotated_appearance_is_turned_with_the_page() {
        let (pdf, annot, ap) = rotated_free_text(4);
        let j = ResizeJob { pages: PageSelection::List(vec![1]), ..job(A4, ResizeMode::Fit) };
        let doc = resize(&pdf, &j);
        let a = doc.get_dictionary(annot).unwrap();
        let rect = read_nums(a, b"Rect");
        let (m, id) = appearance_matrix(&doc, a);
        assert_ne!(id, ap, "the appearance stream is an owned copy");
        let b = mapped_bbox(m, [0.0, 0.0, 200.0, 20.0]);
        let aspect = |r: &[f64]| (r[2] - r[0]) / (r[3] - r[1]);
        assert!((aspect(&b) - aspect(&rect)).abs() < 1e-3, "{b:?} vs {rect:?}");
        assert!(aspect(&rect) < 1.0, "the 200 x 20 note stands upright on the turned sheet");
        // Per-state sub-dictionaries are handled too.
        let d = a.get(b"AP").unwrap().as_dict().unwrap().get(b"D").unwrap().as_dict().unwrap();
        assert_ne!(d.get(b"On").unwrap().as_reference().unwrap(), ap);
        // The shared original stream is untouched.
        let original = doc.get_object(ap).unwrap().as_stream().unwrap();
        assert!(original.dict.get(b"Matrix").is_err());
    }

    #[test]
    fn no_rotate_appearance_is_left_alone() {
        let (pdf, annot, ap) = rotated_free_text(4 | 16);
        let j = ResizeJob { pages: PageSelection::List(vec![1]), ..job(A4, ResizeMode::Fit) };
        let doc = resize(&pdf, &j);
        let (_, id) = appearance_matrix(&doc, doc.get_dictionary(annot).unwrap());
        assert_eq!(id, ap);
    }
}
