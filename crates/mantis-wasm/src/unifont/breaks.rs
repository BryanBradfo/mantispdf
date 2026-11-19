//! Greedy line breaking at UAX 14 opportunities against the box width, with
//! a hard break between shaping clusters for a word wider than the box.

use std::ops::Range;

/// Width slack for float sums compared against the box width.
pub(crate) const EPS: f64 = 1e-9;

/// Line breaking of one paragraph on its measured cluster widths.
pub(crate) struct Breaker<'t> {
    text: &'t str,
    /// `prefix[b]`: width of the clusters starting before byte `b`.
    prefix: Vec<f64>,
    cluster_start: &'t [bool],
    /// Break opportunities (byte offsets a line may end at), ascending.
    opportunities: Vec<usize>,
    max_width: f64,
}

impl<'t> Breaker<'t> {
    /// `advance[b]` is the width in points of the shaping cluster starting at
    /// byte `b` (0 elsewhere); `cluster_start[b]` marks those bytes.
    pub(crate) fn new(text: &'t str, advance: &[f64], cluster_start: &'t [bool], max_width: f64) -> Self {
        let mut prefix = Vec::with_capacity(text.len() + 1);
        prefix.push(0.0);
        for i in 0..text.len() {
            prefix.push(prefix[i] + advance.get(i).copied().unwrap_or(0.0));
        }
        let opportunities = unicode_linebreak::linebreaks(text).map(|(pos, _)| pos).collect();
        Breaker { text, prefix, cluster_start, opportunities, max_width }
    }

    /// End of `s..e` without its trailing whitespace (which takes no room).
    pub(crate) fn trim(&self, s: usize, e: usize) -> usize {
        s + self.text[s..e].trim_end_matches(char::is_whitespace).len()
    }

    /// Start of the next line after a cut at `at`: leading whitespace skipped.
    pub(crate) fn skip_blanks(&self, at: usize) -> usize {
        at + (self.text[at..].len() - self.text[at..].trim_start_matches(char::is_whitespace).len())
    }

    fn fits(&self, s: usize, e: usize) -> bool {
        self.prefix[self.trim(s, e)] - self.prefix[s] <= self.max_width + EPS
    }

    /// The next line from `from` (a line start): its content range (trailing
    /// whitespace dropped) and where the line after it starts. A line holds
    /// at least one cluster, so a box narrower than a glyph still progresses.
    /// At the paragraph end, an empty range at the end.
    pub(crate) fn next_line(&self, from: usize) -> (Range<usize>, usize) {
        let first = self.opportunities.partition_point(|&p| p <= from);
        let mut fitting: Option<usize> = None;
        for &pos in &self.opportunities[first..] {
            if self.fits(from, pos) {
                fitting = Some(pos);
                continue;
            }
            if let Some(end) = fitting {
                return (from..self.trim(from, end), end);
            }
            // The segment alone is too wide: cut it between clusters.
            let end = self.trim(from, pos);
            let mut prev = from;
            for b in (from + 1..=end).filter(|&b| b == end || self.cluster_start.get(b) == Some(&true)) {
                if self.prefix[b] - self.prefix[from] > self.max_width + EPS && prev > from {
                    return (from..prev, prev);
                }
                prev = b;
            }
            return (from..end, pos);
        }
        let end = fitting.unwrap_or(self.text.len());
        (from..self.trim(from, end), end.max(from))
    }

    /// Where to shorten the line `range` by one step: the last break
    /// opportunity inside it, else its last cluster start. None when it
    /// holds one cluster only.
    pub(crate) fn shorter(&self, range: &Range<usize>) -> Option<usize> {
        let inside = |b: usize| b > range.start && b < range.end;
        let opportunity = self.opportunities.iter().rev().copied().find(|&b| inside(b) && self.trim(range.start, b) > range.start);
        opportunity.or_else(|| (range.start + 1..range.end).rev().find(|&b| self.cluster_start.get(b) == Some(&true)))
    }
}
