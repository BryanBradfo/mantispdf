//! Spec section 2 (Rust, embedding part): subsets hold exactly the used
//! glyphs, /W and positions match the layout, ToUnicode reads back through
//! the redact reader (search finds the text, redaction removes it), and
//! poppler extracts every script when `pdftotext` is installed.

use super::*;
use super::{Glyph, Run};
use crate::pdf_util::{load_pdf, save_pdf};
use crate::redact::search::{SearchOptions, redact_search};
use crate::redact::unicode::TextCache;
use crate::redact::verify::{page_glyphs, page_text_glyphs};
use crate::redact::{Budget, Fill, JOB_DECODED, RedactJob, RedactRect, redact};
use lopdf::{Dictionary, Document, Object, ObjectId, Stream, dictionary};
use std::cell::RefCell;
use std::rc::Rc;

macro_rules! font {
    ($file:literal) => {
        include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fonts/", $file)).as_slice()
    };
}

const SANS: &[u8] = font!("NotoSans-subset.ttf");
const ARABIC: &[u8] = font!("NotoSansArabic-subset.ttf");
const HEBREW: &[u8] = font!("NotoSansHebrew-subset.ttf");
const DEVANAGARI: &[u8] = font!("NotoSansDevanagari-subset.ttf");
const THAI: &[u8] = font!("NotoSansThai-subset.ttf");
const SC: &[u8] = font!("NotoSansSC-subset.ttf");

fn all_faces() -> Vec<Face<'static>> {
    load_faces(&[SANS, ARABIC, HEBREW, DEVANAGARI, THAI, SC]).unwrap()
}

/// Box of the test text: left 50, top 750, 500 wide.
const LEFT: f64 = 50.0;
const TOP: f64 = 750.0;
const WIDTH: f64 = 500.0;

struct Built {
    doc: Document,
    page: ObjectId,
    layout: Layout,
    /// PDF origin of each line (pen start at the baseline).
    origins: Vec<(f64, f64)>,
    content: String,
}

/// One page showing `text` laid out with `faces`.
fn build(faces: &[Face], text: &str, size: f64, bold: bool) -> Built {
    let p = LayoutParams { size, width: WIDTH, align: Some(crate::edit_ops::Align::Left), line_height: 1.3 };
    let layout = layout_text(faces, text, &p, &mut ShapeBudget::per_job()).unwrap();
    build_from(faces, layout, size, bold)
}

/// One page showing the lines of `layout`.
fn build_from(faces: &[Face], layout: Layout, size: f64, bold: bool) -> Built {
    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();
    let mut fonts = Dictionary::new();
    let mut embedder = Embedder::new(faces);
    let mut content = String::new();
    let mut origins = Vec::new();
    for line in &layout.lines {
        let origin = (LEFT + line.x, TOP - line.baseline_y);
        origins.push(origin);
        let mut name = |face: usize, id: ObjectId| {
            let name = format!("U{face}");
            fonts.set(name.clone(), id);
            name
        };
        content.push_str(&embedder.show_line(&mut doc, line, origin, size, &|_| bold, &mut name).unwrap());
    }
    embedder.finish(&mut doc).unwrap();
    let c = doc.add_object(Stream::new(dictionary! {}, content.clone().into_bytes()));
    let page = doc.add_object(dictionary! {
        "Type" => "Page", "Parent" => pages_id, "Contents" => c,
        "Resources" => dictionary! { "Font" => fonts },
        "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
    });
    doc.objects.insert(pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1 }));
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog);
    Built { doc, page, layout, origins, content }
}

fn saved(built: &mut Built) -> Vec<u8> {
    save_pdf(&mut built.doc).unwrap()
}

/// The page's glyph texts in drawing order, through the redact ToUnicode reader.
fn drawn_text(doc: &Document, page: ObjectId) -> String {
    let cache = Rc::new(RefCell::new(TextCache::new(JOB_DECODED)));
    let glyphs = page_text_glyphs(doc, page, &mut Budget::page(JOB_DECODED), &cache).unwrap();
    glyphs.iter().map(|g| g.text.as_deref().expect("every glyph has text").to_string()).collect()
}

/// The font dictionaries of the page (Type0, then its descendant).
fn fonts_of(doc: &Document, page: ObjectId) -> Vec<(Dictionary, Dictionary)> {
    let res = doc.get_dictionary(page).unwrap().get(b"Resources").unwrap().as_dict().unwrap();
    let fonts = res.get(b"Font").unwrap().as_dict().unwrap();
    fonts
        .iter()
        .map(|(_, id)| {
            let type0 = doc.get_dictionary(id.as_reference().unwrap()).unwrap().clone();
            let desc = type0.get(b"DescendantFonts").unwrap().as_array().unwrap()[0].as_reference().unwrap();
            (type0, doc.get_dictionary(desc).unwrap().clone())
        })
        .collect()
}

fn stream_bytes(doc: &Document, obj: &Object) -> Vec<u8> {
    let s = doc.get_object(obj.as_reference().unwrap()).unwrap().as_stream().unwrap();
    s.decompressed_content().unwrap_or_else(|_| s.content.clone())
}

fn opts() -> SearchOptions {
    SearchOptions { whole_word: false, case_sensitive: true }
}

// ---- font objects ----

#[test]
fn subset_holds_exactly_the_used_glyphs() {
    let faces = all_faces();
    let built = build(&faces, "Привет мир", 12.0, false);
    let used: std::collections::BTreeSet<u16> =
        built.layout.lines.iter().flat_map(|l| l.runs.iter()).flat_map(|r| r.glyphs.iter()).map(|g| g.gid).collect();
    let fonts = fonts_of(&built.doc, built.page);
    assert_eq!(fonts.len(), 1);
    let (type0, cid) = &fonts[0];
    assert_eq!(type0.get(b"Subtype").unwrap().as_name().unwrap(), b"Type0");
    assert_eq!(type0.get(b"Encoding").unwrap().as_name().unwrap(), b"Identity-H");
    assert_eq!(cid.get(b"Subtype").unwrap().as_name().unwrap(), b"CIDFontType2");
    let descriptor = built.doc.get_dictionary(cid.get(b"FontDescriptor").unwrap().as_reference().unwrap()).unwrap();
    let file = descriptor.get(b"FontFile2").unwrap();
    let file_stream = built.doc.get_object(file.as_reference().unwrap()).unwrap().as_stream().unwrap();
    assert_eq!(file_stream.dict.get(b"Filter").unwrap().as_name().unwrap(), b"FlateDecode");
    let subset = stream_bytes(&built.doc, file);
    assert_eq!(file_stream.dict.get(b"Length1").unwrap().as_i64().unwrap(), subset.len() as i64);
    let parsed = ttf_parser::Face::parse(&subset, 0).unwrap();
    // .notdef plus the glyphs drawn.
    assert_eq!(usize::from(parsed.number_of_glyphs()), used.len() + 1);
    assert!(subset.len() < SANS.len() / 4, "subset {} of {}", subset.len(), SANS.len());
    // BaseFont: six capitals, '+', the PostScript name.
    let base = type0.get(b"BaseFont").unwrap().as_name().unwrap();
    assert_eq!(base[6], b'+');
    assert!(base[..6].iter().all(u8::is_ascii_uppercase));
    assert!(base.ends_with(b"NotoSans-Regular"), "{}", String::from_utf8_lossy(base));
}

#[test]
fn cid_to_gid_map_points_into_the_subset() {
    let faces = all_faces();
    let built = build(&faces, "ab ba", 12.0, false);
    let (_, cid) = &fonts_of(&built.doc, built.page)[0];
    let map = stream_bytes(&built.doc, cid.get(b"CIDToGIDMap").unwrap());
    let gids: Vec<u16> = map.chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
    assert_eq!(gids[0], 0, "CID 0 is .notdef");
    // a, b, space: three glyphs, gids 1..=3 in the subset.
    let mut drawn: Vec<u16> = gids[1..].to_vec();
    drawn.sort_unstable();
    drawn.dedup();
    assert_eq!(drawn, [1, 2, 3]);
}

#[test]
fn widths_are_the_shaped_advances() {
    let faces = all_faces();
    let size = 20.0;
    let built = build(&faces, "Hello", size, false);
    let (_, cid) = &fonts_of(&built.doc, built.page)[0];
    let w = cid.get(b"W").unwrap().as_array().unwrap();
    assert_eq!(w[0].as_i64().unwrap(), 1, "CIDs are numbered from 1");
    let widths: Vec<i64> = w[1].as_array().unwrap().iter().map(|o| o.as_i64().unwrap()).collect();
    let glyphs = &built.layout.lines[0].runs[0].glyphs;
    // H e l o: the second l reuses the first's CID (same glyph, text and width).
    assert_eq!(widths.len(), 4);
    let expect: Vec<i64> = [0, 1, 2, 4].iter().map(|&i| (glyphs[i].x_advance * 1000.0 / size).round() as i64).collect();
    assert_eq!(widths, expect);
    // And they are the hmtx advances of the unkerned glyphs.
    let hmtx = |gid: u16| faces[0].hb.glyph_hor_advance(ttf_parser::GlyphId(gid)).unwrap() as f64 * 1000.0 / faces[0].units_per_em();
    assert_eq!(widths[0], hmtx(glyphs[0].gid).round() as i64);
}

#[test]
fn tounicode_blocks_hold_at_most_100_entries() {
    let faces = all_faces();
    let text: String = (0x21u8..=0x7E).map(char::from).collect::<String>() + "ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏ";
    let built = build(&faces, &text, 8.0, false);
    let (type0, _) = &fonts_of(&built.doc, built.page)[0];
    let cmap = String::from_utf8(stream_bytes(&built.doc, type0.get(b"ToUnicode").unwrap())).unwrap();
    let blocks: Vec<usize> = cmap.lines().filter_map(|l| l.strip_suffix(" beginbfchar")).map(|n| n.parse().unwrap()).collect();
    assert!(blocks.len() >= 2, "{blocks:?}");
    assert!(blocks.iter().all(|&n| n <= 100));
    assert_eq!(blocks.iter().sum::<usize>(), text.chars().count());
}

#[test]
fn bold_cjk_is_stroked() {
    let faces = all_faces();
    let built = build(&faces, "你好", 10.0, true);
    assert!(built.content.contains("2 Tr 0.3 w"), "{}", built.content);
    let plain = build(&faces, "你好", 10.0, false);
    assert!(!plain.content.contains(" Tr"));
}

fn to_unicode_of(built: &Built) -> String {
    let (type0, _) = &fonts_of(&built.doc, built.page)[0];
    String::from_utf8(stream_bytes(&built.doc, type0.get(b"ToUnicode").unwrap())).unwrap()
}

#[test]
fn a_cluster_text_is_spread_over_its_glyphs() {
    // "हि": the i-matra glyph is drawn first; each glyph gets one character.
    let faces = all_faces();
    let built = build(&faces, "हि", 12.0, false);
    let cmap = to_unicode_of(&built);
    assert!(cmap.contains(" <0939>") && cmap.contains(" <093F>"), "{cmap}");
    assert!(!cmap.contains("<>"), "{cmap}");
}

#[test]
fn glyphs_drawn_for_no_text_get_silent_codes() {
    // Noto Sans Arabic draws beh's dot as a second glyph of the one-letter cluster.
    let faces = all_faces();
    let built = build(&faces, "ب", 12.0, false);
    let cmap = to_unicode_of(&built);
    // The dot: the first silent code (U+00AD, a format character pdf.js
    // leaves out when it falls back to the code), mapped to nothing.
    assert!(cmap.contains("<00AD> <>"), "{cmap}");
    assert!(cmap.contains("<0001> <0628>"), "{cmap}");
    let (_, cid) = &fonts_of(&built.doc, built.page)[0];
    let w = cid.get(b"W").unwrap().as_array().unwrap();
    assert_eq!(w[2].as_i64().unwrap(), 0xAD);
    assert_eq!(w[3].as_array().unwrap()[0].as_i64().unwrap(), 0, "a textless glyph has no width");
    let map = stream_bytes(&built.doc, cid.get(b"CIDToGIDMap").unwrap());
    assert_eq!(map.len(), 2 * (0xAD + 1));
    assert_ne!(u16::from_be_bytes([map[2 * 0xAD], map[2 * 0xAD + 1]]), 0);
}

#[test]
fn ordinary_codes_skip_the_silent_ones() {
    // More than 0xAD distinct glyph texts: CID 0xAD is never an ordinary code.
    let faces = all_faces();
    let text: String = (0x21u32..=0x7E).chain(0xA1..=0xFF).filter_map(char::from_u32).collect();
    let built = build(&faces, &text, 6.0, false);
    let cmap = to_unicode_of(&built);
    assert!(!cmap.contains("<00AD> "), "{cmap}");
    assert!(cmap.contains("<00AE> "), "{cmap}");
    let mut pdf = built;
    let doc = load_pdf(&saved(&mut pdf)).unwrap();
    assert_eq!(drawn_text(&doc, doc.get_pages()[&1]).replace(' ', ""), text.replace(' ', ""));
}

#[test]
fn a_long_cluster_spreads_over_its_glyphs() {
    // A base and 40 combining acutes: one 41-unit cluster of 41 glyphs.
    let faces = all_faces();
    let text = format!("e{}", "\u{301}".repeat(40));
    let mut built = build(&faces, &text, 12.0, false);
    assert!(!built.content.contains("ActualText"));
    let (type0, _) = &fonts_of(&built.doc, built.page)[0];
    let cmap = String::from_utf8(stream_bytes(&built.doc, type0.get(b"ToUnicode").unwrap())).unwrap();
    assert!(cmap.lines().all(|l| l.len() <= "<0000> <>".len() + 4 * 32), "{cmap}");
    let doc = load_pdf(&saved(&mut built)).unwrap();
    assert_eq!(drawn_text(&doc, doc.get_pages()[&1]), text);
}

#[test]
fn a_cluster_longer_than_its_glyphs_hold_gets_actual_text() {
    // One glyph for 40 units of text (as a font with a long ligature would draw it).
    let faces = all_faces();
    let gid = faces[0].hb.glyph_index('a').unwrap().0;
    let text = "a".repeat(40);
    let glyph = Glyph { gid, x_advance: 6.0, x_offset: 0.0, y_offset: 0.0, cluster_text: text.clone() };
    let line = Line { x: 0.0, baseline_y: 20.0, width: 6.0, rtl: false, runs: vec![Run { face: 0, rtl: false, glyphs: vec![glyph] }] };
    let mut built = build_from(&faces, Layout { lines: vec![line], missing: Vec::new() }, 10.0, false);
    let hex: String = "FEFF".to_string() + &"0061".repeat(40);
    assert!(built.content.contains(&format!("/Span <</ActualText <{hex}>>> BDC")), "{}", built.content);
    assert!(built.content.trim_end().ends_with("EMC\nET Q"), "{}", built.content);
    let pdf = saved(&mut built);
    let doc = load_pdf(&pdf).unwrap();
    // Known limit: the redact reader keeps 32 units of an entry and ignores /ActualText.
    assert_eq!(drawn_text(&doc, doc.get_pages()[&1]), "a".repeat(32));
    assert_eq!(redact_search(&pdf, &"a".repeat(32), &opts()).unwrap().matches.len(), 1);
    if let Some(extracted) = pdftotext(&pdf) {
        assert_eq!(extracted.trim(), text, "poppler reads /ActualText");
    }
}

// ---- positions ----

#[test]
fn interpreter_places_every_glyph_where_the_layout_put_it() {
    let faces = all_faces();
    for text in ["Привет мир", "नमस्ते हिन्दी", "ที่นี่ สวัสดี", "مرحبا بالعالم", "abc שלום def", "你好，世界 AVATAR"] {
        let size = 14.0;
        let mut built = build(&faces, text, size, false);
        let doc = load_pdf(&saved(&mut built)).unwrap();
        let drawn = page_glyphs(&doc, doc.get_pages()[&1]).unwrap();
        let mut expected = Vec::new();
        for (line, origin) in built.layout.lines.iter().zip(&built.origins) {
            let mut pen = origin.0;
            for g in line.runs.iter().flat_map(|r| r.glyphs.iter()) {
                expected.push((pen + g.x_offset, origin.1 + g.y_offset, pen + g.x_advance));
                pen += g.x_advance;
            }
        }
        assert_eq!(drawn.len(), expected.len(), "{text}");
        // Within a thousandth of an em (CID widths are whole units).
        let tolerance = size / 1000.0 + 1e-9;
        for (i, (g, (x, y, end))) in drawn.iter().zip(&expected).enumerate() {
            assert!((g.origin.0 - x).abs() <= tolerance && (g.origin.1 - y).abs() <= tolerance, "{text} glyph {i}: {:?} vs ({x}, {y})", g.origin);
            if g.width > 0.0 {
                assert!((g.end.0 - end).abs() <= tolerance, "{text} glyph {i}: end {} vs {end}", g.end.0);
            }
        }
    }
}

// ---- text read back ----

#[test]
fn ltr_text_reads_back_through_the_redact_reader() {
    let faces = all_faces();
    for text in ["Привет мир", "Ελληνικά", "你好世界", "नमस्ते", "क्ष हिन्दी", "ที่นี่ สวัสดี", "Hello world", "a😀b"] {
        let mut built = build(&faces, text, 12.0, false);
        let doc = load_pdf(&saved(&mut built)).unwrap();
        assert_eq!(drawn_text(&doc, doc.get_pages()[&1]), text);
    }
}

#[test]
fn rtl_text_reads_back_in_drawing_order() {
    // RTL runs are drawn left to right (visual order), cluster by cluster.
    let faces = all_faces();
    for (text, visual) in [("שלום עולם", "םלוע םולש"), ("abc שלום def", "abc םולש def")] {
        let mut built = build(&faces, text, 12.0, false);
        let doc = load_pdf(&saved(&mut built)).unwrap();
        assert_eq!(drawn_text(&doc, doc.get_pages()[&1]), visual);
    }
    let mut built = build(&faces, "مرحبا", 12.0, false);
    let doc = load_pdf(&saved(&mut built)).unwrap();
    let drawn = drawn_text(&doc, doc.get_pages()[&1]);
    assert_eq!(drawn.chars().rev().collect::<String>(), "مرحبا");
}

#[test]
fn search_finds_the_inserted_text() {
    let faces = all_faces();
    let mut built = build(&faces, "Привет мир\nनमस्ते\n你好世界 Ελληνικά", 12.0, false);
    let pdf = saved(&mut built);
    for query in ["Привет мир", "नमस्ते", "你好世界", "Ελληνικά", "世界 Ελλ"] {
        let found = redact_search(&pdf, query, &opts()).unwrap();
        assert_eq!(found.matches.len(), 1, "{query}");
        assert!(found.undecodable_pages.is_empty(), "{query}: some glyph has no text");
    }
}

#[test]
fn redacting_a_word_removes_it() {
    let faces = all_faces();
    let mut built = build(&faces, "Привет мир 你好世界 नमस्ते", 12.0, false);
    let pdf = saved(&mut built);
    for word in ["мир", "好世", "नमस्ते"] {
        let found = redact_search(&pdf, word, &opts()).unwrap();
        assert_eq!(found.matches.len(), 1, "{word}");
        let rects = found.pages.iter().flat_map(|p| p.rects.iter().map(|r| RedactRect { page: p.page, rect: *r })).collect();
        let job = RedactJob { rects, fill: Fill::Black, remove_metadata: true, rasters: Vec::new() };
        let (out, _) = redact(&pdf, job).unwrap();
        let doc = load_pdf(&out).unwrap();
        let left = drawn_text(&doc, doc.get_pages()[&1]);
        assert!(!left.contains(word), "{word} still in {left:?}");
        assert!(redact_search(&out, word, &opts()).unwrap().matches.is_empty());
        // Its neighbours stay.
        for other in ["Привет", "你", "界"].iter().filter(|o| !word.contains(**o)) {
            assert!(left.contains(other), "{other} lost with {word}: {left:?}");
        }
    }
}

// ---- poppler ----

/// `pdftotext` of `pdf` (logical order, RTL runs wrapped in U+202B..U+202C),
/// or None when poppler is not installed.
fn pdftotext(pdf: &[u8]) -> Option<String> {
    let dir = std::env::temp_dir().join(format!("mantis-unifont-{}", std::process::id()));
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join(format!("{:x}.pdf", pdf.len() as u64 ^ pdf.iter().map(|&b| b as u64).sum::<u64>()));
    std::fs::write(&path, pdf).ok()?;
    let out = std::process::Command::new("pdftotext").arg(&path).arg("-").output().ok()?;
    let _ = std::fs::remove_file(&path);
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

#[test]
fn poppler_extracts_every_script() {
    let faces = all_faces();
    for text in ["Привет мир", "مرحبا بالعالم", "你好世界", "Ελληνικά", "नमस्ते हिन्दी", "שלום עולם", "abc שלום def", "ที่นี่"] {
        let mut built = build(&faces, text, 12.0, false);
        let Some(extracted) = pdftotext(&saved(&mut built)) else {
            eprintln!("pdftotext not installed: skipped");
            return;
        };
        // Poppler places the spaces around RTL runs loosely: compare the
        // characters, bidi controls and whitespace left out.
        let bare = |s: &str| s.chars().filter(|c| !c.is_whitespace() && !('\u{202A}'..='\u{202E}').contains(c)).collect::<String>();
        assert_eq!(bare(&extracted), bare(text), "{text}: {extracted:?}");
    }
}

// ---- hostile fonts ----

#[test]
fn embedding_mutated_fonts_never_panics() {
    let mut seed = 0x2545_F491_4F6C_DD1Du64;
    let mut next = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    for font in [SANS, ARABIC, DEVANAGARI, SC] {
        for _ in 0..120 {
            let mut bad = font.to_vec();
            for _ in 0..1 + next() % 12 {
                let at = (next() as usize) % bad.len();
                bad[at] = next() as u8;
            }
            let Ok(faces) = load_faces(&[&bad]) else { continue };
            let p = LayoutParams { size: 10.0, width: 200.0, align: None, line_height: 1.2 };
            let Ok(layout) = layout_text(&faces, "Hi мир مرحبا नमस्ते 你好", &p, &mut ShapeBudget::per_job()) else { continue };
            let mut doc = Document::with_version("1.7");
            let mut embedder = Embedder::new(&faces);
            for line in &layout.lines {
                let _ = embedder.show_line(&mut doc, line, (0.0, 0.0), 10.0, &|_| false, &mut |f, _| format!("U{f}"));
            }
            let _ = embedder.finish(&mut doc);
        }
    }
}
