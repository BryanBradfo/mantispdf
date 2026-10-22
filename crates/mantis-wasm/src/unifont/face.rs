//! Faces loaded from font bytes, within the job's font budget.

use super::{LayoutError, MAX_FONT_BYTES, MAX_FONTS};
use ttf_parser::gpos::PositioningSubtable;
use ttf_parser::gsub::SubstitutionSubtable;
use ttf_parser::opentype_layout::{ChainedContextLookup, ContextLookup, LayoutTable};

/// One font, parsed once; borrows the caller's bytes (subset when embedded).
pub(crate) struct Face<'a> {
    pub(crate) data: &'a [u8],
    pub(crate) hb: rustybuzz::Face<'a>,
}

impl<'a> Face<'a> {
    fn parse(data: &'a [u8]) -> Option<Self> {
        let hb = rustybuzz::Face::from_slice(data, 0)?;
        // A face without a Unicode cmap can never be picked for a character.
        hb.tables().cmap?;
        if !lookups_resolve(hb.tables().gsub, hb.tables().gpos) {
            return None;
        }
        Some(Face { data, hb })
    }

    pub(crate) fn units_per_em(&self) -> f64 {
        f64::from(self.hb.units_per_em())
    }

    /// Ascender in font units (typo metrics when the font asks for them, else hhea).
    pub(crate) fn ascender(&self) -> f64 {
        f64::from(self.hb.ascender())
    }

    /// Whether the face has a real glyph (not .notdef) for `c`.
    pub(crate) fn covers(&self, c: char) -> bool {
        self.hb.glyph_index(c).is_some_and(|g| g.0 != 0)
    }
}

/// Parses `fonts` in order. Errors: more than `MAX_FONTS`, more than
/// `MAX_FONT_BYTES` together (checked before parsing), or the index of the
/// first font that does not parse. No fonts at all is `BadFont(0)`.
pub(crate) fn load_faces<'a>(fonts: &[&'a [u8]]) -> Result<Vec<Face<'a>>, LayoutError> {
    if fonts.len() > MAX_FONTS {
        return Err(LayoutError::TooManyFonts);
    }
    if fonts.iter().map(|f| f.len()).sum::<usize>() > MAX_FONT_BYTES {
        return Err(LayoutError::FontBytes);
    }
    if fonts.is_empty() {
        return Err(LayoutError::BadFont(0));
    }
    fonts.iter().enumerate().map(|(i, data)| Face::parse(data).ok_or(LayoutError::BadFont(i))).collect()
}

/// Whether every coverage of the format 3 (chained) context lookups resolves.
/// rustybuzz 0.20.1 unwraps those lazily read offsets while shaping, so a font
/// with a broken one would panic (abort in wasm) on the first matching glyph.
fn lookups_resolve(gsub: Option<LayoutTable>, gpos: Option<LayoutTable>) -> bool {
    macro_rules! all_resolve {
        ($($array:expr),+) => { true $(&& (0..$array.len()).all(|i| $array.get(i).is_some()))+ };
    }
    let context = |c: ContextLookup| match c {
        ContextLookup::Format3 { coverages, .. } => all_resolve!(coverages),
        _ => true,
    };
    let chained = |c: ChainedContextLookup| match c {
        ChainedContextLookup::Format3 { backtrack_coverages, input_coverages, lookahead_coverages, .. } => {
            all_resolve!(backtrack_coverages, input_coverages, lookahead_coverages)
        }
        _ => true,
    };
    let gsub_ok = gsub.is_none_or(|t| {
        t.lookups.into_iter().all(|l| {
            l.subtables.into_iter::<SubstitutionSubtable>().all(|s| match s {
                SubstitutionSubtable::Context(c) => context(c),
                SubstitutionSubtable::ChainContext(c) => chained(c),
                _ => true,
            })
        })
    });
    let gpos_ok = gpos.is_none_or(|t| {
        t.lookups.into_iter().all(|l| {
            l.subtables.into_iter::<PositioningSubtable>().all(|s| match s {
                PositioningSubtable::Context(c) => context(c),
                PositioningSubtable::ChainContext(c) => chained(c),
                _ => true,
            })
        })
    });
    gsub_ok && gpos_ok
}
