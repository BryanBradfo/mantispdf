//! Vector graphics removal: painted paths, shadings and inline images under
//! a redaction area.

use super::interp::{PathPaint, Quad, Rect, ShadingPaint};
use std::ops::Range;

/// What to do with a painted path.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum PathEdit {
    /// Drop its construction, clip and painting operators.
    Remove(Range<usize>),
    /// It also clips: keep the clip, replace the painting operator with `n`.
    Unpaint(usize),
}

/// The edit for a painted path whose bounds meet a rect; None for paths
/// that paint nothing or stay clear of every rect.
pub(crate) fn path_edit(path: &PathPaint, rects: &[Rect]) -> Option<PathEdit> {
    let bbox = path.bbox_user?;
    if !path.painted || !rects.iter().any(|r| bbox.overlaps(r)) {
        return None;
    }
    Some(if path.clip { PathEdit::Unpaint(path.op_range.end - 1) } else { PathEdit::Remove(path.op_range.clone()) })
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
