//! Unicode text engine: faces loaded from font bytes, per-character fallback
//! across them, bidi reordering per line, shaping with rustybuzz and line
//! breaking (UAX 14) against the box width. One layout serves both the editor
//! preview and the PDF writer, so their line breaks match exactly.
//!
//! The caller orders the faces: the family face first (it gives the line
//! metrics), then the fallback faces in the order of spec 1.2.

mod bidi;
mod breaks;
mod face;
mod layout;
mod shape;
#[cfg(test)]
mod tests;

pub(crate) use face::{Face, load_faces};
pub(crate) use layout::layout_text;

use crate::edit_ops::Align;

/// Fonts one job may carry.
pub(crate) const MAX_FONTS: usize = 20;
/// Font bytes one job may carry, all fonts together.
pub(crate) const MAX_FONT_BYTES: usize = 64 * 1024 * 1024;
/// Characters one job may shape, all passes and boxes together.
pub(crate) const MAX_SHAPED_CHARS: usize = 1_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LayoutError {
    TooManyFonts,
    FontBytes,
    /// The face at this index is not a usable font.
    BadFont(usize),
    /// Size, width or line height out of range.
    Params,
    /// The job's shaping budget is spent.
    Budget,
}

impl LayoutError {
    /// The settings field the error belongs to, for `Invalid edit settings: <field>`.
    pub(crate) fn field(self) -> &'static str {
        match self {
            LayoutError::TooManyFonts | LayoutError::FontBytes | LayoutError::BadFont(_) => "font",
            LayoutError::Params => "layout",
            LayoutError::Budget => "text",
        }
    }
}

/// Characters left to shape in one job.
#[derive(Debug)]
pub(crate) struct ShapeBudget {
    left: usize,
}

impl ShapeBudget {
    pub(crate) fn new(chars: usize) -> Self {
        ShapeBudget { left: chars }
    }

    pub(crate) fn per_job() -> Self {
        Self::new(MAX_SHAPED_CHARS)
    }

    fn spend(&mut self, chars: usize) -> Result<(), LayoutError> {
        self.left = self.left.checked_sub(chars).ok_or(LayoutError::Budget)?;
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct LayoutParams {
    /// Font size in points.
    pub size: f64,
    /// Box width in points.
    pub width: f64,
    /// `None`: left for LTR paragraphs, right for RTL ones (spec 1.7).
    pub align: Option<Align>,
    /// Baseline pitch as a multiple of `size`.
    pub line_height: f64,
}

/// A text box laid out: lines top to bottom, in points, relative to the box's
/// top-left corner with y growing downward.
#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) struct Layout {
    pub lines: Vec<Line>,
    /// Characters no face covers (drawn as the .notdef of the face before them,
    /// else face 0), in text order, once each.
    pub missing: Vec<char>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Line {
    /// Left edge of the first glyph, alignment applied.
    pub x: f64,
    /// Distance from the box top down to the baseline.
    pub baseline_y: f64,
    /// Sum of the glyph advances.
    pub width: f64,
    /// Paragraph direction (first strong character, bidi rule P2).
    pub rtl: bool,
    /// Runs in visual order, left to right. Empty for an empty line.
    pub runs: Vec<Run>,
}

/// Glyphs of one face and one direction, in visual order, left to right.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Run {
    /// Index into the faces given to `layout_text`.
    pub face: usize,
    pub rtl: bool,
    pub glyphs: Vec<Glyph>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Glyph {
    /// Glyph id in the face (not yet remapped by a subset).
    pub gid: u16,
    /// Pen advance in points.
    pub x_advance: f64,
    /// Offsets from the pen position in points, y upward (font convention).
    pub x_offset: f64,
    pub y_offset: f64,
    /// The text of the shaping cluster this glyph belongs to. A cluster of
    /// several glyphs carries its text on one of them (the first in logical
    /// order) and "" on the others, so concatenating `cluster_text` in
    /// logical order gives the line's text back exactly.
    pub cluster_text: String,
}
