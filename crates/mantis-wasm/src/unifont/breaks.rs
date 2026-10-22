//! Greedy line breaking at UAX 14 opportunities against the box width, with
//! a hard break between shaping clusters for a word wider than the box.

use std::ops::Range;

/// Width slack for float sums compared against the box width.
const EPS: f64 = 1e-9;

/// Line ranges of `text` (one paragraph). `advance[b]` is the width in points
/// of the shaping cluster starting at byte `b` (0 elsewhere); `cluster_start[b]`
/// marks those bytes. Each range drops the line's trailing whitespace, which
/// takes no room. A line holds at least one cluster, so a box narrower than a
/// glyph still progresses. An empty paragraph is one empty line.
pub(crate) fn break_lines(text: &str, advance: &[f64], cluster_start: &[bool], max_width: f64) -> Vec<Range<usize>> {
    let mut prefix = Vec::with_capacity(text.len() + 1);
    prefix.push(0.0);
    for a in advance.iter().take(text.len()) {
        prefix.push(prefix[prefix.len() - 1] + a);
    }
    prefix.resize(text.len() + 1, prefix[prefix.len() - 1]);
    let trim = |s: usize, e: usize| s + text[s..e].trim_end_matches(char::is_whitespace).len();
    let fits = |s: usize, e: usize| prefix[trim(s, e)] - prefix[s] <= max_width + EPS;

    let mut lines = Vec::new();
    let mut start = 0;
    // End of the longest line from `start` known to fit.
    let mut fitting: Option<usize> = None;
    for (pos, _) in unicode_linebreak::linebreaks(text) {
        if pos <= start {
            continue;
        }
        loop {
            if fits(start, pos) {
                fitting = Some(pos);
                break;
            }
            if let Some(end) = fitting.take() {
                lines.push(start..trim(start, end));
                start = end;
                continue;
            }
            // The segment alone is too wide: cut it between clusters.
            let end = trim(start, pos);
            let mut prev = start;
            for b in (start + 1..=end).filter(|&b| b == end || cluster_start.get(b) == Some(&true)) {
                if prefix[b] - prefix[start] > max_width + EPS && prev > start {
                    lines.push(start..prev);
                    start = prev;
                }
                prev = b;
            }
            fitting = Some(pos);
            break;
        }
    }
    if let Some(end) = fitting {
        lines.push(start..trim(start, end));
    }
    if lines.is_empty() {
        lines.push(0..0);
    }
    lines
}
