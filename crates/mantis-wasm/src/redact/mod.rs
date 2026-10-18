//! Redaction: remove the content under marked areas (text, images, vector
//! graphics) instead of only covering it.

// The engine lands piece by piece before the job that calls it; drop this
// once the redaction job is exported.
#![cfg_attr(not(test), allow(dead_code))]

pub(crate) mod fonts;
pub(crate) mod interp;

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
