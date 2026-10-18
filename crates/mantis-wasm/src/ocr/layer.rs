//! Placing words: each word is one `Tj` of invisible text (`3 Tr`) at its
//! box. The font size is the box height and the baseline is the
//! recogniser's (clamped into the box) or 0.2 h above the box bottom, so
//! the glyph boxes (ascent 0.8, descent -0.2, see `font`) cover the box;
//! `Tz` stretches the word's half-em glyphs to the box width. The text
//! matrix is the visible-space placement composed with the page's
//! visible-to-user matrix, so rotated and offset pages need no `cm`.
//!
//! A word followed by a space on its line gets a space glyph after it, in
//! its own `Tj` with its own `Tz`: from the word's end to the next word's
//! start (the next word given), or 0.25 em when that gap is not known (no
//! next word, or one that does not start after this one ends). Extractors
//! and our search then read a real space, however tight the gap.

use super::OcrWord;
use super::font::{GLYPH_WIDTH, SPACE_CID};
use crate::page_content::fmt_num;
use crate::redact::interp::concat;
use crate::stamp::page_writer::lossy;
use std::fmt::Write;

/// Share of the box height below the baseline when it is not known.
const DESCENT_SHARE: f64 = 0.2;
/// Width (em) of a space whose gap is not known.
const DEFAULT_SPACE: f64 = 0.25;

/// A word ready to be written.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Placed {
    size: f64,
    /// Horizontal scaling, percent.
    tz: f64,
    tm: [f64; 6],
    cids: Vec<u16>,
    /// `Tz` of the space glyph drawn after the word, if any.
    space_tz: Option<f64>,
}

/// Where `word` (shown with `cids`, at least one) goes on a page whose
/// visible space maps to user space by `page`; `next` is the word drawn
/// after it.
pub(crate) fn place(word: &OcrWord, cids: Vec<u16>, next: Option<&OcrWord>, page: &[f64; 6]) -> Placed {
    let size = word.h;
    let baseline = word.baseline.map_or(word.y + DESCENT_SHARE * word.h, |b| b.clamp(word.y, word.y + word.h));
    let glyph = GLYPH_WIDTH / 1000.0 * size;
    let tz = 100.0 * word.w / (cids.len().max(1) as f64 * glyph);
    let tm = concat(&[1.0, 0.0, 0.0, 1.0, word.x, baseline], page);
    let space_tz = word.space_after.then(|| {
        let gap = next.map(|n| n.x - (word.x + word.w)).filter(|g| *g > 0.0).unwrap_or(DEFAULT_SPACE * size);
        100.0 * gap / glyph
    });
    Placed { size, tz, tm, cids, space_tz }
}

/// A `Tz` operand: `fmt_num`, unless that rounds a positive scale to 0 (a
/// long word in a very narrow, tall box): then every digit (Display never
/// writes an exponent), so the operand stays positive.
fn fmt_scale(v: f64) -> String {
    match fmt_num(v) {
        z if z == "0" && v > 0.0 => format!("{v}"),
        s => s,
    }
}

/// Appends the layer for `words` in font `font` (a page resource name).
pub(crate) fn write_ops(font: &[u8], words: &[Placed], out: &mut Vec<u8>) {
    let mut ops = String::from("q BT 3 Tr\n");
    let mut size = None;
    for w in words {
        if size != Some(w.size) {
            let _ = write!(ops, "/{} {} Tf ", lossy(font), fmt_num(w.size));
            size = Some(w.size);
        }
        let _ = write!(ops, "{} Tz {} Tm <", fmt_scale(w.tz), w.tm.map(fmt_num).join(" "));
        for cid in &w.cids {
            let _ = write!(ops, "{cid:04X}");
        }
        ops.push_str("> Tj");
        if let Some(tz) = w.space_tz {
            let _ = write!(ops, " {} Tz <{SPACE_CID:04X}> Tj", fmt_scale(tz));
        }
        ops.push('\n');
    }
    ops.push_str("ET Q\n");
    out.extend_from_slice(ops.as_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    const IDENTITY: [f64; 6] = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

    fn w(x: f64, y: f64, w: f64, h: f64, baseline: Option<f64>) -> OcrWord {
        OcrWord { text: String::new(), x, y, w, h, baseline, space_after: false }
    }

    #[test]
    fn tz_stretches_half_em_glyphs_to_the_width() {
        let p = place(&w(10.0, 20.0, 60.0, 12.0, None), vec![0x41; 4], None, &IDENTITY);
        // 4 glyphs x 0.5 em x 12 pt = 24 pt drawn over 60 pt.
        assert_eq!(p.tz, 250.0);
        assert_eq!(p.size, 12.0);
        assert_eq!(p.tm, [1.0, 0.0, 0.0, 1.0, 10.0, 20.0 + 0.2 * 12.0]);
    }

    #[test]
    fn page_matrix_is_composed_into_tm() {
        // /Rotate 90 on a 612 x 792 MediaBox.
        let p = place(&w(100.0, 500.0, 10.0, 10.0, Some(505.0)), vec![0x41], None, &[0.0, 1.0, -1.0, 0.0, 612.0, 0.0]);
        assert_eq!(p.tm, [0.0, 1.0, -1.0, 0.0, 612.0 - 505.0, 100.0]);
    }

    #[test]
    fn ops_set_size_once_per_run_and_hex_cids() {
        let next = w(9.0, 0.0, 5.0, 10.0, None);
        let a = place(&OcrWord { space_after: true, ..w(0.0, 0.0, 5.0, 10.0, None) }, vec![0x41, 0xD800], Some(&next), &IDENTITY);
        let b = place(&OcrWord { space_after: true, ..next.clone() }, vec![0x42], None, &IDENTITY);
        let mut out = Vec::new();
        write_ops(b"FOcr1", &[a, b], &mut out);
        assert_eq!(
            String::from_utf8(out).unwrap(),
            "q BT 3 Tr\n/FOcr1 10 Tf 50 Tz 1 0 0 1 0 2 Tm <0041D800> Tj 80 Tz <0020> Tj\n\
             100 Tz 1 0 0 1 9 2 Tm <0042> Tj 50 Tz <0020> Tj\nET Q\n"
        );
    }
}
