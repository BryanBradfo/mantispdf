//! Font metrics the redaction interpreter needs: how a string splits into
//! character codes, each code's advance width and the box its glyph may ink.
//! Anything that cannot be measured with certainty is `Unsupported`.

use super::Unsupported;
use crate::rebuild::deref;
use crate::stamp::fonts::{StdFont, text_width};
use lopdf::{Dictionary, Document, Object};
use std::collections::{HashMap, HashSet};
use std::ops::Range;

/// Ascent and descent (em) when the font has no usable descriptor values.
const FALLBACK_ASCENT: f64 = 0.9;
const FALLBACK_DESCENT: f64 = -0.2;
/// Descriptor values are clamped into these ranges: a bogus value must not
/// shrink a glyph box to nothing nor grow it over neighbouring lines.
const ASCENT_RANGE: (f64, f64) = (0.7, 1.0);
const DESCENT_RANGE: (f64, f64) = (-0.35, -0.1);
/// A glyph narrower than this (zero-width marks, bogus /Widths) still inks
/// something: its box spans this far on both sides of its origin.
const MIN_INK_WIDTH: f64 = 0.01;
const NARROW_GLYPH_REACH: f64 = 0.6;
/// A declared width below this share of the font's plausible width (capped
/// at `PLAUSIBLE_CAP`) is taken as bogus: the removal box then spans the
/// plausible width instead.
const BOGUS_WIDTH_SHARE: f64 = 0.25;
/// Cap (em) of the plausible width the bogus test compares with, so a wide
/// /FontBBox does not make honest narrow glyphs (i, l, punctuation) bogus.
const PLAUSIBLE_CAP: f64 = 0.5;
/// Plausible glyph width (em) of a font without /AvgWidth or /FontBBox.
const FALLBACK_PLAUSIBLE: f64 = 0.5;
/// Highest CID of a two-byte Identity encoding.
const MAX_CID: i64 = 0xFFFF;
/// Widths a /W array may assign in total (ranges may overlap, so this can
/// exceed the CID count of a sane font only for a hostile one).
const MAX_W_ASSIGNMENTS: usize = 1 << 20;

/// Measured font. Widths and boxes are in text space units per unit of
/// font size (1 em = 1.0).
#[derive(Debug, Clone)]
pub(crate) struct Font {
    label: String,
    kind: Kind,
    ascent: f64,
    descent: f64,
    /// Typical glyph width (em): /AvgWidth, else the /FontBBox width, else
    /// 0.5 em. Stands in for declared widths too small to be true.
    plausible: f64,
    /// Code to text, when loaded for search.
    text: Option<std::rc::Rc<super::unicode::TextMap>>,
    /// The font is Tesseract's "GlyphLessFont" (an OCR text layer's font; MantisPDF's OCR uses it too).
    glyphless: bool,
}

#[derive(Debug, Clone)]
enum Kind {
    /// One-byte codes with widths from /Widths.
    Table { first: i64, widths: Vec<f64>, missing: f64 },
    /// A standard 14 font without /Widths: widths from the Adobe AFMs.
    Standard { font: StdFont, encoding: StdEncoding, remapped: HashSet<u8> },
    /// Type0 with Identity-H: two-byte codes are CIDs.
    Identity { widths: HashMap<u32, f64>, default: f64 },
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum StdEncoding {
    WinAnsi,
    Standard,
    MacRoman,
}

fn number(doc: &Document, obj: &Object) -> Option<f64> {
    let v = match deref(doc, obj)? {
        Object::Integer(i) => *i as f64,
        Object::Real(r) => f64::from(*r),
        _ => return None,
    };
    v.is_finite().then_some(v)
}

fn numbers(doc: &Document, obj: Option<&Object>) -> Option<Vec<f64>> {
    match deref(doc, obj?)? {
        Object::Array(items) => items.iter().map(|o| number(doc, o)).collect(),
        _ => None,
    }
}

fn dict<'a>(doc: &'a Document, obj: Option<&'a Object>) -> Option<&'a Dictionary> {
    deref(doc, obj?)?.as_dict().ok()
}

fn name<'a>(doc: &'a Document, obj: Option<&'a Object>) -> Option<&'a [u8]> {
    deref(doc, obj?)?.as_name().ok()
}

/// /FirstChar of a one-byte font.
fn first_char(doc: &Document, font: &Dictionary) -> Option<i64> {
    let first = number(doc, font.get(b"FirstChar").ok()?)?;
    (first.fract() == 0.0 && (0.0..=255.0).contains(&first)).then_some(first as i64)
}

/// The advance box grows this much (em) on each side.
const CORE_X_MARGIN: f64 = 0.05;

/// Ascent and descent (em) of a font descriptor.
type Metrics = (f64, f64);

fn descriptor_metrics(doc: &Document, descriptor: Option<&Dictionary>) -> Metrics {
    vertical_metrics(doc, descriptor)
}

/// The plausible glyph width (em) of a font descriptor: /AvgWidth, else
/// the /FontBBox width, else 0.5 em.
fn plausible_width(doc: &Document, descriptor: Option<&Dictionary>) -> f64 {
    let avg = descriptor.and_then(|d| d.get(b"AvgWidth").ok()).and_then(|o| number(doc, o)).filter(|w| *w > 0.0);
    let bbox = descriptor
        .and_then(|d| numbers(doc, d.get(b"FontBBox").ok()))
        .filter(|b| b.len() == 4)
        .map(|b| (b[2] - b[0]).abs())
        .filter(|w| *w > 0.0);
    avg.or(bbox).map_or(FALLBACK_PLAUSIBLE, |w| w / 1000.0)
}

/// Ascent and descent (em) from a font descriptor, clamped, with fallbacks.
fn vertical_metrics(doc: &Document, descriptor: Option<&Dictionary>) -> (f64, f64) {
    let value = |key: &[u8]| descriptor.and_then(|d| d.get(key).ok()).and_then(|o| number(doc, o));
    let ascent = match value(b"Ascent") {
        Some(a) if a > 0.0 => (a / 1000.0).clamp(ASCENT_RANGE.0, ASCENT_RANGE.1),
        _ => FALLBACK_ASCENT,
    };
    let descent = match value(b"Descent") {
        Some(d) if d < 0.0 => (d / 1000.0).clamp(DESCENT_RANGE.0, DESCENT_RANGE.1),
        _ => FALLBACK_DESCENT,
    };
    (ascent, descent)
}

/// The AFM metrics a standard 14 font name (or a common metric-compatible
/// alias) uses; None for fonts whose metrics we do not carry.
fn standard_metrics(base: &[u8]) -> Option<StdFont> {
    let base = match base.iter().position(|&b| b == b'+') {
        Some(6) => &base[7..],
        _ => base,
    };
    match base {
        b"Helvetica" | b"Helvetica-Oblique" | b"Arial" | b"ArialMT" | b"Arial,Italic" | b"Arial-ItalicMT" => {
            Some(StdFont::Helvetica)
        }
        b"Helvetica-Bold" | b"Helvetica-BoldOblique" | b"Arial,Bold" | b"Arial-BoldMT" | b"Arial,BoldItalic"
        | b"Arial-BoldItalicMT" => Some(StdFont::HelveticaBold),
        b"Times-Roman" | b"TimesNewRoman" | b"TimesNewRomanPSMT" => Some(StdFont::TimesRoman),
        b"Courier" | b"Courier-Bold" | b"Courier-Oblique" | b"Courier-BoldOblique" | b"CourierNew"
        | b"CourierNewPSMT" | b"CourierNew,Bold" | b"CourierNew,Italic" | b"CourierNew,BoldItalic" => {
            Some(StdFont::Courier)
        }
        _ => None,
    }
}

impl Font {
    /// Load the font dictionary `obj` (direct or by reference); `name` only
    /// labels errors.
    pub(crate) fn load(doc: &Document, name_bytes: &[u8], obj: &Object) -> Result<Font, Unsupported> {
        Self::load_with(doc, name_bytes, obj, None)
    }

    /// `load`, reading what the codes mean as text too (through `text`, the
    /// job's cache) when given. `obj` may be a reference: its id keys the
    /// cache.
    pub(crate) fn load_with(
        doc: &Document,
        name_bytes: &[u8],
        obj: &Object,
        text: Option<&mut super::unicode::TextCache>,
    ) -> Result<Font, Unsupported> {
        let label = String::from_utf8_lossy(name_bytes).into_owned();
        let err = |what: &str| Unsupported(format!("font {label}: {what}"));
        let Some(font) = deref(doc, obj).and_then(|o| o.as_dict().ok()) else {
            return Err(err("not a font dictionary"));
        };
        let subtype = name(doc, font.get(b"Subtype").ok()).unwrap_or(b"");
        let glyphless = name(doc, font.get(b"BaseFont").ok()).is_some_and(|b| b == b"GlyphLessFont" || b.ends_with(b"+GlyphLessFont"));
        let (kind, (ascent, descent), plausible) = match subtype {
            b"Type1" | b"MMType1" | b"TrueType" => {
                let descriptor = dict(doc, font.get(b"FontDescriptor").ok());
                let kind = Self::simple(doc, font, descriptor, &err)?;
                let metrics = match (&kind, descriptor) {
                    // A standard font without descriptor: the AFM metrics,
                    // widened for accents and descenders the AFM line omits.
                    (Kind::Standard { font, .. }, None) => (
                        (font.ascent() / 1000.0).clamp(ASCENT_RANGE.0, ASCENT_RANGE.1),
                        (font.descent() / 1000.0).clamp(DESCENT_RANGE.0, DESCENT_RANGE.1),
                    ),
                    _ => descriptor_metrics(doc, descriptor),
                };
                (kind, metrics, plausible_width(doc, descriptor))
            }
            b"Type0" => Self::type0(doc, font, &err)?,
            // Glyph procedures can paint anywhere: pages using one are
            // rasterized. Search reads past them: their glyphs only advance
            // (their text is unknown, so the page is reported).
            b"Type3" if text.is_some() => {
                let (kind, (ascent, descent), plausible) = Self::type3_for_search(doc, font, &err)?;
                return Ok(Font { label, kind, ascent, descent, plausible, text: None, glyphless });
            }
            b"Type3" => return Err(err("Type3 fonts are not supported")),
            other => return Err(err(&format!("unsupported font type {}", String::from_utf8_lossy(other)))),
        };
        let text = text.and_then(|cache| cache.map_for(doc, obj.as_reference().ok(), font));
        Ok(Font { label, kind, ascent, descent, plausible, text, glyphless })
    }

    /// True for Tesseract's "GlyphLessFont", the font of OCR text layers.
    pub(crate) fn is_glyphless(&self) -> bool {
        self.glyphless
    }

    fn simple(
        doc: &Document,
        font: &Dictionary,
        descriptor: Option<&Dictionary>,
        err: &dyn Fn(&str) -> Unsupported,
    ) -> Result<Kind, Unsupported> {
        if let Ok(widths) = font.get(b"Widths") {
            let widths = numbers(doc, Some(widths)).ok_or_else(|| err("malformed /Widths"))?;
            let first = first_char(doc, font).ok_or_else(|| err("malformed /FirstChar"))?;
            let missing = descriptor
                .and_then(|d| d.get(b"MissingWidth").ok())
                .and_then(|o| number(doc, o))
                .unwrap_or(0.0);
            let widths = widths.into_iter().take(256).map(|w| w / 1000.0).collect();
            return Ok(Kind::Table { first, widths, missing: missing / 1000.0 });
        }
        let base = name(doc, font.get(b"BaseFont").ok()).unwrap_or(b"");
        let std = standard_metrics(base).ok_or_else(|| err("no /Widths and not a standard font"))?;
        let (encoding, remapped) = Self::standard_encoding(doc, font.get(b"Encoding").ok(), err)?;
        Ok(Kind::Standard { font: std, encoding, remapped })
    }

    /// The base encoding of a standard font and the codes /Differences
    /// remaps (their widths are unknown).
    fn standard_encoding(
        doc: &Document,
        obj: Option<&Object>,
        err: &dyn Fn(&str) -> Unsupported,
    ) -> Result<(StdEncoding, HashSet<u8>), Unsupported> {
        let base_of = |n: Option<&[u8]>| match n {
            None | Some(b"StandardEncoding") => Ok(StdEncoding::Standard),
            Some(b"WinAnsiEncoding") => Ok(StdEncoding::WinAnsi),
            Some(b"MacRomanEncoding") => Ok(StdEncoding::MacRoman),
            Some(other) => Err(err(&format!("unsupported encoding {}", String::from_utf8_lossy(other)))),
        };
        let Some(obj) = obj.and_then(|o| deref(doc, o)) else {
            return Ok((StdEncoding::Standard, HashSet::new()));
        };
        match obj {
            Object::Name(n) => Ok((base_of(Some(n))?, HashSet::new())),
            Object::Dictionary(d) => {
                let base = base_of(name(doc, d.get(b"BaseEncoding").ok()))?;
                let mut remapped = HashSet::new();
                if let Ok(diffs) = d.get(b"Differences") {
                    let Some(Object::Array(items)) = deref(doc, diffs) else {
                        return Err(err("malformed /Differences"));
                    };
                    let mut code: Option<i64> = None;
                    for item in items {
                        match deref(doc, item) {
                            Some(Object::Integer(c)) => code = Some(*c),
                            Some(Object::Name(_)) => {
                                let c = code.ok_or_else(|| err("malformed /Differences"))?;
                                if let Ok(b) = u8::try_from(c) {
                                    remapped.insert(b);
                                }
                                code = Some(c.saturating_add(1));
                            }
                            _ => return Err(err("malformed /Differences")),
                        }
                    }
                }
                Ok((base, remapped))
            }
            _ => Err(err("malformed /Encoding")),
        }
    }

    /// A Type3 font as search reads it: one-byte codes advancing by /Widths
    /// through the /FontMatrix, heights from the /FontBBox (clamped), no text.
    fn type3_for_search(doc: &Document, font: &Dictionary, err: &dyn Fn(&str) -> Unsupported) -> Result<(Kind, Metrics, f64), Unsupported> {
        let m = numbers(doc, font.get(b"FontMatrix").ok()).filter(|m| m.len() == 6).ok_or_else(|| err("malformed /FontMatrix"))?;
        let widths = numbers(doc, font.get(b"Widths").ok()).ok_or_else(|| err("malformed /Widths"))?;
        let first = first_char(doc, font).ok_or_else(|| err("malformed /FirstChar"))?;
        let widths = widths.into_iter().take(256).map(|w| w * m[0]).collect();
        let bbox = numbers(doc, font.get(b"FontBBox").ok()).filter(|b| b.len() == 4);
        let plausible = bbox.as_ref().map(|b| ((b[2] - b[0]) * m[0]).abs()).filter(|w| *w > 0.0).unwrap_or(FALLBACK_PLAUSIBLE);
        let (ascent, descent) = match bbox {
            Some(b) => {
                let ys = [b[1], b[3]].map(|y| m[1] * b[0] + m[3] * y + m[5]);
                let (lo, hi) = (ys[0].min(ys[1]), ys[0].max(ys[1]));
                (hi.clamp(ASCENT_RANGE.0, ASCENT_RANGE.1), lo.clamp(DESCENT_RANGE.0, DESCENT_RANGE.1))
            }
            None => (FALLBACK_ASCENT, FALLBACK_DESCENT),
        };
        Ok((Kind::Table { first, widths, missing: 0.0 }, (ascent, descent), plausible))
    }

    fn type0(doc: &Document, font: &Dictionary, err: &dyn Fn(&str) -> Unsupported) -> Result<(Kind, Metrics, f64), Unsupported> {
        match deref(doc, font.get(b"Encoding").map_err(|_| err("no /Encoding"))?) {
            Some(Object::Name(n)) if n == b"Identity-H" => {}
            Some(Object::Name(n)) if n == b"Identity-V" => return Err(err("vertical writing (Identity-V)")),
            Some(Object::Name(n)) => {
                return Err(err(&format!("CMap {} not supported", String::from_utf8_lossy(n))));
            }
            _ => return Err(err("embedded CMap not supported")),
        }
        let descendant = match font.get(b"DescendantFonts").ok().and_then(|o| deref(doc, o)) {
            Some(Object::Array(items)) => items.first().and_then(|o| deref(doc, o)).and_then(|o| o.as_dict().ok()),
            _ => None,
        }
        .ok_or_else(|| err("no descendant font"))?;
        if !matches!(name(doc, descendant.get(b"Subtype").ok()), Some(b"CIDFontType0" | b"CIDFontType2")) {
            return Err(err("unsupported descendant font"));
        }
        let default = match descendant.get(b"DW").ok() {
            Some(o) => number(doc, o).ok_or_else(|| err("malformed /DW"))?,
            None => 1000.0,
        } / 1000.0;
        let widths = match descendant.get(b"W").ok() {
            Some(w) => Self::cid_widths(doc, w).ok_or_else(|| err("malformed /W"))?,
            None => HashMap::new(),
        };
        let descriptor = dict(doc, descendant.get(b"FontDescriptor").ok());
        Ok((Kind::Identity { widths, default }, descriptor_metrics(doc, descriptor), plausible_width(doc, descriptor)))
    }

    /// /W: `c [w1 w2 ...]` and `cfirst clast w` entries (em). Later entries
    /// win; CIDs past 0xFFFF cannot be shown and are skipped.
    fn cid_widths(doc: &Document, w: &Object) -> Option<HashMap<u32, f64>> {
        let Object::Array(items) = deref(doc, w)? else {
            return None;
        };
        let cid = |o: &Object| number(doc, o).filter(|c| c.fract() == 0.0 && *c >= 0.0).map(|c| c as i64);
        let mut out = HashMap::new();
        let mut assigned = 0usize;
        let mut assign = |out: &mut HashMap<u32, f64>, c: i64, width: f64| {
            assigned += 1;
            if c <= MAX_CID {
                out.insert(c as u32, width / 1000.0);
            }
            (assigned <= MAX_W_ASSIGNMENTS).then_some(())
        };
        let mut i = 0;
        while i < items.len() {
            let first = cid(&items[i])?;
            match deref(doc, items.get(i + 1)?)? {
                Object::Array(list) => {
                    for (k, item) in list.iter().enumerate() {
                        assign(&mut out, first.saturating_add(k as i64), number(doc, item)?)?;
                    }
                    i += 2;
                }
                last => {
                    let last = cid(last)?;
                    let width = number(doc, items.get(i + 2)?)?;
                    for c in first..=last.min(MAX_CID) {
                        assign(&mut out, c, width)?;
                    }
                    i += 3;
                }
            }
        }
        Some(out)
    }

    /// The codes of `bytes` with the byte range each occupies.
    pub(crate) fn codes(&self, bytes: &[u8]) -> Result<Vec<(Range<usize>, u32)>, Unsupported> {
        match self.kind {
            Kind::Identity { .. } => {
                if !bytes.len().is_multiple_of(2) {
                    return Err(Unsupported(format!("font {}: incomplete two-byte code", self.label)));
                }
                Ok(bytes
                    .chunks_exact(2)
                    .enumerate()
                    .map(|(i, c)| (2 * i..2 * i + 2, u32::from(c[0]) << 8 | u32::from(c[1])))
                    .collect())
            }
            _ => Ok(bytes.iter().enumerate().map(|(i, &b)| (i..i + 1, u32::from(b))).collect()),
        }
    }

    /// Horizontal displacement w0 of `code` (em).
    pub(crate) fn width(&self, code: u32) -> Result<f64, Unsupported> {
        let table = |first: i64, widths: &[f64]| {
            usize::try_from(i64::from(code) - first).ok().and_then(|i| widths.get(i).copied())
        };
        match &self.kind {
            Kind::Table { first, widths, missing } => Ok(table(*first, widths).unwrap_or(*missing)),
            Kind::Identity { widths, default } => Ok(widths.get(&code).copied().unwrap_or(*default)),
            Kind::Standard { font, encoding, remapped } => {
                let unknown = || Unsupported(format!("font {}: no width for code {code}", self.label));
                let byte = u8::try_from(code).map_err(|_| unknown())?;
                if remapped.contains(&byte) {
                    return Err(unknown());
                }
                let winansi = match (encoding, byte) {
                    (_, 0..=31) => return Ok(0.0),
                    (StdEncoding::WinAnsi, b) => b,
                    (StdEncoding::Standard, b'\'') => 0x92,
                    (StdEncoding::Standard, b'`') => 0x91,
                    (StdEncoding::Standard | StdEncoding::MacRoman, b @ 32..=126) => b,
                    _ => return Err(unknown()),
                };
                Ok(text_width(*font, &[winansi], 1.0))
            }
        }
    }

    /// The text of `code`, when the font was loaded with text and knows it.
    pub(crate) fn text(&self, code: u32) -> Option<std::rc::Rc<str>> {
        self.text.as_ref()?.get(&code).cloned()
    }

    /// True when word spacing (Tw) applies to `code` spanning `len` bytes:
    /// only the single-byte code 32.
    pub(crate) fn word_space_applies(&self, code: u32, len: usize) -> bool {
        len == 1 && code == 32
    }

    /// `[x0, y0, x1, y1]` (em, before font size, scaling and rise) of the
    /// box that decides whether a glyph of width `w0` is under an area: its
    /// advance, from the descent to the ascent (descriptor, or AFM for the
    /// standard fonts, clamped). A glyph without width (a zero-width mark)
    /// reaches 0.6 em each way instead; one whose declared width is too
    /// small to be true (below a quarter of the plausible width, capped at
    /// 0.5 em) spans the plausible width.
    pub(crate) fn glyph_box(&self, w0: f64) -> [f64; 4] {
        if w0 < MIN_INK_WIDTH {
            [-NARROW_GLYPH_REACH, self.descent, NARROW_GLYPH_REACH.max(w0), self.ascent]
        } else if w0 < BOGUS_WIDTH_SHARE * self.plausible.min(PLAUSIBLE_CAP) {
            [0.0, self.descent, self.plausible, self.ascent]
        } else {
            [0.0, self.descent, w0, self.ascent]
        }
    }

    /// `glyph_box` widened 0.05 em on each side: what a removed glyph's
    /// fill must cover.
    pub(crate) fn ink_box(&self, w0: f64) -> [f64; 4] {
        let [x0, y0, x1, y1] = self.glyph_box(w0);
        [x0 - CORE_X_MARGIN, y0, x1 + CORE_X_MARGIN, y1]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::dictionary;

    fn identity_font(doc: &mut Document, w: Vec<Object>) -> Object {
        let cid = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "CIDFontType0", "W" => w });
        Object::Dictionary(dictionary! {
            "Type" => "Font", "Subtype" => "Type0", "Encoding" => "Identity-H",
            "DescendantFonts" => vec![cid.into()],
        })
    }

    fn simple_with_descriptor(doc: &mut Document, descriptor: Dictionary) -> Object {
        let descriptor = doc.add_object(descriptor);
        Object::Dictionary(dictionary! {
            "Type" => "Font", "Subtype" => "TrueType", "FirstChar" => 65,
            "Widths" => vec![500.into()], "FontDescriptor" => descriptor,
        })
    }

    #[test]
    fn the_removal_box_is_the_advance_and_the_descriptor_heights() {
        let mut doc = Document::with_version("1.7");
        let plain = simple_with_descriptor(&mut doc, dictionary! {});
        let plain = Font::load(&doc, b"F", &plain).unwrap();
        // The removal box is the advance; the ink box adds 0.05 em each side.
        assert_eq!(plain.glyph_box(0.5), [0.0, -0.2, 0.5, 0.9]);
        assert_eq!(plain.ink_box(0.5), [-0.05, -0.2, 0.55, 0.9]);
        let bbox = |v: [i64; 4]| Object::Array(v.iter().map(|n| Object::Integer(*n)).collect());
        // A wide /FontBBox no longer widens it (it reached neighbouring lines).
        let wide = simple_with_descriptor(
            &mut doc,
            dictionary! { "Ascent" => 800, "Descent" => -200, "FontBBox" => bbox([-200, -300, 1200, 1100]) },
        );
        let wide = Font::load(&doc, b"F", &wide).unwrap();
        assert_eq!(wide.glyph_box(0.5), [0.0, -0.2, 0.5, 0.8]);
        // Descriptor heights are clamped to -0.35..1.0 em.
        let tall = simple_with_descriptor(&mut doc, dictionary! { "Ascent" => 1400, "Descent" => -600 });
        let tall = Font::load(&doc, b"F", &tall).unwrap();
        assert_eq!(tall.glyph_box(0.5), [0.0, -0.35, 0.5, 1.0]);
    }

    #[test]
    fn widths_too_small_to_be_true_use_the_plausible_width() {
        let mut doc = Document::with_version("1.7");
        let avg = simple_with_descriptor(&mut doc, dictionary! { "AvgWidth" => 400 });
        let avg = Font::load(&doc, b"F", &avg).unwrap();
        // Below a quarter of 0.4 em: bogus, the box spans 0.4 em.
        assert_eq!(avg.glyph_box(0.05)[2], 0.4);
        assert_eq!(avg.glyph_box(0.2)[2], 0.2);
        let bbox = |v: [i64; 4]| Object::Array(v.iter().map(|n| Object::Integer(*n)).collect());
        let wide = simple_with_descriptor(&mut doc, dictionary! { "FontBBox" => bbox([-166, -225, 1000, 931]) });
        let wide = Font::load(&doc, b"F", &wide).unwrap();
        // A wide /FontBBox does not make an honest 'i' (0.222 em) bogus.
        assert_eq!(wide.glyph_box(0.222)[2], 0.222);
        assert!((wide.glyph_box(0.011)[2] - 1.166).abs() < 1e-9);
    }

    #[test]
    fn huge_w_ranges_are_unsupported_not_slow() {
        let mut doc = Document::with_version("1.7");
        let w: Vec<Object> = (0..100).flat_map(|_| [0.into(), 65_535.into(), 500.into()]).collect();
        let font = identity_font(&mut doc, w);
        let start = std::time::Instant::now();
        assert!(Font::load(&doc, b"F", &font).is_err());
        assert!(start.elapsed().as_secs() < 2);
    }

    #[test]
    fn w_later_entries_win_and_cids_past_ffff_are_skipped() {
        let mut doc = Document::with_version("1.7");
        let w = vec![
            0.into(), 9.into(), 100.into(),
            5.into(), Object::Array(vec![700.into()]),
            65_535.into(), 70_000.into(), 300.into(),
        ];
        let obj = identity_font(&mut doc, w);
        let font = Font::load(&doc, b"F", &obj).unwrap();
        assert_eq!(font.width(4).unwrap(), 0.1);
        assert_eq!(font.width(5).unwrap(), 0.7);
        assert_eq!(font.width(65_535).unwrap(), 0.3);
        // Default /DW is 1000.
        assert_eq!(font.width(10).unwrap(), 1.0);
    }
}
