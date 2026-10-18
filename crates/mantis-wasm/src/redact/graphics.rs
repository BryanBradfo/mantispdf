//! Vector graphics removal: painted paths, shadings and inline images under
//! a redaction area.

use super::Unsupported;
use super::interp::{Event, PathPaint, Quad, Rect, ShadingPaint};
use std::ops::Range;

/// What to do with a painted path.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum PathEdit {
    /// Drop its construction, clip and painting operators.
    Remove(Range<usize>),
    /// It also clips: keep the clip, replace the painting operator with `n`.
    Unpaint(usize),
}

/// The edit for a path whose bounds meet a rect: a painted (or unpainted,
/// unclipping) path goes, a
/// single-rectangle clip keeps its clip and loses its paint. Any other clip
/// there is Unsupported: a clip shaped like letter outlines (or built from
/// several rectangles) carries the text.
/// None for paths that stay clear of every rect or only clip with one rect.
pub(crate) fn path_edit(path: &PathPaint, rects: &[Rect]) -> Result<Option<PathEdit>, Unsupported> {
    let Some(bbox) = path.bbox_user else {
        return Ok(None);
    };
    if !rects.iter().any(|r| bbox.overlaps(r)) {
        return Ok(None);
    }
    if path.clip && !path.single_rect {
        return Err(Unsupported::new("shaped clip path under a redaction area"));
    }
    Ok(match (path.painted, path.clip) {
        // A single-rectangle clip that paints nothing stays as it is.
        (false, true) => None,
        (true, true) => Some(PathEdit::Unpaint(path.op_range.end - 1)),
        // Painted, or drawn with `n` for nothing: its geometry goes.
        (_, false) => Some(PathEdit::Remove(path.op_range.clone())),
    })
}

/// A shading without /BBox fills its whole clip region: it meets any rect.
pub(crate) fn shading_hit(shading: &ShadingPaint, rects: &[Rect]) -> bool {
    match shading.bbox_user {
        Some(bbox) => rects.iter().any(|r| bbox.overlaps(r)),
        None => !rects.is_empty(),
    }
}

pub(crate) fn quad_hit(quad: &Quad, rects: &[Rect]) -> bool {
    rects.iter().any(|r| quad.intersects(r))
}

/// Unsupported when content whose look we cannot analyse meets an area:
/// painting with a Pattern colour (the pattern cell repeats over whatever is
/// painted), or a soft mask whose group box meets an area (its content is
/// drawn into the mask even where nothing visible is painted).
pub(crate) fn check_unanalysed_paint(events: &[Event], rects: &[Rect]) -> Result<(), Unsupported> {
    if let Some(reason) = unanalysed_paint(events, rects) {
        return Err(Unsupported::new(reason));
    }
    Ok(())
}

/// The reason `check_unanalysed_paint` refuses `events`, if any.
pub(crate) fn unanalysed_paint(events: &[Event], rects: &[Rect]) -> Option<&'static str> {
    if rects.is_empty() {
        return None;
    }
    let meets = |bbox: &Option<Rect>| bbox.is_none_or(|b| rects.iter().any(|r| b.overlaps(r)));
    for event in events {
        let pattern_hit = match event {
            Event::Glyph(g) => g.pattern && quad_hit(&g.box_user, rects),
            Event::Path(p) => p.pattern && p.painted && p.bbox_user.is_some() && meets(&p.bbox_user),
            Event::Image(i) => i.pattern && quad_hit(&i.quad_user, rects),
            Event::SoftMask(m) if meets(&m.bbox_user) => return Some("soft mask under a redaction area"),
            _ => false,
        };
        if pattern_hit {
            return Some("pattern colour under a redaction area");
        }
    }
    None
}
