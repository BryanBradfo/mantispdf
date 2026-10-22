//! Content stream interpreter for redaction: decodes a page's operators and
//! walks them with the graphics and text state, reporting where every glyph,
//! path, image, shading and form lands in user space.
//!
//! Strict by design: an operator whose operands do not match what it needs,
//! a missing or unmeasurable font, or anything else that would let a viewer
//! draw somewhere we did not predict, is `Unsupported` (the page is then
//! rasterized). Operators we do not know are ignored, as viewers do.

use super::fonts::Font;
use super::{Budget, Unsupported};
pub(crate) use super::codec::{content_ops, decode_ops, encode_ops};
use crate::rebuild::{deref, name_of};
use crate::pdf_util::get_inherited_attr;
use lopdf::content::Operation;
use lopdf::{Dictionary, Document, Object};
use std::collections::HashMap;
use std::ops::Range;
use std::rc::Rc;

/// Nested `q` deeper than this is unsupported.
const MAX_SAVE_DEPTH: usize = 4096;
/// Coordinates and matrix entries past this magnitude (or not finite) make
/// the page unsupported: rounding there could hide where content lands.
const MAX_COORD: f64 = 1e9;
/// Half the width of a zero-width ("thinnest") line, user space.
const MIN_STROKE_REACH: f64 = 0.5;

/// Affine matrix `[a b c d e f]` (PDF row-vector convention).
pub(crate) type Matrix = [f64; 6];

pub(crate) const IDENTITY: Matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// `m` then `n`: the matrix of applying `m` first (PDF `m x n`).
pub(crate) fn concat(m: &Matrix, n: &Matrix) -> Matrix {
    [
        m[0] * n[0] + m[1] * n[2],
        m[0] * n[1] + m[1] * n[3],
        m[2] * n[0] + m[3] * n[2],
        m[2] * n[1] + m[3] * n[3],
        m[4] * n[0] + m[5] * n[2] + n[4],
        m[4] * n[1] + m[5] * n[3] + n[5],
    ]
}

pub(crate) fn apply(m: &Matrix, x: f64, y: f64) -> (f64, f64) {
    (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])
}

fn translate(tx: f64, ty: f64) -> Matrix {
    [1.0, 0.0, 0.0, 1.0, tx, ty]
}

/// Largest factor by which `m` stretches a length.
fn max_scale(m: &Matrix) -> f64 {
    let s = m[0] * m[0] + m[1] * m[1] + m[2] * m[2] + m[3] * m[3];
    let det = m[0] * m[3] - m[1] * m[2];
    ((s + (s * s - 4.0 * det * det).max(0.0).sqrt()) / 2.0).sqrt()
}

/// Axis-aligned rectangle, `x0 <= x1`, `y0 <= y1`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Rect {
    pub(crate) x0: f64,
    pub(crate) y0: f64,
    pub(crate) x1: f64,
    pub(crate) y1: f64,
}

impl Rect {
    fn point(x: f64, y: f64) -> Rect {
        Rect { x0: x, y0: y, x1: x, y1: y }
    }

    fn including(self, (x, y): (f64, f64)) -> Rect {
        Rect { x0: self.x0.min(x), y0: self.y0.min(y), x1: self.x1.max(x), y1: self.y1.max(y) }
    }

    fn around(points: &[(f64, f64)]) -> Option<Rect> {
        let (first, rest) = points.split_first()?;
        Some(rest.iter().fold(Rect::point(first.0, first.1), |r, p| r.including(*p)))
    }

    fn expanded(self, d: f64) -> Rect {
        Rect { x0: self.x0 - d, y0: self.y0 - d, x1: self.x1 + d, y1: self.y1 + d }
    }

    /// True when the two share an area (touching edges do not count).
    pub(crate) fn overlaps(&self, other: &Rect) -> bool {
        self.x0 < other.x1 && other.x0 < self.x1 && self.y0 < other.y1 && other.y0 < self.y1
    }
}

/// Four corners of a transformed box, in order around it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Quad(pub(crate) [(f64, f64); 4]);

impl Quad {
    fn of_box(m: &Matrix, [x0, y0, x1, y1]: [f64; 4]) -> Quad {
        Quad([(x0, y0), (x1, y0), (x1, y1), (x0, y1)].map(|(x, y)| apply(m, x, y)))
    }

    pub(crate) fn bbox(&self) -> Rect {
        Rect::around(&self.0).unwrap_or(Rect::point(0.0, 0.0))
    }

    /// True when the quad and `r` share a positive area (separating axis
    /// test over the rect's axes and the quad's edge normals).
    pub(crate) fn intersects(&self, r: &Rect) -> bool {
        let p = &self.0;
        let twice_area: f64 = (0..4).map(|i| p[i].0 * p[(i + 1) % 4].1 - p[(i + 1) % 4].0 * p[i].1).sum();
        let b = self.bbox();
        let scale = (b.x1 - b.x0).powi(2) + (b.y1 - b.y0).powi(2);
        if twice_area.abs() <= 1e-9 * scale {
            // A segment or a point (zero font size, zero scaling, singular
            // matrix): it still marks where the content is, so touching the
            // closed rect counts.
            return b.x0 <= r.x1 && r.x0 <= b.x1 && b.y0 <= r.y1 && r.y0 <= b.y1;
        }
        if !b.overlaps(r) {
            return false;
        }
        let corners = [(r.x0, r.y0), (r.x1, r.y0), (r.x1, r.y1), (r.x0, r.y1)];
        let span = |pts: &[(f64, f64); 4], (nx, ny): (f64, f64)| {
            pts.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), (x, y)| {
                let d = x * nx + y * ny;
                (lo.min(d), hi.max(d))
            })
        };
        (0..4).all(|i| {
            let normal = (p[i].1 - p[(i + 1) % 4].1, p[(i + 1) % 4].0 - p[i].0);
            let (a0, a1) = span(p, normal);
            let (b0, b1) = span(&corners, normal);
            a0 < b1 && b0 < a1
        })
    }
}

/// Something the content draws, in the order it is drawn.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Event {
    Glyph(Glyph),
    Path(PathPaint),
    Image(ImagePlacement),
    Shading(ShadingPaint),
    Form(FormPlacement),
    /// A `BDC` or `BMC` opening a marked-content sequence.
    Marked(MarkedSequence),
    /// A `gs` installing a soft mask: its group's content is drawn into the
    /// mask wherever its box lies.
    SoftMask(SoftMaskSet),
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SoftMaskSet {
    pub(crate) op_index: usize,
    /// The group's /BBox in user space; None when unknown (anywhere).
    pub(crate) bbox_user: Option<Rect>,
    /// The group form (/G) and its form space to user space matrix; None
    /// when it cannot be read.
    pub(crate) group: Option<(lopdf::ObjectId, Matrix)>,
}

/// Colour spaces in effect that paint with a Pattern.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Paint {
    pub(crate) fill_pattern: bool,
    pub(crate) stroke_pattern: bool,
}

impl Paint {
    pub(crate) fn pattern(self) -> bool {
        self.fill_pattern || self.stroke_pattern
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct MarkedSequence {
    pub(crate) op_index: usize,
    /// Op index of the enclosing sequence, if any.
    pub(crate) parent: Option<usize>,
}

/// One shown character code.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Glyph {
    /// The showing operator (`Tj`, `TJ`, `'` or `"`).
    pub(crate) op_index: usize,
    /// Index of the string in the `TJ` array; 0 for `Tj`, `'` and `"`.
    pub(crate) elem_index: usize,
    /// Bytes of the code within that string.
    pub(crate) byte_range: Range<usize>,
    pub(crate) code: u32,
    /// The box that decides whether the glyph is under an area (its advance,
    /// descent to ascent), in user space.
    pub(crate) box_user: Quad,
    /// That box widened 0.05 em each side: what the fill over a removed
    /// glyph must cover.
    pub(crate) ink_user: Quad,
    /// Tr (3 is invisible text, still a glyph to remove).
    pub(crate) render_mode: i64,
    /// w0: horizontal displacement of the glyph, em.
    pub(crate) width: f64,
    /// Tfs
    pub(crate) font_size: f64,
    /// Th = Tz / 100
    pub(crate) h_scale: f64,
    /// Tc
    pub(crate) char_spacing: f64,
    /// Tw when it applies to this code (single-byte 32), else 0.
    pub(crate) word_spacing: f64,
    /// The glyph's text, when the interpreter reports text and the font
    /// tells it.
    pub(crate) text: Option<Rc<str>>,
    /// Where the glyph starts and where its advance ends on the baseline,
    /// and the font size, all in user space.
    pub(crate) origin: (f64, f64),
    pub(crate) end: (f64, f64),
    pub(crate) em: f64,
    /// Painted with a Pattern colour (fill or stroke): its look comes from
    /// content we do not analyse.
    pub(crate) pattern: bool,
    /// Op index of the innermost enclosing `BDC`/`BMC`, if any.
    pub(crate) marked: Option<usize>,
    /// Invisible text in a GlyphLessFont: an OCR text layer over a scan.
    pub(crate) ocr_layer: bool,
}

impl Glyph {
    /// tx: how far showing this glyph moves the text matrix (text space).
    pub(crate) fn advance(&self) -> f64 {
        (self.width * self.font_size + self.char_spacing + self.word_spacing) * self.h_scale
    }

    /// The `TJ` number that moves the text matrix exactly as showing this
    /// glyph does; None when the font size or the scaling is 0 (no number
    /// can move then). Th cancels out: a number n moves by -n/1000 Tfs Th.
    /// (The text rewrite carries distances instead; tests use this.)
    #[cfg(test)]
    pub(crate) fn tj_adjustment(&self) -> Option<f64> {
        if self.font_size == 0.0 || self.h_scale == 0.0 {
            return None;
        }
        Some(-(self.width * self.font_size + self.char_spacing + self.word_spacing) * 1000.0 / self.font_size)
    }
}

/// A path from its first construction operator to its painting operator.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PathPaint {
    /// Construction, clip and painting operators (painting op included).
    pub(crate) op_range: Range<usize>,
    /// Bounds of what it may paint in user space (stroke width included);
    /// None for a path without points.
    pub(crate) bbox_user: Option<Rect>,
    /// False for `n` (clip only or nothing).
    pub(crate) painted: bool,
    /// `W` or `W*` came before the painting operator.
    pub(crate) clip: bool,
    /// One `re` (and maybe `h`) and nothing else: as a clip it carries no
    /// glyph shape (several rectangles can spell letters).
    pub(crate) single_rect: bool,
    /// Painted with a Pattern colour (fill or stroke): its look comes from
    /// content we do not analyse.
    pub(crate) pattern: bool,
    /// Op index of the innermost enclosing `BDC`/`BMC`, if any.
    pub(crate) marked: Option<usize>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum ImageSource {
    /// `/Name Do` of an image XObject.
    XObject(Vec<u8>),
    /// `BI ... ID ... EI` (the op holds the dictionary and data as a stream).
    Inline,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ImagePlacement {
    pub(crate) op_index: usize,
    pub(crate) source: ImageSource,
    /// The image's unit square in user space.
    pub(crate) quad_user: Quad,
    /// Painted with a Pattern colour (fill or stroke): its look comes from
    /// content we do not analyse.
    pub(crate) pattern: bool,
    /// Op index of the innermost enclosing `BDC`/`BMC`, if any.
    pub(crate) marked: Option<usize>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ShadingPaint {
    pub(crate) op_index: usize,
    pub(crate) name: Vec<u8>,
    /// The shading's /BBox in user space; None when it has none (it then
    /// fills the whole clip region).
    pub(crate) bbox_user: Option<Rect>,
    /// Op index of the innermost enclosing `BDC`/`BMC`, if any.
    pub(crate) marked: Option<usize>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct FormPlacement {
    pub(crate) op_index: usize,
    pub(crate) name: Vec<u8>,
    /// Form space to user space (/Matrix x CTM).
    pub(crate) matrix: Matrix,
    /// Pattern colours the form inherits.
    pub(crate) paint: Paint,
    /// Op index of the innermost enclosing `BDC`/`BMC`, if any.
    pub(crate) marked: Option<usize>,
}

/// Graphics state the interpreter tracks (text state included).
#[derive(Clone)]
struct GState {
    ctm: Matrix,
    font: Option<Rc<Font>>,
    font_size: f64,
    char_spacing: f64,
    word_spacing: f64,
    h_scale: f64,
    leading: f64,
    render_mode: i64,
    rise: f64,
    line_width: f64,
    miter_limit: f64,
    line_join: i64,
    paint: Paint,
}

impl GState {
    fn new(ctm: Matrix) -> GState {
        GState {
            ctm,
            font: None,
            font_size: 0.0,
            char_spacing: 0.0,
            word_spacing: 0.0,
            h_scale: 1.0,
            leading: 0.0,
            render_mode: 0,
            rise: 0.0,
            line_width: 1.0,
            miter_limit: 10.0,
            line_join: 0,
            paint: Paint::default(),
        }
    }

    /// How far a stroke may paint beyond its path, in user space: half the
    /// line width, times the miter limit for miter joins (square caps reach
    /// sqrt(2) half widths), at the CTM's largest scale.
    fn stroke_reach(&self) -> f64 {
        let join = if self.line_join == 0 { self.miter_limit.max(std::f64::consts::SQRT_2) } else { std::f64::consts::SQRT_2 };
        (self.line_width.abs() / 2.0 * join * max_scale(&self.ctm)).max(MIN_STROKE_REACH)
    }
}

/// A path being constructed.
struct PathBuild {
    start: usize,
    bbox: Option<Rect>,
    clip: bool,
    /// `re` operators so far.
    rects: usize,
    /// Any construction operator other than `re` (and `h`).
    shaped: bool,
}

/// Text position: Tm and Tlm.
struct TextPos {
    tm: Matrix,
    tlm: Matrix,
}

impl TextPos {
    fn move_line(&mut self, tx: f64, ty: f64) {
        self.tlm = concat(&translate(tx, ty), &self.tlm);
        self.tm = self.tlm;
    }
}

fn is_path_op(op: &str) -> bool {
    matches!(op, "m" | "l" | "c" | "v" | "y" | "h" | "re" | "W" | "W*") || paint_kind(op).is_some()
}

/// `(painted, stroked)` of a path painting operator.
fn paint_kind(op: &str) -> Option<(bool, bool)> {
    match op {
        "f" | "F" | "f*" => Some((true, false)),
        "S" | "s" | "B" | "B*" | "b" | "b*" => Some((true, true)),
        "n" => Some((false, false)),
        _ => None,
    }
}

fn in_range(values: impl IntoIterator<Item = f64>) -> Result<(), Unsupported> {
    for v in values {
        if !v.is_finite() || v.abs() > MAX_COORD {
            return Err(Unsupported::new("geometry out of range"));
        }
    }
    Ok(())
}

fn quad_values(q: &Quad) -> impl Iterator<Item = f64> + '_ {
    q.0.iter().flat_map(|&(x, y)| [x, y])
}

fn rect_values(r: &Option<Rect>) -> Vec<f64> {
    r.iter().flat_map(|r| [r.x0, r.y0, r.x1, r.y1]).collect()
}

/// Every coordinate an event places must be in range.
fn check_event(event: &Event) -> Result<(), Unsupported> {
    match event {
        Event::Glyph(g) => in_range(quad_values(&g.box_user)),
        Event::Path(p) => in_range(rect_values(&p.bbox_user)),
        Event::Image(i) => in_range(quad_values(&i.quad_user)),
        Event::Shading(s) => in_range(rect_values(&s.bbox_user)),
        Event::Form(f) => in_range(f.matrix),
        Event::Marked(_) => Ok(()),
        Event::SoftMask(m) => in_range(rect_values(&m.bbox_user)),
    }
}

fn malformed(op: &str) -> Unsupported {
    Unsupported(format!("malformed operands for {op}"))
}

fn number(obj: &Object) -> Option<f64> {
    let v = match obj {
        Object::Integer(i) => *i as f64,
        Object::Real(r) => f64::from(*r),
        _ => return None,
    };
    v.is_finite().then_some(v)
}

/// Exactly `N` numeric operands.
fn nums<const N: usize>(op: &str, args: &[Object]) -> Result<[f64; N], Unsupported> {
    if args.len() != N {
        return Err(malformed(op));
    }
    let mut out = [0.0; N];
    for (slot, arg) in out.iter_mut().zip(args) {
        *slot = number(arg).ok_or_else(|| malformed(op))?;
    }
    Ok(out)
}

fn one_name<'a>(op: &str, args: &'a [Object]) -> Result<&'a [u8], Unsupported> {
    match args {
        [Object::Name(n)] => Ok(n),
        _ => Err(malformed(op)),
    }
}

/// The page's /Resources (inherited through /Parent, references followed),
/// as an owned copy; empty when it has none.
pub(crate) fn page_resources(doc: &Document, page: lopdf::ObjectId) -> Dictionary {
    crate::page_content::owned_dict(doc, get_inherited_attr(doc, page, b"Resources").as_ref())
}

/// An owned copy of the `category` dictionary of `resources` (references
/// followed); empty when absent.
pub(crate) fn page_resources_dict(doc: &Document, resources: &Dictionary, category: &[u8]) -> Dictionary {
    crate::page_content::owned_dict(doc, resources.get(category).ok())
}

/// Walks operations against one resource dictionary.
pub(crate) struct Interp<'d> {
    doc: &'d Document,
    resources: Dictionary,
    fonts: HashMap<Vec<u8>, Rc<Font>>,
    /// Report each glyph's text (for search), through the job's cache.
    text: Option<Rc<std::cell::RefCell<super::unicode::TextCache>>>,
}

/// Per-run state.
struct Run<'b> {
    gs: GState,
    stack: Vec<GState>,
    text: TextPos,
    path: Option<PathBuild>,
    events: Vec<Event>,
    budget: &'b mut Budget,
    /// Open marked-content sequences (op indices of their `BDC`/`BMC`).
    marks: Vec<usize>,
    /// Between `BT` and `ET`.
    in_text: bool,
}

impl Run<'_> {
    fn marked(&self) -> Option<usize> {
        self.marks.last().copied()
    }

    fn emit(&mut self, event: Event) -> Result<(), Unsupported> {
        self.budget.take_event()?;
        check_event(&event)?;
        self.events.push(event);
        Ok(())
    }

    /// Add the points of construction operator `op_index`; `rect` tells
    /// whether it is `re`.
    fn add_points(&mut self, op_index: usize, points: &[(f64, f64)], rect: bool) {
        let ctm = self.gs.ctm;
        let path = self.path.get_or_insert(PathBuild { start: op_index, bbox: None, clip: false, rects: 0, shaped: false });
        if rect {
            path.rects += 1;
        } else {
            path.shaped = true;
        }
        for &(x, y) in points {
            let p = apply(&ctm, x, y);
            path.bbox = Some(path.bbox.map_or(Rect::point(p.0, p.1), |r| r.including(p)));
        }
    }

    fn paint(&mut self, op_index: usize, painted: bool, stroked: bool) -> Result<(), Unsupported> {
        let Some(path) = self.path.take() else {
            return Ok(());
        };
        let reach = self.gs.stroke_reach();
        let bbox_user = path.bbox.map(|r| if stroked { r.expanded(reach) } else { r });
        self.emit(Event::Path(PathPaint {
            op_range: path.start..op_index + 1,
            bbox_user,
            painted,
            clip: path.clip,
            single_rect: !path.shaped && path.rects == 1,
            pattern: self.gs.paint.pattern(),
            marked: self.marked(),
        }))
    }

    /// Show `bytes` (string `elem_index` of op `op_index`), moving Tm.
    fn show(&mut self, op_index: usize, elem_index: usize, bytes: &[u8]) -> Result<(), Unsupported> {
        if bytes.is_empty() {
            return Ok(());
        }
        let font = self.gs.font.clone().ok_or_else(|| Unsupported::new("text shown without a font"))?;
        let gs = &self.gs;
        let size = [gs.font_size * gs.h_scale, 0.0, 0.0, gs.font_size, 0.0, gs.rise];
        for (byte_range, code) in font.codes(bytes)? {
            let width = font.width(code)?;
            let word_spacing = if font.word_space_applies(code, byte_range.len()) { self.gs.word_spacing } else { 0.0 };
            let trm = concat(&size, &concat(&self.text.tm, &self.gs.ctm));
            let mut box_user = Quad::of_box(&trm, font.glyph_box(code, width));
            let mut ink_user = Quad::of_box(&trm, font.ink_box(code, width));
            if matches!(self.gs.render_mode, 1 | 2 | 5 | 6) {
                // Stroked outlines reach past the glyph box like a path's.
                let reach = self.gs.stroke_reach();
                let grow = |q: &Quad| {
                    let b = q.bbox().expanded(reach);
                    Quad::of_box(&IDENTITY, [b.x0, b.y0, b.x1, b.y1])
                };
                box_user = grow(&box_user);
                ink_user = grow(&ink_user);
            }
            let origin = apply(&trm, 0.0, 0.0);
            let top = apply(&trm, 0.0, 1.0);
            let mut glyph = Glyph {
                op_index,
                elem_index,
                byte_range,
                code,
                box_user,
                ink_user,
                render_mode: self.gs.render_mode,
                width,
                font_size: self.gs.font_size,
                h_scale: self.gs.h_scale,
                char_spacing: self.gs.char_spacing,
                word_spacing,
                text: font.text(code),
                origin,
                end: origin,
                em: (top.0 - origin.0).hypot(top.1 - origin.1),
                pattern: self.gs.paint.pattern(),
                marked: self.marked(),
                ocr_layer: self.gs.render_mode == 3 && font.is_glyphless(),
            };
            self.text.tm = concat(&translate(glyph.advance(), 0.0), &self.text.tm);
            glyph.end = apply(&concat(&size, &concat(&self.text.tm, &self.gs.ctm)), 0.0, 0.0);
            self.emit(Event::Glyph(glyph))?;
        }
        Ok(())
    }

    fn next_line(&mut self) {
        self.text.move_line(0.0, -self.gs.leading);
    }
}

impl<'d> Interp<'d> {
    pub(crate) fn new(doc: &'d Document, resources: Dictionary) -> Interp<'d> {
        Interp { doc, resources, fonts: HashMap::new(), text: None }
    }

    /// Also report what each glyph means as text (`Glyph::text`), with the
    /// fonts' text maps from `cache`.
    pub(crate) fn with_text(mut self, cache: Rc<std::cell::RefCell<super::unicode::TextCache>>) -> Self {
        self.text = Some(cache);
        self
    }

    /// The resource `name` of `category`, references followed.
    fn resource(&self, category: &[u8], name: &[u8]) -> Option<&Object> {
        let dict = deref(self.doc, self.resources.get(category).ok()?)?.as_dict().ok()?;
        deref(self.doc, dict.get(name).ok()?)
    }

    fn font(&mut self, name: &[u8]) -> Result<Rc<Font>, Unsupported> {
        if let Some(font) = self.fonts.get(name) {
            return Ok(font.clone());
        }
        // The entry itself (a reference keys the text cache).
        let obj = self
            .resources
            .get(b"Font")
            .ok()
            .and_then(|f| deref(self.doc, f))
            .and_then(|d| d.as_dict().ok())
            .and_then(|d| d.get(name).ok())
            .ok_or_else(|| Unsupported(format!("font {} not found", String::from_utf8_lossy(name))))?;
        let font = match &self.text {
            Some(cache) => Font::load_with(self.doc, name, obj, Some(&mut cache.borrow_mut()))?,
            None => Font::load(self.doc, name, obj)?,
        };
        let font = Rc::new(font);
        self.fonts.insert(name.to_vec(), font.clone());
        Ok(font)
    }

    /// True when colour space `name` (a family or a /ColorSpace resource)
    /// is a Pattern space.
    fn is_pattern_space(&self, name: &[u8]) -> bool {
        if name == b"Pattern" {
            return true;
        }
        match self.resource(b"ColorSpace", name) {
            Some(Object::Name(n)) => n == b"Pattern",
            Some(Object::Array(items)) => items.first().and_then(|o| o.as_name().ok()) == Some(b"Pattern"),
            _ => false,
        }
    }

    fn ext_gstate(&self, run: &mut Run, op_index: usize, name: &[u8]) -> Result<(), Unsupported> {
        let Some(Object::Dictionary(dict)) = self.resource(b"ExtGState", name) else {
            return Ok(());
        };
        if let Ok(smask) = dict.get(b"SMask")
            && deref(self.doc, smask).and_then(|o| o.as_name().ok()) != Some(b"None")
        {
            let bbox_user = self.soft_mask_box(smask, &run.gs.ctm);
            let group = self.soft_mask_group(smask, &run.gs.ctm);
            run.emit(Event::SoftMask(SoftMaskSet { op_index, bbox_user, group }))?;
        }
        let gs = &mut run.gs;
        let value = |key: &[u8]| -> Result<Option<f64>, Unsupported> {
            match dict.get(key) {
                Ok(obj) => deref(self.doc, obj).and_then(number).map(Some).ok_or_else(|| malformed("gs")),
                Err(_) => Ok(None),
            }
        };
        if dict.has(b"Font") {
            return Err(Unsupported::new("font set by a graphics state"));
        }
        if let Some(w) = value(b"LW")? {
            gs.line_width = w;
        }
        if let Some(m) = value(b"ML")? {
            gs.miter_limit = m;
        }
        if let Some(j) = value(b"LJ")? {
            gs.line_join = j as i64;
        }
        Ok(())
    }

    /// The user-space box of a soft mask's group (/G form /BBox through its
    /// /Matrix and `ctm`); None when it cannot be read.
    fn soft_mask_box(&self, smask: &Object, ctm: &Matrix) -> Option<Rect> {
        let Object::Dictionary(mask) = deref(self.doc, smask)? else {
            return None;
        };
        let Object::Stream(group) = deref(self.doc, mask.get(b"G").ok()?)? else {
            return None;
        };
        let Object::Array(items) = deref(self.doc, group.dict.get(b"BBox").ok()?)? else {
            return None;
        };
        let v: Vec<f64> = items.iter().map(|o| deref(self.doc, o).and_then(number)).collect::<Option<_>>()?;
        let [x0, y0, x1, y1] = <[f64; 4]>::try_from(v).ok()?;
        let matrix = concat(&self.matrix_of(group.dict.get(b"Matrix").ok())?, ctm);
        Some(Quad::of_box(&matrix, [x0, y0, x1, y1]).bbox())
    }

    /// The soft mask's group form and where its content lands (/Matrix x
    /// `ctm`).
    fn soft_mask_group(&self, smask: &Object, ctm: &Matrix) -> Option<(lopdf::ObjectId, Matrix)> {
        let Object::Dictionary(mask) = deref(self.doc, smask)? else {
            return None;
        };
        let id = mask.get(b"G").ok()?.as_reference().ok()?;
        let Ok(Object::Stream(group)) = self.doc.get_object(id) else {
            return None;
        };
        Some((id, concat(&self.matrix_of(group.dict.get(b"Matrix").ok())?, ctm)))
    }

    fn matrix_of(&self, obj: Option<&Object>) -> Option<Matrix> {
        let Some(obj) = obj else {
            return Some(IDENTITY);
        };
        let Object::Array(items) = deref(self.doc, obj)? else {
            return None;
        };
        let v: Vec<f64> = items.iter().map(|o| deref(self.doc, o).and_then(number)).collect::<Option<_>>()?;
        <[f64; 6]>::try_from(v).ok()
    }

    fn xobject(&self, run: &mut Run, op_index: usize, name: &[u8]) -> Result<(), Unsupported> {
        // Viewers skip a missing XObject, but a name we cannot resolve may
        // be one they can (different inheritance rules): never guess.
        let Some(Object::Stream(stream)) = self.resource(b"XObject", name) else {
            return Err(Unsupported(format!("XObject {} not found", String::from_utf8_lossy(name))));
        };
        let ctm = run.gs.ctm;
        match name_of(&stream.dict, b"Subtype") {
            Some(b"Image") => run.emit(Event::Image(ImagePlacement {
                op_index,
                source: ImageSource::XObject(name.to_vec()),
                quad_user: Quad::of_box(&ctm, [0.0, 0.0, 1.0, 1.0]),
                pattern: run.gs.paint.pattern(),
                marked: run.marked(),
            })),
            Some(b"Form") => {
                let form = self.matrix_of(stream.dict.get(b"Matrix").ok()).ok_or_else(|| malformed("Do"))?;
                let marked = run.marked();
                let paint = run.gs.paint;
                run.emit(Event::Form(FormPlacement { op_index, name: name.to_vec(), matrix: concat(&form, &ctm), paint, marked }))
            }
            Some(b"PS") => Ok(()),
            _ => Err(Unsupported(format!("XObject {} of unknown type", String::from_utf8_lossy(name)))),
        }
    }

    fn shading(&self, run: &mut Run, op_index: usize, name: &[u8]) -> Result<(), Unsupported> {
        let dict = match self.resource(b"Shading", name) {
            Some(Object::Dictionary(d)) => d,
            Some(Object::Stream(s)) => &s.dict,
            _ => return Ok(()),
        };
        let bbox = match dict.get(b"BBox").ok().and_then(|o| deref(self.doc, o)) {
            Some(Object::Array(items)) if items.len() == 4 => {
                let v: Option<Vec<f64>> = items.iter().map(|o| deref(self.doc, o).and_then(number)).collect();
                v.and_then(|v| Rect::around(&Quad::of_box(&run.gs.ctm, [v[0], v[1], v[2], v[3]]).0))
            }
            _ => None,
        };
        let marked = run.marked();
        run.emit(Event::Shading(ShadingPaint { op_index, name: name.to_vec(), bbox_user: bbox, marked }))
    }

    /// Events of `ops` drawn with the initial CTM `ctm`.
    pub(crate) fn run(&mut self, ops: &[Operation], ctm: Matrix, budget: &mut Budget) -> Result<Vec<Event>, Unsupported> {
        self.run_inherited(ops, ctm, Paint::default(), budget)
    }

    /// `run` for a form's content: it starts with the pattern colours of
    /// its placement.
    pub(crate) fn run_inherited(&mut self, ops: &[Operation], ctm: Matrix, paint: Paint, budget: &mut Budget) -> Result<Vec<Event>, Unsupported> {
        let mut gs = GState::new(ctm);
        gs.paint = paint;
        let mut run = Run {
            gs,
            stack: Vec::new(),
            text: TextPos { tm: IDENTITY, tlm: IDENTITY },
            path: None,
            events: Vec::new(),
            budget,
            marks: Vec::new(),
            in_text: false,
        };
        for (i, op) in ops.iter().enumerate() {
            run.budget.take_op()?;
            self.step(&mut run, i, op)?;
            in_range(run.gs.ctm.into_iter().chain(run.text.tm).chain(run.text.tlm))?;
        }
        Ok(run.events)
    }

    fn step(&mut self, run: &mut Run, i: usize, op: &Operation) -> Result<(), Unsupported> {
        let o = op.operator.as_str();
        let args = op.operands.as_slice();
        if run.path.is_some() && !is_path_op(o) {
            return Err(Unsupported(format!("operator {o} inside a path")));
        }
        match o {
            "q" => {
                if run.stack.len() >= MAX_SAVE_DEPTH {
                    return Err(Unsupported::new("graphics states nest too deep"));
                }
                run.stack.push(run.gs.clone());
            }
            "Q" => {
                if let Some(saved) = run.stack.pop() {
                    run.gs = saved;
                }
            }
            "cm" => {
                let m = nums::<6>(o, args)?;
                run.gs.ctm = concat(&m, &run.gs.ctm);
            }
            "w" => run.gs.line_width = nums::<1>(o, args)?[0],
            "M" => run.gs.miter_limit = nums::<1>(o, args)?[0],
            "j" => run.gs.line_join = nums::<1>(o, args)?[0] as i64,
            "gs" => self.ext_gstate(run, i, one_name(o, args)?)?,
            "cs" | "CS" => {
                let pattern = self.is_pattern_space(one_name(o, args)?);
                if o == "cs" {
                    run.gs.paint.fill_pattern = pattern;
                } else {
                    run.gs.paint.stroke_pattern = pattern;
                }
            }
            // A name operand selects a pattern.
            "scn" if matches!(args.last(), Some(Object::Name(_))) => run.gs.paint.fill_pattern = true,
            "SCN" if matches!(args.last(), Some(Object::Name(_))) => run.gs.paint.stroke_pattern = true,
            "g" | "rg" | "k" => run.gs.paint.fill_pattern = false,
            "G" | "RG" | "K" => run.gs.paint.stroke_pattern = false,
            "m" | "l" => {
                let [x, y] = nums::<2>(o, args)?;
                run.add_points(i, &[(x, y)], false);
            }
            "c" => {
                let [x1, y1, x2, y2, x3, y3] = nums::<6>(o, args)?;
                run.add_points(i, &[(x1, y1), (x2, y2), (x3, y3)], false);
            }
            "v" | "y" => {
                let [x1, y1, x2, y2] = nums::<4>(o, args)?;
                run.add_points(i, &[(x1, y1), (x2, y2)], false);
            }
            "re" => {
                let [x, y, w, h] = nums::<4>(o, args)?;
                run.add_points(i, &[(x, y), (x + w, y), (x + w, y + h), (x, y + h)], true);
            }
            "h" => {}
            "W" | "W*" => {
                if let Some(path) = run.path.as_mut() {
                    path.clip = true;
                }
            }
            "BT" => {
                run.text = TextPos { tm: IDENTITY, tlm: IDENTITY };
                run.in_text = true;
            }
            "ET" => run.in_text = false,
            // Viewers differ on text shown outside a text object.
            "Tj" | "TJ" | "'" | "\"" if !run.in_text => {
                return Err(Unsupported::new("text shown outside BT/ET"));
            }
            "Tc" => run.gs.char_spacing = nums::<1>(o, args)?[0],
            "Tw" => run.gs.word_spacing = nums::<1>(o, args)?[0],
            "Tz" => run.gs.h_scale = nums::<1>(o, args)?[0] / 100.0,
            "TL" => run.gs.leading = nums::<1>(o, args)?[0],
            "Ts" => run.gs.rise = nums::<1>(o, args)?[0],
            "Tr" => {
                let mode = nums::<1>(o, args)?[0];
                if mode.fract() != 0.0 || !(0.0..=7.0).contains(&mode) {
                    return Err(malformed(o));
                }
                run.gs.render_mode = mode as i64;
            }
            "Tf" => {
                let [Object::Name(name), size] = args else {
                    return Err(malformed(o));
                };
                let size = number(size).ok_or_else(|| malformed(o))?;
                run.gs.font = Some(self.font(name)?);
                run.gs.font_size = size;
            }
            "Td" => {
                let [tx, ty] = nums::<2>(o, args)?;
                run.text.move_line(tx, ty);
            }
            "TD" => {
                let [tx, ty] = nums::<2>(o, args)?;
                run.gs.leading = -ty;
                run.text.move_line(tx, ty);
            }
            "Tm" => {
                let m = nums::<6>(o, args)?;
                run.text = TextPos { tm: m, tlm: m };
            }
            "T*" => {
                if !args.is_empty() {
                    return Err(malformed(o));
                }
                run.next_line();
            }
            "Tj" | "'" => {
                let [Object::String(bytes, _)] = args else {
                    return Err(malformed(o));
                };
                if o == "'" {
                    run.next_line();
                }
                run.show(i, 0, bytes)?;
            }
            "\"" => {
                let [aw, ac, Object::String(bytes, _)] = args else {
                    return Err(malformed(o));
                };
                run.gs.word_spacing = number(aw).ok_or_else(|| malformed(o))?;
                run.gs.char_spacing = number(ac).ok_or_else(|| malformed(o))?;
                run.next_line();
                run.show(i, 0, bytes)?;
            }
            "TJ" => {
                let [Object::Array(items)] = args else {
                    return Err(malformed(o));
                };
                for (k, item) in items.iter().enumerate() {
                    match item {
                        Object::String(bytes, _) => run.show(i, k, bytes)?,
                        other => {
                            let n = number(other).ok_or_else(|| malformed(o))?;
                            let tx = -n / 1000.0 * run.gs.font_size * run.gs.h_scale;
                            run.text.tm = concat(&translate(tx, 0.0), &run.text.tm);
                        }
                    }
                }
            }
            "BMC" | "BDC" => {
                let well_formed = match args {
                    [Object::Name(_)] => o == "BMC",
                    [Object::Name(_), Object::Dictionary(_) | Object::Name(_)] => o == "BDC",
                    _ => false,
                };
                if !well_formed {
                    return Err(malformed(o));
                }
                let parent = run.marked();
                run.emit(Event::Marked(MarkedSequence { op_index: i, parent }))?;
                run.marks.push(i);
            }
            "EMC" => {
                run.marks.pop();
            }
            "Do" => self.xobject(run, i, one_name(o, args)?)?,
            "sh" => self.shading(run, i, one_name(o, args)?)?,
            "BI" => {
                let quad_user = Quad::of_box(&run.gs.ctm, [0.0, 0.0, 1.0, 1.0]);
                let marked = run.marked();
                let pattern = run.gs.paint.pattern();
                run.emit(Event::Image(ImagePlacement { op_index: i, source: ImageSource::Inline, quad_user, pattern, marked }))?;
            }
            _ => {
                if let Some((painted, stroked)) = paint_kind(o) {
                    run.paint(i, painted, stroked)?;
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "interp_tests.rs"]
mod tests;
