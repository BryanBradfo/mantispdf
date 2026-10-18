//! Redaction: remove the content under marked areas (text, images, vector
//! graphics) instead of only covering it.

// The engine lands piece by piece before the job that calls it; drop this
// once the redaction job is exported.
#![cfg_attr(not(test), allow(dead_code))]

#[cfg(test)]
mod content_tests;
pub(crate) mod fonts;
pub(crate) mod graphics;
pub(crate) mod interp;
pub(crate) mod text;

use interp::{Event, Rect};
use lopdf::content::Operation;
use std::collections::{BTreeMap, HashMap, HashSet};

/// Why a page cannot be redacted by rewriting its content (the page is then
/// rasterized instead).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Unsupported(pub(crate) String);

impl Unsupported {
    pub(crate) fn new(reason: impl Into<String>) -> Unsupported {
        Unsupported(reason.into())
    }
}

/// Content operators one page may run, its form XObjects included.
pub(crate) const MAX_PAGE_OPS: usize = 2_000_000;
/// Events (glyphs, paths, images, ...) one page may produce.
pub(crate) const MAX_PAGE_EVENTS: usize = 1_000_000;

/// What is left of one page's allowance. Shared by the page content and the
/// forms it draws, so nesting cannot multiply the work.
#[derive(Debug, Clone)]
pub(crate) struct Budget {
    pub(crate) ops: usize,
    pub(crate) events: usize,
    /// Decoded content bytes still allowed (the job's remaining share).
    pub(crate) decoded: usize,
}

impl Budget {
    /// A fresh page allowance drawing on `decoded` bytes of the job budget.
    pub(crate) fn page(decoded: usize) -> Budget {
        Budget { ops: MAX_PAGE_OPS, events: MAX_PAGE_EVENTS, decoded }
    }

    pub(crate) fn take_op(&mut self) -> Result<(), Unsupported> {
        self.ops = self.ops.checked_sub(1).ok_or_else(|| Unsupported::new("too many content operators"))?;
        Ok(())
    }

    pub(crate) fn take_event(&mut self) -> Result<(), Unsupported> {
        self.events = self.events.checked_sub(1).ok_or_else(|| Unsupported::new("too much content"))?;
        Ok(())
    }
}

/// What `redact_content` removed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Report {
    pub(crate) glyphs_removed: usize,
    pub(crate) paths_removed: usize,
    pub(crate) shadings_removed: usize,
    pub(crate) inline_images_removed: usize,
}

/// `ops` without the glyphs, painted paths, shadings and inline images of
/// `events` (their interpretation) that intersect any of `rects` (user
/// space). Image and form XObjects are left to their own passes.
pub(crate) fn redact_content(ops: &[Operation], events: &[Event], rects: &[Rect]) -> Result<(Vec<Operation>, Report), Unsupported> {
    let mut report = Report::default();
    let mut dropped: HashSet<usize> = HashSet::new();
    let mut replaced: HashMap<usize, Vec<Operation>> = HashMap::new();
    let mut removed_glyphs: BTreeMap<usize, Vec<&interp::Glyph>> = BTreeMap::new();
    let mut shown: HashMap<usize, usize> = HashMap::new();
    for event in events {
        if let Event::Glyph(g) = event {
            *shown.entry(g.op_index).or_default() += 1;
        }
        match event {
            Event::Glyph(g) if graphics::quad_hit(&g.box_user, rects) => {
                removed_glyphs.entry(g.op_index).or_default().push(g);
            }
            Event::Path(p) => match graphics::path_edit(p, rects)? {
                Some(graphics::PathEdit::Remove(range)) => {
                    dropped.extend(range);
                    report.paths_removed += 1;
                }
                Some(graphics::PathEdit::Unpaint(paint)) => {
                    replaced.insert(paint, vec![Operation::new("n", vec![])]);
                    report.paths_removed += 1;
                }
                None => {}
            },
            Event::Shading(s) if graphics::shading_hit(s, rects) => {
                dropped.insert(s.op_index);
                report.shadings_removed += 1;
            }
            Event::Image(img) if img.source == interp::ImageSource::Inline && graphics::quad_hit(&img.quad_user, rects) => {
                dropped.insert(img.op_index);
                report.inline_images_removed += 1;
            }
            _ => {}
        }
    }
    for (index, glyphs) in removed_glyphs {
        let op = ops.get(index).ok_or_else(|| Unsupported::new("glyph outside the content"))?;
        let (rewritten, whole) = text::rewrite_show(op, &glyphs, text::later_text_depends(ops, index))?;
        report.glyphs_removed += if whole { shown.get(&index).copied().unwrap_or(0) } else { glyphs.len() };
        replaced.insert(index, rewritten);
    }
    let mut out = Vec::with_capacity(ops.len());
    for (i, op) in ops.iter().enumerate() {
        if dropped.contains(&i) {
            continue;
        }
        match replaced.remove(&i) {
            Some(ops) => out.extend(ops),
            None => out.push(op.clone()),
        }
    }
    Ok((out, report))
}
