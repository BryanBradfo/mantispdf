//! Real ink boxes of glyphs from an embedded TrueType program (FontFile2),
//! for glyphs whose advance says nothing about where they draw: zero-width
//! marks (Thai tone marks, Devanagari matras, Arabic dots and harakat) sit
//! over or before their base. Without this they get a wide fallback box that
//! reaches the neighbouring letters.
//!
//! An ink box only narrows that fallback when it is certain:
//! - the code reaches its glyph without guessing: a Type0 CIDFontType2 with
//!   CIDToGIDMap /Identity or a stream, or a symbolic simple TrueType font
//!   without /Encoding whose program has only a (3,0) cmap;
//! - the glyph's outline reads (its box is computed from its points, never
//!   from the glyf header), within ±`MAX_REACH` em; a glyph is empty only
//!   when its loca range is empty;
//! - the program decodes within the job's decode budget (charged once per
//!   document: decoded programs are shared by object id through `Programs`).
//!
//! Anything else answers None, and the caller keeps its wide fallback.

use super::Budget;
use crate::rebuild::{Decoded, deref, strict_content_in};
use lopdf::{Dictionary, Document, Object, ObjectId};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

/// Decoded bytes of one font program (or one CIDToGIDMap) read at most.
const MAX_PROGRAM_BYTES: usize = 32 << 20;
/// A glyph box farther than this (em) from the origin is not believed.
const MAX_REACH: f64 = 2.0;
/// Glyph answers cached per font.
const MAX_CACHED: usize = 1 << 16;

/// Decoded streams (font programs, CIDToGIDMaps) of one document by object
/// id, shared by the page budgets of a job; None: it did not decode.
pub(crate) type Programs = Rc<RefCell<HashMap<ObjectId, Option<Rc<Vec<u8>>>>>>;

/// How codes reach glyph ids.
#[derive(Debug)]
enum GidMap {
    /// Two-byte CIDs, glyph id = CID.
    Identity,
    /// Two-byte CIDs through a CIDToGIDMap stream.
    Stream(ObjectId),
    /// One-byte codes of a symbolic TrueType font through a (3,0) cmap only.
    Symbolic,
}

/// The ink source of one font: references, nothing read at load.
#[derive(Debug)]
pub(crate) struct Ink {
    program: ObjectId,
    map: GidMap,
    /// Answers already given, by code (None: unknown).
    answers: RefCell<HashMap<u32, Option<GlyphInk>>>,
}

/// What the ink of one code is.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum GlyphInk {
    /// `[x0, y0, x1, y1]` in em, from the glyph's origin.
    Box([f64; 4]),
    /// The glyph draws nothing (its loca range is empty).
    Empty,
}

/// The FontFile2 of `descriptor`, as an indirect stream.
fn font_file2(doc: &Document, descriptor: Option<&Dictionary>) -> Option<ObjectId> {
    let id = descriptor?.get(b"FontFile2").ok()?.as_reference().ok()?;
    matches!(doc.get_object(id), Ok(Object::Stream(_))).then_some(id)
}

impl Ink {
    /// Ink of a Type0 font's descendant `cid_font` (Identity-H): only a
    /// CIDFontType2 with CIDToGIDMap /Identity or an indirect stream.
    pub(crate) fn for_cid_font(doc: &Document, cid_font: &Dictionary, descriptor: Option<&Dictionary>) -> Option<Ink> {
        if cid_font.get(b"Subtype").ok()?.as_name().ok()? != b"CIDFontType2" {
            return None;
        }
        let map = match cid_font.get(b"CIDToGIDMap").ok()? {
            Object::Name(n) if n == b"Identity" => GidMap::Identity,
            Object::Reference(id) if matches!(doc.get_object(*id), Ok(Object::Stream(_))) => GidMap::Stream(*id),
            _ => return None,
        };
        Some(Ink { program: font_file2(doc, descriptor)?, map, answers: RefCell::default() })
    }

    /// Ink of a simple TrueType font `font`: only a symbolic one (Flags bit
    /// 3) without /Encoding (its program must also have only a (3,0) cmap).
    pub(crate) fn for_simple_truetype(doc: &Document, font: &Dictionary, descriptor: Option<&Dictionary>) -> Option<Ink> {
        if font.has(b"Encoding") {
            return None;
        }
        let flags = descriptor?.get(b"Flags").ok().and_then(|f| deref(doc, f))?.as_i64().ok()?;
        if flags & 4 == 0 {
            return None;
        }
        Some(Ink { program: font_file2(doc, descriptor)?, map: GidMap::Symbolic, answers: RefCell::default() })
    }

    /// The ink of `code`; None when it cannot be known with certainty.
    pub(crate) fn glyph(&self, code: u32, doc: &Document, budget: &mut Budget) -> Option<GlyphInk> {
        if let Some(answer) = self.answers.borrow().get(&code) {
            return *answer;
        }
        let answer = self.read_glyph(code, doc, budget);
        let mut answers = self.answers.borrow_mut();
        if answers.len() < MAX_CACHED {
            answers.insert(code, answer);
        }
        answer
    }

    fn read_glyph(&self, code: u32, doc: &Document, budget: &mut Budget) -> Option<GlyphInk> {
        let program = decoded(doc, self.program, budget)?;
        let face = ttf_parser::Face::parse(&program, 0).ok()?;
        let gid = match &self.map {
            GidMap::Identity => u16::try_from(code).ok()?,
            GidMap::Stream(id) => {
                let map = decoded(doc, *id, budget)?;
                let at = 2 * usize::try_from(code).ok()?;
                u16::from_be_bytes([*map.get(at)?, *map.get(at + 1)?])
            }
            GidMap::Symbolic => symbolic_gid(&face, code)?,
        };
        if gid >= face.number_of_glyphs() {
            return None;
        }
        let glyph = ttf_parser::GlyphId(gid);
        let upem = f64::from(face.units_per_em());
        match face.glyph_bounding_box(glyph) {
            Some(r) => {
                let b = [r.x_min, r.y_min, r.x_max, r.y_max].map(|v| f64::from(v) / upem);
                b.iter().all(|v| v.abs() <= MAX_REACH).then_some(GlyphInk::Box(b))
            }
            // No outline read: empty only when loca says it has no data.
            None => loca_empty(&face, gid)?.then_some(GlyphInk::Empty),
        }
    }
}

/// The decoded stream `id`, decoded once per document (through the budget's
/// shared `Programs`) and charged to the job's decode budget.
fn decoded(doc: &Document, id: ObjectId, budget: &mut Budget) -> Option<Rc<Vec<u8>>> {
    if let Some(known) = budget.programs.borrow().get(&id) {
        return known.clone();
    }
    let Ok(Object::Stream(stream)) = doc.get_object(id) else {
        return None;
    };
    let mut charged = 0;
    let bytes = match strict_content_in(Some(doc), stream, MAX_PROGRAM_BYTES.min(budget.decoded), &mut charged) {
        Decoded::Content(bytes) => Some(Rc::new(bytes)),
        _ => None,
    };
    budget.decoded = budget.decoded.saturating_sub(charged);
    // Kept either way: the job's budget only shrinks, so a stream past it
    // stays past it.
    budget.programs.borrow_mut().insert(id, bytes.clone());
    bytes
}

/// Whether glyph `gid` has no data in glyf: its two loca offsets are equal
/// (read from the raw table: ttf-parser's range reports an empty glyph and a
/// broken one alike). None when loca cannot be read for it.
fn loca_empty(face: &ttf_parser::Face, gid: u16) -> Option<bool> {
    let loca = face.raw_face().table(ttf_parser::Tag::from_bytes(b"loca"))?;
    let i = usize::from(gid);
    let offset = |k: usize| -> Option<u32> {
        match face.tables().head.index_to_location_format {
            ttf_parser::head::IndexToLocationFormat::Short => {
                let b = loca.get(2 * k..2 * k + 2)?;
                Some(u32::from(u16::from_be_bytes([b[0], b[1]])) * 2)
            }
            ttf_parser::head::IndexToLocationFormat::Long => {
                let b = loca.get(4 * k..4 * k + 4)?;
                Some(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
            }
        }
    };
    Some(offset(i)? == offset(i + 1)?)
}

/// Glyph id of one-byte `code` in a symbolic TrueType program whose only
/// cmap is (3,0): at 0xF000 + code.
fn symbolic_gid(face: &ttf_parser::Face, code: u32) -> Option<u16> {
    let code = u8::try_from(code).ok()?;
    let cmap = face.tables().cmap?;
    let only = cmap.subtables.into_iter().all(|s| s.platform_id == ttf_parser::PlatformId::Windows && s.encoding_id == 0);
    if !only {
        return None;
    }
    cmap.subtables.into_iter().find_map(|s| s.glyph_index(0xF000 + u32::from(code))).map(|g| g.0).filter(|&g| g != 0)
}
