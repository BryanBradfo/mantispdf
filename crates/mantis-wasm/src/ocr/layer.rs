//! Placing words: each word is one `Tj` of invisible text (`3 Tr`) at its
//! box. The font size is the box height and the baseline is the
//! recogniser's (clamped into the box) or 0.2 h above the box bottom, so
//! the glyph boxes (ascent 0.8, descent -0.2, see `font`) cover the box;
//! `Tz` stretches the word's half-em glyphs to the box width. The text
//! matrix is the visible-space placement composed with the page's
//! visible-to-user matrix, so rotated and offset pages need no `cm`.

use super::OcrWord;
use super::font::GLYPH_WIDTH;
use crate::page_content::fmt_num;
use crate::redact::interp::concat;
use crate::stamp::page_writer::lossy;
use std::fmt::Write;

/// Share of the box height below the baseline when it is not known.
const DESCENT_SHARE: f64 = 0.2;

/// A word ready to be written.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Placed {
    size: f64,
    /// Horizontal scaling, percent.
    tz: f64,
    tm: [f64; 6],
    cids: Vec<u16>,
}

/// Where `word` (shown with `cids`, at least one) goes on a page whose
/// visible space maps to user space by `page`.
pub(crate) fn place(word: &OcrWord, cids: Vec<u16>, page: &[f64; 6]) -> Placed {
    let size = word.h;
    let baseline = word.baseline.map_or(word.y + DESCENT_SHARE * word.h, |b| b.clamp(word.y, word.y + word.h));
    let advance = cids.len().max(1) as f64 * GLYPH_WIDTH / 1000.0 * size;
    let tz = 100.0 * word.w / advance;
    let tm = concat(&[1.0, 0.0, 0.0, 1.0, word.x, baseline], page);
    Placed { size, tz, tm, cids }
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
        let _ = write!(ops, "{} Tz {} Tm <", fmt_num(w.tz), w.tm.map(fmt_num).join(" "));
        for cid in &w.cids {
            let _ = write!(ops, "{cid:04X}");
        }
        ops.push_str("> Tj\n");
    }
    ops.push_str("ET Q\n");
    out.extend_from_slice(ops.as_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    const IDENTITY: [f64; 6] = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

    fn w(x: f64, y: f64, w: f64, h: f64, baseline: Option<f64>) -> OcrWord {
        OcrWord { text: String::new(), x, y, w, h, baseline }
    }

    #[test]
    fn tz_stretches_half_em_glyphs_to_the_width() {
        let p = place(&w(10.0, 20.0, 60.0, 12.0, None), vec![0x41; 4], &IDENTITY);
        // 4 glyphs x 0.5 em x 12 pt = 24 pt drawn over 60 pt.
        assert_eq!(p.tz, 250.0);
        assert_eq!(p.size, 12.0);
        assert_eq!(p.tm, [1.0, 0.0, 0.0, 1.0, 10.0, 20.0 + 0.2 * 12.0]);
    }

    #[test]
    fn page_matrix_is_composed_into_tm() {
        // /Rotate 90 on a 612 x 792 MediaBox.
        let p = place(&w(100.0, 500.0, 10.0, 10.0, Some(505.0)), vec![0x41], &[0.0, 1.0, -1.0, 0.0, 612.0, 0.0]);
        assert_eq!(p.tm, [0.0, 1.0, -1.0, 0.0, 612.0 - 505.0, 100.0]);
    }

    #[test]
    fn ops_set_size_once_per_run_and_hex_cids() {
        let a = place(&w(0.0, 0.0, 5.0, 10.0, None), vec![0x41, 0xD800], &IDENTITY);
        let b = place(&w(9.0, 0.0, 5.0, 10.0, None), vec![0x42], &IDENTITY);
        let mut out = Vec::new();
        write_ops(b"FOcr1", &[a, b], &mut out);
        assert_eq!(
            String::from_utf8(out).unwrap(),
            "q BT 3 Tr\n/FOcr1 10 Tf 50 Tz 1 0 0 1 0 2 Tm <0041D800> Tj\n100 Tz 1 0 0 1 9 2 Tm <0042> Tj\nET Q\n"
        );
    }
}
