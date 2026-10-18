//! Vector graphics removal: painted paths, shadings and inline images under
//! a redaction area.

use super::Unsupported;
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

/// The edit for a path whose bounds meet a rect: a painted path goes, a
/// rectangle clip keeps its clip and loses its paint. Any other clip there
/// is Unsupported: a clip shaped like letter outlines carries the text.
/// None for paths that stay clear of every rect or only clip with rects.
pub(crate) fn path_edit(path: &PathPaint, rects: &[Rect]) -> Result<Option<PathEdit>, Unsupported> {
    let Some(bbox) = path.bbox_user else {
        return Ok(None);
    };
    if !rects.iter().any(|r| bbox.overlaps(r)) {
        return Ok(None);
    }
    if path.clip && !path.rects_only {
        return Err(Unsupported::new("shaped clip path under a redaction area"));
    }
    Ok(match (path.painted, path.clip) {
        (false, _) => None,
        (true, true) => Some(PathEdit::Unpaint(path.op_range.end - 1)),
        (true, false) => Some(PathEdit::Remove(path.op_range.clone())),
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
