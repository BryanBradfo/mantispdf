//! What a font's character codes mean as text, for search: the /ToUnicode
//! CMap when there is one, else the simple font's encoding (/Differences
//! glyph names through a small Adobe Glyph List subset).

use crate::rebuild::{Decoded, deref, name_of, strict_content_in};
use lopdf::content::Content;
use lopdf::{Dictionary, Document, Object, ObjectId};
use std::collections::HashMap;
use std::rc::Rc;

/// Decoded bytes of a /ToUnicode CMap read.
const MAX_CMAP_BYTES: usize = 1 << 20;
/// Codes one font's map may hold.
const MAX_ENTRIES: usize = 1 << 17;
/// Codes one bfrange may cover.
const MAX_RANGE: u32 = 1 << 16;
/// Codes one CMap may make us process (kept or not).
const MAX_WORK: usize = 70_000;
/// Longest text of one code, in UTF-16 units.
const MAX_TEXT_UNITS: usize = 32;

/// Code to text.
pub(crate) type TextMap = HashMap<u32, Rc<str>>;

/// The text maps of one search job, per font object, with the bytes their
/// CMaps decoded charged against what the job has left.
pub(crate) struct TextCache {
    /// None: the font's text cannot be known.
    maps: HashMap<ObjectId, Option<Rc<TextMap>>>,
    /// CMap bytes still allowed.
    limit: usize,
    charged: usize,
}

impl TextCache {
    /// A cache that may decode `limit` bytes of CMaps.
    pub(crate) fn new(limit: usize) -> TextCache {
        TextCache { maps: HashMap::new(), limit, charged: 0 }
    }

    /// CMap bytes decoded so far.
    pub(crate) fn charged(&self) -> usize {
        self.charged
    }

    /// Allow `limit` more bytes from now on (what the job has left; what
    /// was charged before is already out of it).
    pub(crate) fn set_limit(&mut self, limit: usize) {
        self.limit = limit;
    }

    /// The text map of font dictionary `font` (object `id` when it is one);
    /// None when its text cannot be known (a /ToUnicode CMap that cannot be
    /// read in full).
    pub(crate) fn map_for(&mut self, doc: &Document, id: Option<ObjectId>, font: &Dictionary) -> Option<Rc<TextMap>> {
        if let Some(map) = id.and_then(|id| self.maps.get(&id)) {
            return map.clone();
        }
        let mut charged = 0;
        let map = text_map(doc, font, self.limit, &mut charged).map(Rc::new);
        self.charged += charged;
        self.limit = self.limit.saturating_sub(charged);
        if let Some(id) = id {
            self.maps.insert(id, map.clone());
        }
        map
    }
}

/// The text of every code of font dictionary `font` we can tell: its
/// /ToUnicode entries over (for simple fonts) its encoding. A /ToUnicode
/// that cannot be read in full (undecodable, over `left` bytes, past the
/// work caps) makes the font's text unknown (None): falling back to the
/// encoding could read the wrong text. Decoding is added to `charged`.
fn text_map(doc: &Document, font: &Dictionary, left: usize, charged: &mut usize) -> Option<TextMap> {
    let mut map = TextMap::new();
    let simple = !matches!(name_of(font, b"Subtype"), Some(b"Type0"));
    if simple {
        encoding_map(doc, font, &mut map);
    }
    let Ok(cmap) = font.get(b"ToUnicode") else {
        // Without a /ToUnicode, a symbolic font's codes are glyph ids (as are
        // a TrueType font's without /Encoding): their text is unknown.
        return (!simple || !symbolic(doc, font)).then_some(map);
    };
    let Some(Object::Stream(cmap)) = deref(doc, cmap) else {
        return None;
    };
    let Decoded::Content(bytes) = strict_content_in(Some(doc), cmap, MAX_CMAP_BYTES.min(left), charged) else {
        return None;
    };
    if !read_cmap(&bytes, &mut map) {
        return None;
    }
    // Mostly Private Use Area text is not the text shown.
    let private = map.values().filter(|t| t.chars().any(is_private_use)).count();
    if private * 2 > map.len() {
        return None;
    }
    Some(map)
}

fn is_private_use(c: char) -> bool {
    matches!(u32::from(c), 0xE000..=0xF8FF | 0xF0000..=0xFFFFD | 0x100000..=0x10FFFD)
}

/// A simple font whose codes need not follow any standard encoding: the
/// descriptor's Symbolic flag (bit 3), or a TrueType font without /Encoding.
fn symbolic(doc: &Document, font: &Dictionary) -> bool {
    let flags = font
        .get(b"FontDescriptor")
        .ok()
        .and_then(|d| deref(doc, d))
        .and_then(|d| d.as_dict().ok())
        .and_then(|d| d.get(b"Flags").ok())
        .and_then(|f| deref(doc, f))
        .and_then(|f| f.as_i64().ok())
        .unwrap_or(0);
    flags & 4 != 0 || (name_of(font, b"Subtype") == Some(b"TrueType") && !font.has(b"Encoding"))
}

/// `text` cut to at most `MAX_TEXT_UNITS` UTF-16 units.
fn capped(text: String) -> Rc<str> {
    let mut units = 0;
    let end = text
        .char_indices()
        .find(|(_, c)| {
            units += c.len_utf16();
            units > MAX_TEXT_UNITS
        })
        .map_or(text.len(), |(i, _)| i);
    Rc::from(&text[..end])
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
/// then the `endbfchar` / `endbfrange` keyword). Every code processed, times
/// the UTF-16 units of its text, counts against `MAX_WORK`, kept or not.
/// False when reading stopped there or at a full map (or did not parse):
/// the map is then incomplete.
fn read_cmap(bytes: &[u8], map: &mut TextMap) -> bool {
    // All of it must parse: a CMap read in part could leave codes unknown
    // that the encoding would then read wrongly.
    let Some(operations) = crate::rebuild::decode_complete(bytes) else {
        return false;
    };
    let content = Content { operations };
    let string = |o: &Object| match o {
        Object::String(b, _) => Some(b.clone()),
        _ => None,
    };
    let mut work = 0usize;
    for op in content.operations {
        match op.operator.as_str() {
            "endbfchar" => {
                for pair in op.operands.chunks_exact(2) {
                    work += string(&pair[1]).map_or(1, |b| (b.len() / 2).clamp(1, MAX_TEXT_UNITS));
                    if work > MAX_WORK || map.len() >= MAX_ENTRIES {
                        return false;
                    }
                    if let (Some(src), Some(dst)) = (string(&pair[0]).and_then(|b| code(&b)), string(&pair[1]).and_then(|b| utf16(&b))) {
                        map.insert(src, capped(dst));
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
                    let units_per_code = match &triple[2] {
                        Object::String(dst, _) => (dst.len() / 2).clamp(1, MAX_TEXT_UNITS),
                        _ => MAX_TEXT_UNITS,
                    };
                    work += (hi - lo + 1) as usize * units_per_code;
                    if work > MAX_WORK || map.len() >= MAX_ENTRIES {
                        return false;
                    }
                    match &triple[2] {
                        Object::String(dst, _) => {
                            // Incrementing form: the last UTF-16 unit counts up
                            // (of the target cut to `MAX_TEXT_UNITS` first).
                            if dst.len() < 2 || !dst.len().is_multiple_of(2) {
                                continue;
                            }
                            let mut units: Vec<u16> =
                                dst.chunks_exact(2).take(MAX_TEXT_UNITS).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
                            let last = units.len() - 1;
                            let first = units[last];
                            for (k, c) in (lo..=hi).enumerate() {
                                units[last] = first.wrapping_add(k as u16);
                                if let Ok(text) = String::from_utf16(&units) {
                                    map.insert(c, capped(text));
                                }
                            }
                        }
                        Object::Array(items) => {
                            for (c, item) in (lo..=hi).zip(items) {
                                if let Some(text) = string(item).and_then(|b| utf16(&b)) {
                                    map.insert(c, capped(text));
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
    true
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
            map.insert(u32::from(b), Rc::from(ch.to_string()));
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
                                map.insert(c, capped(text));
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
    use lopdf::dictionary;

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
    fn cmap_work_is_counted_even_for_codes_not_kept() {
        // 70000 codes of ranges (each mapping the same few codes again),
        // then one more entry: past the work cap, it is not read.
        let mut cmap = String::from("1 beginbfrange ");
        for _ in 0..70 {
            cmap.push_str("<0000> <03E7> <0041> ");
        }
        cmap.push_str("endbfrange 1 beginbfchar <FFFF> <0042> endbfchar");
        let mut map = TextMap::new();
        assert!(!read_cmap(cmap.as_bytes(), &mut map), "stopped: the map is incomplete");
        assert!(!map.contains_key(&0xFFFF));
    }

    #[test]
    fn long_range_targets_are_cut_and_their_units_counted() {
        let long = "0041".repeat(40);
        let mut map = TextMap::new();
        assert!(read_cmap(format!("1 beginbfrange <0000> <0001> <{long}> endbfrange").as_bytes(), &mut map));
        assert_eq!(map.get(&1).map(|t| t.encode_utf16().count()), Some(32));
        // 3000 codes of 32 units each: past the work cap.
        let mut map = TextMap::new();
        assert!(!read_cmap(format!("1 beginbfrange <0000> <0BB7> <{long}> endbfrange").as_bytes(), &mut map));
    }

    #[test]
    fn a_font_whose_cmap_cannot_be_read_has_no_text() {
        let mut doc = Document::with_version("1.7");
        let broken = doc.add_object(lopdf::Stream::new(lopdf::dictionary! { "Filter" => "FlateDecode" }, b"not zlib".to_vec()));
        let font = doc.add_object(lopdf::dictionary! {
            "Type" => "Font", "Subtype" => "Type1", "Encoding" => "WinAnsiEncoding", "ToUnicode" => broken,
        });
        let dict = doc.get_dictionary(font).unwrap().clone();
        assert!(TextCache::new(1 << 20).map_for(&doc, Some(font), &dict).is_none(), "no silent fallback to the encoding");
        // Too large for what the job has left: unknown too.
        let cmap = doc.add_object(lopdf::Stream::new(lopdf::dictionary! {}, b"1 beginbfchar <01> <0041> endbfchar".to_vec()));
        let font = doc.add_object(lopdf::dictionary! { "Type" => "Font", "Subtype" => "Type1", "ToUnicode" => cmap });
        let dict = doc.get_dictionary(font).unwrap().clone();
        assert!(TextCache::new(10).map_for(&doc, Some(font), &dict).is_none());
    }

    #[test]
    fn the_cache_charges_each_cmap_once() {
        let mut doc = Document::with_version("1.7");
        let font = |doc: &mut Document| {
            let cmap = doc.add_object(lopdf::Stream::new(lopdf::dictionary! {}, b"1 beginbfchar <01> <0041> endbfchar".to_vec()));
            let id = doc.add_object(lopdf::dictionary! { "Type" => "Font", "Subtype" => "Type1", "ToUnicode" => cmap });
            (id, doc.get_dictionary(id).unwrap().clone())
        };
        let (a, a_dict) = font(&mut doc);
        let (b, b_dict) = font(&mut doc);
        // Room for both (35 bytes each); the search lowers the limit by what
        // was charged, so the second must still fit.
        let mut cache = TextCache::new(70);
        assert!(cache.map_for(&doc, Some(a), &a_dict).is_some());
        cache.set_limit(70 - cache.charged());
        assert!(cache.map_for(&doc, Some(b), &b_dict).is_some());
        assert_eq!(cache.charged(), 70);
    }

    #[test]
    fn mapped_strings_are_capped_at_32_units() {
        let mut map = TextMap::new();
        let long = "0041".repeat(40);
        let _ = read_cmap(format!("1 beginbfchar <01> <{long}> endbfchar").as_bytes(), &mut map);
        assert_eq!(map.get(&1).map(|t| t.encode_utf16().count()), Some(32));
    }

    #[test]
    fn text_maps_are_cached_per_font_and_charged_to_the_budget() {
        let mut doc = Document::with_version("1.7");
        let cmap = doc.add_object(lopdf::Stream::new(lopdf::dictionary! {}, b"1 beginbfchar <01> <0041> endbfchar".to_vec()));
        let font = doc.add_object(lopdf::dictionary! { "Type" => "Font", "Subtype" => "Type1", "ToUnicode" => cmap });
        let dict = doc.get_dictionary(font).unwrap().clone();
        let mut cache = TextCache::new(1 << 20);
        let a = cache.map_for(&doc, Some(font), &dict).unwrap();
        let b = cache.map_for(&doc, Some(font), &dict).unwrap();
        assert!(std::rc::Rc::ptr_eq(&a, &b));
        assert_eq!(cache.charged(), 35, "decoded once");
        assert_eq!(a.get(&1).map(|t| &**t), Some("A"));

    }

    #[test]
    fn cmap_ranges_are_bounded() {
        let mut map = TextMap::new();
        let _ = read_cmap(b"1 beginbfrange <0000> <FFFFFF> <0041> endbfrange", &mut map);
        assert!(map.is_empty());
        let _ = read_cmap(b"1 beginbfrange <0041> <0043> <0061> endbfrange", &mut map);
        assert_eq!(map.get(&0x42).map(|t| &**t), Some("b"));
    }
}
