//! Shaping one run of text (one face, one direction) with rustybuzz.

use super::{Face, LayoutError, ShapeBudget};
use std::ops::Range;

/// Characters of context given to the shaper on each side of a run (HarfBuzz
/// reads at most 5).
const CONTEXT_CHARS: usize = 5;

/// One shaped glyph in font units. `cluster` is a byte offset into the text
/// passed to `shape` (rustybuzz reports UTF-8 byte offsets, not char indices).
#[derive(Debug, Clone, Copy)]
pub(crate) struct ShapedGlyph {
    pub gid: u16,
    pub cluster: usize,
    pub x_advance: i32,
    pub x_offset: i32,
    pub y_offset: i32,
}

/// Shapes `text[range]` with `face`, the text in `context` around it serving
/// as shaping context (Arabic joining across a run edge). Glyphs come back in
/// visual order: left to right, so reversed for an RTL run.
pub(crate) fn shape(
    face: &Face,
    text: &str,
    range: Range<usize>,
    context: Range<usize>,
    rtl: bool,
    budget: &mut ShapeBudget,
) -> Result<Vec<ShapedGlyph>, LayoutError> {
    let run = &text[range.clone()];
    budget.spend(run.chars().count())?;
    let mut buffer = rustybuzz::UnicodeBuffer::new();
    buffer.push_str(run);
    let before = &text[context.start..range.start];
    let after = &text[range.end..context.end];
    let pre_start = before.char_indices().rev().nth(CONTEXT_CHARS - 1).map_or(0, |(i, _)| i);
    let post_end = after.char_indices().nth(CONTEXT_CHARS).map_or(after.len(), |(i, _)| i);
    buffer.set_pre_context(&before[pre_start..]);
    buffer.set_post_context(&after[..post_end]);
    buffer.guess_segment_properties();
    buffer.set_direction(if rtl { rustybuzz::Direction::RightToLeft } else { rustybuzz::Direction::LeftToRight });
    let out = rustybuzz::shape(&face.hb, &[], buffer);
    Ok(out
        .glyph_infos()
        .iter()
        .zip(out.glyph_positions())
        .map(|(info, pos)| ShapedGlyph {
            // Glyph ids come from the font's 16-bit tables.
            gid: u16::try_from(info.glyph_id).unwrap_or(0),
            cluster: range.start + info.cluster as usize,
            x_advance: pos.x_advance,
            x_offset: pos.x_offset,
            y_offset: pos.y_offset,
        })
        .collect())
}
