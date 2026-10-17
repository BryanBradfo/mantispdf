//! Standard 14 font subset (Helvetica, Helvetica-Bold, Times-Roman, Courier):
//! WinAnsi encoding and advance widths from the Adobe core AFMs.

use super::afm_widths::{VMETRICS, WIDTHS};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StdFont {
    Helvetica,
    HelveticaBold,
    TimesRoman,
    Courier,
}

impl StdFont {
    fn index(self) -> usize {
        match self {
            StdFont::Helvetica => 0,
            StdFont::HelveticaBold => 1,
            StdFont::TimesRoman => 2,
            StdFont::Courier => 3,
        }
    }

    pub fn base_font(self) -> &'static str {
        match self {
            StdFont::Helvetica => "Helvetica",
            StdFont::HelveticaBold => "Helvetica-Bold",
            StdFont::TimesRoman => "Times-Roman",
            StdFont::Courier => "Courier",
        }
    }

    /// Ascender per 1000 em.
    pub fn ascent(self) -> f64 {
        f64::from(VMETRICS[self.index()].0)
    }

    /// Descender per 1000 em (negative).
    pub fn descent(self) -> f64 {
        f64::from(VMETRICS[self.index()].1)
    }
}

/// WinAnsi 0x80..=0x9F: the characters that differ from Latin-1 (the five
/// undefined codes 0x81, 0x8D, 0x8F, 0x90, 0x9D are absent).
const CP1252_HIGH: [(char, u8); 27] = [
    ('\u{20AC}', 0x80), ('\u{201A}', 0x82), ('\u{0192}', 0x83), ('\u{201E}', 0x84),
    ('\u{2026}', 0x85), ('\u{2020}', 0x86), ('\u{2021}', 0x87), ('\u{02C6}', 0x88),
    ('\u{2030}', 0x89), ('\u{0160}', 0x8A), ('\u{2039}', 0x8B), ('\u{0152}', 0x8C),
    ('\u{017D}', 0x8E), ('\u{2018}', 0x91), ('\u{2019}', 0x92), ('\u{201C}', 0x93),
    ('\u{201D}', 0x94), ('\u{2022}', 0x95), ('\u{2013}', 0x96), ('\u{2014}', 0x97),
    ('\u{02DC}', 0x98), ('\u{2122}', 0x99), ('\u{0161}', 0x9A), ('\u{203A}', 0x9B),
    ('\u{0153}', 0x9C), ('\u{017E}', 0x9E), ('\u{0178}', 0x9F),
];

/// WinAnsi byte for `c`, or None when the standard fonts cannot show it.
pub(crate) fn winansi_byte(c: char) -> Option<u8> {
    match u32::from(c) {
        0x20..=0x7E | 0xA0..=0xFF => Some(c as u8),
        _ => CP1252_HIGH.iter().find(|(ch, _)| *ch == c).map(|(_, b)| *b),
    }
}

/// Encode `text` as WinAnsi bytes; the error lists unsupported characters
/// (deduplicated, in order of first appearance).
pub fn encode_winansi(text: &str) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::with_capacity(text.len());
    let mut bad = String::new();
    for c in text.chars() {
        match winansi_byte(c) {
            Some(b) => bytes.push(b),
            None if !bad.contains(c) => bad.push(c),
            None => {}
        }
    }
    if bad.is_empty() {
        Ok(bytes)
    } else {
        Err(format!("Characters not supported by the standard PDF fonts: {bad}"))
    }
}

/// Width in points of WinAnsi `bytes` set in `font` at `size`. Bytes outside
/// 32..=255 have no glyph and count as zero.
pub fn text_width(font: StdFont, bytes: &[u8], size: f64) -> f64 {
    let table = &WIDTHS[font.index()];
    // u64: a u32 sum overflows past ~4.3M glyphs.
    let units: u64 = bytes
        .iter()
        .filter(|&&b| b >= 32)
        .map(|&b| u64::from(table[usize::from(b) - 32]))
        .sum();
    units as f64 * size / 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helvetica_matches_afm_sum() {
        // P 667 + a 556 + g 556 + e 556 + space 278 + 1 556 = 3169
        let w = text_width(StdFont::Helvetica, b"Page 1", 10.0);
        assert!((w - 31.69).abs() < 1e-9, "{w}");
    }

    #[test]
    fn courier_is_monospaced() {
        assert!((text_width(StdFont::Courier, b"abcde", 12.0) - 36.0).abs() < 1e-9);
        assert!((text_width(StdFont::Courier, b"iWi.M", 12.0) - 36.0).abs() < 1e-9);
    }

    #[test]
    fn bold_and_times_differ_from_helvetica() {
        let h = text_width(StdFont::Helvetica, b"Hello", 10.0);
        assert!(text_width(StdFont::HelveticaBold, b"Hello", 10.0) > h);
        assert!(text_width(StdFont::TimesRoman, b"Hello", 10.0) < h);
    }

    #[test]
    fn unknown_bytes_have_zero_width() {
        assert_eq!(text_width(StdFont::Helvetica, &[0, 10, 31], 10.0), 0.0);
    }

    #[test]
    fn encodes_latin1_and_cp1252_extras() {
        assert_eq!(encode_winansi("é€—").unwrap(), vec![0xE9, 0x80, 0x97]);
        assert_eq!(encode_winansi("Page 1").unwrap(), b"Page 1");
        assert_eq!(encode_winansi("“quoted” • …").unwrap(), vec![0x93, b'q', b'u', b'o', b't', b'e', b'd', 0x94, b' ', 0x95, b' ', 0x85]);
        assert_eq!(encode_winansi("").unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn rejects_unsupported_characters_deduped_in_order() {
        let err = encode_winansi("日本 ok").unwrap_err();
        assert_eq!(err, "Characters not supported by the standard PDF fonts: 日本");
        let err = encode_winansi("a日b本日").unwrap_err();
        assert!(err.ends_with("日本"), "{err}");
        assert!(encode_winansi("tab\there").is_err());
    }

    #[test]
    fn font_metadata() {
        assert_eq!(StdFont::Helvetica.base_font(), "Helvetica");
        assert_eq!(StdFont::HelveticaBold.base_font(), "Helvetica-Bold");
        assert_eq!(StdFont::TimesRoman.base_font(), "Times-Roman");
        assert_eq!(StdFont::Courier.base_font(), "Courier");
        assert_eq!(StdFont::Helvetica.ascent(), 718.0);
        assert_eq!(StdFont::Helvetica.descent(), -207.0);
        assert_eq!(StdFont::Courier.ascent(), 629.0);
    }

    #[test]
    fn long_runs_do_not_overflow() {
        // 100k glyphs: exact sum.
        let w = text_width(StdFont::Courier, &vec![b'x'; 100_000], 1.0);
        assert_eq!(w, 60_000.0);
        // 5M 'W' (944 units) is past u32::MAX units.
        let w = text_width(StdFont::Helvetica, &vec![b'W'; 5_000_000], 1.0);
        assert_eq!(w, 4_720_000.0);
    }

    #[test]
    fn euro_and_nbsp_widths_exist() {
        let euro = text_width(StdFont::Helvetica, &[0x80], 1000.0);
        assert_eq!(euro, 556.0);
        assert_eq!(text_width(StdFont::Helvetica, &[0xA0], 1000.0), 278.0);
    }
}
