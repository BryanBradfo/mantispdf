//! What a font's character codes mean as text, for search: the /ToUnicode
//! CMap when there is one, else the simple font's encoding (/Differences
//! glyph names through a small Adobe Glyph List subset).

use crate::rebuild::{Decoded, deref, name_of, strict_content_in};
use lopdf::content::Content;
use lopdf::{Dictionary, Document, Object};
use std::collections::HashMap;

/// Decoded bytes of a /ToUnicode CMap read.
const MAX_CMAP_BYTES: usize = 1 << 20;
/// Codes one font's map may hold.
const MAX_ENTRIES: usize = 1 << 17;
/// Codes one bfrange may cover.
const MAX_RANGE: u32 = 1 << 16;

/// Code to text.
pub(crate) type TextMap = HashMap<u32, String>;

/// The text of every code of font dictionary `font` we can tell: its
/// /ToUnicode entries over (for simple fonts) its encoding.
pub(crate) fn text_map(doc: &Document, font: &Dictionary) -> TextMap {
    let mut map = TextMap::new();
    let simple = !matches!(name_of(font, b"Subtype"), Some(b"Type0"));
    if simple {
        encoding_map(doc, font, &mut map);
    }
    if let Some(Object::Stream(cmap)) = font.get(b"ToUnicode").ok().and_then(|o| deref(doc, o)) {
        let mut charged = 0;
        if let Decoded::Content(bytes) = strict_content_in(Some(doc), cmap, MAX_CMAP_BYTES, &mut charged) {
            read_cmap(&bytes, &mut map);
        }
    }
    map
}

/// UTF-16BE bytes as text (None when they are not valid UTF-16).
fn utf16(bytes: &[u8]) -> Option<String> {
    if !bytes.len().is_multiple_of(2) {
        return None;
    }
    let units: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
    String::from_utf16(&units).ok()
}

/// The code a CMap source string stands for (big-endian, 1 to 4 bytes).
fn code(bytes: &[u8]) -> Option<u32> {
    if bytes.is_empty() || bytes.len() > 4 {
        return None;
    }
    Some(bytes.iter().fold(0u32, |acc, b| acc << 8 | u32::from(*b)))
}

/// `bfchar` and `bfrange` entries of a CMap (parsed as content: operands
/// then the `endbfchar` / `endbfrange` keyword). Bounded; whatever does not
/// parse is ignored.
fn read_cmap(bytes: &[u8], map: &mut TextMap) {
    let Ok(content) = Content::decode(bytes) else {
        return;
    };
    let string = |o: &Object| match o {
        Object::String(b, _) => Some(b.clone()),
        _ => None,
    };
    for op in content.operations {
        match op.operator.as_str() {
            "endbfchar" => {
                for pair in op.operands.chunks_exact(2) {
                    if let (Some(src), Some(dst)) = (string(&pair[0]).and_then(|b| code(&b)), string(&pair[1]).and_then(|b| utf16(&b))) {
                        insert(map, src, dst);
                    }
                }
            }
            "endbfrange" => {
                for triple in op.operands.chunks_exact(3) {
                    let (Some(lo), Some(hi)) = (string(&triple[0]).and_then(|b| code(&b)), string(&triple[1]).and_then(|b| code(&b))) else {
                        continue;
                    };
                    if hi < lo || hi - lo >= MAX_RANGE {
                        continue;
                    }
                    match &triple[2] {
                        Object::String(dst, _) => {
                            // Incrementing form: the last UTF-16 unit counts up.
                            if dst.len() < 2 || dst.len() % 2 != 0 {
                                continue;
                            }
                            let mut units: Vec<u16> = dst.chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
                            let last = units.len() - 1;
                            let first = units[last];
                            for (k, c) in (lo..=hi).enumerate() {
                                units[last] = first.wrapping_add(k as u16);
                                if let Ok(text) = String::from_utf16(&units) {
                                    insert(map, c, text);
                                }
                            }
                        }
                        Object::Array(items) => {
                            for (c, item) in (lo..=hi).zip(items) {
                                if let Some(text) = string(item).and_then(|b| utf16(&b)) {
                                    insert(map, c, text);
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
}

fn insert(map: &mut TextMap, code: u32, text: String) {
    if map.len() < MAX_ENTRIES || map.contains_key(&code) {
        map.insert(code, text);
    }
}

/// Simple fonts: the base encoding (WinAnsi, MacRoman, Standard; the
/// built-in encoding of a font without one is read as Standard) and the
/// /Differences glyph names.
fn encoding_map(doc: &Document, font: &Dictionary, map: &mut TextMap) {
    let encoding = font.get(b"Encoding").ok().and_then(|o| deref(doc, o));
    let base = match encoding {
        Some(Object::Name(n)) => Some(n.as_slice()),
        Some(Object::Dictionary(d)) => name_of(d, b"BaseEncoding"),
        _ => None,
    };
    let base_font = name_of(font, b"BaseFont").unwrap_or(b"");
    if matches!(base_font, b"Symbol" | b"ZapfDingbats") && base.is_none() {
        return;
    }
    for b in 0u8..=255 {
        let ch = match base {
            Some(b"WinAnsiEncoding") => winansi(b),
            Some(b"MacRomanEncoding") => (32..=126).contains(&b).then(|| char::from(b)),
            _ => standard(b),
        };
        if let Some(ch) = ch {
            map.insert(u32::from(b), ch.to_string());
        }
    }
    if let Some(Object::Dictionary(d)) = encoding
        && let Some(Object::Array(diffs)) = d.get(b"Differences").ok().and_then(|o| deref(doc, o))
    {
        let mut code: Option<u32> = None;
        for item in diffs {
            match deref(doc, item) {
                Some(Object::Integer(c)) => code = u32::try_from(*c).ok(),
                Some(Object::Name(name)) => {
                    if let Some(c) = code.filter(|c| *c <= 255) {
                        match glyph_text(name) {
                            Some(text) => {
                                map.insert(c, text);
                            }
                            None => {
                                map.remove(&c);
                            }
                        }
                    }
                    code = code.map(|c| c + 1);
                }
                _ => return,
            }
        }
    }
}

/// StandardEncoding, ASCII part (its quotes are curly).
fn standard(b: u8) -> Option<char> {
    match b {
        b'\'' => Some('\u{2019}'),
        b'`' => Some('\u{2018}'),
        32..=126 => Some(char::from(b)),
        _ => None,
    }
}

/// WinAnsi (Windows-1252).
fn winansi(b: u8) -> Option<char> {
    match b {
        32..=126 | 0xA0..=0xFF => Some(char::from(b)),
        0x80..=0x9F => crate::stamp::fonts::CP1252_HIGH.iter().find(|(_, byte)| *byte == b).map(|(c, _)| *c),
        _ => None,
    }
}

/// Adobe names of U+00A1..=U+00FF, in order.
const LATIN1: [&str; 95] = [
    "exclamdown", "cent", "sterling", "currency", "yen", "brokenbar", "section", "dieresis", "copyright", "ordfeminine",
    "guillemotleft", "logicalnot", "uni00AD", "registered", "macron", "degree", "plusminus", "twosuperior",
    "threesuperior", "acute", "mu", "paragraph", "periodcentered", "cedilla", "onesuperior", "ordmasculine",
    "guillemotright", "onequarter", "onehalf", "threequarters", "questiondown", "Agrave", "Aacute", "Acircumflex",
    "Atilde", "Adieresis", "Aring", "AE", "Ccedilla", "Egrave", "Eacute", "Ecircumflex", "Edieresis", "Igrave",
    "Iacute", "Icircumflex", "Idieresis", "Eth", "Ntilde", "Ograve", "Oacute", "Ocircumflex", "Otilde", "Odieresis",
    "multiply", "Oslash", "Ugrave", "Uacute", "Ucircumflex", "Udieresis", "Yacute", "Thorn", "germandbls", "agrave",
    "aacute", "acircumflex", "atilde", "adieresis", "aring", "ae", "ccedilla", "egrave", "eacute", "ecircumflex",
    "edieresis", "igrave", "iacute", "icircumflex", "idieresis", "eth", "ntilde", "ograve", "oacute", "ocircumflex",
    "otilde", "odieresis", "divide", "oslash", "ugrave", "uacute", "ucircumflex", "udieresis", "yacute", "thorn",
    "ydieresis",
];

/// Adobe names of ASCII punctuation and digits, and common extras.
const NAMED: [(&str, &str); 66] = [
    ("space", " "), ("exclam", "!"), ("quotedbl", "\""), ("numbersign", "#"), ("dollar", "$"), ("percent", "%"),
    ("ampersand", "&"), ("quotesingle", "'"), ("parenleft", "("), ("parenright", ")"), ("asterisk", "*"),
    ("plus", "+"), ("comma", ","), ("hyphen", "-"), ("period", "."), ("slash", "/"), ("zero", "0"), ("one", "1"),
    ("two", "2"), ("three", "3"), ("four", "4"), ("five", "5"), ("six", "6"), ("seven", "7"), ("eight", "8"),
    ("nine", "9"), ("colon", ":"), ("semicolon", ";"), ("less", "<"), ("equal", "="), ("greater", ">"),
    ("question", "?"), ("at", "@"), ("bracketleft", "["), ("backslash", "\\"), ("bracketright", "]"),
    ("asciicircum", "^"), ("underscore", "_"), ("grave", "`"), ("braceleft", "{"), ("bar", "|"), ("braceright", "}"),
    ("asciitilde", "~"), ("quoteleft", "\u{2018}"), ("quoteright", "\u{2019}"), ("quotedblleft", "\u{201C}"),
    ("quotedblright", "\u{201D}"), ("quotesinglbase", "\u{201A}"), ("quotedblbase", "\u{201E}"),
    ("endash", "\u{2013}"), ("emdash", "\u{2014}"), ("bullet", "\u{2022}"), ("ellipsis", "\u{2026}"),
    ("dagger", "\u{2020}"), ("daggerdbl", "\u{2021}"), ("perthousand", "\u{2030}"), ("trademark", "\u{2122}"),
    ("Euro", "\u{20AC}"), ("OE", "\u{0152}"), ("oe", "\u{0153}"), ("Scaron", "\u{0160}"), ("scaron", "\u{0161}"),
    ("Zcaron", "\u{017D}"), ("zcaron", "\u{017E}"), ("Ydieresis", "\u{0178}"), ("dotlessi", "\u{0131}"),
];

/// The text of a glyph name: single letters, the names above, ligatures,
/// `uniXXXX...` and `uXXXX[XX]`; a suffix after `.` is ignored.
pub(crate) fn glyph_text(name: &[u8]) -> Option<String> {
    let name = std::str::from_utf8(name).ok()?;
    let name = name.split('.').next().unwrap_or(name);
    if name.len() == 1 && name.as_bytes()[0].is_ascii_alphabetic() {
        return Some(name.to_string());
    }
    if let Some((_, text)) = NAMED.iter().find(|(n, _)| *n == name) {
        return Some((*text).to_string());
    }
    if let Some(i) = LATIN1.iter().position(|n| *n == name) {
        return char::from_u32(0xA1 + i as u32).map(String::from);
    }
    match name {
        "fi" | "fl" | "ff" | "ffi" | "ffl" => return Some(name.to_string()),
        _ => {}
    }
    let hex = |s: &str| u32::from_str_radix(s, 16).ok().and_then(char::from_u32);
    if let Some(rest) = name.strip_prefix("uni")
        && !rest.is_empty()
        && rest.len() % 4 == 0
        && rest.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return (0..rest.len()).step_by(4).map(|i| hex(&rest[i..i + 4])).collect();
    }
    if let Some(rest) = name.strip_prefix('u')
        && (4..=6).contains(&rest.len())
        && rest.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return hex(rest).map(String::from);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glyph_names() {
        assert_eq!(glyph_text(b"A").as_deref(), Some("A"));
        assert_eq!(glyph_text(b"eacute").as_deref(), Some("\u{e9}"));
        assert_eq!(glyph_text(b"uni00410042").as_deref(), Some("AB"));
        assert_eq!(glyph_text(b"u1F600").as_deref(), Some("\u{1F600}"));
        assert_eq!(glyph_text(b"a.sc").as_deref(), Some("a"));
        assert_eq!(glyph_text(b"fi").as_deref(), Some("fi"));
        assert_eq!(glyph_text(b"seven").as_deref(), Some("7"));
        assert_eq!(glyph_text(b"g123"), None);
    }

    #[test]
    fn cmap_ranges_are_bounded() {
        let mut map = TextMap::new();
        read_cmap(b"1 beginbfrange <0000> <FFFFFF> <0041> endbfrange", &mut map);
        assert!(map.is_empty());
        read_cmap(b"1 beginbfrange <0041> <0043> <0061> endbfrange", &mut map);
        assert_eq!(map.get(&0x42).map(String::as_str), Some("b"));
    }
}
