//! The OCR layer's font: Tesseract's "GlyphLessFont" (`assets/pdf.ttf`,
//! Apache-2.0) as a Type0 / CIDFontType2 font with Identity-H codes, the
//! objects Tesseract's PDF renderer (`src/api/pdfrenderer.cpp`) writes:
//!
//! - Type0 `/BaseFont /GlyphLessFont /Encoding /Identity-H` with one
//!   descendant and a /ToUnicode CMap;
//! - CIDFontType2 with `/CIDSystemInfo (Adobe) (Identity) 0`, `/DW 500` (the
//!   glyphless glyph advances half an em) and a /CIDToGIDMap stream sending
//!   every CID to glyph 1, the font's one (empty) glyph;
//! - a FontDescriptor (`/Flags 5`) whose /FontFile2 is `pdf.ttf`.
//!
//! One departure: Tesseract's descriptor says /Ascent 1000 /Descent -1 with
//! /FontBBox [0 0 500 1000]; ours says 800 / -200 with [0 -200 500 800], so
//! a word drawn at size h with its baseline 0.2 h above its box's bottom
//! (see `layer`) has glyph boxes that cover exactly that box. Viewers that
//! read the descriptor (and our redaction engine) then highlight and redact
//! the word where it is printed, not 0.2 h above it.
//!
//! Codes: a character of the Basic Multilingual Plane is shown with the CID
//! equal to its UTF-16 code unit, as in Tesseract. Tesseract writes a
//! character past the BMP as its two surrogate units and maps the whole
//! range 0000-FFFF to itself in its ToUnicode, so each surrogate CID maps
//! to a lone surrogate: viewers that concatenate UTF-16 units (pdf.js) get
//! the character back, but strict readers (poppler, our redaction search)
//! cannot decode a lone surrogate. A per-CID map cannot do better while two
//! characters may share a high surrogate, so we instead give each distinct
//! character past the BMP one CID of its own from the surrogate block
//! D800-DFFF (unused by BMP text), mapped by a bfchar to its two UTF-16
//! units. Past 2048 such characters in a document the rest show U+FFFD.
//! The ToUnicode lists only the CIDs used, in bfchar blocks of at most 100.

use crate::page_content::plain_stream;
use crate::redact::page::flate_stream;
use lopdf::{Document, Object, ObjectId, Stream, StringFormat, dictionary};
use std::collections::{BTreeMap, HashMap};
use std::fmt::Write;

/// Tesseract's glyphless font (572 bytes).
pub(crate) const GLYPHLESS_TTF: &[u8] = include_bytes!("../../assets/pdf.ttf");

/// The CID of a space (U+0020), drawn after words followed by one.
pub(crate) const SPACE_CID: u16 = 0x20;
/// Advance of every CID, in thousandths of an em.
pub(crate) const GLYPH_WIDTH: f64 = 500.0;
/// First CID given to characters past the BMP, and how many there are.
const ASTRAL_FIRST: u16 = 0xD800;
const ASTRAL_SLOTS: usize = 0x800;
/// Entries per bfchar block (the CMap limit).
const BFCHAR_BLOCK: usize = 100;

/// The CIDs a job's words use, with the text each stands for.
#[derive(Debug, Default)]
pub(crate) struct Cids {
    text: BTreeMap<u16, char>,
    astral: HashMap<char, u16>,
}

impl Cids {
    /// The CIDs showing `text`, one per character.
    pub(crate) fn encode(&mut self, text: &str) -> Vec<u16> {
        text.chars().map(|c| self.cid(c)).collect()
    }

    fn cid(&mut self, c: char) -> u16 {
        let (cid, c) = match u16::try_from(u32::from(c)) {
            Ok(unit) => (unit, c),
            Err(_) => match self.astral.get(&c) {
                Some(&cid) => (cid, c),
                None if self.astral.len() < ASTRAL_SLOTS => {
                    let cid = ASTRAL_FIRST + self.astral.len() as u16;
                    self.astral.insert(c, cid);
                    (cid, c)
                }
                None => (0xFFFD, '\u{FFFD}'),
            },
        };
        self.text.insert(cid, c);
        cid
    }

    /// The ToUnicode CMap of the CIDs used so far.
    pub(crate) fn to_unicode(&self) -> Vec<u8> {
        let mut out = String::from(
            "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n\
             /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n\
             /CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n\
             1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n",
        );
        let entries: Vec<(&u16, &char)> = self.text.iter().collect();
        for block in entries.chunks(BFCHAR_BLOCK) {
            let _ = writeln!(out, "{} beginbfchar", block.len());
            for (cid, c) in block {
                let _ = write!(out, "<{cid:04X}> <");
                for unit in c.encode_utf16(&mut [0; 2]) {
                    let _ = write!(out, "{unit:04X}");
                }
                out.push_str(">\n");
            }
            out.push_str("endbfchar\n");
        }
        out.push_str("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n");
        out.into_bytes()
    }
}

/// Adds the font objects for the CIDs of `cids`; returns the Type0 font.
pub(crate) fn add_font(doc: &mut Document, cids: &Cids) -> ObjectId {
    let mut file = plain_stream(GLYPHLESS_TTF.to_vec());
    file.dict.set("Length1", GLYPHLESS_TTF.len() as i64);
    let file = doc.add_object(file);
    let descriptor = doc.add_object(dictionary! {
        "Type" => "FontDescriptor",
        "FontName" => "GlyphLessFont",
        "Flags" => 5,
        // Not Tesseract's 1000 / -1 (see the module comment): with these the
        // glyph boxes of a word drawn at size h, baseline 0.2 h up, are its box.
        "FontBBox" => vec![0.into(), (-200).into(), 500.into(), 800.into()],
        "ItalicAngle" => 0,
        "Ascent" => 800,
        "Descent" => -200,
        "CapHeight" => 800,
        "StemV" => 80,
        "FontFile2" => file,
    });
    // Every CID (two bytes each, big-endian) maps to glyph 1.
    let gid_map: Vec<u8> = [0u8, 1].repeat(1 << 16);
    let gid_map = doc.add_object(flate_stream(dictionary! {}, &gid_map));
    let descendant = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "CIDFontType2",
        "BaseFont" => "GlyphLessFont",
        "CIDSystemInfo" => dictionary! {
            "Registry" => Object::String(b"Adobe".to_vec(), StringFormat::Literal),
            "Ordering" => Object::String(b"Identity".to_vec(), StringFormat::Literal),
            "Supplement" => 0,
        },
        "FontDescriptor" => descriptor,
        "DW" => GLYPH_WIDTH as i64,
        "CIDToGIDMap" => gid_map,
    });
    let to_unicode: Stream = flate_stream(dictionary! {}, &cids.to_unicode());
    let to_unicode = doc.add_object(to_unicode);
    doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type0",
        "BaseFont" => "GlyphLessFont",
        "Encoding" => "Identity-H",
        "DescendantFonts" => vec![descendant.into()],
        "ToUnicode" => to_unicode,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bmp_cids_are_utf16_units() {
        let mut c = Cids::default();
        assert_eq!(c.encode("Aé日"), [0x41, 0xE9, 0x65E5]);
    }

    #[test]
    fn astral_cids_are_allocated_once_each() {
        let mut c = Cids::default();
        assert_eq!(c.encode("😀𝔸😀"), [0xD800, 0xD801, 0xD800]);
        let cmap = String::from_utf8(c.to_unicode()).unwrap();
        assert!(cmap.contains("<D800> <D83DDE00>"), "{cmap}");
        assert!(cmap.contains("<D801> <D835DD38>"), "{cmap}");
        assert!(cmap.contains("2 beginbfchar"), "{cmap}");
    }
}
