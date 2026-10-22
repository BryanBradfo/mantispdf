//! Embedding laid-out text: content operators for each line, then per
//! document and face one subset font (Type0 / CIDFontType2, Identity-H).
//!
//! CIDs are not glyph ids. One CID stands for one (glyph, text, width)
//! triple, numbered from 1 in order of first use, and an explicit
//! CIDToGIDMap points each at its glyph in the subset. So:
//! - ToUnicode is exact per drawn glyph: the same glyph can carry different
//!   text (a Devanagari matra glyph leads one cluster and follows in
//!   another), which one entry per glyph id (CIDToGIDMap /Identity) could
//!   not say.
//! - /W holds the shaped advance (kerning included), so a reader that places
//!   glyphs by /W (pdf.js selection, our redact interpreter) puts each glyph
//!   box where it is drawn, and TJ adjustments are only needed for mark
//!   offsets and rounding.
//!
//! A cluster's text is spread over its glyphs (`entry_texts`), so a glyph
//! carries no text only when its cluster has more glyphs than characters
//! (Noto Sans Arabic draws letter dots as separate glyphs). Such a glyph
//! maps to `<>` (empty), never left out of the ToUnicode: an unmapped code
//! reads as unknown text in the redact reader (U+FFFD: search counts the page
//! undecodable). pdf.js reads an empty entry as missing and shows the code
//! itself as a character, so these CIDs are taken from `SILENT_CODES`, code
//! points of invisible format characters (Cf) that pdf.js leaves out of its
//! text. Past those, a font falls back to ordinary codes (a known limit:
//! pdf.js then shows a stray control character).

use super::{Face, LayoutError, Line, Run};
use crate::page_content::{flate_stream, fmt_num};
use lopdf::{Dictionary, Document, Object, ObjectId, StringFormat, dictionary};
use std::collections::HashMap;
use std::fmt::Write;

/// Highest CID (two-byte codes; 0 is .notdef).
const MAX_CID: u32 = 0xFFFF;
/// Entries per bfchar block (the CMap limit).
const BFCHAR_BLOCK: usize = 100;
/// Longest text one CID's ToUnicode entry carries, in UTF-16 units (what
/// the redact reader keeps of an entry, `redact::unicode::MAX_TEXT_UNITS`).
const MAX_ENTRY_UNITS: usize = 32;
/// Stroke width of synthetic bold (CJK faces have no Bold file), in em.
pub(crate) const FAKE_BOLD_EM: f64 = 0.03;

/// BMP code points of general category Cf, not whitespace to JavaScript
/// (U+FEFF is, U+180E was): the codes of glyphs drawn for no text.
const SILENT_CODES: [u16; 39] = [
    0x00AD, 0x0600, 0x0601, 0x0602, 0x0603, 0x0604, 0x0605, 0x061C, 0x06DD, 0x070F, 0x08E2, 0x200B, 0x200C,
    0x200D, 0x200E, 0x200F, 0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064,
    0x2066, 0x2067, 0x2068, 0x2069, 0x206A, 0x206B, 0x206C, 0x206D, 0x206E, 0x206F, 0xFFF9, 0xFFFA, 0xFFFB,
];

/// One CID: the glyph (id in the full face), its text, its width in 1/1000 em.
type CidKey = (u16, String, i64);

struct FaceUse {
    /// The Type0 font object, reserved at first use and written by `finish`.
    id: ObjectId,
    cids: HashMap<CidKey, u16>,
    /// Every CID with its key, in order of first use.
    entries: Vec<(u16, CidKey)>,
    /// Next ordinary code to try, and silent codes handed out.
    next: u32,
    silent: usize,
}

/// The fonts of one document: call `show_line` for every line drawn, then
/// `finish` once.
pub(crate) struct Embedder<'f, 'a> {
    faces: &'f [Face<'a>],
    used: Vec<Option<FaceUse>>,
}

/// One element of a TJ array.
enum Item {
    Cids(Vec<u16>),
    /// TJ number: moves the pen left by n / 1000 em.
    Adjust(i64),
}

impl<'f, 'a> Embedder<'f, 'a> {
    pub(crate) fn new(faces: &'f [Face<'a>]) -> Self {
        Embedder { faces, used: faces.iter().map(|_| None).collect() }
    }

    fn font_use(&mut self, doc: &mut Document, face: usize) -> &mut FaceUse {
        self.used[face].get_or_insert_with(|| FaceUse {
            id: doc.new_object_id(),
            cids: HashMap::new(),
            entries: Vec::new(),
            next: 1,
            silent: 0,
        })
    }

    fn cid(&mut self, doc: &mut Document, face: usize, key: CidKey) -> Result<u16, LayoutError> {
        let used = self.font_use(doc, face);
        if let Some(&cid) = used.cids.get(&key) {
            return Ok(cid);
        }
        let cid = if key.1.is_empty() && used.silent < SILENT_CODES.len() {
            used.silent += 1;
            SILENT_CODES[used.silent - 1]
        } else {
            while SILENT_CODES.binary_search(&(used.next as u16)).is_ok() && used.next <= MAX_CID {
                used.next += 1;
            }
            if used.next > MAX_CID {
                return Err(LayoutError::Budget);
            }
            used.next += 1;
            (used.next - 1) as u16
        };
        used.entries.push((cid, key.clone()));
        used.cids.insert(key, cid);
        Ok(cid)
    }

    /// Content (`q BT ... ET Q`) drawing `line` with its pen starting at
    /// `origin` (PDF user space, on the baseline) at `size` points.
    /// `font_name(face, id)` puts font object `id` in the page resources and
    /// returns its resource name. Runs whose face `fake_bold` names are also
    /// stroked `FAKE_BOLD_EM` wide (render mode 2): the caller sets the stroke
    /// colour to the fill colour. Errors with `Budget` past `MAX_CIDS` CIDs
    /// for one face, or `BadFont` for a face index out of range.
    pub(crate) fn show_line(
        &mut self,
        doc: &mut Document,
        line: &Line,
        origin: (f64, f64),
        size: f64,
        fake_bold: &dyn Fn(usize) -> bool,
        font_name: &mut dyn FnMut(usize, ObjectId) -> String,
    ) -> Result<String, LayoutError> {
        let mut out = String::from("q BT\n");
        let mut pen = 0.0;
        let mut rise = 0.0;
        let mut stroked = false;
        let unit = |p: f64| (p * 1000.0 / size).round() as i64;
        for run in &line.runs {
            if run.face >= self.faces.len() {
                return Err(LayoutError::BadFont(run.face));
            }
            let id = self.font_use(doc, run.face).id;
            let name = font_name(run.face, id);
            let _ = writeln!(out, "/{name} {} Tf", fmt_num(size));
            let bold = fake_bold(run.face);
            if bold != stroked {
                if bold {
                    let _ = writeln!(out, "2 Tr {} w", fmt_num(FAKE_BOLD_EM * size));
                } else {
                    out.push_str("0 Tr\n");
                }
                stroked = bold;
            }
            let (texts, actual_text) = entry_texts(run);
            if let Some(text) = &actual_text {
                let _ = writeln!(out, "/Span <</ActualText <{}>>> BDC", utf16_hex(text, true));
            }
            let _ = writeln!(out, "1 0 0 1 {} {} Tm", fmt_num(origin.0 + pen), fmt_num(origin.1));
            // Positions in 1/1000 em from the run start: `at` is where the
            // PDF pen is, `p` where the layout's pen is.
            let mut at = 0i64;
            let mut p = 0.0;
            let mut items: Vec<Item> = Vec::new();
            for (g, text) in run.glyphs.iter().zip(texts) {
                if g.y_offset != rise {
                    flush(&mut out, &mut items);
                    let _ = writeln!(out, "{} Ts", fmt_num(g.y_offset));
                    rise = g.y_offset;
                }
                let start = unit(p + g.x_offset);
                // A glyph carrying no text is a mark-like piece of its cluster:
                // width 0 (pdf.js skips it without advancing), placed by TJ.
                // Otherwise the glyph's own shaped advance, rounded: the same
                // glyph keeps one CID wherever it stands (TJ absorbs rounding).
                let width = if text.is_empty() { 0 } else { unit(g.x_advance).max(0) };
                let cid = self.cid(doc, run.face, (g.gid, text, width))?;
                if at != start {
                    items.push(Item::Adjust(at - start));
                }
                match items.last_mut() {
                    Some(Item::Cids(cids)) => cids.push(cid),
                    _ => items.push(Item::Cids(vec![cid])),
                }
                at = start + width;
                p += g.x_advance;
            }
            flush(&mut out, &mut items);
            if actual_text.is_some() {
                out.push_str("EMC\n");
            }
            pen += p;
        }
        out.push_str("ET Q\n");
        Ok(out)
    }

    /// Writes the font of every face used: subset, widths, CID map,
    /// ToUnicode. A face whose subset fails is `BadFont(face)`.
    pub(crate) fn finish(self, doc: &mut Document) -> Result<(), LayoutError> {
        for (index, used) in self.used.into_iter().enumerate() {
            if let Some(used) = used {
                let font = write_font(doc, &self.faces[index], &used).ok_or(LayoutError::BadFont(index))?;
                doc.objects.insert(used.id, Object::Dictionary(font));
            }
        }
        Ok(())
    }
}

/// The ToUnicode text of each glyph of `run`, and the run's whole text when
/// some cluster does not fit in its glyphs' entries.
///
/// The layout puts a cluster's text on its first glyph (logical order) and
/// "" on the others. Here the text is spread over the cluster's glyphs in
/// order: every glyph gets at least one character while there are some,
/// the first ones take more, up to `MAX_ENTRY_UNITS` UTF-16 units each
/// (characters never split). The texts of a cluster's glyphs, in logical
/// order, still spell the cluster. What does not fit is dropped from the
/// entries; the run is then wrapped in an /ActualText span holding its full
/// text (logical order), which pdf.js and poppler extract instead. The
/// redact reader does not read /ActualText: there such a cluster reads cut
/// (a known limit).
fn entry_texts(run: &Run) -> (Vec<String>, Option<String>) {
    let mut texts = vec![String::new(); run.glyphs.len()];
    let order: Vec<usize> = if run.rtl { (0..run.glyphs.len()).rev().collect() } else { (0..run.glyphs.len()).collect() };
    let mut overflow = false;
    let mut k = 0;
    while k < order.len() {
        // A cluster: a glyph with text, then the glyphs with none after it.
        let mut end = k + 1;
        while end < order.len() && run.glyphs[order[end]].cluster_text.is_empty() {
            end += 1;
        }
        let chars: Vec<char> = run.glyphs[order[k]].cluster_text.chars().collect();
        let mut next = 0;
        for (j, &i) in order[k..end].iter().enumerate() {
            let glyphs_after = end - k - j - 1;
            let mut units = 0;
            while let Some(&c) = chars.get(next) {
                let full = units + c.len_utf16() > MAX_ENTRY_UNITS;
                let leave_for_later = units > 0 && chars.len() - next <= glyphs_after;
                if full || leave_for_later {
                    break;
                }
                units += c.len_utf16();
                texts[i].push(c);
                next += 1;
            }
        }
        overflow |= next < chars.len();
        k = end;
    }
    let whole = overflow.then(|| order.iter().map(|&i| run.glyphs[i].cluster_text.as_str()).collect());
    (texts, whole)
}

/// `text` as UTF-16BE hex digits, with a byte order mark when `bom`.
fn utf16_hex(text: &str, bom: bool) -> String {
    let mut out = String::from(if bom { "FEFF" } else { "" });
    for unit in text.encode_utf16() {
        let _ = write!(out, "{unit:04X}");
    }
    out
}

/// Appends `items` as one TJ (nothing when empty) and clears them.
fn flush(out: &mut String, items: &mut Vec<Item>) {
    if items.is_empty() {
        return;
    }
    out.push('[');
    for item in items.drain(..) {
        match item {
            Item::Cids(cids) => {
                out.push('<');
                for cid in cids {
                    let _ = write!(out, "{cid:04X}");
                }
                out.push('>');
            }
            Item::Adjust(n) => {
                let _ = write!(out, " {n} ");
            }
        }
    }
    out.push_str("] TJ\n");
}

/// The Type0 font dictionary of `used`, its other objects added to `doc`.
fn write_font(doc: &mut Document, face: &Face, used: &FaceUse) -> Option<Dictionary> {
    let mut entries: Vec<(u16, &CidKey)> = used.entries.iter().map(|(cid, key)| (*cid, key)).collect();
    entries.sort_unstable_by_key(|(cid, _)| *cid);
    let gids: Vec<u16> = entries.iter().map(|(_, (gid, _, _))| *gid).collect();
    let remapper = subsetter::GlyphRemapper::new_from_glyphs_sorted(&gids);
    let subset = subsetter::subset(face.data, 0, &remapper).ok()?;

    let last = entries.last().map_or(0, |(cid, _)| usize::from(*cid));
    let mut gid_map = vec![0u8; 2 * (last + 1)];
    for (cid, (gid, _, _)) in &entries {
        let at = 2 * usize::from(*cid);
        gid_map[at..at + 2].copy_from_slice(&remapper.get(*gid).unwrap_or(0).to_be_bytes());
    }
    // /W: `first [w ...]` per run of consecutive CIDs.
    let mut widths: Vec<Object> = Vec::new();
    let mut previous: Option<u16> = None;
    for (cid, (_, _, w)) in &entries {
        if previous.is_none_or(|p| p + 1 != *cid) {
            widths.push(Object::Integer(i64::from(*cid)));
            widths.push(Object::Array(Vec::new()));
        }
        if let Some(Object::Array(list)) = widths.last_mut() {
            list.push(Object::Integer(*w));
        }
        previous = Some(*cid);
    }

    let hb = &face.hb;
    let k = 1000.0 / face.units_per_em();
    let em = |v: f64| Object::Integer((v * k).round() as i64);
    let ascent = f64::from(hb.ascender());
    let descent = f64::from(hb.descender());
    // Readers that box glyphs by the descriptor (our redact interpreter does)
    // stack those boxes line over line: Noto's ascender plus descender is
    // 1.3 to 1.45 em, more than a 1.2 line pitch, so redacting a word would
    // also hit the lines above and below it. Ascent and Descent are scaled
    // down to one em together (their ratio kept).
    let fit = (face.units_per_em() / (ascent - descent)).min(1.0);
    let (box_ascent, box_descent) = (ascent * fit, descent * fit);
    let bbox = hb.global_bounding_box();
    let name = base_font(face, &gids);

    let file = flate_stream(dictionary! { "Length1" => subset.len() as i64 }, &subset);
    let file = doc.add_object(file);
    let descriptor = doc.add_object(dictionary! {
        "Type" => "FontDescriptor",
        "FontName" => Object::Name(name.clone()),
        "Flags" => 4,
        "FontBBox" => vec![em(bbox.x_min.into()), em(bbox.y_min.into()), em(bbox.x_max.into()), em(bbox.y_max.into())],
        "ItalicAngle" => Object::Real(hb.italic_angle()),
        "Ascent" => em(box_ascent),
        "Descent" => em(box_descent),
        "CapHeight" => em(hb.capital_height().map_or(box_ascent, f64::from).min(box_ascent)),
        "StemV" => 80,
        "FontFile2" => file,
    });
    let gid_map = doc.add_object(flate_stream(Dictionary::new(), &gid_map));
    let descendant = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "CIDFontType2",
        "BaseFont" => Object::Name(name.clone()),
        "CIDSystemInfo" => dictionary! {
            "Registry" => Object::String(b"Adobe".to_vec(), StringFormat::Literal),
            "Ordering" => Object::String(b"Identity".to_vec(), StringFormat::Literal),
            "Supplement" => 0,
        },
        "FontDescriptor" => descriptor,
        "DW" => 0,
        "W" => widths,
        "CIDToGIDMap" => gid_map,
    });
    let to_unicode = doc.add_object(flate_stream(Dictionary::new(), &to_unicode(&entries)));
    Some(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type0",
        "BaseFont" => Object::Name(name),
        "Encoding" => "Identity-H",
        "DescendantFonts" => vec![descendant.into()],
        "ToUnicode" => to_unicode,
    })
}

/// `ABCDEF+PostScriptName`: the tag is a hash of the glyphs used, so the
/// same text gives the same bytes.
fn base_font(face: &Face, gids: &[u16]) -> Vec<u8> {
    let ps: String = face
        .hb
        .names()
        .into_iter()
        .filter(|n| n.name_id == ttf_parser::name_id::POST_SCRIPT_NAME)
        .find_map(|n| n.to_string())
        .unwrap_or_default()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(63)
        .collect();
    let ps = if ps.is_empty() { "Font".to_string() } else { ps };
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for gid in gids {
        for b in gid.to_be_bytes() {
            hash = (hash ^ u64::from(b)).wrapping_mul(0x100_0000_01b3);
        }
    }
    let mut name: Vec<u8> = (0..6)
        .map(|_| {
            let letter = b'A' + (hash % 26) as u8;
            hash /= 26;
            letter
        })
        .collect();
    name.push(b'+');
    name.extend_from_slice(ps.as_bytes());
    name
}

/// The ToUnicode CMap: every CID (sorted) with its text, UTF-16BE; `<>`
/// for a glyph drawn for no text (see the module comment).
fn to_unicode(entries: &[(u16, &CidKey)]) -> Vec<u8> {
    let mut out = String::from(
        "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n\
         /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n\
         /CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n\
         1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n",
    );
    for block in entries.chunks(BFCHAR_BLOCK) {
        let _ = writeln!(out, "{} beginbfchar", block.len());
        for (cid, (_, text, _)) in block {
            let _ = writeln!(out, "<{cid:04X}> <{}>", utf16_hex(text, false));
        }
        out.push_str("endbfchar\n");
    }
    out.push_str("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n");
    out.into_bytes()
}
