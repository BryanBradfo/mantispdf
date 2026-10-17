//! N-up: several source pages per output sheet. Each source page becomes a
//! Form XObject showing its visible box upright; sheets draw the forms into
//! a grid of cells. The output is a fresh document (catalog with /Pages,
//! plus /OCProperties for the layers copied): resources are copied through the rebuild copier, trimmed to the
//! names each page draws, so nothing a page does not show reaches it.
//! Annotations are not carried.

pub use super::resize::Orientation;
use super::resize::{MAX_MARGIN, MAX_SHEET, MIN_SHEET};
use super::{invalid, invert, number, page_map};
use crate::page_content::fmt_num;
use crate::pdf_util::{get_inherited_attr, load_pdf, save_pdf};
use crate::rebuild::{
    Decoded, MAX_STREAM_DECODED, SafeCopier, deref, optional_content, save_balance, scan_content,
    strict_content,
};
use crate::stamp::geometry::VisibleBox;
use lopdf::{Dictionary, Document, Object, ObjectId, Stream, dictionary};
use std::collections::HashMap;
use std::io::Write;

/// How cells are filled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Order {
    /// Left to right, then top to bottom.
    Rows,
    /// Top to bottom, then left to right.
    Columns,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Sheet {
    /// `[width, height]` in points, either orientation.
    Size([f64; 2]),
    /// The visible size of the first page.
    SameAsFirst,
}

#[derive(Debug, Clone)]
pub struct NupJob {
    pub per_sheet: u8,
    pub sheet: Sheet,
    /// Auto: landscape for 2 and 8 per sheet, portrait otherwise.
    pub orientation: Orientation,
    pub order: Order,
    /// Points kept free on every side of the sheet.
    pub margin: f64,
    /// Points between neighboring cells.
    pub gap: f64,
    /// Thin frame around each cell holding a page.
    pub border: bool,
}

#[derive(Debug, Clone)]
pub struct NupResult {
    pub bytes: Vec<u8>,
    pub sheets: u32,
    /// Source pages (1-based) whose content could not be decoded within the
    /// limits: their cells stay empty.
    pub undecodable_pages: Vec<u32>,
}

pub(crate) const PER_SHEET: [u8; 6] = [2, 4, 6, 8, 9, 16];

/// Decoded content bytes all pages of one job may produce together.
const MAX_JOB_DECODED: usize = 512 << 20;

/// (columns, rows) for `per_sheet` (one of `PER_SHEET`) on a portrait or
/// landscape sheet.
pub(crate) fn grid(per_sheet: u8, landscape: bool) -> (u32, u32) {
    let (c, r) = match per_sheet {
        2 => (1, 2),
        4 => (2, 2),
        6 => (2, 3),
        8 => (2, 4),
        9 => (3, 3),
        _ => (4, 4),
    };
    if landscape { (r, c) } else { (c, r) }
}

pub(crate) fn auto_landscape(per_sheet: u8) -> bool {
    matches!(per_sheet, 2 | 8)
}

/// Cell size on a `w` x `h` sheet (may be <= 0 when margin and gap leave no room).
fn cell_size(per_sheet: u8, (w, h): (f64, f64), margin: f64, gap: f64) -> (f64, f64) {
    let (c, r) = grid(per_sheet, w > h);
    let (c, r) = (c as f64, r as f64);
    ((w - 2.0 * margin - (c - 1.0) * gap) / c, (h - 2.0 * margin - (r - 1.0) * gap) / r)
}

/// `[x, y, w, h]` of every cell of a `w` x `h` sheet, in fill order (the
/// first at the top-left). Landscape grids are used when `w > h`.
pub(crate) fn cells(per_sheet: u8, (w, h): (f64, f64), order: Order, margin: f64, gap: f64) -> Vec<[f64; 4]> {
    let (c, r) = grid(per_sheet, w > h);
    let (cw, ch) = cell_size(per_sheet, (w, h), margin, gap);
    (0..c * r)
        .map(|i| {
            let (col, row) = match order {
                Order::Rows => (i % c, i / c),
                Order::Columns => (i / r, i % r),
            };
            let x = margin + col as f64 * (cw + gap);
            let top = h - margin - row as f64 * (ch + gap);
            [x, top - ch, cw, ch]
        })
        .collect()
}

pub fn nup(pdf: &[u8], job: &NupJob) -> Result<NupResult, String> {
    nup_with_budget(pdf, job, MAX_JOB_DECODED)
}

/// Sheet size `(w, h)` with orientation applied.
fn sheet_size(doc: &Document, pages: &[ObjectId], job: &NupJob) -> Result<(f64, f64), String> {
    let [w, h] = match job.sheet {
        Sheet::Size(size) => size,
        Sheet::SameAsFirst => {
            let first = pages.first().ok_or("The PDF has no pages")?;
            let vb = VisibleBox::of_page(doc, *first);
            [vb.width(), vb.height()]
        }
    };
    if ![w, h].iter().all(|v| v.is_finite() && (MIN_SHEET..=MAX_SHEET).contains(v)) {
        return Err(invalid("sheet"));
    }
    let (short, long) = (w.min(h), w.max(h));
    let landscape = match job.orientation {
        Orientation::Auto => auto_landscape(job.per_sheet),
        Orientation::Portrait => false,
        Orientation::Landscape => true,
    };
    Ok(if landscape { (long, short) } else { (short, long) })
}

fn validate(job: &NupJob) -> Result<(), String> {
    if !PER_SHEET.contains(&job.per_sheet) {
        return Err(invalid("per_sheet"));
    }
    let in_range = |v: f64| v.is_finite() && (0.0..=MAX_MARGIN).contains(&v);
    if !in_range(job.margin) {
        return Err(invalid("margin"));
    }
    if !in_range(job.gap) {
        return Err(invalid("gap"));
    }
    Ok(())
}

pub(crate) fn nup_with_budget(pdf: &[u8], job: &NupJob, budget: usize) -> Result<NupResult, String> {
    validate(job)?;
    let doc = load_pdf(pdf)?;
    let pages: Vec<ObjectId> = page_map(&doc).into_values().collect();
    if pages.is_empty() {
        return Err("The PDF has no pages".into());
    }
    let (sw, sh) = sheet_size(&doc, &pages, job)?;
    // The margin alone must leave room; then the gaps.
    if sw.min(sh) - 2.0 * job.margin <= 0.0 {
        return Err(invalid("margin"));
    }
    let (cw, ch) = cell_size(job.per_sheet, (sw, sh), job.margin, job.gap);
    if cw <= 0.0 || ch <= 0.0 {
        return Err(invalid("gap"));
    }
    let cell_rects = cells(job.per_sheet, (sw, sh), job.order, job.margin, job.gap);

    let version = if doc.version.as_str() > "1.7" { doc.version.clone() } else { "1.7".into() };
    let mut out = Document::with_version(version);
    let sources = [doc];
    let doc = &sources[0];
    let mut copier = SafeCopier::new(&sources, false);
    let mut budget = budget;
    let mut forms: HashMap<ObjectId, Option<(ObjectId, VisibleBox)>> = HashMap::new();
    let mut undecodable = Vec::new();
    let mut kids = Vec::new();

    for (sheet_index, chunk) in pages.chunks(job.per_sheet as usize).enumerate() {
        let mut content = Vec::new();
        let mut xobjects = Dictionary::new();
        for (i, &page) in chunk.iter().enumerate() {
            let number = (sheet_index * job.per_sheet as usize + i + 1) as u32;
            let [x, y, w, h] = cell_rects[i];
            let form = match forms.get(&page) {
                Some(known) => *known,
                None => {
                    let made = page_form(&mut out, &mut copier, doc, page, &mut budget);
                    forms.insert(page, made);
                    made
                }
            };
            let Some((form_id, vb)) = form else {
                undecodable.push(number);
                continue;
            };
            if job.border {
                let rect = [x, y, w, h].map(fmt_num).join(" ");
                content.extend(format!("q 0.5 w 0.6 G {rect} re S Q\n").into_bytes());
            }
            let (vw, vh) = (vb.width(), vb.height());
            let s = (w / vw).min(h / vh);
            let (dx, dy) = (x + (w - s * vw) / 2.0, y + (h - s * vh) / 2.0);
            let cm = [s, 0.0, 0.0, s, dx, dy].map(fmt_num).join(" ");
            content.extend(format!("q {cm} cm /Pg{number} Do Q\n").into_bytes());
            xobjects.set(format!("Pg{number}"), form_id);
        }
        let contents = out.add_object(flate_stream(Dictionary::new(), &content)?);
        let mut resources = Dictionary::new();
        if !xobjects.is_empty() {
            resources.set("XObject", xobjects);
        }
        kids.push(out.add_object(dictionary! {
            "Type" => "Page",
            "MediaBox" => vec![0.into(), 0.into(), number(sw), number(sh)],
            "Resources" => resources,
            "Contents" => contents,
        }));
    }

    let pages_id = out.new_object_id();
    for &id in &kids {
        if let Ok(dict) = out.get_dictionary_mut(id) {
            dict.set("Parent", pages_id);
        }
    }
    let sheets = kids.len() as u32;
    let kids: Vec<Object> = kids.into_iter().map(Object::Reference).collect();
    out.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => sheets as i64 }),
    );
    let mut catalog = dictionary! { "Type" => "Catalog", "Pages" => pages_id };
    // Layers hidden by default stay hidden (only the groups copied are listed).
    if let Some(oc) = optional_content(&copier, &sources) {
        catalog.set("OCProperties", oc);
    }
    let catalog = out.add_object(catalog);
    out.trailer.set("Root", catalog);
    let bytes = save_pdf(&mut out)?;
    Ok(NupResult { bytes, sheets, undecodable_pages: undecodable })
}

/// Page `page` as a Form XObject in `out`: its decoded content balanced
/// (a `q` before it for each stray `Q`, which would otherwise pop the state
/// `Do` saved and draw outside the cell; a `Q` after it for each open `q`),
/// resources trimmed to what that content draws, `/Matrix` taking user
/// space to the upright visible box at the origin. None when the content
/// cannot be decoded within the limits.
fn page_form(
    out: &mut Document,
    copier: &mut SafeCopier,
    doc: &Document,
    page: ObjectId,
    budget: &mut usize,
) -> Option<(ObjectId, VisibleBox)> {
    let decoded = decode_page(doc, page, budget)?;
    let (open, excess) = save_balance(&decoded).unwrap_or((0, 0));
    let mut content = "q ".repeat(excess).into_bytes();
    content.extend(decoded);
    content.extend("Q\n".repeat(open).into_bytes());

    let vb = VisibleBox::of_page(doc, page);
    let mut dict = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Form",
        "BBox" => vec![number(vb.x0), number(vb.y0), number(vb.x1), number(vb.y1)],
        "Matrix" => invert(vb.matrix()).iter().map(|&v| number(v)).collect::<Vec<_>>(),
    };
    let resources = get_inherited_attr(doc, page, b"Resources");
    if let Some(res) = resources.as_ref().and_then(|r| deref(doc, r)).and_then(|r| r.as_dict().ok()) {
        // Unparsable content keeps every resource (as a rebuild does).
        let used = scan_content(&content);
        dict.set("Resources", copier.copy_resources(out, 0, res, used.as_ref()));
    }
    // A transparency group keeps blending as on the page.
    if let Ok(group) = doc.get_dictionary(page).and_then(|p| p.get(b"Group")) {
        dict.set("Group", copier.copy(out, 0, group));
    }
    let stream = flate_stream(dict, &content).ok()?;
    Some((out.add_object(stream), vb))
}

/// The page's content streams decoded and joined with newlines (so an
/// operator split across streams stays valid). None when a stream exceeds
/// `MAX_STREAM_DECODED` or what is left of `budget`, or cannot be decoded.
fn decode_page(doc: &Document, page: ObjectId, budget: &mut usize) -> Option<Vec<u8>> {
    let mut joined = Vec::new();
    for id in doc.get_page_contents(page) {
        let Ok(stream) = doc.get_object(id).and_then(Object::as_stream) else {
            continue;
        };
        let mut charged = 0;
        let decoded = strict_content(stream, MAX_STREAM_DECODED.min(*budget), &mut charged);
        *budget = budget.saturating_sub(charged);
        let Decoded::Content(decoded) = decoded else {
            return None;
        };
        joined.extend(decoded);
        joined.push(b'\n');
    }
    Some(joined)
}

/// A stream holding `content` Flate-encoded.
fn flate_stream(mut dict: Dictionary, content: &[u8]) -> Result<Stream, String> {
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    encoder
        .write_all(content)
        .and_then(|_| encoder.finish())
        .map(|bytes| {
            dict.set("Filter", "FlateDecode");
            Stream::new(dict, bytes).with_compression(false)
        })
        .map_err(|e| format!("Failed to compress content: {e}"))
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry_ops::fixture::{Fixture, nums, read_nums};
    use crate::geometry_ops::{apply, concat};
    use lopdf::content::Content;
    use lopdf::{Dictionary, Document, Object, ObjectId, Stream, dictionary};

    const LETTER: [f64; 4] = [0.0, 0.0, 612.0, 792.0];
    const A4: [f64; 2] = [595.276, 841.89];

    fn job(per_sheet: u8) -> NupJob {
        NupJob {
            per_sheet,
            sheet: Sheet::Size(A4),
            orientation: Orientation::Auto,
            order: Order::Rows,
            margin: 0.0,
            gap: 0.0,
            border: false,
        }
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-3
    }

    fn close_all(a: &[f64], b: &[f64]) -> bool {
        a.len() == b.len() && a.iter().zip(b).all(|(x, y)| close(*x, *y))
    }

    /// `n` Letter pages; page k shows the text `Page k`.
    fn letters(n: usize) -> Vec<u8> {
        let mut f = Fixture::new();
        for k in 1..=n {
            f.page(
                dictionary! { "MediaBox" => nums(&LETTER) },
                &format!("BT /F1 12 Tf 72 700 Td (Page {k}) Tj ET"),
            );
        }
        f.finish(Dictionary::new())
    }

    fn run(pdf: &[u8], job: &NupJob) -> (Document, NupResult) {
        let result = nup(pdf, job).unwrap();
        (Document::load_mem(&result.bytes).unwrap(), result)
    }

    fn sheet_ids(doc: &Document) -> Vec<ObjectId> {
        doc.get_pages().values().copied().collect()
    }

    /// Operations of sheet `n`'s content.
    fn sheet_ops(doc: &Document, n: usize) -> Vec<(String, Vec<Object>)> {
        let content = doc.get_page_content(sheet_ids(doc)[n]).unwrap();
        Content::decode(&content)
            .unwrap()
            .operations
            .into_iter()
            .map(|op| (op.operator, op.operands))
            .collect()
    }

    fn floats(operands: &[Object]) -> Vec<f64> {
        operands.iter().map(|o| o.as_float().unwrap() as f64).collect()
    }

    /// (XObject name, cm matrix) of every page drawn on sheet `n`, in order.
    fn placements(doc: &Document, n: usize) -> Vec<(String, Vec<f64>)> {
        let ops = sheet_ops(doc, n);
        let mut out = vec![];
        let mut cm = vec![];
        for (op, operands) in ops {
            match op.as_str() {
                "cm" => cm = floats(&operands),
                "Do" => {
                    let name = String::from_utf8(operands[0].as_name().unwrap().to_vec()).unwrap();
                    out.push((name, cm.clone()));
                }
                _ => {}
            }
        }
        out
    }

    /// The form XObject `name` in sheet `n`'s resources.
    fn form<'a>(doc: &'a Document, n: usize, name: &str) -> &'a Stream {
        let page = doc.get_dictionary(sheet_ids(doc)[n]).unwrap();
        let res = page.get(b"Resources").unwrap().as_dict().unwrap();
        let xobjects = res.get(b"XObject").unwrap().as_dict().unwrap();
        let id = xobjects.get(name.as_bytes()).unwrap().as_reference().unwrap();
        doc.get_object(id).unwrap().as_stream().unwrap()
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack.windows(needle.len()).any(|w| w == needle)
    }

    // ---- layout math ----

    #[test]
    fn grid_per_sheet_and_orientation() {
        let table = [(2, (1, 2)), (4, (2, 2)), (6, (2, 3)), (8, (2, 4)), (9, (3, 3)), (16, (4, 4))];
        for (n, (c, r)) in table {
            assert_eq!(grid(n, false), (c, r), "{n} portrait");
            assert_eq!(grid(n, true), (r, c), "{n} landscape");
        }
        for n in [2, 8] {
            assert!(auto_landscape(n));
        }
        for n in [4, 6, 9, 16] {
            assert!(!auto_landscape(n));
        }
    }

    #[test]
    fn cell_rects_table() {
        // 400 x 600 portrait sheet, 10 pt margin, 20 pt gap.
        let (w, h, m, g) = (400.0, 600.0, 10.0, 20.0);
        // 4-up rows: cells 180 x 280.
        let rows = cells(4, (w, h), Order::Rows, m, g);
        let expect = [
            [10.0, 310.0, 180.0, 280.0],
            [210.0, 310.0, 180.0, 280.0],
            [10.0, 10.0, 180.0, 280.0],
            [210.0, 10.0, 180.0, 280.0],
        ];
        for (got, want) in rows.iter().zip(expect) {
            assert!(close_all(got, &want), "{got:?} != {want:?}");
        }
        // 4-up columns: down first.
        let cols = cells(4, (w, h), Order::Columns, m, g);
        for (i, want) in [0, 2, 1, 3].into_iter().enumerate() {
            assert!(close_all(&cols[i], &expect[want]));
        }
        // 6-up rows on the landscape sheet: 3 columns x 2 rows of 113.33 x 180.
        let six = cells(6, (h, w), Order::Rows, m, g);
        let cw = (600.0 - 20.0 - 40.0) / 3.0;
        assert!(close_all(&six[0], &[10.0, 210.0, cw, 180.0]));
        assert!(close_all(&six[2], &[10.0 + 2.0 * (cw + 20.0), 210.0, cw, 180.0]));
        assert!(close_all(&six[3], &[10.0, 10.0, cw, 180.0]));
        // 2-up landscape: two side by side.
        let two = cells(2, (h, w), Order::Rows, 0.0, 0.0);
        assert!(close_all(&two[0], &[0.0, 0.0, 300.0, 400.0]));
        assert!(close_all(&two[1], &[300.0, 0.0, 300.0, 400.0]));
    }

    #[test]
    fn cell_layout_every_combination() {
        for n in PER_SHEET {
            for landscape in [false, true] {
                for order in [Order::Rows, Order::Columns] {
                    let (w, h) = if landscape { (842.0, 595.0) } else { (595.0, 842.0) };
                    let (m, g) = (28.35, 14.17);
                    let (c, r) = grid(n, landscape);
                    let list = cells(n, (w, h), order, m, g);
                    assert_eq!(list.len(), n as usize);
                    let (cw, ch) = ((w - 2.0 * m - (c as f64 - 1.0) * g) / c as f64, (h - 2.0 * m - (r as f64 - 1.0) * g) / r as f64);
                    // First cell at the top-left corner inside the margin.
                    assert!(close_all(&list[0], &[m, h - m - ch, cw, ch]), "{n} {landscape} {order:?}");
                    for (i, rect) in list.iter().enumerate() {
                        let (col, row) = match order {
                            Order::Rows => (i as u32 % c, i as u32 / c),
                            Order::Columns => (i as u32 / r, i as u32 % r),
                        };
                        let want = [m + col as f64 * (cw + g), h - m - ch - row as f64 * (ch + g), cw, ch];
                        assert!(close_all(rect, &want), "{n} {landscape} {order:?} cell {i}");
                        assert!(rect[0] >= m - 1e-6 && rect[0] + rect[2] <= w - m + 1e-6);
                        assert!(rect[1] >= m - 1e-6 && rect[1] + rect[3] <= h - m + 1e-6);
                    }
                }
            }
        }
    }

    // ---- validation ----

    #[test]
    fn rejects_bad_settings() {
        let pdf = letters(2);
        let err = |j: NupJob| nup(&pdf, &j).err().unwrap();
        assert_eq!(err(NupJob { per_sheet: 3, ..job(4) }), "Invalid geometry settings: per_sheet");
        assert_eq!(err(NupJob { sheet: Sheet::Size([10.0, 800.0]), ..job(4) }), "Invalid geometry settings: sheet");
        assert_eq!(err(NupJob { sheet: Sheet::Size([f64::NAN, 800.0]), ..job(4) }), "Invalid geometry settings: sheet");
        assert_eq!(err(NupJob { margin: -1.0, ..job(4) }), "Invalid geometry settings: margin");
        assert_eq!(err(NupJob { margin: 600.0, ..job(4) }), "Invalid geometry settings: margin");
        assert_eq!(err(NupJob { gap: f64::INFINITY, ..job(4) }), "Invalid geometry settings: gap");
        // Margins and gaps that leave no room for a cell.
        assert_eq!(err(NupJob { margin: 300.0, ..job(4) }), "Invalid geometry settings: margin");
        assert_eq!(err(NupJob { per_sheet: 16, margin: 200.0, gap: 100.0, ..job(4) }), "Invalid geometry settings: gap");
    }

    // ---- documents ----

    #[test]
    fn five_pages_four_up_make_two_sheets() {
        let (doc, result) = run(&letters(5), &job(4));
        assert_eq!(result.sheets, 2);
        assert!(result.undecodable_pages.is_empty());
        assert_eq!(sheet_ids(&doc).len(), 2);
        let first = placements(&doc, 0);
        let names: Vec<&str> = first.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, ["Pg1", "Pg2", "Pg3", "Pg4"]);
        let second = placements(&doc, 1);
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].0, "Pg5");
        // Sheet is A4 portrait, the fresh catalog holds only /Type and /Pages.
        let sheet = doc.get_dictionary(sheet_ids(&doc)[0]).unwrap();
        assert!(close_all(&read_nums(sheet, b"MediaBox"), &[0.0, 0.0, A4[0], A4[1]]));
        let catalog = doc.catalog().unwrap();
        let mut keys: Vec<&[u8]> = catalog.iter().map(|(k, _)| k.as_slice()).collect();
        keys.sort();
        assert_eq!(keys, [&b"Pages"[..], b"Type"]);
        // Page 5 sits in the top-left cell of sheet 2, like page 1 on sheet 1.
        assert_eq!(first[0].1, second[0].1);
    }

    #[test]
    fn auto_two_up_is_landscape_and_explicit_orientation_wins() {
        let (doc, _) = run(&letters(2), &job(2));
        let sheet = doc.get_dictionary(sheet_ids(&doc)[0]).unwrap();
        assert!(close_all(&read_nums(sheet, b"MediaBox"), &[0.0, 0.0, A4[1], A4[0]]));
        let j = NupJob { orientation: Orientation::Portrait, ..job(2) };
        let (doc, _) = run(&letters(2), &j);
        let sheet = doc.get_dictionary(sheet_ids(&doc)[0]).unwrap();
        assert!(close_all(&read_nums(sheet, b"MediaBox"), &[0.0, 0.0, A4[0], A4[1]]));
        // A landscape-given size is normalized first.
        let j = NupJob { sheet: Sheet::Size([A4[1], A4[0]]), orientation: Orientation::Portrait, ..job(4) };
        let (doc, _) = run(&letters(2), &j);
        let sheet = doc.get_dictionary(sheet_ids(&doc)[0]).unwrap();
        assert!(close_all(&read_nums(sheet, b"MediaBox"), &[0.0, 0.0, A4[0], A4[1]]));
    }

    #[test]
    fn same_as_first_takes_the_first_visible_page() {
        let mut f = Fixture::new();
        f.page(dictionary! { "MediaBox" => nums(&[0.0, 0.0, 300.0, 500.0]) }, "0 0 m");
        f.page(dictionary! { "MediaBox" => nums(&LETTER) }, "0 0 m");
        let pdf = f.finish(Dictionary::new());
        let j = NupJob { sheet: Sheet::SameAsFirst, ..job(4) };
        let (doc, _) = run(&pdf, &j);
        let sheet = doc.get_dictionary(sheet_ids(&doc)[0]).unwrap();
        assert!(close_all(&read_nums(sheet, b"MediaBox"), &[0.0, 0.0, 300.0, 500.0]));
    }

    /// For each rotation, the form shows the visible page upright in
    /// [0, vw] x [0, vh]: its Matrix maps the user-space point of each
    /// visible corner back to that corner, and its BBox to the full cell.
    #[test]
    fn rotated_pages_are_upright() {
        let media = [10.0, 20.0, 610.0, 820.0];
        for rotate in [0, 90, 180, 270] {
            let mut f = Fixture::new();
            f.page(dictionary! { "MediaBox" => nums(&media), "Rotate" => rotate }, "0 0 m");
            let pdf = f.finish(Dictionary::new());
            let src = Document::load_mem(&pdf).unwrap();
            let vb = VisibleBox::of_page(&src, crate::geometry_ops::fixture::pages(&src)[0]);
            let (vw, vh) = (vb.width(), vb.height());
            let (doc, _) = run(&pdf, &job(4));
            let fm = form(&doc, 0, "Pg1");
            let m: [f64; 6] = read_nums(&fm.dict, b"Matrix").try_into().unwrap();
            for (vx, vy) in [(0.0, 0.0), (vw, 0.0), (0.0, vh), (vw, vh), (100.0, 50.0)] {
                let (ux, uy) = vb.to_user(vx, vy);
                let (x, y) = apply(m, ux, uy);
                assert!(close(x, vx) && close(y, vy), "rotate {rotate}: ({vx},{vy}) -> ({x},{y})");
            }
            // The BBox (form space) covers exactly the visible rectangle.
            let bbox = read_nums(&fm.dict, b"BBox");
            let corners = [(bbox[0], bbox[1]), (bbox[2], bbox[1]), (bbox[0], bbox[3]), (bbox[2], bbox[3])];
            let mapped: Vec<(f64, f64)> = corners.iter().map(|&(x, y)| apply(m, x, y)).collect();
            let xs: Vec<f64> = mapped.iter().map(|p| p.0).collect();
            let ys: Vec<f64> = mapped.iter().map(|p| p.1).collect();
            let min = |v: &[f64]| v.iter().cloned().fold(f64::INFINITY, f64::min);
            let max = |v: &[f64]| v.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
            assert!(close_all(&[min(&xs), min(&ys), max(&xs), max(&ys)], &[0.0, 0.0, vw, vh]), "rotate {rotate}");
            // On the sheet: the visible top-left corner lands on the top-left
            // of the scaled page inside cell 0 (top-left of the sheet).
            let cm: [f64; 6] = placements(&doc, 0)[0].1.clone().try_into().unwrap();
            let full = concat(m, cm);
            let (ux, uy) = vb.to_user(0.0, vh);
            let (x, y) = apply(full, ux, uy);
            let (cw, ch) = (A4[0] / 2.0, A4[1] / 2.0);
            let s = (cw / vw).min(ch / vh);
            let left = (cw - s * vw) / 2.0;
            let top = A4[1] - (ch - s * vh) / 2.0;
            assert!(close(x, left) && close(y, top), "rotate {rotate}: ({x},{y}) vs ({left},{top})");
        }
    }

    #[test]
    fn different_sizes_are_scaled_and_centered() {
        let mut f = Fixture::new();
        f.page(dictionary! { "MediaBox" => nums(&LETTER) }, "0 0 m");
        f.page(dictionary! { "MediaBox" => nums(&[0.0, 0.0, 300.0, 300.0]) }, "0 0 m");
        let pdf = f.finish(Dictionary::new());
        let j = NupJob { margin: 10.0, gap: 20.0, ..job(4) };
        let (doc, _) = run(&pdf, &j);
        let cell = cells(4, (A4[0], A4[1]), Order::Rows, 10.0, 20.0);
        let placed = placements(&doc, 0);
        for (i, (vw, vh)) in [(612.0, 792.0), (300.0, 300.0)].into_iter().enumerate() {
            let [x, y, cw, ch] = cell[i];
            let s = (cw / vw).min(ch / vh);
            let want = [s, 0.0, 0.0, s, x + (cw - s * vw) / 2.0, y + (ch - s * vh) / 2.0];
            assert!(close_all(&placed[i].1, &want), "page {}: {:?} vs {want:?}", i + 1, placed[i].1);
        }
    }

    #[test]
    fn border_draws_each_cell() {
        let j = NupJob { border: true, margin: 10.0, gap: 20.0, ..job(4) };
        let (doc, _) = run(&letters(3), &j);
        let ops = sheet_ops(&doc, 0);
        let rects: Vec<Vec<f64>> = ops.iter().filter(|(o, _)| o == "re").map(|(_, a)| floats(a)).collect();
        let cell = cells(4, (A4[0], A4[1]), Order::Rows, 10.0, 20.0);
        assert_eq!(rects.len(), 3);
        for (got, want) in rects.iter().zip(&cell) {
            assert!(close_all(got, want));
        }
        assert!(ops.iter().any(|(o, a)| o == "w" && close(floats(a)[0], 0.5)));
        assert!(ops.iter().any(|(o, a)| o == "G" && close(floats(a)[0], 0.6)));
        let (doc, _) = run(&letters(3), &job(4));
        assert!(!sheet_ops(&doc, 0).iter().any(|(o, _)| o == "re"));
    }

    /// One shared /Resources on /Pages: Im_secret is never drawn by any
    /// page, Im_used is. Neither the unused image nor annotations nor the
    /// document info reach the output.
    #[test]
    fn unused_shared_resources_never_reach_the_output() {
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let image = |doc: &mut Document, payload: &[u8]| {
            doc.add_object(Stream::new(
                dictionary! {
                    "Type" => "XObject", "Subtype" => "Image", "Width" => payload.len() as i64,
                    "Height" => 1, "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8,
                },
                payload.to_vec(),
            ))
        };
        let used = image(&mut doc, b"USEDIMG");
        let secret = image(&mut doc, b"SECRET_IMG");
        let font = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica" });
        let resources = doc.add_object(dictionary! {
            "Font" => dictionary! { "F1" => font },
            "XObject" => dictionary! { "Im_used" => used, "Im_secret" => secret },
        });
        let annot = doc.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Text", "Rect" => nums(&[0.0, 0.0, 10.0, 10.0]),
            "Contents" => Object::string_literal("SECRET_ANNOT"),
        });
        let c1 = doc.add_object(Stream::new(Dictionary::new(), b"q 10 0 0 10 0 0 cm /Im_used Do Q".to_vec()));
        let c2 = doc.add_object(Stream::new(Dictionary::new(), b"BT /F1 12 Tf (two) Tj ET".to_vec()));
        let p1 = doc.add_object(dictionary! { "Type" => "Page", "Parent" => pages_id, "Contents" => c1, "Annots" => vec![annot.into()] });
        let p2 = doc.add_object(dictionary! { "Type" => "Page", "Parent" => pages_id, "Contents" => c2 });
        doc.objects.insert(pages_id, Object::Dictionary(dictionary! {
            "Type" => "Pages", "Kids" => vec![p1.into(), p2.into()], "Count" => 2,
            "Resources" => resources, "MediaBox" => nums(&LETTER),
        }));
        let info = doc.add_object(dictionary! { "Title" => Object::string_literal("SECRET_INFO") });
        let cat = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id, "Names" => dictionary! { "X" => Object::string_literal("SECRET_NAMES") } });
        doc.trailer.set("Root", cat);
        doc.trailer.set("Info", info);
        let mut pdf = Vec::new();
        doc.save_to(&mut pdf).unwrap();

        let result = nup(&pdf, &job(2)).unwrap();
        for secret in ["SECRET_IMG", "SECRET_ANNOT", "SECRET_INFO", "SECRET_NAMES"] {
            assert!(!contains(&result.bytes, secret.as_bytes()), "{secret} leaked");
        }
        assert!(contains(&result.bytes, b"USEDIMG"));
        // Page 2's form keeps the font it draws with, and nothing else.
        let out = Document::load_mem(&result.bytes).unwrap();
        let res = form(&out, 0, "Pg2").dict.get(b"Resources").unwrap().as_dict().unwrap();
        assert!(res.get(b"Font").is_ok());
        assert!(res.get(b"XObject").is_err());
    }

    #[test]
    fn undecodable_page_is_reported_and_others_drawn() {
        let mut f = Fixture::new();
        f.page(dictionary! { "MediaBox" => nums(&LETTER) }, "BT /F1 12 Tf (one) Tj ET");
        let bogus = f.doc.add_object(Stream::new(
            dictionary! { "Filter" => "FlateDecode" },
            b"this is not zlib data at all".to_vec(),
        ));
        f.page(dictionary! { "MediaBox" => nums(&LETTER), "Contents" => bogus }, "");
        f.page(dictionary! { "MediaBox" => nums(&LETTER) }, "BT /F1 12 Tf (three) Tj ET");
        let pdf = f.finish(Dictionary::new());
        let (doc, result) = run(&pdf, &job(4));
        assert_eq!(result.undecodable_pages, vec![2]);
        assert_eq!(result.sheets, 1);
        let names: Vec<String> = placements(&doc, 0).into_iter().map(|(n, _)| n).collect();
        assert_eq!(names, ["Pg1", "Pg3"]);
        // Page 3 keeps its cell (the third one).
        let cell = cells(4, (A4[0], A4[1]), Order::Rows, 0.0, 0.0);
        let cm = &placements(&doc, 0)[1].1;
        assert!(cm[4] >= cell[2][0] - 1e-6 && cm[5] >= cell[2][1] - 1e-6 && cm[5] < cell[0][1]);
    }

    #[test]
    fn decode_budget_exhausted_reports_the_rest() {
        // Room for page 1's content only.
        let budget = "BT /F1 12 Tf 72 700 Td (Page 1) Tj ET".len() + 1;
        let result = nup_with_budget(&letters(3), &job(4), budget).unwrap();
        assert_eq!(result.undecodable_pages, vec![2, 3]);
    }

    #[test]
    fn unbalanced_q_is_closed_inside_the_form() {
        let mut f = Fixture::new();
        f.page(dictionary! { "MediaBox" => nums(&LETTER) }, "q q 1 0 0 1 5 5 cm 0 0 m");
        let pdf = f.finish(Dictionary::new());
        let (doc, _) = run(&pdf, &job(4));
        let content = form(&doc, 0, "Pg1").decompressed_content().unwrap();
        let ops = Content::decode(&content).unwrap().operations;
        let q = ops.iter().filter(|o| o.operator == "q").count();
        let big_q = ops.iter().filter(|o| o.operator == "Q").count();
        assert_eq!((q, big_q), (2, 2));
        assert_eq!(form(&doc, 0, "Pg1").dict.get(b"Filter").unwrap().as_name().unwrap(), b"FlateDecode");
    }

    /// Depth of `q` nesting after each operation; never below zero when
    /// the content is balanced from its start.
    fn depths(content: &[u8]) -> Vec<i64> {
        let mut depth = 0;
        Content::decode(content)
            .unwrap()
            .operations
            .iter()
            .map(|o| {
                match o.operator.as_str() {
                    "q" => depth += 1,
                    "Q" => depth -= 1,
                    _ => {}
                }
                depth
            })
            .collect()
    }

    #[test]
    fn stray_q_cannot_escape_the_form() {
        let mut f = Fixture::new();
        f.page(dictionary! { "MediaBox" => nums(&LETTER) }, "Q Q 0 0 m q 1 0 0 1 5 5 cm");
        let pdf = f.finish(Dictionary::new());
        let (doc, _) = run(&pdf, &job(4));
        let content = form(&doc, 0, "Pg1").decompressed_content().unwrap();
        let d = depths(&content);
        assert!(d.iter().all(|&x| x >= 0), "{d:?} in {:?}", String::from_utf8_lossy(&content));
        assert_eq!(*d.last().unwrap(), 0);
    }

    fn zlib(data: &[u8]) -> Vec<u8> {
        let mut e = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        e.write_all(data).unwrap();
        e.finish().unwrap()
    }

    #[test]
    fn empty_compressed_content_is_a_blank_cell() {
        let mut f = Fixture::new();
        let empty = f.doc.add_object(Stream::new(dictionary! { "Filter" => "FlateDecode" }, zlib(b"")));
        f.page(dictionary! { "MediaBox" => nums(&LETTER), "Contents" => empty }, "");
        f.page(dictionary! { "MediaBox" => nums(&LETTER) }, "0 0 m");
        let pdf = f.finish(Dictionary::new());
        let (doc, result) = run(&pdf, &job(4));
        assert!(result.undecodable_pages.is_empty());
        let names: Vec<String> = placements(&doc, 0).into_iter().map(|(n, _)| n).collect();
        assert_eq!(names, ["Pg1", "Pg2"]);
    }

    #[test]
    fn operators_split_across_content_streams_stay_valid() {
        let mut f = Fixture::new();
        let a = f.doc.add_object(Stream::new(Dictionary::new(), b"0 0 m".to_vec()));
        let b = f.doc.add_object(Stream::new(dictionary! { "Filter" => "FlateDecode" }, zlib(b"100 100 l S")));
        f.page(dictionary! { "MediaBox" => nums(&LETTER), "Contents" => vec![a.into(), b.into()] }, "");
        let pdf = f.finish(Dictionary::new());
        let (doc, result) = run(&pdf, &job(4));
        assert!(result.undecodable_pages.is_empty());
        let content = form(&doc, 0, "Pg1").decompressed_content().unwrap();
        let ops: Vec<(String, Vec<f64>)> = Content::decode(&content)
            .unwrap()
            .operations
            .into_iter()
            .map(|o| (o.operator, floats(&o.operands)))
            .collect();
        assert_eq!(
            ops,
            [("m".to_string(), vec![0.0, 0.0]), ("l".to_string(), vec![100.0, 100.0]), ("S".to_string(), vec![])]
        );
    }

    #[test]
    fn undecodable_cell_has_no_border() {
        let mut f = Fixture::new();
        let bogus = f.doc.add_object(Stream::new(dictionary! { "Filter" => "FlateDecode" }, b"not zlib".to_vec()));
        f.page(dictionary! { "MediaBox" => nums(&LETTER), "Contents" => bogus }, "");
        f.page(dictionary! { "MediaBox" => nums(&LETTER) }, "0 0 m");
        let pdf = f.finish(Dictionary::new());
        let (doc, result) = run(&pdf, &NupJob { border: true, ..job(4) });
        assert_eq!(result.undecodable_pages, vec![1]);
        let rects: Vec<Vec<f64>> =
            sheet_ops(&doc, 0).into_iter().filter(|(o, _)| o == "re").map(|(_, a)| floats(&a)).collect();
        let cell = cells(4, (A4[0], A4[1]), Order::Rows, 0.0, 0.0);
        assert_eq!(rects.len(), 1);
        assert!(close_all(&rects[0], &cell[1]));
    }

    /// lopdf's extract_text does not follow `Do`, so each form is checked
    /// as a page of its own: its content with its resources.
    #[test]
    fn source_text_is_extractable_from_the_forms() {
        let (mut doc, _) = run(&letters(4), &job(4));
        let sheet = sheet_ids(&doc)[0];
        let forms: Vec<Stream> = (1..=4).map(|k| form(&doc, 0, &format!("Pg{k}")).clone()).collect();
        for (k, fm) in (1..=4).zip(forms) {
            let content = fm.decompressed_content().unwrap();
            let res = fm.dict.get(b"Resources").unwrap().clone();
            let c = doc.add_object(Stream::new(Dictionary::new(), content));
            let page = doc.get_dictionary_mut(sheet).unwrap();
            page.set("Contents", c);
            page.set("Resources", res);
            let text = doc.extract_text(&[1]).unwrap();
            assert!(text.contains(&format!("Page {k}")), "{text:?}");
        }
    }

    #[test]
    fn page_listed_twice_draws_twice_with_one_form() {
        let mut f = Fixture::new();
        let p = f.page(dictionary! { "MediaBox" => nums(&LETTER) }, "BT /F1 12 Tf (x) Tj ET");
        f.kids.push(p.into());
        let pdf = f.finish(Dictionary::new());
        let (doc, result) = run(&pdf, &job(4));
        assert_eq!(result.sheets, 1);
        let page = doc.get_dictionary(sheet_ids(&doc)[0]).unwrap();
        let xo = page.get(b"Resources").unwrap().as_dict().unwrap().get(b"XObject").unwrap().as_dict().unwrap();
        assert_eq!(xo.get(b"Pg1").unwrap(), xo.get(b"Pg2").unwrap());
    }

    /// A layer hidden by default stays hidden: the catalog keeps an
    /// /OCProperties listing only the groups the sheets draw, with the hidden
    /// one under /D /OFF. A group no page uses does not reach the output.
    #[test]
    fn hidden_optional_content_stays_hidden() {
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let ocg = |doc: &mut Document, name: &str| {
            doc.add_object(dictionary! { "Type" => "OCG", "Name" => Object::string_literal(name) })
        };
        let hidden = ocg(&mut doc, "Hidden");
        let shown = ocg(&mut doc, "Shown");
        let other = ocg(&mut doc, "SECRET_OTHERLAYER");
        let content = b"/OC /oc1 BDC 0 0 10 10 re f EMC /OC /oc2 BDC 0 0 5 5 re f EMC".to_vec();
        let c1 = doc.add_object(Stream::new(Dictionary::new(), content));
        let p1 = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id, "Contents" => c1, "MediaBox" => nums(&LETTER),
            "Resources" => dictionary! { "Properties" => dictionary! { "oc1" => hidden, "oc2" => shown, "oc3" => other } },
        });
        doc.objects.insert(pages_id, Object::Dictionary(dictionary! {
            "Type" => "Pages", "Kids" => vec![p1.into()], "Count" => 1,
        }));
        let refs = |ids: &[ObjectId]| -> Object { ids.iter().map(|&id| Object::Reference(id)).collect::<Vec<_>>().into() };
        let cat = doc.add_object(dictionary! {
            "Type" => "Catalog", "Pages" => pages_id,
            "OCProperties" => dictionary! {
                "OCGs" => refs(&[hidden, shown, other]),
                "D" => dictionary! { "OFF" => refs(&[hidden, other]), "Order" => refs(&[hidden, shown, other]) },
            },
        });
        doc.trailer.set("Root", cat);
        let mut pdf = Vec::new();
        doc.save_to(&mut pdf).unwrap();

        let (out, result) = run(&pdf, &job(2));
        assert!(!contains(&result.bytes, b"SECRET_OTHERLAYER"), "unused layer leaked");
        let props = form(&out, 0, "Pg1").dict.get(b"Resources").unwrap().as_dict().unwrap();
        let props = props.get(b"Properties").unwrap().as_dict().unwrap();
        let new_hidden = props.get(b"oc1").unwrap().as_reference().unwrap();
        let new_shown = props.get(b"oc2").unwrap().as_reference().unwrap();
        let oc = out
            .catalog()
            .unwrap()
            .get(b"OCProperties")
            .expect("/OCProperties dropped: the hidden layer would show");
        let oc = match oc {
            Object::Reference(id) => out.get_dictionary(*id).unwrap(),
            other => other.as_dict().unwrap(),
        };
        let ids = |obj: &Object| -> Vec<ObjectId> {
            obj.as_array().unwrap().iter().filter_map(|o| o.as_reference().ok()).collect()
        };
        assert_eq!(ids(oc.get(b"OCGs").unwrap()), vec![new_hidden, new_shown]);
        let d = oc.get(b"D").unwrap().as_dict().unwrap();
        assert_eq!(ids(d.get(b"OFF").unwrap()), vec![new_hidden]);
    }
}
