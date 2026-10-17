//! Stamp engine: draws text and images on top of pages, positioned in
//! visible page space (see `geometry`).

use super::fonts::{StdFont, encode_winansi, text_width};
use super::geometry::VisibleBox;
use super::image::{BuiltImage, build_image};
use crate::pdf_util::{get_inherited_attr, load_pdf};
use crate::rebuild::{MAX_STREAM_DECODED, bounded_content, deref, unbalanced_saves};
use lopdf::{Dictionary, Document, Object, ObjectId, Stream, dictionary};
use std::collections::{BTreeSet, HashMap};

/// Pages to stamp with text; numbers are 1-based.
#[derive(Debug, Clone, PartialEq)]
pub enum PageSelection {
    All,
    List(Vec<u32>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Anchor {
    TopLeft,
    TopCenter,
    TopRight,
    MiddleLeft,
    Center,
    MiddleRight,
    BottomLeft,
    BottomCenter,
    BottomRight,
}

#[derive(Debug, Clone)]
pub struct TextStamp {
    pub template: String,
    pub font: StdFont,
    pub size: f64,
    pub color: [f64; 3],
    pub opacity: f64,
    pub anchor: Anchor,
    pub margin_x: f64,
    pub margin_y: f64,
    /// Visible-space baseline origin; when set, `anchor` and the margins are
    /// ignored.
    pub at: Option<[f64; 2]>,
    /// 1-based page this text goes on, independent of `StampJob::pages`
    /// (and not counted as a Bates-stamped page).
    pub page_only: Option<u32>,
}

#[derive(Debug, Clone)]
pub enum ImageData {
    Rgba { width: u32, height: u32, pixels: Vec<u8> },
    Jpeg(Vec<u8>),
}

#[derive(Debug, Clone)]
pub struct ImageStamp {
    pub image: ImageData,
    /// 1-based page the image goes on (independent of `StampJob::pages`).
    pub page: u32,
    /// Visible-space x, y, width, height.
    pub rect: [f64; 4],
    pub opacity: f64,
}

#[derive(Debug, Clone)]
pub struct Bates {
    pub prefix: String,
    pub suffix: String,
    pub start: u64,
    pub digits: u8,
}

#[derive(Debug, Clone)]
pub struct StampJob {
    pub pages: PageSelection,
    pub texts: Vec<TextStamp>,
    pub images: Vec<ImageStamp>,
    pub number_start: i64,
    pub bates: Option<Bates>,
}

#[derive(Debug, Clone)]
pub struct StampResult {
    pub bytes: Vec<u8>,
    pub stamped_pages: u32,
}

/// A text stamp resolved for one page: WinAnsi bytes at a visible-space
/// baseline origin.
struct PlacedText {
    font: StdFont,
    size: f64,
    color: [f64; 3],
    opacity: f64,
    x: f64,
    y: f64,
    bytes: Vec<u8>,
}

/// Everything one page receives, computed before the document is touched.
struct PagePlan {
    page_id: ObjectId,
    matrix: [f64; 6],
    texts: Vec<PlacedText>,
    /// Indices into `StampJob::images`.
    images: Vec<usize>,
}

pub fn apply_stamps(pdf: &[u8], job: &StampJob) -> Result<StampResult, String> {
    let mut doc = load_pdf(pdf)?;
    let pages: Vec<(u32, ObjectId)> = doc.get_pages().into_iter().collect();
    let total = pages.len() as u32;
    validate(job, total)?;

    let selected: BTreeSet<u32> = match &job.pages {
        PageSelection::All => (1..=total).collect(),
        PageSelection::List(list) => list.iter().copied().collect(),
    };

    // Plan every page first: any error (WinAnsi, overflow, bad image) is
    // returned before anything is written.
    let mut plans = Vec::new();
    let mut stamped_so_far: u64 = 0;
    for &(number, page_id) in &pages {
        let vb = VisibleBox::of_page(&doc, page_id);
        let mut texts = Vec::new();
        let n = i64::from(number).saturating_add(job.number_start).saturating_sub(1);
        let mut bates = None;
        if selected.contains(&number) && job.texts.iter().any(|t| t.page_only.is_none()) {
            if let Some(b) = &job.bates {
                bates = Some(format_bates(b, stamped_so_far)?);
            }
            stamped_so_far += 1;
        }
        for t in &job.texts {
            let applies = match t.page_only {
                Some(p) => p == number,
                None => selected.contains(&number),
            };
            if !applies {
                continue;
            }
            let resolved = resolve_tokens(&t.template, n, total, bates.as_deref());
            let bytes = encode_winansi(&normalize_whitespace(&resolved))?;
            if !bytes.is_empty() {
                texts.push(place_text(t, bytes, vb.width(), vb.height()));
            }
        }
        let images: Vec<usize> =
            (0..job.images.len()).filter(|&i| job.images[i].page == number).collect();
        if !texts.is_empty() || !images.is_empty() {
            plans.push(PagePlan { page_id, matrix: vb.matrix(), texts, images });
        }
    }
    let built: Vec<BuiltImage> =
        job.images.iter().map(|im| build_image(&im.image)).collect::<Result<_, _>>()?;

    // Shared new objects: one font per StdFont, one ExtGState per opacity,
    // one XObject per image, one `q` stream. None of them pre-exists, so
    // sharing them between pages mutates nothing of the original document.
    let mut fonts: HashMap<&'static str, ObjectId> = HashMap::new();
    let mut states: HashMap<u64, ObjectId> = HashMap::new();
    let mut image_ids: Vec<Option<ObjectId>> = vec![None; built.len()];
    let mut built: Vec<Option<BuiltImage>> = built.into_iter().map(Some).collect();
    let mut open_q: Option<ObjectId> = None;

    for plan in &plans {
        let page = doc
            .get_dictionary(plan.page_id)
            .map_err(|e| format!("Page {:?} not found: {e}", plan.page_id))?;
        let mut resources = owned_dict(&doc, get_inherited_attr(&doc, plan.page_id, b"Resources").as_ref());
        let mut font_dict = owned_dict(&doc, resources.get(b"Font").ok());
        let mut gs_dict = owned_dict(&doc, resources.get(b"ExtGState").ok());
        let mut xobject_dict = owned_dict(&doc, resources.get(b"XObject").ok());
        let original = original_contents(&doc, page.get(b"Contents").ok());
        let open = unbalanced_in(&doc, &original);

        // Page-local names, made unique against what the page already has.
        let mut font_names: HashMap<&'static str, Vec<u8>> = HashMap::new();
        let mut gs_names: HashMap<u64, Vec<u8>> = HashMap::new();
        let matrix = plan.matrix.map(fmt_num).join(" ");
        // Stamp operators; text bodies are WinAnsi bytes, not UTF-8.
        let mut ops: Vec<u8> = Vec::new();
        if !original.is_empty() {
            ops.extend_from_slice(b"\nQ\n");
            ops.extend_from_slice("Q\n".repeat(open).as_bytes());
        }

        for t in &plan.texts {
            let gs = gs_name(&mut doc, &mut states, &mut gs_names, &mut gs_dict, t.opacity);
            let font = match font_names.get(t.font.base_font()) {
                Some(n) => n.clone(),
                None => {
                    let id = *fonts.entry(t.font.base_font()).or_insert_with(|| doc.add_object(font_object(t.font)));
                    let name = free_name(&font_dict, "MStF");
                    font_dict.set(name.clone(), Object::Reference(id));
                    font_names.insert(t.font.base_font(), name.clone());
                    name
                }
            };
            let [r, g, b] = t.color.map(fmt_num);
            ops.extend_from_slice(
                format!(
                    "q {matrix} cm /{} gs BT /{} {} Tf {r} {g} {b} rg {} {} Td (",
                    lossy(&gs),
                    lossy(&font),
                    fmt_num(t.size),
                    fmt_num(t.x),
                    fmt_num(t.y),
                )
                .as_bytes(),
            );
            escape_literal(&t.bytes, &mut ops);
            ops.extend_from_slice(b") Tj ET Q\n");
        }

        for &i in &plan.images {
            let stamp = &job.images[i];
            let id = match image_ids[i] {
                Some(id) => id,
                None => {
                    let BuiltImage { mut image, smask } = built[i].take().expect("image built once");
                    if let Some(mask) = smask {
                        let mask_id = doc.add_object(mask);
                        image.dict.set("SMask", Object::Reference(mask_id));
                    }
                    let id = doc.add_object(image);
                    image_ids[i] = Some(id);
                    id
                }
            };
            let gs = gs_name(&mut doc, &mut states, &mut gs_names, &mut gs_dict, stamp.opacity);
            let name = free_name(&xobject_dict, "MStIm");
            xobject_dict.set(name.clone(), Object::Reference(id));
            let [x, y, w, h] = stamp.rect.map(fmt_num);
            ops.extend_from_slice(
                format!(
                    "q {matrix} cm /{} gs {w} 0 0 {h} {x} {y} cm /{} Do Q\n",
                    lossy(&gs),
                    lossy(&name),
                )
                .as_bytes(),
            );
        }

        if !font_dict.is_empty() || resources.has(b"Font") {
            resources.set("Font", font_dict);
        }
        if !gs_dict.is_empty() || resources.has(b"ExtGState") {
            resources.set("ExtGState", gs_dict);
        }
        if !xobject_dict.is_empty() || resources.has(b"XObject") {
            resources.set("XObject", xobject_dict);
        }

        let mut contents = Vec::with_capacity(original.len() + 2);
        if !original.is_empty() {
            let q = *open_q.get_or_insert_with(|| doc.add_object(plain_stream(b"q\n".to_vec())));
            contents.push(Object::Reference(q));
        }
        contents.extend(original);
        let tail = doc.add_object(plain_stream(ops));
        contents.push(Object::Reference(tail));

        let page = doc
            .get_dictionary_mut(plan.page_id)
            .map_err(|e| format!("Page {:?} not found: {e}", plan.page_id))?;
        page.set("Resources", resources);
        page.set("Contents", contents);
    }

    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).map_err(|e| format!("Failed to write PDF: {e}"))?;
    Ok(StampResult { bytes, stamped_pages: plans.len() as u32 })
}

/// Visible width and height of every page, in page order: `[w1, h1, w2, h2, ...]`.
pub fn visible_page_sizes(pdf: &[u8]) -> Result<Vec<f64>, String> {
    let doc = load_pdf(pdf)?;
    Ok(doc
        .get_pages()
        .values()
        .flat_map(|&id| {
            let vb = VisibleBox::of_page(&doc, id);
            [vb.width(), vb.height()]
        })
        .collect())
}

fn validate(job: &StampJob, total: u32) -> Result<(), String> {
    let finite = |v: &[f64]| v.iter().all(|x| x.is_finite());
    if let PageSelection::List(list) = &job.pages
        && let Some(p) = list.iter().find(|&&p| p == 0 || p > total)
    {
        return Err(format!("Page {p} does not exist (the document has {total} pages)"));
    }
    for t in &job.texts {
        if !(t.size.is_finite() && t.size > 0.0) {
            return Err("Font size must be a positive number".into());
        }
        if !finite(&[t.opacity, t.margin_x, t.margin_y]) || !finite(&t.color) || !t.at.is_none_or(|a| finite(&a)) {
            return Err("Invalid text stamp settings".into());
        }
        if let Some(p) = t.page_only
            && (p == 0 || p > total)
        {
            return Err(format!("Page {p} does not exist (the document has {total} pages)"));
        }
    }
    for im in &job.images {
        if im.page == 0 || im.page > total {
            return Err(format!("Page {} does not exist (the document has {total} pages)", im.page));
        }
        let [_, _, w, h] = im.rect;
        if !finite(&im.rect) || !finite(&[im.opacity]) || w <= 0.0 || h <= 0.0 {
            return Err("Invalid image placement".into());
        }
    }
    Ok(())
}

/// `prefix` + zero-padded counter + `suffix`; the counter is `start` plus the
/// number of pages stamped before this one.
fn format_bates(b: &Bates, stamped_so_far: u64) -> Result<String, String> {
    let counter = b.start.checked_add(stamped_so_far).ok_or("Bates number is too large")?;
    Ok(format!("{}{:0width$}{}", b.prefix, counter, b.suffix, width = usize::from(b.digits)))
}

/// Replace `{n}`, `{total}` and (when Bates is on) `{bates}` in one pass, so
/// a substituted value is never scanned for tokens again.
fn resolve_tokens(template: &str, n: i64, total: u32, bates: Option<&str>) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(i) = rest.find('{') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        if let Some(r) = rest.strip_prefix("{n}") {
            out.push_str(&n.to_string());
            rest = r;
        } else if let Some(r) = rest.strip_prefix("{total}") {
            out.push_str(&total.to_string());
            rest = r;
        } else if let (Some(b), Some(r)) = (bates, rest.strip_prefix("{bates}")) {
            out.push_str(b);
            rest = r;
        } else {
            out.push('{');
            rest = &rest[1..];
        }
    }
    out.push_str(rest);
    out
}

/// Tabs and line breaks become spaces: a stamp is a single line, and the
/// WinAnsi encoder rejects control characters.
fn normalize_whitespace(text: &str) -> String {
    text.chars()
        .map(|c| if matches!(c, '\t' | '\n' | '\r' | '\u{0B}' | '\u{0C}') { ' ' } else { c })
        .collect()
}

/// Baseline origin of `bytes` in visible space for the stamp's anchor.
fn place_text(t: &TextStamp, bytes: Vec<u8>, w: f64, h: f64) -> PlacedText {
    use Anchor::*;
    let width = text_width(t.font, &bytes, t.size);
    let (ascent, descent) = (t.font.ascent() * t.size / 1000.0, t.font.descent() * t.size / 1000.0);
    if let Some([x, y]) = t.at {
        return PlacedText {
            font: t.font,
            size: t.size,
            color: t.color.map(|c| c.clamp(0.0, 1.0)),
            opacity: t.opacity.clamp(0.0, 1.0),
            x,
            y,
            bytes,
        };
    }
    let x = match t.anchor {
        TopLeft | MiddleLeft | BottomLeft => t.margin_x,
        TopCenter | Center | BottomCenter => (w - width) / 2.0,
        TopRight | MiddleRight | BottomRight => w - t.margin_x - width,
    };
    let y = match t.anchor {
        TopLeft | TopCenter | TopRight => h - t.margin_y - ascent,
        MiddleLeft | Center | MiddleRight => (h - (ascent + descent)) / 2.0,
        BottomLeft | BottomCenter | BottomRight => t.margin_y - descent,
    };
    PlacedText {
        font: t.font,
        size: t.size,
        color: t.color.map(|c| c.clamp(0.0, 1.0)),
        opacity: t.opacity.clamp(0.0, 1.0),
        x,
        y,
        bytes,
    }
}

/// An owned copy of a dictionary held directly or by reference (empty when
/// absent or not a dictionary). The engine only ever writes such copies, so
/// an object shared with other pages or resource users is never mutated.
fn owned_dict(doc: &Document, obj: Option<&Object>) -> Dictionary {
    match obj.and_then(|o| deref(doc, o)) {
        Some(Object::Dictionary(d)) => d.clone(),
        _ => Dictionary::new(),
    }
}

/// The page's content items as a direct list. A reference to an array is
/// replaced by a copy of its items (never nested, never mutated).
fn original_contents(doc: &Document, contents: Option<&Object>) -> Vec<Object> {
    match contents {
        Some(Object::Reference(id)) => match doc.get_object(*id) {
            Ok(Object::Array(items)) => items.clone(),
            Ok(Object::Stream(_)) => vec![Object::Reference(*id)],
            _ => vec![],
        },
        Some(Object::Array(items)) => items.clone(),
        _ => vec![],
    }
}

/// `q` the original content leaves open at its end. Undecodable or oversized
/// content counts as balanced.
fn unbalanced_in(doc: &Document, items: &[Object]) -> usize {
    let mut content = Vec::new();
    let mut charged = 0;
    for item in items {
        let Some(Object::Stream(stream)) = deref(doc, item) else {
            continue;
        };
        let cap = MAX_STREAM_DECODED.saturating_sub(content.len());
        match bounded_content(stream, cap, &mut charged) {
            Some(bytes) => content.extend(bytes),
            None => return 0,
        }
        content.push(b'\n');
    }
    unbalanced_saves(&content).unwrap_or(0)
}

/// Page-local name of the ExtGState for `opacity`, creating the document
/// object on first use.
fn gs_name(
    doc: &mut Document,
    states: &mut HashMap<u64, ObjectId>,
    names: &mut HashMap<u64, Vec<u8>>,
    gs_dict: &mut Dictionary,
    opacity: f64,
) -> Vec<u8> {
    let opacity = opacity.clamp(0.0, 1.0);
    let key = opacity.to_bits();
    if let Some(n) = names.get(&key) {
        return n.clone();
    }
    let id = *states.entry(key).or_insert_with(|| {
        doc.add_object(dictionary! {
            "Type" => "ExtGState",
            "ca" => Object::Real(opacity as f32),
            "CA" => Object::Real(opacity as f32),
        })
    });
    let name = free_name(gs_dict, "MStGs");
    gs_dict.set(name.clone(), Object::Reference(id));
    names.insert(key, name.clone());
    name
}

/// First `<prefix><k>` (k = 1, 2, ...) not already in `dict`.
fn free_name(dict: &Dictionary, prefix: &str) -> Vec<u8> {
    (1u32..)
        .map(|k| format!("{prefix}{k}").into_bytes())
        .find(|n| !dict.has(n))
        .expect("a free name exists")
}

fn font_object(font: StdFont) -> Dictionary {
    dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => Object::Name(font.base_font().as_bytes().to_vec()),
        "Encoding" => "WinAnsiEncoding",
    }
}

fn lossy(name: &[u8]) -> std::borrow::Cow<'_, str> {
    String::from_utf8_lossy(name)
}

fn fmt_num(v: f64) -> String {
    let r = (v * 1e4).round() / 1e4;
    if r == 0.0 { "0".into() } else { format!("{r}") }
}

/// Append `bytes` as the body of a PDF literal string.
fn escape_literal(bytes: &[u8], out: &mut Vec<u8>) {
    for &b in bytes {
        if matches!(b, b'\\' | b'(' | b')') {
            out.push(b'\\');
        }
        out.push(b);
    }
}

fn plain_stream(content: Vec<u8>) -> Stream {
    Stream::new(Dictionary::new(), content).with_compression(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stamp::fonts::text_width;
    use crate::stamp::geometry::VisibleBox;
    use lopdf::content::Content;
    use lopdf::{Dictionary, Document, Object, ObjectId, Stream, dictionary};

    const HELLO: &str = "BT /F1 12 Tf 72 700 Td (Hello) Tj ET";

    /// A document under construction: pages are added to one /Pages node.
    struct Fixture {
        doc: Document,
        pages_id: ObjectId,
        kids: Vec<Object>,
        font_id: ObjectId,
    }

    impl Fixture {
        fn new() -> Self {
            let mut doc = Document::with_version("1.7");
            let pages_id = doc.new_object_id();
            let font_id = doc.add_object(dictionary! {
                "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Times-Roman",
            });
            Fixture { doc, pages_id, kids: vec![], font_id }
        }

        /// Page 0 0 600 800 with inline /Resources `{Font: {F1}}` unless
        /// `extra` sets /Resources itself.
        fn page(&mut self, extra: Dictionary, content: &str) -> ObjectId {
            let c = self.doc.add_object(Stream::new(Dictionary::new(), content.as_bytes().to_vec()));
            let mut page = dictionary! {
                "Type" => "Page", "Parent" => self.pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 600.into(), 800.into()],
                "Resources" => dictionary! { "Font" => dictionary! { "F1" => self.font_id } },
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
            f.page(Dictionary::new(), &format!("BT /F1 12 Tf 72 700 Td (Hello {}) Tj ET", i + 1));
        }
        f.finish()
    }

    fn text(template: &str, anchor: Anchor) -> TextStamp {
        TextStamp {
            template: template.into(),
            font: StdFont::Helvetica,
            size: 10.0,
            color: [0.0, 0.0, 0.0],
            opacity: 1.0,
            anchor,
            margin_x: 20.0,
            margin_y: 20.0,
            at: None,
            page_only: None,
        }
    }

    fn job(pages: PageSelection, texts: Vec<TextStamp>) -> StampJob {
        StampJob { pages, texts, images: vec![], number_start: 1, bates: None }
    }

    fn page_ids(doc: &Document) -> Vec<ObjectId> {
        doc.get_pages().values().copied().collect()
    }

    /// The page's content streams (decoded), in /Contents order.
    fn streams(doc: &Document, page: ObjectId) -> Vec<Vec<u8>> {
        let items = match doc.get_dictionary(page).unwrap().get(b"Contents").unwrap() {
            Object::Array(a) => a.clone(),
            Object::Reference(id) => match doc.get_object(*id).unwrap() {
                Object::Array(a) => a.clone(),
                _ => vec![Object::Reference(*id)],
            },
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

    fn tail_ops(doc: &Document, page: ObjectId) -> Vec<lopdf::content::Operation> {
        let s = streams(doc, page);
        Content::decode(s.last().unwrap()).unwrap().operations
    }

    fn nums(op: &lopdf::content::Operation) -> Vec<f64> {
        op.operands.iter().map(|o| o.as_float().unwrap() as f64).collect()
    }

    fn tj_strings(doc: &Document, page: ObjectId) -> Vec<Vec<u8>> {
        tail_ops(doc, page)
            .iter()
            .filter(|op| op.operator == "Tj")
            .map(|op| op.operands[0].as_str().unwrap().to_vec())
            .collect()
    }

    fn resolve<'a>(doc: &'a Document, obj: &'a Object) -> &'a Object {
        match obj {
            Object::Reference(id) => doc.get_object(*id).unwrap(),
            o => o,
        }
    }

    fn resources(doc: &Document, page: ObjectId) -> Dictionary {
        let res = crate::pdf_util::get_inherited_attr(doc, page, b"Resources").unwrap();
        resolve(doc, &res).as_dict().unwrap().clone()
    }

    fn category(doc: &Document, page: ObjectId, key: &[u8]) -> Dictionary {
        match resources(doc, page).get(key) {
            Ok(o) => resolve(doc, o).as_dict().unwrap().clone(),
            Err(_) => Dictionary::new(),
        }
    }

    fn load(bytes: &[u8]) -> Document {
        Document::load_mem(bytes).unwrap()
    }

    #[test]
    fn numbers_bottom_right_on_each_rotation() {
        let mut f = Fixture::new();
        for r in [0, 90, 180, 270] {
            f.page(dictionary! { "Rotate" => r }, HELLO);
        }
        let pdf = f.finish();
        let out = apply_stamps(&pdf, &job(PageSelection::All, vec![text("{n}", Anchor::BottomRight)]))
            .unwrap();
        assert_eq!(out.stamped_pages, 4);
        let doc = load(&out.bytes);
        for (i, page) in page_ids(&doc).into_iter().enumerate() {
            let vb = VisibleBox::of_page(&doc, page);
            assert_eq!(vb.width(), if i % 2 == 0 { 600.0 } else { 800.0 });
            let ops = tail_ops(&doc, page);
            let cm = nums(ops.iter().rfind(|op| op.operator == "cm").unwrap());
            let td = nums(ops.iter().find(|op| op.operator == "Td").unwrap());
            let label = format!("{}", i + 1);
            assert_eq!(tj_strings(&doc, page), vec![label.as_bytes().to_vec()]);
            let width = text_width(StdFont::Helvetica, label.as_bytes(), 10.0);
            let user = (
                cm[0] * td[0] + cm[2] * td[1] + cm[4],
                cm[1] * td[0] + cm[3] * td[1] + cm[5],
            );
            let want = vb.to_user(
                vb.width() - 20.0 - width,
                20.0 - StdFont::Helvetica.descent() * 10.0 / 1000.0,
            );
            assert!(
                (user.0 - want.0).abs() < 0.01 && (user.1 - want.1).abs() < 0.01,
                "page {} rotate {}: {user:?} != {want:?}",
                i + 1,
                vb.rotate
            );
        }
    }

    #[test]
    fn tokens_total_and_start() {
        let mut j = job(PageSelection::All, vec![text("Page {n} of {total}", Anchor::BottomCenter)]);
        j.number_start = 5;
        let out = apply_stamps(&simple_pdf(3), &j).unwrap();
        let doc = load(&out.bytes);
        let got: Vec<Vec<Vec<u8>>> = page_ids(&doc).into_iter().map(|p| tj_strings(&doc, p)).collect();
        assert_eq!(
            got,
            vec![
                vec![b"Page 5 of 3".to_vec()],
                vec![b"Page 6 of 3".to_vec()],
                vec![b"Page 7 of 3".to_vec()],
            ]
        );
    }

    #[test]
    fn selection_and_bates_counts_only_stamped() {
        let pdf = simple_pdf(5);
        let before = load(&pdf);
        let mut j = job(PageSelection::List(vec![2, 4]), vec![text("{bates}", Anchor::BottomRight)]);
        j.bates = Some(Bates { prefix: "ACME-".into(), suffix: String::new(), start: 41, digits: 6 });
        let out = apply_stamps(&pdf, &j).unwrap();
        assert_eq!(out.stamped_pages, 2);
        let doc = load(&out.bytes);
        let pages = page_ids(&doc);
        assert_eq!(tj_strings(&doc, pages[1]), vec![b"ACME-000041".to_vec()]);
        assert_eq!(tj_strings(&doc, pages[3]), vec![b"ACME-000042".to_vec()]);
        let old = page_ids(&before);
        for i in [0, 2, 4] {
            assert_eq!(
                doc.get_object(pages[i]).unwrap(),
                before.get_object(old[i]).unwrap(),
                "page {} dictionary changed",
                i + 1
            );
            assert_eq!(streams(&doc, pages[i]), streams(&before, old[i]));
        }
    }

    #[test]
    fn shared_font_dict_not_mutated() {
        let mut f = Fixture::new();
        let fonts_id = f.doc.add_object(dictionary! { "F1" => f.font_id });
        for _ in 0..2 {
            f.page(dictionary! { "Resources" => dictionary! { "Font" => fonts_id } }, HELLO);
        }
        let pdf = f.finish();
        let before = load(&pdf).get_object(fonts_id).unwrap().clone();
        let out = apply_stamps(&pdf, &job(PageSelection::List(vec![1]), vec![text("{n}", Anchor::TopLeft)]))
            .unwrap();
        let doc = load(&out.bytes);
        assert_eq!(doc.get_object(fonts_id).unwrap(), &before);
        let pages = page_ids(&doc);
        let p2 = category(&doc, pages[1], b"Font");
        assert!(p2.has(b"F1"));
        assert!(!p2.iter().any(|(k, _)| k.starts_with(b"MSt")));
        let p1 = category(&doc, pages[0], b"Font");
        assert!(p1.has(b"F1"));
        assert!(p1.iter().any(|(k, _)| k.starts_with(b"MStF")));
    }

    #[test]
    fn isolation_from_unbalanced_original() {
        let original = "q 2 0 0 2 0 0 cm BT /F1 12 Tf 10 10 Td (X) Tj ET";
        let mut f = Fixture::new();
        f.page(Dictionary::new(), original);
        let out = apply_stamps(&f.finish(), &job(PageSelection::All, vec![text("S", Anchor::Center)]))
            .unwrap();
        let doc = load(&out.bytes);
        let page = page_ids(&doc)[0];
        let s = streams(&doc, page);
        assert_eq!(s.len(), 3);
        assert_eq!(s[0], b"q\n");
        assert_eq!(s[1], original.as_bytes());
        assert!(s[2].starts_with(b"\nQ\n"), "{:?}", String::from_utf8_lossy(&s[2]));
        // Replay q/Q over the whole page: the stamp's cm runs inside only its
        // own q, every save of the original being closed.
        let all: Vec<u8> = s.join(&b'\n');
        let ops = Content::decode(&all).unwrap().operations;
        let mut depth = 0i32;
        let mut cm_depths = vec![];
        for op in &ops {
            match op.operator.as_str() {
                "q" => depth += 1,
                "Q" => depth -= 1,
                "cm" => cm_depths.push(depth),
                _ => {}
            }
        }
        assert_eq!(cm_depths, vec![2, 1]);
        assert_eq!(depth, 0);
    }

    #[test]
    fn name_collision() {
        let mut f = Fixture::new();
        let font = f.font_id;
        f.page(
            dictionary! { "Resources" => dictionary! { "Font" => dictionary! { "F1" => font, "MStF1" => font } } },
            HELLO,
        );
        let out = apply_stamps(&f.finish(), &job(PageSelection::All, vec![text("x", Anchor::Center)]))
            .unwrap();
        let doc = load(&out.bytes);
        let page = page_ids(&doc)[0];
        let ops = tail_ops(&doc, page);
        let tf = ops.iter().find(|op| op.operator == "Tf").unwrap();
        let name = tf.operands[0].as_name().unwrap();
        assert_ne!(name, b"MStF1");
        assert!(name.starts_with(b"MSt"));
        let fonts = category(&doc, page, b"Font");
        assert_eq!(fonts.get(b"MStF1").unwrap(), &Object::Reference(font));
        let ours = resolve(&doc, fonts.get(name).unwrap()).as_dict().unwrap();
        assert_eq!(ours.get(b"BaseFont").unwrap().as_name().unwrap(), b"Helvetica");
        assert_eq!(ours.get(b"Encoding").unwrap().as_name().unwrap(), b"WinAnsiEncoding");
    }

    #[test]
    fn winansi_rejected_before_write() {
        let err = apply_stamps(&simple_pdf(2), &job(PageSelection::All, vec![text("日本", Anchor::Center)]))
            .unwrap_err();
        assert!(err.contains("Characters not supported by the standard PDF fonts"), "{err}");
    }

    fn image_job(image: ImageData, page: u32) -> StampJob {
        StampJob {
            pages: PageSelection::All,
            texts: vec![],
            images: vec![ImageStamp { image, page, rect: [10.0, 20.0, 30.0, 15.0], opacity: 1.0 }],
            number_start: 1,
            bates: None,
        }
    }

    /// The image XObject drawn by the page's stamp stream.
    fn drawn_image(doc: &Document, page: ObjectId) -> lopdf::Stream {
        let ops = tail_ops(doc, page);
        let name = ops.iter().find(|op| op.operator == "Do").unwrap().operands[0].as_name().unwrap().to_vec();
        let xobjects = category(doc, page, b"XObject");
        resolve(doc, xobjects.get(&name).unwrap()).as_stream().unwrap().clone()
    }

    #[test]
    fn image_rgba_with_alpha() {
        let rgba = ImageData::Rgba { width: 2, height: 1, pixels: vec![255, 0, 0, 255, 0, 0, 255, 0] };
        let out = apply_stamps(&simple_pdf(1), &image_job(rgba, 1)).unwrap();
        let doc = load(&out.bytes);
        let page = page_ids(&doc)[0];
        let img = drawn_image(&doc, page);
        assert_eq!(img.dict.get(b"Subtype").unwrap().as_name().unwrap(), b"Image");
        assert_eq!(img.dict.get(b"ColorSpace").unwrap().as_name().unwrap(), b"DeviceRGB");
        assert_eq!(img.dict.get(b"BitsPerComponent").unwrap().as_i64().unwrap(), 8);
        assert_eq!(img.dict.get(b"Filter").unwrap().as_name().unwrap(), b"FlateDecode");
        assert_eq!(img.decompressed_content().unwrap(), vec![255, 0, 0, 0, 0, 255]);
        let smask = resolve(&doc, img.dict.get(b"SMask").unwrap()).as_stream().unwrap();
        assert_eq!(smask.dict.get(b"ColorSpace").unwrap().as_name().unwrap(), b"DeviceGray");
        assert_eq!(smask.decompressed_content().unwrap(), vec![255, 0]);
        // Placement: w 0 0 h x y cm inside the visible-space matrix.
        let ops = tail_ops(&doc, page);
        let cms: Vec<Vec<f64>> = ops.iter().filter(|op| op.operator == "cm").map(nums).collect();
        assert_eq!(cms.last().unwrap(), &vec![30.0, 0.0, 0.0, 15.0, 10.0, 20.0]);

        let opaque = ImageData::Rgba { width: 1, height: 1, pixels: vec![1, 2, 3, 255] };
        let out = apply_stamps(&simple_pdf(1), &image_job(opaque, 1)).unwrap();
        let doc = load(&out.bytes);
        let img = drawn_image(&doc, page_ids(&doc)[0]);
        assert!(!img.dict.has(b"SMask"));
    }

    fn tiny_jpeg() -> Vec<u8> {
        let mut out = Vec::new();
        jpeg_encoder::Encoder::new(&mut out, 90)
            .encode(&[200, 100, 50], 1, 1, jpeg_encoder::ColorType::Rgb)
            .unwrap();
        out
    }

    #[test]
    fn image_jpeg_passthrough() {
        let jpeg = tiny_jpeg();
        let out = apply_stamps(&simple_pdf(1), &image_job(ImageData::Jpeg(jpeg.clone()), 1)).unwrap();
        let doc = load(&out.bytes);
        let img = drawn_image(&doc, page_ids(&doc)[0]);
        assert_eq!(img.dict.get(b"Filter").unwrap().as_name().unwrap(), b"DCTDecode");
        assert_eq!(img.dict.get(b"ColorSpace").unwrap().as_name().unwrap(), b"DeviceRGB");
        assert_eq!(img.dict.get(b"Width").unwrap().as_i64().unwrap(), 1);
        assert_eq!(img.content, jpeg);
    }

    #[test]
    fn image_on_one_page_only() {
        let pdf = simple_pdf(4);
        let before = load(&pdf);
        let out = apply_stamps(&pdf, &image_job(ImageData::Jpeg(tiny_jpeg()), 3)).unwrap();
        assert_eq!(out.stamped_pages, 1);
        let doc = load(&out.bytes);
        let (pages, old) = (page_ids(&doc), page_ids(&before));
        for i in 0..4 {
            let has_image = !category(&doc, pages[i], b"XObject").is_empty();
            assert_eq!(has_image, i == 2, "page {}", i + 1);
            if i != 2 {
                assert_eq!(doc.get_object(pages[i]).unwrap(), before.get_object(old[i]).unwrap());
            }
        }
    }

    #[test]
    fn encrypted_input_refused() {
        let enc = crate::encrypt::encrypt_pdf_impl(&simple_pdf(1), "user", "owner").unwrap();
        assert!(apply_stamps(&enc, &job(PageSelection::All, vec![text("x", Anchor::Center)])).is_err());
    }

    // Beyond the brief.

    #[test]
    fn contents_reference_to_array_is_flattened() {
        let mut f = Fixture::new();
        let a = f.doc.add_object(Stream::new(Dictionary::new(), b"BT /F1 12 Tf 72 700 Td (A) Tj ET".to_vec()));
        let b = f.doc.add_object(Stream::new(Dictionary::new(), b"BT /F1 12 Tf 72 600 Td (B) Tj ET".to_vec()));
        let arr = f.doc.add_object(vec![Object::Reference(a), Object::Reference(b)]);
        f.page(dictionary! { "Contents" => arr }, "");
        f.page(dictionary! { "Contents" => arr }, "");
        let pdf = f.finish();
        let out = apply_stamps(&pdf, &job(PageSelection::List(vec![1]), vec![text("x", Anchor::Center)]))
            .unwrap();
        let doc = load(&out.bytes);
        let pages = page_ids(&doc);
        let Object::Array(items) = doc.get_dictionary(pages[0]).unwrap().get(b"Contents").unwrap() else {
            panic!("stamped /Contents must be a direct array");
        };
        assert_eq!(items.len(), 4);
        assert_eq!(&items[1..3], &[Object::Reference(a), Object::Reference(b)]);
        // The shared array object itself is untouched; page 2 still uses it.
        assert_eq!(doc.get_object(arr).unwrap().as_array().unwrap().len(), 2);
        assert_eq!(doc.get_dictionary(pages[1]).unwrap().get(b"Contents").unwrap(), &Object::Reference(arr));
    }

    #[test]
    fn inherited_resources_kept() {
        let pdf = crate::pdf_util::make_inherited_test_pdf_sized(2, 600, 800);
        let out = apply_stamps(&pdf, &job(PageSelection::All, vec![text("{n}", Anchor::TopRight)])).unwrap();
        let doc = load(&out.bytes);
        for page in page_ids(&doc) {
            let fonts = category(&doc, page, b"Font");
            assert!(fonts.has(b"F1"));
            assert!(fonts.iter().any(|(k, _)| k.starts_with(b"MStF")));
        }
    }

    #[test]
    fn one_font_and_gs_per_document_and_opacity() {
        let mut faint = text("a", Anchor::TopLeft);
        faint.opacity = 0.5;
        let texts = vec![text("b", Anchor::TopRight), faint, text("c", Anchor::BottomLeft)];
        let out = apply_stamps(&simple_pdf(3), &job(PageSelection::All, texts)).unwrap();
        let doc = load(&out.bytes);
        let count = |pred: &dyn Fn(&Dictionary) -> bool| {
            doc.objects.values().filter(|o| o.as_dict().is_ok_and(pred)).count()
        };
        let is = |d: &Dictionary, t: &[u8]| d.get(b"Type").and_then(Object::as_name).ok() == Some(t);
        assert_eq!(count(&|d| is(d, b"ExtGState")), 2);
        assert_eq!(count(&|d| is(d, b"Font") && d.get(b"BaseFont").unwrap().as_name().unwrap() == b"Helvetica"), 1);
        let gs = category(&doc, page_ids(&doc)[0], b"ExtGState");
        let opacities: Vec<f64> = gs
            .iter()
            .map(|(_, v)| resolve(&doc, v).as_dict().unwrap().get(b"ca").unwrap().as_float().unwrap() as f64)
            .collect();
        assert_eq!(opacities.len(), 2);
        assert!(opacities.contains(&0.5) && opacities.contains(&1.0));
    }

    #[test]
    fn anchors_top_and_middle() {
        let out = apply_stamps(
            &simple_pdf(1),
            &job(PageSelection::All, vec![text("ab", Anchor::TopLeft), text("ab", Anchor::Center)]),
        )
        .unwrap();
        let doc = load(&out.bytes);
        let tds: Vec<Vec<f64>> =
            tail_ops(&doc, page_ids(&doc)[0]).iter().filter(|op| op.operator == "Td").map(nums).collect();
        let (asc, desc) = (StdFont::Helvetica.ascent(), StdFont::Helvetica.descent());
        let w = text_width(StdFont::Helvetica, b"ab", 10.0);
        let close = |a: &[f64], b: [f64; 2]| (a[0] - b[0]).abs() < 0.01 && (a[1] - b[1]).abs() < 0.01;
        assert!(close(&tds[0], [20.0, 800.0 - 20.0 - asc * 10.0 / 1000.0]), "{tds:?}");
        assert!(close(&tds[1], [(600.0 - w) / 2.0, (800.0 - (asc + desc) * 10.0 / 1000.0) / 2.0]), "{tds:?}");
    }

    #[test]
    fn escapes_and_whitespace() {
        let out = apply_stamps(&simple_pdf(1), &job(PageSelection::All, vec![text("a(b)\\c\td\né", Anchor::Center)]))
            .unwrap();
        let doc = load(&out.bytes);
        assert_eq!(tj_strings(&doc, page_ids(&doc)[0]), vec![b"a(b)\\c d \xE9".to_vec()]);
    }

    #[test]
    fn out_of_range_pages_rejected() {
        assert!(apply_stamps(&simple_pdf(2), &job(PageSelection::List(vec![3]), vec![text("x", Anchor::Center)])).is_err());
        assert!(apply_stamps(&simple_pdf(2), &image_job(ImageData::Jpeg(tiny_jpeg()), 3)).is_err());
        let bad = ImageData::Rgba { width: 2, height: 2, pixels: vec![0; 3] };
        assert!(apply_stamps(&simple_pdf(2), &image_job(bad, 1)).is_err());
    }

    fn absolute(template: &str, at: [f64; 2], page: u32) -> TextStamp {
        TextStamp { at: Some(at), page_only: Some(page), ..text(template, Anchor::BottomRight) }
    }

    #[test]
    fn absolute_text_on_one_page_ignores_anchor_and_margins() {
        let pdf = simple_pdf(3);
        let before = load(&pdf);
        let out = apply_stamps(&pdf, &job(PageSelection::All, vec![absolute("Signed", [100.0, 50.0], 2)])).unwrap();
        assert_eq!(out.stamped_pages, 1);
        let doc = load(&out.bytes);
        let (pages, old) = (page_ids(&doc), page_ids(&before));
        assert_eq!(tj_strings(&doc, pages[1]), vec![b"Signed".to_vec()]);
        let td = nums(tail_ops(&doc, pages[1]).iter().find(|op| op.operator == "Td").unwrap());
        assert_eq!(td, vec![100.0, 50.0]);
        for i in [0, 2] {
            assert_eq!(doc.get_object(pages[i]).unwrap(), before.get_object(old[i]).unwrap());
        }
    }

    #[test]
    fn absolute_text_on_rotated_page_maps_through_visible_space() {
        let mut f = Fixture::new();
        f.page(dictionary! { "Rotate" => 90 }, HELLO);
        let pdf = f.finish();
        let out = apply_stamps(&pdf, &job(PageSelection::List(vec![]), vec![absolute("x", [100.0, 50.0], 1)])).unwrap();
        let doc = load(&out.bytes);
        let page = page_ids(&doc)[0];
        let vb = VisibleBox::of_page(&doc, page);
        let ops = tail_ops(&doc, page);
        let cm = nums(ops.iter().rfind(|op| op.operator == "cm").unwrap());
        let td = nums(ops.iter().find(|op| op.operator == "Td").unwrap());
        let user = (cm[0] * td[0] + cm[2] * td[1] + cm[4], cm[1] * td[0] + cm[3] * td[1] + cm[5]);
        assert_eq!(user, vb.to_user(100.0, 50.0));
        assert_eq!(user, (550.0, 100.0));
    }

    #[test]
    fn page_only_text_mixes_with_selection_and_keeps_bates_count() {
        let mut j = job(
            PageSelection::List(vec![1, 3]),
            vec![text("{bates}", Anchor::BottomRight), absolute("p{n}", [10.0, 10.0], 2)],
        );
        j.bates = Some(Bates { prefix: String::new(), suffix: String::new(), start: 7, digits: 2 });
        let out = apply_stamps(&simple_pdf(3), &j).unwrap();
        assert_eq!(out.stamped_pages, 3);
        let doc = load(&out.bytes);
        let pages = page_ids(&doc);
        assert_eq!(tj_strings(&doc, pages[0]), vec![b"07".to_vec()]);
        assert_eq!(tj_strings(&doc, pages[1]), vec![b"p2".to_vec()]);
        assert_eq!(tj_strings(&doc, pages[2]), vec![b"08".to_vec()]);
    }

    #[test]
    fn page_only_out_of_range_rejected() {
        let err = apply_stamps(&simple_pdf(2), &job(PageSelection::All, vec![absolute("x", [1.0, 1.0], 3)])).unwrap_err();
        assert!(err.contains("Page 3 does not exist"), "{err}");
        let mut t = absolute("x", [f64::NAN, 1.0], 1);
        assert!(apply_stamps(&simple_pdf(1), &job(PageSelection::All, vec![t.clone()])).is_err());
        t.at = Some([1.0, f64::INFINITY]);
        assert!(apply_stamps(&simple_pdf(1), &job(PageSelection::All, vec![t])).is_err());
    }

    #[test]
    fn visible_sizes_per_page() {
        let mut f = Fixture::new();
        f.page(Dictionary::new(), HELLO);
        f.page(dictionary! { "Rotate" => 270 }, HELLO);
        f.page(
            dictionary! { "CropBox" => vec![10.into(), 20.into(), 110.into(), 70.into()], "Rotate" => 90 },
            HELLO,
        );
        assert_eq!(
            visible_page_sizes(&f.finish()).unwrap(),
            vec![600.0, 800.0, 800.0, 600.0, 50.0, 100.0]
        );
        assert!(visible_page_sizes(b"not a pdf").is_err());
    }
}
