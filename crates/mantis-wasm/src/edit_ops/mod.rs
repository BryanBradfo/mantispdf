//! Edit PDF engine: text boxes, images, shapes, lines and arrows,
//! highlights, freehand drawing and whiteout, baked into page content on top
//! of what is there. Items are positioned in visible page space (see
//! `stamp::geometry`) and painted in job order.

pub(crate) mod binding;
pub(crate) mod draw;
pub(crate) mod job;
pub(crate) mod text;
pub(crate) mod unitext;

use crate::page_content::fmt_num;
use crate::pdf_util::{load_pdf, save_pdf};
use crate::stamp::engine::{ImageData, MAX_COORD, MAX_TOTAL_PIXELS, add_image};
use crate::stamp::fonts::StdFont;
use crate::stamp::geometry::VisibleBox;
use crate::stamp::image::{BuiltImage, build_image};
use crate::stamp::page_writer::{Blend, DocWriter, escape_literal, lossy};
use crate::unifont::{Embedder, Face, MAX_FONTS, ShapeBudget, load_faces};
use lopdf::ObjectId;
use std::collections::HashMap;
use std::sync::Arc;

/// Items per job.
pub(crate) const MAX_ITEMS: usize = 2000;
/// Image items per job.
pub(crate) const MAX_IMAGES: usize = 200;
/// Bytes of image data (JPEG bytes plus RGBA pixels) all images of a job may carry together,
/// counted once per distinct image (wasm32 memory peaks: input, decoded copy and output).
pub(crate) const MAX_IMAGE_BYTES: u64 = 256 * 1024 * 1024;
/// Freehand points all strokes of a job may carry together.
pub(crate) const MAX_FREEHAND_POINTS: usize = 20_000;
/// Characters in one text box.
pub(crate) const MAX_TEXT_CHARS: usize = 5000;
pub(crate) const MAX_STROKE_WIDTH: f64 = 100.0;
pub(crate) const MIN_FONT_SIZE: f64 = 4.0;
pub(crate) const MAX_FONT_SIZE: f64 = 400.0;
pub(crate) const MIN_LINE_HEIGHT: f64 = 0.5;
pub(crate) const MAX_LINE_HEIGHT: f64 = 5.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Paint {
    None,
    Rgb([f64; 3]),
}

/// The font of a text box.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TextFont {
    /// A standard 14 font (WinAnsi text only).
    Standard(StdFont),
    /// Embedded fonts (indices into `EditJob::fonts`): the family first,
    /// then the fallbacks in order. `fake_bold` faces (no Bold file, CJK)
    /// are stroked.
    Unicode { faces: Vec<usize>, fake_bold: Vec<usize> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Align {
    Left,
    Center,
    Right,
}

/// One edit; `page` is 1-based, rects are visible-space `[x, y, w, h]`.
#[derive(Debug, Clone)]
pub enum EditItem {
    Text {
        page: u32,
        rect: [f64; 4],
        text: String,
        font: TextFont,
        size: f64,
        color: [f64; 3],
        opacity: f64,
        /// None: left for left-to-right paragraphs, right for right-to-left
        /// ones (embedded fonts; the standard fonts are left-to-right only).
        align: Option<Align>,
        line_height: f64,
    },
    /// Items sharing one `Arc` (the same picked image placed several times) share one XObject.
    Image { page: u32, rect: [f64; 4], image: Arc<ImageData>, opacity: f64, rotation: u16 },
    Rect { page: u32, rect: [f64; 4], stroke: Paint, width: f64, fill: Paint, opacity: f64 },
    Ellipse { page: u32, rect: [f64; 4], stroke: Paint, width: f64, fill: Paint, opacity: f64 },
    Line {
        page: u32,
        from: [f64; 2],
        to: [f64; 2],
        color: [f64; 3],
        width: f64,
        opacity: f64,
        arrow_start: bool,
        arrow_end: bool,
    },
    Highlight { page: u32, rect: [f64; 4], color: [f64; 3], opacity: f64 },
    Freehand { page: u32, points: Vec<[f64; 2]>, color: [f64; 3], width: f64, opacity: f64 },
    Whiteout { page: u32, rect: [f64; 4] },
}

impl EditItem {
    pub fn page(&self) -> u32 {
        match self {
            EditItem::Text { page, .. }
            | EditItem::Image { page, .. }
            | EditItem::Rect { page, .. }
            | EditItem::Ellipse { page, .. }
            | EditItem::Line { page, .. }
            | EditItem::Highlight { page, .. }
            | EditItem::Freehand { page, .. }
            | EditItem::Whiteout { page, .. } => *page,
        }
    }
}

#[derive(Debug, Clone)]
pub struct EditJob {
    pub items: Vec<EditItem>,
    /// Font files the text boxes with embedded fonts use.
    pub fonts: Vec<Vec<u8>>,
}

/// What one item draws, resolved before the document is touched.
enum Planned {
    /// Path operators painted with an ExtGState of `opacity` and `blend`.
    Path { body: String, opacity: f64, blend: Blend },
    /// Path operators painted without a graphics state (whiteout).
    Opaque { body: String },
    Text { font: StdFont, size: f64, color: [f64; 3], opacity: f64, lines: Vec<text::PlacedLine> },
    /// Lines laid out with embedded fonts, each with its pen origin.
    Unicode { size: f64, color: [f64; 3], opacity: f64, fake_bold: Vec<usize>, lines: Vec<unitext::PlacedLine> },
    /// `image` indexes the built images.
    Image { image: usize, matrix: [f64; 6], opacity: f64 },
}

struct PagePlan {
    page_id: ObjectId,
    matrix: [f64; 6],
    items: Vec<Planned>,
}

pub(crate) fn invalid(field: &str) -> String {
    format!("Invalid edit settings: {field}")
}

pub fn edit_pdf(pdf: &[u8], job: &EditJob) -> Result<Vec<u8>, String> {
    let mut doc = load_pdf(pdf)?;
    let pages: Vec<ObjectId> = doc.get_pages().into_values().collect();
    validate(job, pages.len())?;

    // Plan every item first: any error (WinAnsi, bad image) is returned
    // before anything is written. A page object listed more than once in the
    // tree gets one plan holding the items aimed at any of its occurrences,
    // in job order.
    let mut plans: Vec<PagePlan> = Vec::new();
    let mut plan_of: HashMap<ObjectId, usize> = HashMap::new();
    let mut images = Images::default();
    // Embedded fonts: parsed once (limits checked), shaped within one budget.
    let unicode = job.items.iter().any(|it| matches!(it, EditItem::Text { font: TextFont::Unicode { .. }, .. }));
    let font_bytes: Vec<&[u8]> = job.fonts.iter().map(Vec::as_slice).collect();
    let faces = if unicode { load_faces(&font_bytes).map_err(|e| invalid(e.field()))? } else { Vec::new() };
    let mut shaping = ShapeBudget::per_job();
    for item in &job.items {
        let Some(planned) = plan_item(item, &mut images, &faces, &mut shaping)? else {
            continue;
        };
        let page_id = pages[item.page() as usize - 1];
        let i = *plan_of.entry(page_id).or_insert_with(|| {
            plans.push(PagePlan { page_id, matrix: VisibleBox::of_page(&doc, page_id).matrix(), items: Vec::new() });
            plans.len() - 1
        });
        plans[i].items.push(planned);
    }

    let mut writer = DocWriter::new();
    let mut embedder = Embedder::new(&faces);
    for plan in &plans {
        let mut pw = writer.page(&doc, plan.page_id)?;
        // Page-local names of the embedded fonts drawn on this page.
        let mut font_names: HashMap<ObjectId, String> = HashMap::new();
        let matrix = plan.matrix.map(fmt_num).join(" ");
        for item in &plan.items {
            let ops = match item {
                Planned::Path { body, opacity, blend } => {
                    let gs = pw.gs(&mut doc, &mut writer, *opacity, *blend);
                    format!("q {matrix} cm /{} gs {body} Q\n", lossy(&gs)).into_bytes()
                }
                Planned::Opaque { body } => format!("q {matrix} cm {body} Q\n").into_bytes(),
                Planned::Text { font, size, color, opacity, lines } => {
                    let gs = pw.gs(&mut doc, &mut writer, *opacity, Blend::Normal);
                    let name = pw.font(&mut doc, &mut writer, *font);
                    let mut ops = format!(
                        "q {matrix} cm /{} gs BT /{} {} Tf {} rg",
                        lossy(&gs),
                        lossy(&name),
                        fmt_num(*size),
                        color.map(fmt_num).join(" "),
                    )
                    .into_bytes();
                    for line in lines {
                        ops.extend_from_slice(format!(" 1 0 0 1 {} {} Tm (", fmt_num(line.x), fmt_num(line.y)).as_bytes());
                        escape_literal(&line.bytes, &mut ops);
                        ops.extend_from_slice(b") Tj");
                    }
                    ops.extend_from_slice(b" ET Q\n");
                    ops
                }
                Planned::Unicode { size, color, opacity, fake_bold, lines } => {
                    let gs = pw.gs(&mut doc, &mut writer, *opacity, Blend::Normal);
                    let rgb = color.map(fmt_num).join(" ");
                    let mut ops = format!("q {matrix} cm /{} gs {rgb} rg {rgb} RG\n", lossy(&gs));
                    for line in lines {
                        let mut name = |_: usize, id: ObjectId| {
                            font_names.entry(id).or_insert_with(|| lossy(&pw.font_object(id, "MUnF")).into_owned()).clone()
                        };
                        let shown = embedder
                            .show_line(&mut doc, &line.line, line.origin, *size, &|f| fake_bold.contains(&f), &mut name)
                            .map_err(|e| invalid(e.field()))?;
                        ops.push_str(&shown);
                    }
                    ops.push_str("Q\n");
                    ops.into_bytes()
                }
                Planned::Image { image, matrix: placement, opacity } => {
                    let id = images.object(&mut doc, *image);
                    let gs = pw.gs(&mut doc, &mut writer, *opacity, Blend::Normal);
                    let name = pw.xobject(id);
                    let placement = placement.map(fmt_num).join(" ");
                    format!("q {matrix} cm /{} gs {placement} cm /{} Do Q\n", lossy(&gs), lossy(&name)).into_bytes()
                }
            };
            pw.ops.extend_from_slice(&ops);
        }
        pw.finish(&mut doc, &mut writer)?;
    }
    embedder.finish(&mut doc).map_err(|e| invalid(e.field()))?;
    save_pdf(&mut doc)
}

/// The job's distinct images: built once each, added to the document on first use.
#[derive(Default)]
struct Images {
    index: HashMap<*const ImageData, usize>,
    built: Vec<Option<BuiltImage>>,
    ids: Vec<Option<ObjectId>>,
}

impl Images {
    /// Index of `data`, built on its first placement.
    fn plan(&mut self, data: &Arc<ImageData>) -> Result<usize, String> {
        if let Some(&i) = self.index.get(&Arc::as_ptr(data)) {
            return Ok(i);
        }
        self.built.push(Some(build_image(data)?));
        self.ids.push(None);
        let i = self.built.len() - 1;
        self.index.insert(Arc::as_ptr(data), i);
        Ok(i)
    }

    /// The image XObject of index `i`, added to `doc` the first time it is drawn.
    fn object(&mut self, doc: &mut lopdf::Document, i: usize) -> ObjectId {
        if let Some(id) = self.ids[i] {
            return id;
        }
        let id = add_image(doc, self.built[i].take().expect("image added once"));
        self.ids[i] = Some(id);
        id
    }
}

/// What `item` draws, or None when it is invisible (a shape with neither
/// stroke nor fill, a text box with only blank lines). Images are built
/// into `images`.
fn plan_item(item: &EditItem, images: &mut Images, faces: &[Face], shaping: &mut ShapeBudget) -> Result<Option<Planned>, String> {
    let path = |body: Option<String>, opacity: f64, blend: Blend| body.map(|body| Planned::Path { body, opacity, blend });
    Ok(match item {
        EditItem::Text { rect, text, font: TextFont::Unicode { faces: chain, fake_bold }, size, color, opacity, align, line_height, .. } => {
            let chain: Vec<&Face> = chain.iter().map(|&i| &faces[i]).collect();
            let lines = unitext::place_lines(&chain, *rect, text, *size, *align, *line_height, shaping)?;
            // Runs index the job's fonts, not the chain.
            let lines: Vec<unitext::PlacedLine> = lines
                .into_iter()
                .map(|mut l| {
                    for run in &mut l.line.runs {
                        run.face = item_face(item, run.face);
                    }
                    l
                })
                .collect();
            (!lines.is_empty()).then(|| Planned::Unicode {
                size: *size,
                color: *color,
                opacity: *opacity,
                fake_bold: fake_bold.clone(),
                lines,
            })
        }
        EditItem::Text { rect, text, font: TextFont::Standard(font), size, color, opacity, align, line_height, .. } => {
            let lines = text::layout_text(*rect, text, *font, *size, align.unwrap_or(Align::Left), *line_height)?;
            (!lines.is_empty()).then_some(Planned::Text {
                font: *font,
                size: *size,
                color: *color,
                opacity: *opacity,
                lines,
            })
        }
        EditItem::Image { rect, image, opacity, rotation, .. } => {
            let image = images.plan(image)?;
            Some(Planned::Image { image, matrix: draw::image_matrix(*rect, *rotation), opacity: *opacity })
        }
        EditItem::Rect { rect, stroke, width, fill, opacity, .. } => {
            path(draw::rect_ops(*rect, *stroke, *width, *fill), *opacity, Blend::Normal)
        }
        EditItem::Ellipse { rect, stroke, width, fill, opacity, .. } => {
            path(draw::ellipse_ops(*rect, *stroke, *width, *fill), *opacity, Blend::Normal)
        }
        // A zero-length line draws nothing (its round caps are not a mark worth a rewrite).
        EditItem::Line { from, to, .. } if from == to => None,
        EditItem::Line { from, to, color, width, opacity, arrow_start, arrow_end, .. } => path(
            Some(draw::line_ops(*from, *to, *color, *width, *arrow_start, *arrow_end)),
            *opacity,
            Blend::Normal,
        ),
        EditItem::Highlight { rect, color, opacity, .. } => {
            path(Some(draw::fill_rect_ops(*rect, *color)), *opacity, Blend::Multiply)
        }
        EditItem::Freehand { points, color, width, opacity, .. } => {
            path(Some(draw::freehand_ops(points, *color, *width)), *opacity, Blend::Normal)
        }
        EditItem::Whiteout { rect, .. } => Some(Planned::Opaque { body: draw::fill_rect_ops(*rect, [1.0, 1.0, 1.0]) }),
    })
}

/// The job font index of face `k` of a text item's chain.
fn item_face(item: &EditItem, k: usize) -> usize {
    match item {
        EditItem::Text { font: TextFont::Unicode { faces, .. }, .. } => faces[k],
        _ => k,
    }
}

/// Per-job image budget: item count and total image bytes.
fn images_ok(count: usize, bytes: u64) -> bool {
    count <= MAX_IMAGES && bytes <= MAX_IMAGE_BYTES
}

#[derive(Debug, PartialEq, Eq)]
struct ImageBudget {
    /// Image items.
    placements: usize,
    /// Data bytes and RGBA pixels, each distinct image (shared `Arc`) counted once.
    bytes: u64,
    pixels: u64,
}

fn image_budget(items: &[EditItem]) -> ImageBudget {
    let mut seen = std::collections::HashSet::new();
    let mut b = ImageBudget { placements: 0, bytes: 0, pixels: 0 };
    for item in items {
        let EditItem::Image { image, .. } = item else { continue };
        b.placements += 1;
        if !seen.insert(Arc::as_ptr(image)) {
            continue;
        }
        match &**image {
            ImageData::Rgba { width, height, pixels } => {
                b.pixels += u64::from(*width) * u64::from(*height);
                b.bytes += pixels.len() as u64;
            }
            ImageData::Jpeg(bytes) => b.bytes += bytes.len() as u64,
        }
    }
    b
}

fn validate(job: &EditJob, total: usize) -> Result<(), String> {
    if job.items.len() > MAX_ITEMS {
        return Err(invalid("items"));
    }
    let bounded = |v: &[f64]| v.iter().all(|x| x.is_finite() && x.abs() <= MAX_COORD);
    let unit = |v: f64| (0.0..=1.0).contains(&v);
    let check = |ok: bool, field: &str| if ok { Ok(()) } else { Err(invalid(field)) };
    let rect_ok = |r: &[f64; 4]| bounded(r) && r[2] > 0.0 && r[3] > 0.0;
    let color_ok = |c: &[f64; 3]| c.iter().all(|&v| unit(v));
    let paint_ok = |p: &Paint| match p {
        Paint::None => true,
        Paint::Rgb(c) => color_ok(c),
    };
    let width_ok = |w: f64| (0.0..=MAX_STROKE_WIDTH).contains(&w);
    let stroke_ok = |w: f64| w > 0.0 && w <= MAX_STROKE_WIDTH;

    let mut points = 0usize;
    for item in &job.items {
        check((1..=total).contains(&(item.page() as usize)), "page")?;
        match item {
            EditItem::Text { rect, text, size, color, opacity, line_height, font, .. } => {
                if let TextFont::Unicode { faces, fake_bold } = font {
                    let known = |i: &usize| *i < job.fonts.len();
                    check(!faces.is_empty() && faces.len() <= MAX_FONTS && faces.iter().all(known), "font")?;
                    check(fake_bold.iter().all(|f| faces.contains(f)), "font")?;
                }
                check(rect_ok(rect), "rect")?;
                check(text.chars().count() <= MAX_TEXT_CHARS, "text")?;
                check((MIN_FONT_SIZE..=MAX_FONT_SIZE).contains(size), "size")?;
                check((MIN_LINE_HEIGHT..=MAX_LINE_HEIGHT).contains(line_height), "line_height")?;
                check(color_ok(color), "color")?;
                check(unit(*opacity), "opacity")?;
            }
            EditItem::Image { rect, opacity, rotation, .. } => {
                check(rect_ok(rect), "rect")?;
                check(unit(*opacity), "opacity")?;
                check(matches!(rotation, 0 | 90 | 180 | 270), "rotation")?;
            }
            EditItem::Rect { rect, stroke, width, fill, opacity, .. }
            | EditItem::Ellipse { rect, stroke, width, fill, opacity, .. } => {
                check(rect_ok(rect), "rect")?;
                check(width_ok(*width), "width")?;
                check(paint_ok(stroke) && paint_ok(fill), "color")?;
                check(unit(*opacity), "opacity")?;
            }
            EditItem::Line { from, to, color, width, opacity, .. } => {
                check(bounded(from), "from")?;
                check(bounded(to), "to")?;
                check(stroke_ok(*width), "width")?;
                check(color_ok(color), "color")?;
                check(unit(*opacity), "opacity")?;
            }
            EditItem::Highlight { rect, color, opacity, .. } => {
                check(rect_ok(rect), "rect")?;
                check(color_ok(color), "color")?;
                check(unit(*opacity), "opacity")?;
            }
            EditItem::Freehand { points: pts, color, width, opacity, .. } => {
                points += pts.len();
                check(!pts.is_empty() && points <= MAX_FREEHAND_POINTS, "points")?;
                check(pts.iter().all(|p| bounded(p)), "points")?;
                check(stroke_ok(*width), "width")?;
                check(color_ok(color), "color")?;
                check(unit(*opacity), "opacity")?;
            }
            EditItem::Whiteout { rect, .. } => check(rect_ok(rect), "rect")?,
        }
    }
    let budget = image_budget(&job.items);
    check(images_ok(budget.placements, budget.bytes), "images")?;
    if budget.pixels > MAX_TOTAL_PIXELS {
        return Err("Images are too large".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::content::{Content, Operation};
    use lopdf::{Dictionary, Document, Object, Stream, dictionary};
    use std::sync::Arc;

    struct Fixture {
        doc: Document,
        pages_id: ObjectId,
        kids: Vec<Object>,
    }

    impl Fixture {
        fn new() -> Self {
            let mut doc = Document::with_version("1.7");
            let pages_id = doc.new_object_id();
            Fixture { doc, pages_id, kids: vec![] }
        }

        fn page(&mut self, extra: Dictionary, content: &str) -> ObjectId {
            let c = self.doc.add_object(Stream::new(Dictionary::new(), content.as_bytes().to_vec()));
            let mut page = dictionary! {
                "Type" => "Page", "Parent" => self.pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 600.into(), 800.into()],
                "Resources" => dictionary! {},
                "Contents" => c,
            };
            for (k, v) in extra {
                page.set(k, v);
            }
            let id = self.doc.add_object(page);
            self.kids.push(id.into());
            id
        }

        fn finish(mut self) -> Vec<u8> {
            let count = self.kids.len() as i64;
            self.doc.objects.insert(
                self.pages_id,
                Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => self.kids, "Count" => count }),
            );
            let cat = self.doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => self.pages_id });
            self.doc.trailer.set("Root", cat);
            let mut buf = Vec::new();
            self.doc.save_to(&mut buf).unwrap();
            buf
        }
    }

    fn simple_pdf(n: usize) -> Vec<u8> {
        let mut f = Fixture::new();
        for i in 0..n {
            f.page(Dictionary::new(), &format!("0 0 1 rg 0 0 10 10 re f % page {}", i + 1));
        }
        f.finish()
    }

    fn page_ids(doc: &Document) -> Vec<ObjectId> {
        doc.get_pages().values().copied().collect()
    }

    fn streams(doc: &Document, page: ObjectId) -> Vec<Vec<u8>> {
        let items = match doc.get_dictionary(page).unwrap().get(b"Contents").unwrap() {
            Object::Array(a) => a.clone(),
            Object::Reference(id) => vec![Object::Reference(*id)],
            other => panic!("unexpected /Contents {other:?}"),
        };
        items
            .iter()
            .map(|o| {
                let s = doc.get_object(o.as_reference().unwrap()).unwrap().as_stream().unwrap();
                s.decompressed_content().unwrap_or_else(|_| s.content.clone())
            })
            .collect()
    }

    fn tail(doc: &Document, page: ObjectId) -> String {
        String::from_utf8_lossy(streams(doc, page).last().unwrap()).into_owned()
    }

    fn tail_ops(doc: &Document, page: ObjectId) -> Vec<Operation> {
        Content::decode(streams(doc, page).last().unwrap()).unwrap().operations
    }

    fn nums(op: &Operation) -> Vec<f64> {
        op.operands.iter().map(|o| o.as_float().unwrap() as f64).collect()
    }

    fn resolve<'a>(doc: &'a Document, obj: &'a Object) -> &'a Object {
        match obj {
            Object::Reference(id) => doc.get_object(*id).unwrap(),
            o => o,
        }
    }

    fn category(doc: &Document, page: ObjectId, key: &[u8]) -> Dictionary {
        let res = crate::pdf_util::get_inherited_attr(doc, page, b"Resources").unwrap();
        match resolve(doc, &res).as_dict().unwrap().get(key) {
            Ok(o) => resolve(doc, o).as_dict().unwrap().clone(),
            Err(_) => Dictionary::new(),
        }
    }

    fn load(bytes: &[u8]) -> Document {
        Document::load_mem(bytes).unwrap()
    }

    fn rect_item(page: u32) -> EditItem {
        EditItem::Rect {
            page,
            rect: [10.0, 20.0, 100.0, 50.0],
            stroke: Paint::Rgb([1.0, 0.0, 0.0]),
            width: 2.0,
            fill: Paint::None,
            opacity: 1.0,
        }
    }

    fn text_item(page: u32, text: &str) -> EditItem {
        EditItem::Text {
            page,
            rect: [100.0, 500.0, 200.0, 50.0],
            text: text.into(),
            font: TextFont::Standard(StdFont::Helvetica),
            size: 10.0,
            color: [0.0, 0.0, 0.0],
            opacity: 1.0,
            align: Some(Align::Left),
            line_height: 1.2,
        }
    }

    fn run(pdf: &[u8], items: Vec<EditItem>) -> Result<Document, String> {
        edit_pdf(pdf, &EditJob { items, fonts: Vec::new() }).map(|b| load(&b))
    }

    #[test]
    fn rect_drawn_in_isolated_visible_space() {
        let doc = run(&simple_pdf(1), vec![rect_item(1)]).unwrap();
        let p = page_ids(&doc)[0];
        let s = streams(&doc, p);
        assert_eq!(s.len(), 3, "q, original, tail");
        assert_eq!(s[0], b"q\n");
        assert_eq!(tail(&doc, p), "\nQ\nq 1 0 0 1 0 0 cm /MStGs1 gs 1 0 0 RG 2 w 10 20 100 50 re S Q\n");
    }

    #[test]
    fn items_only_on_their_pages() {
        let pdf = simple_pdf(3);
        let before = load(&pdf);
        let doc = run(&pdf, vec![rect_item(2), text_item(2, "Hi")]).unwrap();
        let ids = page_ids(&doc);
        let old = page_ids(&before);
        for i in [0, 2] {
            assert_eq!(streams(&doc, ids[i]), streams(&before, old[i]), "page {}", i + 1);
            assert!(category(&doc, ids[i], b"Font").is_empty());
        }
        assert_eq!(streams(&doc, ids[1]).len(), 3);
    }

    #[test]
    fn paint_order_is_item_order() {
        let doc = run(&simple_pdf(1), vec![text_item(1, "Top"), rect_item(1)]).unwrap();
        let t = tail(&doc, page_ids(&doc)[0]);
        assert!(t.find("Tj").unwrap() < t.find(" re S").unwrap(), "{t}");
    }

    #[test]
    fn text_lines_fonts_and_clipping() {
        let doc = run(&simple_pdf(1), vec![text_item(1, "a\nb\nc\nd\ne\nf")]).unwrap();
        let p = page_ids(&doc)[0];
        let ops = tail_ops(&doc, p);
        let tj: Vec<Vec<u8>> =
            ops.iter().filter(|o| o.operator == "Tj").map(|o| o.operands[0].as_str().unwrap().to_vec()).collect();
        assert_eq!(tj, [b"a".to_vec(), b"b".to_vec(), b"c".to_vec(), b"d".to_vec()]);
        let tms: Vec<Vec<f64>> = ops.iter().filter(|o| o.operator == "Tm").map(nums).collect();
        assert_eq!(tms[0][..4], [1.0, 0.0, 0.0, 1.0]);
        assert!((tms[0][4] - 100.0).abs() < 1e-4 && (tms[0][5] - 542.82).abs() < 1e-4, "{tms:?}");
        let tf = ops.iter().find(|o| o.operator == "Tf").unwrap();
        let name = tf.operands[0].as_name().unwrap();
        let fonts = category(&doc, p, b"Font");
        let font = resolve(&doc, fonts.get(name).unwrap()).as_dict().unwrap();
        assert_eq!(font.get(b"BaseFont").unwrap().as_name().unwrap(), b"Helvetica");
        assert_eq!(font.get(b"Encoding").unwrap().as_name().unwrap(), b"WinAnsiEncoding");
    }

    #[test]
    fn text_align_center_offsets() {
        let mut item = text_item(1, "ab\nabcd");
        if let EditItem::Text { font, align, rect, .. } = &mut item {
            *font = TextFont::Standard(StdFont::Courier);
            *align = Some(Align::Center);
            *rect = [50.0, 0.0, 100.0, 100.0];
        }
        let doc = run(&simple_pdf(1), vec![item]).unwrap();
        let xs: Vec<f64> =
            tail_ops(&doc, page_ids(&doc)[0]).iter().filter(|o| o.operator == "Tm").map(|o| nums(o)[4]).collect();
        assert_eq!(xs, [94.0, 88.0]);
    }

    #[test]
    fn text_escapes_parentheses() {
        let doc = run(&simple_pdf(1), vec![text_item(1, "a(b)\\c")]).unwrap();
        let ops = tail_ops(&doc, page_ids(&doc)[0]);
        let tj = ops.iter().find(|o| o.operator == "Tj").unwrap();
        assert_eq!(tj.operands[0].as_str().unwrap(), b"a(b)\\c");
    }

    #[test]
    fn rotated_page_text_origin_transform() {
        let mut f = Fixture::new();
        f.page(dictionary! { "Rotate" => 90 }, "");
        let doc = run(&f.finish(), vec![text_item(1, "Up")]).unwrap();
        let p = page_ids(&doc)[0];
        let ops = tail_ops(&doc, p);
        let cm = ops.iter().find(|o| o.operator == "cm").unwrap();
        assert_eq!(nums(cm), [0.0, 1.0, -1.0, 0.0, 600.0, 0.0]);
        let tm = nums(ops.iter().find(|o| o.operator == "Tm").unwrap());
        let vb = VisibleBox::of_page(&doc, p);
        let (ux, uy) = vb.to_user(tm[4], tm[5]);
        // Visible (100, 542.82) on an 800 x 600 visible page.
        assert!((ux - (600.0 - 542.82)).abs() < 1e-3 && (uy - 100.0).abs() < 1e-3, "{ux} {uy}");
    }

    #[test]
    fn empty_original_content_needs_no_isolation() {
        let mut f = Fixture::new();
        f.page(dictionary! { "Rotate" => 90 }, "");
        let doc = run(&f.finish(), vec![rect_item(1)]).unwrap();
        let p = page_ids(&doc)[0];
        // The empty stream still counts as content: isolated like any other.
        assert!(tail(&doc, p).starts_with("\nQ\nq 0 1 -1 0 600 0 cm"), "{}", tail(&doc, p));
    }

    #[test]
    fn isolation_from_unbalanced_original() {
        let mut f = Fixture::new();
        f.page(Dictionary::new(), "q q 2 0 0 2 0 0 cm");
        let doc = run(&f.finish(), vec![rect_item(1)]).unwrap();
        assert!(tail(&doc, page_ids(&doc)[0]).starts_with("\nQ\nQ\nQ\nq "));
    }

    #[test]
    fn highlight_uses_multiply_gs() {
        let item = EditItem::Highlight { page: 1, rect: [0.0, 0.0, 50.0, 10.0], color: [1.0, 1.0, 0.0], opacity: 0.4 };
        let doc = run(&simple_pdf(1), vec![item, rect_item(1)]).unwrap();
        let p = page_ids(&doc)[0];
        let t = tail(&doc, p);
        assert!(t.contains("/MStGs1 gs 1 1 0 rg 0 0 50 10 re f Q"), "{t}");
        let gs = category(&doc, p, b"ExtGState");
        let hl = resolve(&doc, gs.get(b"MStGs1").unwrap()).as_dict().unwrap();
        assert_eq!(hl.get(b"BM").unwrap().as_name().unwrap(), b"Multiply");
        assert!((hl.get(b"ca").unwrap().as_float().unwrap() - 0.4).abs() < 1e-6);
        assert!((hl.get(b"CA").unwrap().as_float().unwrap() - 0.4).abs() < 1e-6);
        // The plain rect's state has no blend mode.
        let plain = resolve(&doc, gs.get(b"MStGs2").unwrap()).as_dict().unwrap();
        assert!(plain.get(b"BM").is_err());
    }

    #[test]
    fn whiteout_shapes_lines_freehand() {
        let items = vec![
            EditItem::Whiteout { page: 1, rect: [1.0, 2.0, 3.0, 4.0] },
            EditItem::Ellipse {
                page: 1,
                rect: [0.0, 0.0, 100.0, 50.0],
                stroke: Paint::None,
                width: 1.0,
                fill: Paint::Rgb([0.0, 0.0, 1.0]),
                opacity: 0.5,
            },
            EditItem::Line {
                page: 1,
                from: [0.0, 0.0],
                to: [100.0, 0.0],
                color: [1.0, 0.0, 0.0],
                width: 2.0,
                opacity: 1.0,
                arrow_start: false,
                arrow_end: true,
            },
            EditItem::Freehand { page: 1, points: vec![[1.0, 2.0], [3.0, 4.0]], color: [0.0, 0.0, 0.0], width: 3.0, opacity: 1.0 },
        ];
        let doc = run(&simple_pdf(1), items).unwrap();
        let t = tail(&doc, page_ids(&doc)[0]);
        assert!(t.contains("q 1 0 0 1 0 0 cm 1 1 1 rg 1 2 3 4 re f Q"), "{t}");
        assert!(t.contains(" 100 25 m 100 38.807119 "), "{t}");
        assert!(t.contains("90.4 0 l S 1 0 0 rg 100 0 m 88 5.595692 l 88 -5.595692 l h f Q"), "{t}");
        assert!(t.contains("0 0 0 RG 3 w 1 J 1 j 1 2 m 3 4 l S Q"), "{t}");
    }

    #[test]
    fn invisible_shape_leaves_page_untouched() {
        let pdf = simple_pdf(1);
        let item = EditItem::Rect { page: 1, rect: [0.0, 0.0, 5.0, 5.0], stroke: Paint::None, width: 1.0, fill: Paint::None, opacity: 1.0 };
        let doc = run(&pdf, vec![item]).unwrap();
        assert_eq!(streams(&doc, page_ids(&doc)[0]).len(), 1);
    }

    #[test]
    fn shared_resources_untouched() {
        let mut f = Fixture::new();
        let font = f.doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Times-Roman" });
        let fonts = f.doc.add_object(dictionary! { "F1" => font });
        let shared = f.doc.add_object(dictionary! { "Font" => fonts });
        f.page(dictionary! { "Resources" => shared }, "BT /F1 12 Tf (A) Tj ET");
        f.page(dictionary! { "Resources" => shared }, "BT /F1 12 Tf (B) Tj ET");
        let pdf = f.finish();
        let before = load(&pdf);
        let doc = run(&pdf, vec![text_item(1, "New"), EditItem::Highlight { page: 1, rect: [0.0, 0.0, 9.0, 9.0], color: [1.0, 1.0, 0.0], opacity: 0.4 }]).unwrap();
        assert_eq!(doc.get_object(shared).unwrap(), before.get_object(shared).unwrap());
        assert_eq!(doc.get_object(fonts).unwrap(), before.get_object(fonts).unwrap());
        let ids = page_ids(&doc);
        assert_eq!(doc.get_dictionary(ids[1]).unwrap().get(b"Resources").unwrap(), &Object::Reference(shared));
        // Page 1 keeps F1 next to the new font.
        let f1 = category(&doc, ids[0], b"Font");
        assert!(f1.has(b"F1") && f1.has(b"MStF1"));
    }

    #[test]
    fn image_item_rotation_and_opacity() {
        let pixels = vec![255, 0, 0, 255, 0, 255, 0, 128];
        let item = EditItem::Image {
            page: 1,
            rect: [10.0, 20.0, 100.0, 50.0],
            image: Arc::new(ImageData::Rgba { width: 2, height: 1, pixels }),
            opacity: 0.5,
            rotation: 90,
        };
        let doc = run(&simple_pdf(1), vec![item]).unwrap();
        let p = page_ids(&doc)[0];
        let ops = tail_ops(&doc, p);
        let cms: Vec<Vec<f64>> = ops.iter().filter(|o| o.operator == "cm").map(nums).collect();
        assert_eq!(cms[1], [0.0, -50.0, 100.0, 0.0, 10.0, 70.0]);
        let doop = ops.iter().find(|o| o.operator == "Do").unwrap();
        let xo = category(&doc, p, b"XObject");
        let img = resolve(&doc, xo.get(doop.operands[0].as_name().unwrap()).unwrap()).as_stream().unwrap();
        assert_eq!(img.dict.get(b"Width").unwrap().as_i64().unwrap(), 2);
        assert!(img.dict.has(b"SMask"));
    }

    #[test]
    fn winansi_rejected_before_write() {
        let err = run(&simple_pdf(1), vec![rect_item(1), text_item(1, "日本")]).unwrap_err();
        assert_eq!(err, "Characters not supported by the standard PDF fonts: 日本");
    }

    #[test]
    fn page_listed_twice_gets_one_plan_in_item_order() {
        let mut f = Fixture::new();
        let p = f.page(Dictionary::new(), "");
        f.kids.push(p.into());
        let doc = run(&f.finish(), vec![rect_item(1), text_item(2, "Hi")]).unwrap();
        let t = tail(&doc, page_ids(&doc)[0]);
        assert!(t.contains(" re S") && t.contains("Tj"), "{t}");
        assert_eq!(streams(&doc, page_ids(&doc)[0]).len(), 3);
    }

    fn err(items: Vec<EditItem>) -> String {
        run(&simple_pdf(2), items).unwrap_err()
    }

    #[test]
    fn limits_errors() {
        let e = |f: &str| format!("Invalid edit settings: {f}");
        assert_eq!(err(vec![rect_item(1); MAX_ITEMS + 1]), e("items"));
        assert!(run(&simple_pdf(1), vec![rect_item(1); MAX_ITEMS]).is_ok());
        assert_eq!(err(vec![rect_item(3)]), e("page"));
        assert_eq!(err(vec![rect_item(0)]), e("page"));

        let free = |n: usize| EditItem::Freehand { page: 1, points: vec![[1.0, 1.0]; n], color: [0.0; 3], width: 1.0, opacity: 1.0 };
        assert_eq!(err(vec![free(10_000), free(10_001)]), e("points"));
        assert!(run(&simple_pdf(1), vec![free(10_000), free(10_000)]).is_ok());
        assert_eq!(err(vec![free(0)]), e("points"));

        assert_eq!(err(vec![text_item(1, &"a".repeat(MAX_TEXT_CHARS + 1))]), e("text"));
        assert!(run(&simple_pdf(1), vec![text_item(1, &"é".repeat(MAX_TEXT_CHARS))]).is_ok());

        let with_text = |f: &dyn Fn(&mut EditItem)| {
            let mut t = text_item(1, "x");
            f(&mut t);
            err(vec![t])
        };
        assert_eq!(with_text(&|t| if let EditItem::Text { size, .. } = t { *size = 3.9 }), e("size"));
        assert_eq!(with_text(&|t| if let EditItem::Text { size, .. } = t { *size = 401.0 }), e("size"));
        assert_eq!(with_text(&|t| if let EditItem::Text { line_height, .. } = t { *line_height = f64::NAN }), e("line_height"));
        assert_eq!(with_text(&|t| if let EditItem::Text { color, .. } = t { color[1] = 1.5 }), e("color"));
        assert_eq!(with_text(&|t| if let EditItem::Text { opacity, .. } = t { *opacity = -0.1 }), e("opacity"));
        assert_eq!(with_text(&|t| if let EditItem::Text { rect, .. } = t { rect[0] = 2e6 }), e("rect"));
        assert_eq!(with_text(&|t| if let EditItem::Text { rect, .. } = t { rect[2] = 0.0 }), e("rect"));

        let rect_with = |width: f64, stroke: Paint| EditItem::Rect { page: 1, rect: [0.0, 0.0, 1.0, 1.0], stroke, width, fill: Paint::None, opacity: 1.0 };
        assert_eq!(err(vec![rect_with(100.5, Paint::Rgb([0.0; 3]))]), e("width"));
        assert_eq!(err(vec![rect_with(-1.0, Paint::Rgb([0.0; 3]))]), e("width"));
        assert_eq!(err(vec![rect_with(1.0, Paint::Rgb([f64::INFINITY, 0.0, 0.0]))]), e("color"));
        let line = EditItem::Line { page: 1, from: [0.0, f64::NAN], to: [1.0, 1.0], color: [0.0; 3], width: 1.0, opacity: 1.0, arrow_start: false, arrow_end: false };
        assert_eq!(err(vec![line]), e("from"));
        let image = EditItem::Image { page: 1, rect: [0.0, 0.0, 1.0, 1.0], image: Arc::new(ImageData::Rgba { width: 1, height: 1, pixels: vec![0; 4] }), opacity: 1.0, rotation: 45 };
        assert_eq!(err(vec![image]), e("rotation"));
        let far = EditItem::Freehand { page: 1, points: vec![[0.0, -1.5e6]], color: [0.0; 3], width: 1.0, opacity: 1.0 };
        assert_eq!(err(vec![far]), e("points"));
    }

    #[test]
    fn line_and_freehand_need_a_positive_width() {
        let e = |f: &str| format!("Invalid edit settings: {f}");
        let line = |width: f64| EditItem::Line { page: 1, from: [0.0, 0.0], to: [5.0, 0.0], color: [0.0; 3], width, opacity: 1.0, arrow_start: false, arrow_end: false };
        let free = |width: f64| EditItem::Freehand { page: 1, points: vec![[1.0, 1.0]], color: [0.0; 3], width, opacity: 1.0 };
        assert_eq!(err(vec![line(0.0)]), e("width"));
        assert_eq!(err(vec![free(0.0)]), e("width"));
        assert_eq!(err(vec![line(100.5)]), e("width"));
        assert!(run(&simple_pdf(1), vec![line(100.0), free(0.5)]).is_ok());
    }

    #[test]
    fn zero_length_line_is_a_noop() {
        let line = |to: [f64; 2]| EditItem::Line { page: 1, from: [3.0, 4.0], to, color: [0.0; 3], width: 2.0, opacity: 1.0, arrow_start: true, arrow_end: true };
        let doc = run(&simple_pdf(1), vec![line([3.0, 4.0])]).unwrap();
        assert_eq!(streams(&doc, page_ids(&doc)[0]).len(), 1);
        let doc = run(&simple_pdf(1), vec![line([30.0, 4.0])]).unwrap();
        assert_eq!(streams(&doc, page_ids(&doc)[0]).len(), 3);
    }

    #[test]
    fn image_count_and_byte_limits() {
        let e = |f: &str| format!("Invalid edit settings: {f}");
        let pixel = || EditItem::Image { page: 1, rect: [0.0, 0.0, 1.0, 1.0], image: Arc::new(ImageData::Rgba { width: 1, height: 1, pixels: vec![0; 4] }), opacity: 1.0, rotation: 0 };
        assert_eq!(err(vec![pixel(); MAX_IMAGES + 1]), e("images"));
        assert!(run(&simple_pdf(1), vec![pixel(); MAX_IMAGES]).is_ok());
        assert!(images_ok(MAX_IMAGES, MAX_IMAGE_BYTES));
        assert!(!images_ok(MAX_IMAGES, MAX_IMAGE_BYTES + 1));
        assert!(!images_ok(MAX_IMAGES + 1, 0));
    }

    #[test]
    fn bad_image_rejected_before_write() {
        let item = EditItem::Image { page: 1, rect: [0.0, 0.0, 1.0, 1.0], image: Arc::new(ImageData::Jpeg(vec![1, 2, 3])), opacity: 1.0, rotation: 0 };
        assert!(!err(vec![item]).is_empty());
    }

    #[test]
    fn output_numbers_have_no_exponent() {
        let item = EditItem::Rect { page: 1, rect: [1e-9, 1e5, 0.1, 0.2], stroke: Paint::None, width: 0.0, fill: Paint::Rgb([0.3, 0.0, 0.0]), opacity: 1.0 };
        let doc = run(&simple_pdf(1), vec![item]).unwrap();
        let t = tail(&doc, page_ids(&doc)[0]);
        assert!(t.contains("0.3 0 0 rg 0 100000 0.1 0.2 re f"), "{t}");
    }

    fn count_images(doc: &Document) -> usize {
        doc.objects
            .values()
            .filter(|o| o.as_stream().is_ok_and(|s| s.dict.get(b"Subtype").and_then(|v| v.as_name()).is_ok_and(|n| n == b"Image")))
            .count()
    }

    #[test]
    fn one_image_placed_twice_is_embedded_once() {
        let shared = Arc::new(ImageData::Rgba { width: 2, height: 1, pixels: vec![255, 0, 0, 255, 0, 255, 0, 255] });
        let at = |page: u32, x: f64| EditItem::Image { page, rect: [x, 0.0, 10.0, 5.0], image: Arc::clone(&shared), opacity: 1.0, rotation: 0 };
        let doc = run(&simple_pdf(2), vec![at(1, 0.0), at(1, 50.0), at(2, 0.0)]).unwrap();
        assert_eq!(count_images(&doc), 1);
        let ids = page_ids(&doc);
        let target = |p: ObjectId| {
            let ops = tail_ops(&doc, p);
            let xo = category(&doc, p, b"XObject");
            ops.iter()
                .filter(|o| o.operator == "Do")
                .map(|o| xo.get(o.operands[0].as_name().unwrap()).unwrap().as_reference().unwrap())
                .collect::<Vec<_>>()
        };
        let (t1, t2) = (target(ids[0]), target(ids[1]));
        assert_eq!(t1.len(), 2);
        assert_eq!(t1[0], t1[1]);
        assert_eq!(t2, vec![t1[0]]);

        // Equal pixels in two separate buffers are two images (only shared data is deduplicated).
        let copy = |x: f64| EditItem::Image { page: 1, rect: [x, 0.0, 10.0, 5.0], image: Arc::new((*shared).clone()), opacity: 1.0, rotation: 0 };
        let doc = run(&simple_pdf(1), vec![copy(0.0), copy(50.0)]).unwrap();
        assert_eq!(count_images(&doc), 2);
    }

    #[test]
    fn image_budget_counts_shared_data_once() {
        assert_eq!(MAX_IMAGE_BYTES, 256 * 1024 * 1024);
        let shared = Arc::new(ImageData::Jpeg(vec![0; 100]));
        let other = Arc::new(ImageData::Rgba { width: 2, height: 2, pixels: vec![0; 16] });
        let img = |d: &Arc<ImageData>| EditItem::Image { page: 1, rect: [0.0, 0.0, 1.0, 1.0], image: Arc::clone(d), opacity: 1.0, rotation: 0 };
        let budget = image_budget(&[img(&shared), img(&shared), img(&other), img(&shared)]);
        assert_eq!(budget, ImageBudget { placements: 4, bytes: 116, pixels: 4 });
    }

    // ---- embedded (Noto) fonts ----

    const SANS: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fonts/NotoSans-subset.ttf"));
    const HEBREW: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fonts/NotoSansHebrew-subset.ttf"));
    const SC: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fonts/NotoSansSC-subset.ttf"));

    fn noto_item(text: &str, faces: Vec<usize>, fake_bold: Vec<usize>) -> EditItem {
        EditItem::Text {
            page: 1,
            rect: [100.0, 500.0, 300.0, 100.0],
            text: text.into(),
            font: TextFont::Unicode { faces, fake_bold },
            size: 12.0,
            color: [0.2, 0.4, 0.6],
            opacity: 1.0,
            align: None,
            line_height: 1.2,
        }
    }

    /// One page whose content ends with a newline (`simple_pdf` ends in a
    /// comment, which the redact reader's strict parse of the joined streams
    /// refuses, so search could not read it).
    fn searchable_pdf() -> Vec<u8> {
        let mut f = Fixture::new();
        f.page(Dictionary::new(), "0 0 1 rg 0 0 10 10 re f\n");
        f.finish()
    }

    fn run_fonts(items: Vec<EditItem>) -> Result<Vec<u8>, String> {
        edit_pdf(&searchable_pdf(), &EditJob { items, fonts: vec![SANS.to_vec(), HEBREW.to_vec(), SC.to_vec()] })
    }

    fn search(pdf: &[u8], query: &str) -> usize {
        let options = crate::redact::search::SearchOptions { whole_word: false, case_sensitive: true };
        crate::redact::search::redact_search(pdf, query, &options).unwrap().matches.len()
    }

    #[test]
    fn noto_text_is_embedded_and_searchable() {
        let pdf = run_fonts(vec![noto_item("Привет мир\n你好世界", vec![0, 1, 2], vec![]), text_item(1, "Hi")]).unwrap();
        let doc = load(&pdf);
        let p = page_ids(&doc)[0];
        let fonts = category(&doc, p, b"Font");
        let subtypes: Vec<Vec<u8>> =
            fonts.iter().map(|(_, f)| resolve(&doc, f).as_dict().unwrap().get(b"Subtype").unwrap().as_name().unwrap().to_vec()).collect();
        // Noto Sans and Noto Sans SC (Hebrew unused), plus Helvetica.
        assert_eq!(subtypes.iter().filter(|s| s.as_slice() == b"Type0").count(), 2, "{subtypes:?}");
        assert_eq!(subtypes.iter().filter(|s| s.as_slice() == b"Type1").count(), 1);
        for query in ["Привет мир", "你好世界", "Hi"] {
            assert_eq!(search(&pdf, query), 1, "{query}");
        }
        // Colour for fill and stroke, in the item's graphics state.
        assert!(tail(&doc, p).contains("0.2 0.4 0.6 rg 0.2 0.4 0.6 RG"), "{}", tail(&doc, p));
    }

    #[test]
    fn noto_lines_are_clipped_like_standard_ones() {
        let mut item = noto_item("a\nb\nc\nd\ne\nf", vec![0], vec![]);
        if let EditItem::Text { rect, .. } = &mut item {
            *rect = [100.0, 500.0, 200.0, 50.0];
        }
        let pdf = run_fonts(vec![item]).unwrap();
        let doc = load(&pdf);
        let tms = tail_ops(&doc, page_ids(&doc)[0]).iter().filter(|o| o.operator == "Tm").count();
        // Noto Sans 12 pt, pitch 14.4: baselines 12.8, 27.2, 41.6 below the top; the
        // descender (-0.293 em, 3.5 pt) of a fourth line would leave the 50 pt box.
        assert_eq!(tms, 3);
        // A box too short for one line still shows it.
        let mut item = noto_item("a\nb", vec![0], vec![]);
        if let EditItem::Text { rect, .. } = &mut item {
            *rect = [100.0, 500.0, 200.0, 2.0];
        }
        let doc = load(&run_fonts(vec![item]).unwrap());
        assert_eq!(tail_ops(&doc, page_ids(&doc)[0]).iter().filter(|o| o.operator == "Tm").count(), 1);
    }

    #[test]
    fn right_to_left_text_is_right_aligned_by_default() {
        let pdf = run_fonts(vec![noto_item("שלום", vec![0, 1], vec![])]).unwrap();
        let doc = load(&pdf);
        let tm = tail_ops(&doc, page_ids(&doc)[0]).into_iter().find(|o| o.operator == "Tm").unwrap();
        let faces = crate::unifont::load_faces(&[SANS, HEBREW]).unwrap();
        let p = crate::unifont::LayoutParams { size: 12.0, width: 300.0, align: None, line_height: 1.2 };
        let layout = crate::unifont::layout_text(&faces, "שלום", &p, &mut ShapeBudget::per_job()).unwrap();
        let width = layout.lines[0].width;
        assert!((nums(&tm)[4] - (100.0 + 300.0 - width)).abs() < 1e-3, "{:?} width {width}", nums(&tm));
        assert_eq!(search(&pdf, "שלום"), 1);
    }

    #[test]
    fn synthetic_bold_strokes_only_its_faces() {
        let pdf = run_fonts(vec![noto_item("Hi 你好", vec![0, 2], vec![2])]).unwrap();
        let doc = load(&pdf);
        let t = tail(&doc, page_ids(&doc)[0]);
        let cjk = t.find("2 Tr").expect("CJK run stroked");
        assert!(t[..cjk].contains("Tf"), "{t}");
        assert!(t.matches("2 Tr").count() == 1, "{t}");
    }

    #[test]
    fn noto_font_errors() {
        // A chain naming a font the job does not carry.
        let e = run_fonts(vec![noto_item("x", vec![0, 7], vec![])]).unwrap_err();
        assert_eq!(e, "Invalid edit settings: font");
        let e = run_fonts(vec![noto_item("x", vec![], vec![])]).unwrap_err();
        assert_eq!(e, "Invalid edit settings: font");
        // Bold for a face outside the chain.
        let e = run_fonts(vec![noto_item("x", vec![0], vec![1])]).unwrap_err();
        assert_eq!(e, "Invalid edit settings: font");
        // Bytes that are not a font.
        let job = EditJob { items: vec![noto_item("x", vec![0], vec![])], fonts: vec![b"junk".to_vec()] };
        assert_eq!(edit_pdf(&simple_pdf(1), &job).unwrap_err(), "Invalid edit settings: font");
        // Standard text never parses the job's fonts.
        let job = EditJob { items: vec![text_item(1, "ok")], fonts: vec![b"junk".to_vec()] };
        assert!(edit_pdf(&simple_pdf(1), &job).is_ok());
    }
}
