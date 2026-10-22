//! Real ink boxes of glyphs from an embedded TrueType program (FontFile2),
//! for glyphs whose advance says nothing about where they draw: zero-width
//! marks (Thai tone marks, Devanagari matras, Arabic dots and harakat) sit
//! over or before their base. Without this they get a wide fallback box that
//! reaches the neighbouring letters.
//!
//! Everything is lazy and bounded: the program is decoded on the first
//! narrow glyph of a font, once, within `MAX_PROGRAM_BYTES`. Anything odd (no
//! FontFile2, a program that does not decode or parse, a glyph id that is
//! not in it, a box outside ±`MAX_REACH` em) answers None, and the caller
//! keeps its conservative fallback.

use crate::rebuild::{Decoded, deref, strict_content_in};
use lopdf::{Dictionary, Document, Object, Stream};
use std::cell::RefCell;
use std::collections::HashMap;

/// Decoded bytes of one font program (and of one CIDToGIDMap) read at most.
const MAX_PROGRAM_BYTES: usize = 32 << 20;
/// Compressed bytes of a font program cloned at font load at most.
const MAX_STORED_BYTES: usize = 32 << 20;
/// A glyph box farther than this (em) from the origin is not believed.
const MAX_REACH: f64 = 2.0;
/// Glyph boxes cached per font.
const MAX_CACHED: usize = 1 << 16;

/// How codes reach glyph ids.
#[derive(Debug)]
enum GidMap {
    /// Two-byte CIDs, glyph id = CID.
    Identity,
    /// Two-byte CIDs through a CIDToGIDMap stream (decoded on first use).
    Stream(Stream),
    /// One-byte codes of a simple TrueType font through its (3,0) or (1,0) cmap.
    SimpleCmap,
}

#[derive(Debug)]
enum State {
    Unread,
    Failed,
    Read { program: Vec<u8>, gids: Option<Vec<u8>>, boxes: HashMap<u32, Option<[f64; 4]>> },
}

/// The ink source of one font.
#[derive(Debug)]
pub(crate) struct Ink {
    program: Stream,
    map: GidMap,
    state: RefCell<State>,
}

/// What the ink of one code is.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum GlyphInk {
    /// `[x0, y0, x1, y1]` in em, from the glyph's origin.
    Box([f64; 4]),
    /// The glyph draws nothing (no outline).
    Empty,
}

fn font_file2(doc: &Document, descriptor: Option<&Dictionary>) -> Option<Stream> {
    let file = descriptor?.get(b"FontFile2").ok()?;
    let Some(Object::Stream(s)) = deref(doc, file) else {
        return None;
    };
    (s.content.len() <= MAX_STORED_BYTES).then(|| s.clone())
}

impl Ink {
    /// Ink of a Type0 font's CIDFontType2 descendant `cid_font` (Identity-H).
    pub(crate) fn for_cid_font(doc: &Document, cid_font: &Dictionary, descriptor: Option<&Dictionary>) -> Option<Ink> {
        if cid_font.get(b"Subtype").ok()?.as_name().ok()? != b"CIDFontType2" {
            return None;
        }
        let program = font_file2(doc, descriptor)?;
        let map = match cid_font.get(b"CIDToGIDMap").ok().and_then(|o| deref(doc, o)) {
            None => GidMap::Identity,
            Some(Object::Name(n)) if n == b"Identity" => GidMap::Identity,
            Some(Object::Stream(s)) if s.content.len() <= MAX_STORED_BYTES => GidMap::Stream(s.clone()),
            _ => return None,
        };
        Some(Ink { program, map, state: RefCell::new(State::Unread) })
    }

    /// Ink of a simple TrueType font.
    pub(crate) fn for_simple_truetype(doc: &Document, descriptor: Option<&Dictionary>) -> Option<Ink> {
        let program = font_file2(doc, descriptor)?;
        Some(Ink { program, map: GidMap::SimpleCmap, state: RefCell::new(State::Unread) })
    }

    /// The ink of `code`; None when it cannot be known with confidence.
    pub(crate) fn glyph(&self, code: u32) -> Option<GlyphInk> {
        let mut state = self.state.borrow_mut();
        if matches!(*state, State::Unread) {
            *state = self.read().unwrap_or(State::Failed);
        }
        let State::Read { program, gids, boxes } = &mut *state else {
            return None;
        };
        // Cached: only answers we are sure of (None there means no outline).
        if let Some(cached) = boxes.get(&code) {
            return Some(cached.map_or(GlyphInk::Empty, GlyphInk::Box));
        }
        let face = ttf_parser::Face::parse(program, 0).ok()?;
        let gid = match &self.map {
            GidMap::Identity => u16::try_from(code).ok()?,
            GidMap::Stream(_) => {
                let gids = gids.as_ref()?;
                let at = 2 * usize::try_from(code).ok()?;
                u16::from_be_bytes([*gids.get(at)?, *gids.get(at + 1)?])
            }
            GidMap::SimpleCmap => simple_gid(&face, code)?,
        };
        if gid >= face.number_of_glyphs() {
            return None;
        }
        let upem = f64::from(face.units_per_em());
        let ink = match face.glyph_bounding_box(ttf_parser::GlyphId(gid)) {
            None => None,
            Some(r) => {
                let b = [r.x_min, r.y_min, r.x_max, r.y_max].map(|v| f64::from(v) / upem);
                if b.iter().any(|v| v.abs() > MAX_REACH) {
                    return None;
                }
                Some(b)
            }
        };
        if boxes.len() < MAX_CACHED {
            boxes.insert(code, ink);
        }
        Some(ink.map_or(GlyphInk::Empty, GlyphInk::Box))
    }

    /// The ink of `code` if it was read already (never reads the program).
    pub(crate) fn cached(&self, code: u32) -> Option<GlyphInk> {
        match &*self.state.borrow() {
            State::Read { boxes, .. } => boxes.get(&code).map(|b| b.map_or(GlyphInk::Empty, GlyphInk::Box)),
            _ => None,
        }
    }

    fn read(&self) -> Option<State> {
        let mut charged = 0;
        let Decoded::Content(program) = strict_content_in(None, &self.program, MAX_PROGRAM_BYTES, &mut charged) else {
            return None;
        };
        ttf_parser::Face::parse(&program, 0).ok()?;
        let gids = match &self.map {
            GidMap::Stream(s) => match strict_content_in(None, s, MAX_PROGRAM_BYTES, &mut charged) {
                Decoded::Content(bytes) => Some(bytes),
                _ => return None,
            },
            _ => None,
        };
        Some(State::Read { program, gids, boxes: HashMap::new() })
    }
}

/// Glyph id of one-byte `code` in a simple TrueType font: the (3,0) cmap at
/// 0xF000 + code (symbolic fonts), else the (1,0) cmap at code.
fn simple_gid(face: &ttf_parser::Face, code: u32) -> Option<u16> {
    let code = u8::try_from(code).ok()?;
    let cmap = face.tables().cmap?;
    let lookup = |platform: ttf_parser::PlatformId, encoding: u16, c: u32| {
        cmap.subtables
            .into_iter()
            .filter(|s| s.platform_id == platform && s.encoding_id == encoding)
            .find_map(|s| s.glyph_index(c))
            .map(|g| g.0)
            .filter(|&g| g != 0)
    };
    lookup(ttf_parser::PlatformId::Windows, 0, 0xF000 + u32::from(code))
        .or_else(|| lookup(ttf_parser::PlatformId::Macintosh, 0, u32::from(code)))
}
