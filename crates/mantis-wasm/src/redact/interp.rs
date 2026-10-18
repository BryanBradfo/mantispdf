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
use crate::rebuild::{
    Decoded, MAX_STREAM_DECODED, decode_complete, decode_inline_dict, deref, inline_image_extent, is_pdf_regular,
    name_of, skip_literal_string, strict_content_in,
};
use lopdf::content::Operation;
use lopdf::{Dictionary, Document, Object, Stream};
use std::collections::HashMap;
use std::ops::Range;
use std::rc::Rc;

/// Nested `q` deeper than this is unsupported.
const MAX_SAVE_DEPTH: usize = 4096;
/// `[` / `<<` nesting deeper than this is unsupported (the parser recurses).
const MAX_NESTING: usize = 64;
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
        if twice_area.abs() < 1e-12 || !self.bbox().overlaps(r) {
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
    /// The box the glyph may ink, in user space.
    pub(crate) box_user: Quad,
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
}

impl Glyph {
    /// tx: how far showing this glyph moves the text matrix (text space).
    pub(crate) fn advance(&self) -> f64 {
        (self.width * self.font_size + self.char_spacing + self.word_spacing) * self.h_scale
    }

    /// The `TJ` number that moves the text matrix exactly as showing this
    /// glyph does; None when the font size or the scaling is 0 (no number
    /// can move then). Th cancels out: a number n moves by -n/1000 Tfs Th.
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
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ShadingPaint {
    pub(crate) op_index: usize,
    pub(crate) name: Vec<u8>,
    /// The shading's /BBox in user space; None when it has none (it then
    /// fills the whole clip region).
    pub(crate) bbox_user: Option<Rect>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct FormPlacement {
    pub(crate) op_index: usize,
    pub(crate) name: Vec<u8>,
    /// Form space to user space (/Matrix x CTM).
    pub(crate) matrix: Matrix,
}

fn unparsable() -> Unsupported {
    Unsupported::new("content cannot be parsed")
}

/// Decode content into operations; inline images become one `BI` operation
/// whose single operand is a stream (dictionary + raw data). Errors when
/// any byte cannot be parsed or `[` / `<<` nest too deep.
pub(crate) fn decode_ops(c: &[u8]) -> Result<Vec<Operation>, Unsupported> {
    let mut ops = Vec::new();
    let mut segment_start = 0;
    let mut depth = 0usize;
    let enter = |depth: &mut usize| {
        *depth += 1;
        if *depth > MAX_NESTING { Err(Unsupported::new("content nests too deep")) } else { Ok(()) }
    };
    let mut i = 0;
    while i < c.len() {
        match c[i] {
            b'[' => {
                enter(&mut depth)?;
                i += 1;
            }
            b'<' if c.get(i + 1) == Some(&b'<') => {
                enter(&mut depth)?;
                i += 2;
            }
            b']' => {
                depth = depth.saturating_sub(1);
                i += 1;
            }
            b'>' if c.get(i + 1) == Some(&b'>') => {
                depth = depth.saturating_sub(1);
                i += 2;
            }
            b'%' => {
                while i < c.len() && c[i] != b'\n' && c[i] != b'\r' {
                    i += 1;
                }
            }
            b'(' => i = skip_literal_string(c, i),
            b'<' => {
                while i < c.len() && c[i] != b'>' {
                    i += 1;
                }
                i += 1;
            }
            b'/' => {
                i += 1;
                while i < c.len() && is_pdf_regular(c[i]) {
                    i += 1;
                }
            }
            b if is_pdf_regular(b) => {
                let start = i;
                while i < c.len() && is_pdf_regular(c[i]) {
                    i += 1;
                }
                if &c[start..i] == b"BI" {
                    let (dict_tokens, end) = inline_image_extent(c, i).ok_or_else(unparsable)?;
                    ops.extend(decode_complete(&c[segment_start..start]).ok_or_else(unparsable)?);
                    let dict = decode_inline_dict(dict_tokens).ok_or_else(unparsable)?;
                    // `ID`, one whitespace byte, data, whitespace, `EI`.
                    let data_start = i + dict_tokens.len() + 3;
                    let mut image = Stream::new(dict, c[data_start..end - 3].to_vec());
                    image.dict.remove(b"Length");
                    ops.push(Operation::new("BI", vec![Object::Stream(image)]));
                    segment_start = end;
                    i = end;
                }
            }
            _ => i += 1,
        }
    }
    ops.extend(decode_complete(&c[segment_start..]).ok_or_else(unparsable)?);
    Ok(ops)
}

/// The operations of content `items` (streams, direct or by reference),
/// concatenated. Decoding is charged to `budget.decoded`.
pub(crate) fn content_ops(doc: &Document, items: &[Object], budget: &mut Budget) -> Result<Vec<Operation>, Unsupported> {
    let mut content = Vec::new();
    for item in items {
        let Some(Object::Stream(stream)) = deref(doc, item) else {
            continue;
        };
        let mut charged = 0;
        let decoded = strict_content_in(Some(doc), stream, MAX_STREAM_DECODED.min(budget.decoded), &mut charged);
        budget.decoded = budget.decoded.saturating_sub(charged);
        match decoded {
            Decoded::Content(bytes) => {
                content.extend(bytes);
                content.push(b'\n');
            }
            Decoded::TooLarge => return Err(Unsupported::new("content too large")),
            Decoded::Failed => return Err(Unsupported::new("content cannot be decoded")),
        }
    }
    decode_ops(&content)
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

/// Walks operations against one resource dictionary.
pub(crate) struct Interp<'d> {
    doc: &'d Document,
    resources: Dictionary,
    fonts: HashMap<Vec<u8>, Rc<Font>>,
}

/// Per-run state.
struct Run<'b> {
    gs: GState,
    stack: Vec<GState>,
    text: TextPos,
    path: Option<PathBuild>,
    events: Vec<Event>,
    budget: &'b mut Budget,
}

impl Run<'_> {
    fn emit(&mut self, event: Event) -> Result<(), Unsupported> {
        self.budget.take_event()?;
        self.events.push(event);
        Ok(())
    }

    fn add_points(&mut self, op_index: usize, points: &[(f64, f64)]) {
        let ctm = self.gs.ctm;
        let path = self.path.get_or_insert(PathBuild { start: op_index, bbox: None, clip: false });
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
        self.emit(Event::Path(PathPaint { op_range: path.start..op_index + 1, bbox_user, painted, clip: path.clip }))
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
            let glyph = Glyph {
                op_index,
                elem_index,
                byte_range,
                code,
                box_user: Quad::of_box(&trm, font.glyph_box(width)),
                render_mode: self.gs.render_mode,
                width,
                font_size: self.gs.font_size,
                h_scale: self.gs.h_scale,
                char_spacing: self.gs.char_spacing,
                word_spacing,
            };
            self.text.tm = concat(&translate(glyph.advance(), 0.0), &self.text.tm);
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
        Interp { doc, resources, fonts: HashMap::new() }
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
        let obj = self
            .resource(b"Font", name)
            .ok_or_else(|| Unsupported(format!("font {} not found", String::from_utf8_lossy(name))))?;
        let font = Rc::new(Font::load(self.doc, name, obj)?);
        self.fonts.insert(name.to_vec(), font.clone());
        Ok(font)
    }

    fn ext_gstate(&self, name: &[u8], gs: &mut GState) -> Result<(), Unsupported> {
        let Some(Object::Dictionary(dict)) = self.resource(b"ExtGState", name) else {
            return Ok(());
        };
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
        let Some(Object::Stream(stream)) = self.resource(b"XObject", name) else {
            return Ok(());
        };
        let ctm = run.gs.ctm;
        match name_of(&stream.dict, b"Subtype") {
            Some(b"Image") => run.emit(Event::Image(ImagePlacement {
                op_index,
                source: ImageSource::XObject(name.to_vec()),
                quad_user: Quad::of_box(&ctm, [0.0, 0.0, 1.0, 1.0]),
            })),
            Some(b"Form") => {
                let form = self.matrix_of(stream.dict.get(b"Matrix").ok()).ok_or_else(|| malformed("Do"))?;
                run.emit(Event::Form(FormPlacement { op_index, name: name.to_vec(), matrix: concat(&form, &ctm) }))
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
        run.emit(Event::Shading(ShadingPaint { op_index, name: name.to_vec(), bbox_user: bbox }))
    }

    /// Events of `ops` drawn with the initial CTM `ctm`.
    pub(crate) fn run(&mut self, ops: &[Operation], ctm: Matrix, budget: &mut Budget) -> Result<Vec<Event>, Unsupported> {
        let mut run = Run {
            gs: GState::new(ctm),
            stack: Vec::new(),
            text: TextPos { tm: IDENTITY, tlm: IDENTITY },
            path: None,
            events: Vec::new(),
            budget,
        };
        for (i, op) in ops.iter().enumerate() {
            run.budget.take_op()?;
            self.step(&mut run, i, op)?;
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
            "gs" => self.ext_gstate(one_name(o, args)?, &mut run.gs)?,
            "m" | "l" => {
                let [x, y] = nums::<2>(o, args)?;
                run.add_points(i, &[(x, y)]);
            }
            "c" => {
                let [x1, y1, x2, y2, x3, y3] = nums::<6>(o, args)?;
                run.add_points(i, &[(x1, y1), (x2, y2), (x3, y3)]);
            }
            "v" | "y" => {
                let [x1, y1, x2, y2] = nums::<4>(o, args)?;
                run.add_points(i, &[(x1, y1), (x2, y2)]);
            }
            "re" => {
                let [x, y, w, h] = nums::<4>(o, args)?;
                run.add_points(i, &[(x, y), (x + w, y), (x + w, y + h), (x, y + h)]);
            }
            "h" => {}
            "W" | "W*" => {
                if let Some(path) = run.path.as_mut() {
                    path.clip = true;
                }
            }
            "BT" => run.text = TextPos { tm: IDENTITY, tlm: IDENTITY },
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
            "Do" => self.xobject(run, i, one_name(o, args)?)?,
            "sh" => self.shading(run, i, one_name(o, args)?)?,
            "BI" => {
                let quad_user = Quad::of_box(&run.gs.ctm, [0.0, 0.0, 1.0, 1.0]);
                run.emit(Event::Image(ImagePlacement { op_index: i, source: ImageSource::Inline, quad_user }))?;
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
mod tests {
    use super::*;
    use crate::redact::MAX_PAGE_EVENTS;
    use lopdf::{Stream, dictionary};

    const EPS: f64 = 1e-9;

    /// F1: TrueType with /Widths 32..=90 (space 250, A 500, B 600, C 700,
    /// others 400), no descriptor.
    fn simple_font() -> Dictionary {
        let widths: Vec<Object> = (32..=90)
            .map(|c| match c {
                32 => 250,
                65 => 500,
                66 => 600,
                67 => 700,
                _ => 400,
            })
            .map(Object::Integer)
            .collect();
        dictionary! {
            "Type" => "Font", "Subtype" => "TrueType", "BaseFont" => "Embedded",
            "FirstChar" => 32, "LastChar" => 90, "Widths" => widths,
        }
    }

    fn type0(doc: &mut Document, encoding: Object) -> Dictionary {
        let descriptor = doc.add_object(dictionary! {
            "Type" => "FontDescriptor", "FontName" => "CID", "Ascent" => 800, "Descent" => -200,
        });
        let w: Vec<Object> = vec![
            1.into(),
            Object::Array(vec![500.into(), 600.into()]),
            10.into(),
            20.into(),
            700.into(),
        ];
        let cid = doc.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "CIDFontType2", "BaseFont" => "CID",
            "W" => w, "DW" => 1000, "FontDescriptor" => descriptor,
        });
        dictionary! {
            "Type" => "Font", "Subtype" => "Type0", "BaseFont" => "CID",
            "Encoding" => encoding, "DescendantFonts" => vec![cid.into()],
        }
    }

    fn std_font(base: &str, encoding: Option<&str>) -> Dictionary {
        let mut d = dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => base };
        if let Some(e) = encoding {
            d.set("Encoding", Object::Name(e.as_bytes().to_vec()));
        }
        d
    }

    fn type3() -> Dictionary {
        let reals = |v: &[f64]| Object::Array(v.iter().map(|n| Object::Real(*n as f32)).collect());
        dictionary! {
            "Type" => "Font", "Subtype" => "Type3",
            "FontMatrix" => reals(&[0.5, 0.0, 0.0, 0.5, 0.0, 0.0]),
            "FontBBox" => reals(&[0.0, -1.0, 2.0, 3.0]),
            "FirstChar" => 65, "LastChar" => 66, "Widths" => vec![1.into(), 2.into()],
            "CharProcs" => dictionary! {},
            "Encoding" => dictionary! { "Type" => "Encoding", "Differences" => vec![65.into(), "a".into(), "b".into()] },
        }
    }

    fn fixture() -> (Document, Dictionary) {
        let mut doc = Document::with_version("1.7");
        let f1 = doc.add_object(simple_font());
        let f2 = type0(&mut doc, "Identity-H".into());
        let f3 = type0(&mut doc, "Identity-V".into());
        let f4 = type0(&mut doc, "UniGB-UCS2-H".into());
        let cmap = doc.add_object(Stream::new(dictionary! { "Type" => "CMap" }, b"begincmap endcmap".to_vec()));
        let f5 = type0(&mut doc, cmap.into());
        let im = doc.add_object(Stream::new(
            dictionary! { "Type" => "XObject", "Subtype" => "Image", "Width" => 1, "Height" => 1 },
            vec![0],
        ));
        let fm = doc.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Form", "BBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
                "Matrix" => vec![1.into(), 0.into(), 0.into(), 1.into(), 5.into(), 5.into()],
            },
            b"0 0 m".to_vec(),
        ));
        let resources = dictionary! {
            "Font" => dictionary! {
                "F1" => f1, "F2" => f2, "F3" => f3, "F4" => f4, "F5" => f5,
                "H" => std_font("Helvetica", Some("WinAnsiEncoding")),
                "HS" => std_font("Helvetica", None),
                "HO" => std_font("Helvetica-Oblique", Some("WinAnsiEncoding")),
                "Sym" => std_font("Symbol", None),
                "T3" => type3(),
            },
            "XObject" => dictionary! { "Im1" => im, "Fm1" => fm },
            "Shading" => dictionary! {
                "Sh1" => dictionary! { "ShadingType" => 2, "BBox" => vec![0.into(), 0.into(), 10.into(), 10.into()] },
                "Sh2" => dictionary! { "ShadingType" => 2 },
            },
            "ExtGState" => dictionary! { "G1" => dictionary! { "LW" => 4 } },
        };
        (doc, resources)
    }

    fn events_with(content: &str, budget: &mut Budget) -> Result<Vec<Event>, Unsupported> {
        let (doc, resources) = fixture();
        let ops = decode_ops(content.as_bytes())?;
        Interp::new(&doc, resources).run(&ops, IDENTITY, budget)
    }

    fn events(content: &str) -> Result<Vec<Event>, Unsupported> {
        events_with(content, &mut Budget::page(1 << 20))
    }

    fn glyphs(content: &str) -> Vec<Glyph> {
        events(content)
            .unwrap()
            .into_iter()
            .filter_map(|e| match e {
                Event::Glyph(g) => Some(g),
                _ => None,
            })
            .collect()
    }

    fn assert_quad(q: &Quad, expected: [(f64, f64); 4]) {
        for (got, want) in q.0.iter().zip(expected) {
            assert!(
                (got.0 - want.0).abs() < EPS && (got.1 - want.1).abs() < EPS,
                "{q:?} != {expected:?}"
            );
        }
    }

    /// Box of a glyph from x0..x1 on the baseline y with the 0.9/-0.2 em
    /// fallback at size 10.
    fn upright(x0: f64, x1: f64, y: f64) -> [(f64, f64); 4] {
        [(x0, y - 2.0), (x1, y - 2.0), (x1, y + 9.0), (x0, y + 9.0)]
    }

    fn unsupported(content: &str) -> String {
        match events(content) {
            Err(Unsupported(reason)) => reason,
            Ok(ev) => panic!("{content}: expected Unsupported, got {ev:?}"),
        }
    }

    #[test]
    fn td_and_tj_advance_with_char_word_spacing_and_scaling() {
        let g = glyphs("BT /F1 10 Tf 2 Tc 3 Tw 50 Tz 100 200 Td (A B) Tj ET");
        assert_eq!(g.len(), 3);
        assert_eq!(g.iter().map(|g| g.code).collect::<Vec<_>>(), vec![65, 32, 66]);
        assert_eq!(g.iter().map(|g| g.byte_range.clone()).collect::<Vec<_>>(), vec![0..1, 1..2, 2..3]);
        assert!(g.iter().all(|g| g.op_index == 6 && g.elem_index == 0 && g.render_mode == 0));
        // Th = 0.5: A advances (5 + 2) * 0.5 = 3.5; space (2.5 + 2 + 3) * 0.5 = 3.75.
        assert_quad(&g[0].box_user, upright(100.0, 102.5, 200.0));
        assert_quad(&g[1].box_user, upright(103.5, 104.75, 200.0));
        assert_quad(&g[2].box_user, upright(107.25, 110.25, 200.0));
        assert_eq!((g[0].width, g[0].font_size, g[0].h_scale, g[0].char_spacing), (0.5, 10.0, 0.5, 2.0));
        assert_eq!((g[0].word_spacing, g[1].word_spacing, g[2].word_spacing), (0.0, 3.0, 0.0));
        assert_eq!((g[0].advance(), g[1].advance()), (3.5, 3.75));
    }

    #[test]
    fn tj_numbers_move_the_text_position() {
        let g = glyphs("BT /F1 10 Tf [(A) -500 (B) 250 (C)] TJ ET");
        assert_eq!(g.iter().map(|g| g.elem_index).collect::<Vec<_>>(), vec![0, 2, 4]);
        assert!(g.iter().all(|g| g.op_index == 2));
        assert_quad(&g[0].box_user, upright(0.0, 5.0, 0.0));
        assert_quad(&g[1].box_user, upright(10.0, 16.0, 0.0));
        assert_quad(&g[2].box_user, upright(13.5, 20.5, 0.0));
    }

    #[test]
    fn quote_operators_move_to_the_next_line_and_set_spacing() {
        let g = glyphs("BT /F1 10 Tf 12 TL 0 100 Td (A) ' (B) Tj 5 1 (C ) \" (A) Tj ET");
        assert_eq!(g.iter().map(|g| g.op_index).collect::<Vec<_>>(), vec![4, 5, 6, 6, 7]);
        assert_quad(&g[0].box_user, upright(0.0, 5.0, 88.0));
        assert_quad(&g[1].box_user, upright(5.0, 11.0, 88.0));
        // `"` sets Tw 5 and Tc 1 before showing.
        assert_quad(&g[2].box_user, upright(0.0, 7.0, 76.0));
        assert_eq!((g[2].char_spacing, g[3].word_spacing), (1.0, 5.0));
        assert_quad(&g[3].box_user, upright(8.0, 10.5, 76.0));
        assert_quad(&g[4].box_user, upright(16.5, 21.5, 76.0));
        assert_eq!(g[2].elem_index, 0);
    }

    #[test]
    fn td_capital_sets_leading_and_t_star_uses_it() {
        let g = glyphs("BT /F1 10 Tf 10 50 TD (A) Tj T* (B) Tj ET");
        assert_quad(&g[0].box_user, upright(10.0, 15.0, 50.0));
        // TL = -50: T* moves by +50.
        assert_quad(&g[1].box_user, upright(10.0, 16.0, 100.0));
    }

    #[test]
    fn ctm_scaling_and_rotation_with_save_restore() {
        let g = glyphs("q 3 0 0 3 0 0 cm Q 2 0 0 2 0 0 cm 0 1 -1 0 100 0 cm BT /F1 10 Tf (A) Tj ET");
        assert_quad(&g[0].box_user, [(204.0, 0.0), (204.0, 10.0), (182.0, 10.0), (182.0, 0.0)]);
    }

    #[test]
    fn tm_with_shear_and_td_relative_to_line_matrix() {
        let g = glyphs("BT /F1 10 Tf 1 0 0.5 1 10 20 Tm (A) Tj 0 -10 Td (B) Tj ET");
        assert_quad(&g[0].box_user, [(9.0, 18.0), (14.0, 18.0), (19.5, 29.0), (14.5, 29.0)]);
        assert_quad(&g[1].box_user, [(4.0, 8.0), (10.0, 8.0), (15.5, 19.0), (9.5, 19.0)]);
    }

    #[test]
    fn rise_shifts_the_glyph_box() {
        let g = glyphs("BT /F1 10 Tf 3 Ts 1 0 0.5 1 10 20 Tm (A) Tj ET");
        assert_quad(&g[0].box_user, [(10.5, 21.0), (15.5, 21.0), (21.0, 32.0), (16.0, 32.0)]);
    }

    #[test]
    fn text_state_is_saved_and_restored() {
        let g = glyphs("BT /F1 10 Tf q 3 Tr 5 Tc /F1 20 Tf Q (AB) Tj ET");
        assert_eq!(g[0].render_mode, 0);
        assert_quad(&g[1].box_user, upright(5.0, 11.0, 0.0));
    }

    #[test]
    fn invisible_text_is_reported_with_its_mode() {
        let g = glyphs("BT /F1 10 Tf 3 Tr (A) Tj ET");
        assert_eq!(g[0].render_mode, 3);
        assert_quad(&g[0].box_user, upright(0.0, 5.0, 0.0));
    }

    #[test]
    fn identity_h_two_byte_codes_with_w_ranges() {
        let g = glyphs("BT /F2 10 Tf 3 Tw <00010002000F00300020> Tj ET");
        assert_eq!(g.iter().map(|g| g.code).collect::<Vec<_>>(), vec![1, 2, 15, 48, 32]);
        assert_eq!(g.iter().map(|g| g.byte_range.clone()).collect::<Vec<_>>(), vec![0..2, 2..4, 4..6, 6..8, 8..10]);
        assert_eq!(g.iter().map(|g| g.width).collect::<Vec<_>>(), vec![0.5, 0.6, 0.7, 1.0, 1.0]);
        // Descriptor ascent 0.8 / descent -0.2; Tw never applies to 2-byte codes.
        let xs = [0.0, 5.0, 11.0, 18.0, 28.0];
        for (glyph, x) in g.iter().zip(xs) {
            let x1 = x + glyph.width * 10.0;
            assert_quad(&glyph.box_user, [(x, -2.0), (x1, -2.0), (x1, 8.0), (x, 8.0)]);
            assert_eq!(glyph.word_spacing, 0.0);
        }
    }

    #[test]
    fn identity_h_odd_byte_count_is_unsupported() {
        unsupported("BT /F2 10 Tf <000100> Tj ET");
    }

    #[test]
    fn standard_helvetica_without_widths_uses_afm() {
        let g = glyphs("BT /H 10 Tf (Hi') Tj ET");
        // WinAnsi: H 722, i 222, quotesingle 191.
        let widths: Vec<f64> = g.iter().map(|g| g.width).collect();
        assert!((widths[0] - 0.722).abs() < EPS && (widths[1] - 0.222).abs() < EPS && (widths[2] - 0.191).abs() < EPS);
        assert_quad(&g[1].box_user, upright(7.22, 9.44, 0.0));
        assert_quad(&g[2].box_user, upright(9.44, 11.35, 0.0));
        // Oblique shares the upright widths.
        assert!((glyphs("BT /HO 10 Tf (H) Tj ET")[0].width - 0.722).abs() < EPS);
    }

    #[test]
    fn standard_encoding_maps_quotes_and_rejects_unknown_codes() {
        // StandardEncoding 0x27 is quoteright (222), 0x60 quoteleft (222).
        let g = glyphs("BT /HS 10 Tf (`') Tj ET");
        assert!((g[0].width - 0.222).abs() < EPS && (g[1].width - 0.222).abs() < EPS);
        unsupported("BT /HS 10 Tf (\\351) Tj ET");
    }

    #[test]
    fn standard_font_without_metrics_is_unsupported() {
        unsupported("BT /Sym 10 Tf (a) Tj ET");
    }

    #[test]
    fn type3_fonts_are_unsupported() {
        // Glyph procedures can paint anywhere; such pages are rasterized.
        assert!(unsupported("BT /T3 10 Tf (AB) Tj ET").contains("Type3"));
    }

    #[test]
    fn vertical_and_other_cmaps_are_unsupported() {
        assert!(unsupported("BT /F3 10 Tf <0001> Tj ET").contains("vertical"), "Identity-V");
        assert!(unsupported("BT /F4 10 Tf <0001> Tj ET").contains("CMap"), "named CMap");
        assert!(unsupported("BT /F5 10 Tf <0001> Tj ET").contains("CMap"), "embedded CMap");
    }

    #[test]
    fn op_budget_exceeded_is_unsupported() {
        let mut budget = Budget::page(1 << 20);
        budget.ops = 3;
        assert!(events_with("q Q q Q", &mut budget).is_err());
        let mut budget = Budget::page(1 << 20);
        budget.ops = 4;
        assert!(events_with("q Q q Q", &mut budget).is_ok());
        assert_eq!(budget.ops, 0);
    }

    #[test]
    fn event_budget_exceeded_is_unsupported() {
        let mut budget = Budget::page(1 << 20);
        budget.events = 1;
        assert!(events_with("BT /F1 10 Tf (AB) Tj ET", &mut budget).is_err());
        assert_eq!(Budget::page(0).events, MAX_PAGE_EVENTS);
    }

    #[test]
    fn decode_budget_exceeded_is_unsupported() {
        let mut doc = Document::with_version("1.7");
        let a = doc.add_object(Stream::new(dictionary! {}, b"q".to_vec()));
        let b = doc.add_object(Stream::new(dictionary! {}, b"Q".to_vec()));
        let items = vec![Object::Reference(a), Object::Reference(b)];
        let mut budget = Budget::page(10);
        let ops = content_ops(&doc, &items, &mut budget).unwrap();
        assert_eq!(ops.iter().map(|o| o.operator.as_str()).collect::<Vec<_>>(), vec!["q", "Q"]);
        assert_eq!(budget.decoded, 8);
        let mut budget = Budget::page(1);
        assert!(content_ops(&doc, &items, &mut budget).is_err());
    }

    #[test]
    fn malformed_operands_are_unsupported_never_a_panic() {
        for content in [
            "BT /F1 Tf ET",
            "1 2 cm",
            "BT /F1 10 Tf [(A) /X] TJ ET",
            "BT (A) Tj ET",
            "BT /F1 10 Tf 5 Tj ET",
            "BT /F1 10 Tf ' ET",
            "BT /F1 10 Tf 1 (A) \" ET",
            "BT /Nope 10 Tf ET",
            "BT /F1 10 Tf 1 2 3 Td ET",
            "BT 1 2 3 4 5 Tm ET",
            "BT /F1 10 Tf (A) 3 Tz ET 2 TL x 1 Tc",
            "/F1 Tz",
            "0 0 m 1 1 l q S",
            "1 2 3 re f",
            "0 0 m 1 c S",
            "BT /XX 10 Tf ET",
            "/Fm1 /Fm1 Do",
            "/G1 gs (A) w",
        ] {
            let result = std::panic::catch_unwind(|| events(content));
            match result {
                Ok(Err(_)) => {}
                Ok(Ok(ev)) => panic!("{content}: expected Unsupported, got {ev:?}"),
                Err(_) => panic!("{content}: panicked"),
            }
        }
    }

    #[test]
    fn harmless_oddities_are_tolerated() {
        for content in ["Q Q Q", "/Missing Do", "/Missing sh", "f", "foo bar 1 2 baz", "BT ET ET", "/Missing gs"] {
            assert_eq!(events(content).unwrap(), vec![], "{content}");
        }
    }

    #[test]
    fn unparsable_or_too_deep_content_is_unsupported() {
        assert!(decode_ops(b"1 2 (unterminated").is_err());
        assert!(decode_ops(b"q ] Q").is_err());
        let deep = format!("{}{} pop", "[".repeat(10_000), "]".repeat(10_000));
        assert!(decode_ops(deep.as_bytes()).is_err());
        let deep = format!("{} pop", "<<".repeat(10_000));
        assert!(decode_ops(deep.as_bytes()).is_err());
    }

    #[test]
    fn inline_images_decode_with_filters_and_are_placed() {
        let content = "q 10 0 0 20 5 5 cm BI /W 2 /H 1 /CS /G /BPC 8 /F /AHx ID 00FF> EI Q (BI) Tj";
        let ops = decode_ops(content.as_bytes()).unwrap();
        assert_eq!(ops.iter().map(|o| o.operator.as_str()).collect::<Vec<_>>(), vec!["q", "cm", "BI", "Q", "Tj"]);
        let Object::Stream(image) = &ops[2].operands[0] else { panic!("{:?}", ops[2]) };
        assert_eq!(image.content, b"00FF>");
        assert_eq!(image.dict.get(b"W").unwrap(), &Object::Integer(2));
        assert_eq!(image.dict.get(b"F").unwrap(), &Object::Name(b"AHx".to_vec()));
        let ev = events("q 10 0 0 20 5 5 cm BI /W 2 /H 1 /CS /G /BPC 8 /F /AHx ID 00FF> EI Q").unwrap();
        let [Event::Image(img)] = ev.as_slice() else { panic!("{ev:?}") };
        assert_eq!((img.op_index, &img.source), (2, &ImageSource::Inline));
        assert_quad(&img.quad_user, [(5.0, 5.0), (15.0, 5.0), (15.0, 25.0), (5.0, 25.0)]);
    }

    #[test]
    fn image_and_form_xobjects() {
        let ev = events("q 100 0 0 50 10 20 cm /Im1 Do Q 2 0 0 2 0 0 cm /Fm1 Do").unwrap();
        let [Event::Image(img), Event::Form(form)] = ev.as_slice() else { panic!("{ev:?}") };
        assert_eq!((img.op_index, &img.source), (2, &ImageSource::XObject(b"Im1".to_vec())));
        assert_quad(&img.quad_user, [(10.0, 20.0), (110.0, 20.0), (110.0, 70.0), (10.0, 70.0)]);
        assert_eq!((form.op_index, form.name.as_slice()), (5, &b"Fm1"[..]));
        assert_eq!(form.matrix, [2.0, 0.0, 0.0, 2.0, 10.0, 10.0]);
    }

    #[test]
    fn shadings_with_and_without_bbox() {
        let ev = events("1 0 0 1 5 5 cm /Sh1 sh /Sh2 sh").unwrap();
        let [Event::Shading(a), Event::Shading(b)] = ev.as_slice() else { panic!("{ev:?}") };
        assert_eq!((a.op_index, a.bbox_user), (1, Some(Rect { x0: 5.0, y0: 5.0, x1: 15.0, y1: 15.0 })));
        assert_eq!((b.op_index, b.name.as_slice(), b.bbox_user), (2, &b"Sh2"[..], None));
    }

    fn path(content: &str) -> PathPaint {
        let ev = events(content).unwrap();
        let [Event::Path(p)] = ev.as_slice() else { panic!("{content}: {ev:?}") };
        p.clone()
    }

    fn assert_rect(r: Option<Rect>, [x0, y0, x1, y1]: [f64; 4]) {
        let r = r.expect("bbox");
        assert!(
            (r.x0 - x0).abs() < EPS && (r.y0 - y0).abs() < EPS && (r.x1 - x1).abs() < EPS && (r.y1 - y1).abs() < EPS,
            "{r:?} != {:?}",
            [x0, y0, x1, y1]
        );
    }

    #[test]
    fn filled_path_range_and_bbox() {
        let p = path("1 0 0 1 10 10 cm 0 0 m 10 0 l 10 5 l h f");
        assert_eq!((p.op_range.clone(), p.painted, p.clip), (1..6, true, false));
        assert_rect(p.bbox_user, [10.0, 10.0, 20.0, 15.0]);
        assert_rect(path("15 5 -10 20 re f").bbox_user, [5.0, 5.0, 15.0, 25.0]);
        assert_rect(path("0 0 m 10 20 30 -5 40 0 c f").bbox_user, [0.0, -5.0, 40.0, 20.0]);
        assert_rect(path("0 0 m 10 20 40 0 v 5 -3 50 1 y f*").bbox_user, [0.0, -3.0, 50.0, 20.0]);
    }

    #[test]
    fn stroked_path_bbox_includes_the_stroke() {
        // Round joins: half width times sqrt(2) for square caps.
        let h = std::f64::consts::SQRT_2;
        assert_rect(path("2 w 1 j 0 0 m 10 0 l S").bbox_user, [-h, -h, 10.0 + h, h]);
        // Miter joins reach half width times the miter limit (default 10).
        assert_rect(path("2 w 0 0 m 10 0 l S").bbox_user, [-10.0, -10.0, 20.0, 10.0]);
        assert_rect(path("2 w 2 M 0 0 m 10 0 l s").bbox_user, [-2.0, -2.0, 12.0, 2.0]);
        // Line width from an ExtGState (LW 4), scaled by the CTM.
        assert_rect(path("/G1 gs 1 j 2 0 0 2 0 0 cm 0 0 m 10 0 l B").bbox_user, [-4.0 * h, -4.0 * h, 20.0 + 4.0 * h, 4.0 * h]);
        // A zero width line still covers half a unit.
        assert_rect(path("0 w 1 j 0 0 m 10 0 l S").bbox_user, [-0.5, -0.5, 10.5, 0.5]);
    }

    #[test]
    fn clip_paths_are_marked() {
        let p = path("0 0 m 10 0 l 10 10 l W n");
        assert_eq!((p.op_range.clone(), p.painted, p.clip), (0..5, false, true));
        let p = path("0 0 10 10 re W* f");
        assert_eq!((p.op_range.clone(), p.painted, p.clip), (0..3, true, true));
    }

    #[test]
    fn save_depth_is_bounded() {
        let content = "q ".repeat(100_000);
        assert!(events(&content).is_err());
    }

    #[test]
    fn tj_adjustment_keeps_following_glyphs_in_place() {
        let base = glyphs("BT /F1 10 Tf 1 Tc 2 Tw 50 Tz [(A B)] TJ ET");
        let adj: Vec<f64> = base.iter().map(|g| g.tj_adjustment().unwrap()).collect();
        // Th does not enter the number: -(w0 Tfs + Tc + Tw) * 1000 / Tfs.
        assert_eq!(adj, vec![-600.0, -550.0, -700.0]);
        let without_a = glyphs(&format!("BT /F1 10 Tf 1 Tc 2 Tw 50 Tz [{} ( B)] TJ ET", adj[0]));
        assert_eq!(without_a[1].box_user, base[2].box_user);
        let without_space = glyphs(&format!("BT /F1 10 Tf 1 Tc 2 Tw 50 Tz [(A) {} (B)] TJ ET", adj[1]));
        assert_eq!(without_space[1].box_user, base[2].box_user);
        let zero = Glyph { font_size: 0.0, ..base[0].clone() };
        assert_eq!(zero.tj_adjustment(), None);
    }

    #[test]
    fn quad_intersection_needs_positive_area() {
        let r = Rect { x0: 0.0, y0: 0.0, x1: 10.0, y1: 10.0 };
        let square = |x0: f64, y0: f64, x1: f64, y1: f64| Quad([(x0, y0), (x1, y0), (x1, y1), (x0, y1)]);
        assert!(square(5.0, 5.0, 15.0, 15.0).intersects(&r));
        assert!(square(-5.0, -5.0, 20.0, 20.0).intersects(&r));
        assert!(!square(10.0, 0.0, 20.0, 10.0).intersects(&r), "touching edge");
        assert!(!square(11.0, 0.0, 20.0, 10.0).intersects(&r));
        // A diamond whose bounding box overlaps the corner but not the rect.
        let diamond = Quad([(15.0, 9.0), (21.0, 15.0), (15.0, 21.0), (9.0, 15.0)]);
        assert!(!diamond.intersects(&r));
        assert_eq!(diamond.bbox(), Rect { x0: 9.0, y0: 9.0, x1: 21.0, y1: 21.0 });
        let diamond = Quad([(10.0, 4.0), (16.0, 10.0), (10.0, 16.0), (4.0, 10.0)]);
        assert!(diamond.intersects(&r));
        // A degenerate quad covers no area.
        assert!(!square(5.0, 5.0, 5.0, 8.0).intersects(&r));
    }
}
