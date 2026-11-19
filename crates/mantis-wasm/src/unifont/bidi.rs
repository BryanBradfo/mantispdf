//! Bidi analysis of one paragraph (UAX 9) and visual runs per line.

use std::ops::Range;
use unicode_bidi::ParagraphBidiInfo;

/// Bidi levels of one paragraph, its direction from the first strong
/// character (rule P2).
pub(crate) struct Paragraph<'t> {
    info: ParagraphBidiInfo<'t>,
}

impl<'t> Paragraph<'t> {
    /// `text` holds no paragraph separator (the caller splits on them).
    pub(crate) fn new(text: &'t str) -> Self {
        Paragraph { info: ParagraphBidiInfo::new(text, None) }
    }

    pub(crate) fn rtl(&self) -> bool {
        self.info.paragraph_level.is_rtl()
    }

    /// Embedding direction of the character starting at byte `at`, before line reordering.
    pub(crate) fn rtl_at(&self, at: usize) -> bool {
        self.info.levels.get(at).is_some_and(|l| l.is_rtl())
    }

    /// Runs of `line` (a non-empty byte range of the paragraph) in visual
    /// order, left to right, each with its direction.
    pub(crate) fn visual_runs(&self, line: Range<usize>) -> Vec<(Range<usize>, bool)> {
        if line.start >= line.end || line.end > self.info.text.len() {
            return Vec::new();
        }
        let (levels, runs) = self.info.visual_runs(line);
        runs.into_iter().map(|run| {
            let rtl = levels[run.start].is_rtl();
            (run, rtl)
        }).collect()
    }
}
