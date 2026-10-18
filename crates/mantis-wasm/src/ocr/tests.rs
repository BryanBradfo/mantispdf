//! OCR text layer: font objects, ToUnicode, positions read back by the
//! redaction interpreter, isolation from the original content, search.

use super::font::GLYPHLESS_TTF;
use super::*;
use crate::pdf_util::{load_pdf, save_pdf};
use crate::redact::interp::{Glyph, Rect};
use crate::redact::search::{SearchOptions, redact_search};
use crate::redact::unicode::TextCache;
use crate::redact::verify::page_text_glyphs;
use crate::redact::{Budget, JOB_DECODED};
use lopdf::{Dictionary, Document, Object, ObjectId, Stream, dictionary};
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

const ORIGINAL: &[u8] = b"q 1 0 0 1 0 0 cm 0.5 g 0 0 10 10 re f Q\n";

fn nums(v: &[f64]) -> Object {
    Object::Array(v.iter().map(|n| Object::Real(*n as f32)).collect())
}

/// `n` pages sharing one /Resources object (with a font) and one content
/// stream each (`ORIGINAL`, the first leaving a `q` open), MediaBox
/// `media` and `/Rotate rotate` on every page.
fn doc(n: usize, media: [f64; 4], rotate: i64) -> Vec<u8> {
    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();
    let font = doc.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica", "Encoding" => "WinAnsiEncoding",
    });
    let res = doc.add_object(dictionary! { "Font" => dictionary! { "F1" => font } });
    let mut kids = Vec::new();
    for i in 0..n {
        let body = if i == 0 { [ORIGINAL, b"q\n"].concat() } else { ORIGINAL.to_vec() };
        let c = doc.add_object(Stream::new(dictionary! {}, body));
        let page = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id, "Contents" => c, "Resources" => res,
            "MediaBox" => nums(&media), "Rotate" => rotate,
        });
        kids.push(Object::Reference(page));
    }
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => n as i64 }),
    );
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog);
    save_pdf(&mut doc).unwrap()
}

fn letter() -> Vec<u8> {
    doc(1, [0.0, 0.0, 612.0, 792.0], 0)
}

fn word(text: &str, x: f64, y: f64, w: f64, h: f64) -> OcrWord {
    OcrWord { text: text.into(), x, y, w, h, baseline: None, space_after: false }
}

fn page(page: u32, words: Vec<OcrWord>) -> OcrPage {
    OcrPage { page, words }
}

fn page_id(doc: &Document, n: u32) -> ObjectId {
    doc.get_pages()[&n]
}

fn resolve<'a>(doc: &'a Document, obj: &'a Object) -> &'a Object {
    match obj {
        Object::Reference(id) => doc.get_object(*id).unwrap(),
        o => o,
    }
}

fn dict<'a>(doc: &'a Document, obj: &'a Object) -> &'a Dictionary {
    resolve(doc, obj).as_dict().unwrap()
}

fn name<'a>(d: &'a Dictionary, key: &[u8]) -> &'a [u8] {
    d.get(key).unwrap().as_name().unwrap()
}

/// The page's font dictionary entries that are Type0 fonts: (name, id).
fn ocr_fonts(doc: &Document, page: ObjectId) -> Vec<(Vec<u8>, ObjectId)> {
    let p = doc.get_dictionary(page).unwrap();
    let res = dict(doc, p.get(b"Resources").unwrap());
    let fonts = dict(doc, res.get(b"Font").unwrap());
    fonts
        .iter()
        .filter_map(|(k, v)| {
            let id = v.as_reference().ok()?;
            let d = doc.get_dictionary(id).ok()?;
            (name(d, b"Subtype") == b"Type0").then(|| (k.clone(), id))
        })
        .collect()
}

fn stream_bytes(doc: &Document, obj: &Object) -> Vec<u8> {
    let s = resolve(doc, obj).as_stream().unwrap();
    s.decompressed_content().unwrap_or_else(|_| s.content.clone())
}

/// The text glyphs of page `n`, with their text.
fn glyphs(doc: &Document, n: u32) -> Vec<Glyph> {
    let cache = Rc::new(RefCell::new(TextCache::new(JOB_DECODED)));
    page_text_glyphs(doc, page_id(doc, n), &mut Budget::page(JOB_DECODED), &cache).unwrap()
}

/// Per shown string (one per word), the union of its glyph boxes in user
/// space and its text.
fn words_drawn(glyphs: &[Glyph]) -> Vec<(Rect, String)> {
    let mut by_op: BTreeMap<usize, (Rect, String)> = BTreeMap::new();
    for g in glyphs.iter().filter(|g| g.render_mode == 3 && g.text.as_deref() != Some(" ")) {
        let b = g.box_user.bbox();
        let text = g.text.as_deref().unwrap_or("\u{FFFD}");
        by_op
            .entry(g.op_index)
            .and_modify(|(r, t)| {
                *r = Rect { x0: r.x0.min(b.x0), y0: r.y0.min(b.y0), x1: r.x1.max(b.x1), y1: r.y1.max(b.y1) };
                t.push_str(text);
            })
            .or_insert((b, text.to_string()));
    }
    by_op.into_values().collect()
}

fn assert_rect(r: &Rect, expected: [f64; 4]) {
    let got = [r.x0, r.y0, r.x1, r.y1];
    for (g, e) in got.iter().zip(expected) {
        assert!((g - e).abs() <= 0.5, "{got:?} != {expected:?}");
    }
}

fn add(pdf: &[u8], pages: &[OcrPage]) -> Document {
    load_pdf(&add_text_layer(pdf, pages).unwrap()).unwrap()
}

#[test]
fn font_objects_follow_tesseract_glyphless_font() {
    let out = add(&letter(), &[page(1, vec![word("Hello", 100.0, 700.0, 50.0, 12.0)])]);
    let fonts = ocr_fonts(&out, page_id(&out, 1));
    assert_eq!(fonts.len(), 1);
    let (font_name, font_id) = &fonts[0];
    assert!(font_name.starts_with(b"FOcr"));
    let t0 = out.get_dictionary(*font_id).unwrap();
    assert_eq!(name(t0, b"Type"), b"Font");
    assert_eq!(name(t0, b"BaseFont"), b"GlyphLessFont");
    assert_eq!(name(t0, b"Encoding"), b"Identity-H");
    assert!(t0.has(b"ToUnicode"));
    let desc_arr = resolve(&out, t0.get(b"DescendantFonts").unwrap()).as_array().unwrap();
    assert_eq!(desc_arr.len(), 1);
    let cid = dict(&out, &desc_arr[0]);
    assert_eq!(name(cid, b"Subtype"), b"CIDFontType2");
    assert_eq!(name(cid, b"BaseFont"), b"GlyphLessFont");
    assert_eq!(cid.get(b"DW").unwrap().as_float().unwrap(), 500.0);
    let info = dict(&out, cid.get(b"CIDSystemInfo").unwrap());
    assert_eq!(info.get(b"Registry").unwrap().as_str().unwrap(), b"Adobe");
    assert_eq!(info.get(b"Ordering").unwrap().as_str().unwrap(), b"Identity");
    assert_eq!(info.get(b"Supplement").unwrap().as_i64().unwrap(), 0);
    // Every CID shows glyph 1, the glyphless glyph.
    let map = stream_bytes(&out, cid.get(b"CIDToGIDMap").unwrap());
    assert_eq!(map.len(), 2 << 16);
    assert!(map.chunks_exact(2).all(|c| c == [0, 1]));
    let fd = dict(&out, cid.get(b"FontDescriptor").unwrap());
    assert_eq!(name(fd, b"Type"), b"FontDescriptor");
    assert_eq!(name(fd, b"FontName"), b"GlyphLessFont");
    assert_eq!(fd.get(b"Ascent").unwrap().as_float().unwrap(), 800.0);
    assert_eq!(fd.get(b"Descent").unwrap().as_float().unwrap(), -200.0);
    let ff = resolve(&out, fd.get(b"FontFile2").unwrap()).as_stream().unwrap();
    assert_eq!(ff.dict.get(b"Length1").unwrap().as_i64().unwrap(), GLYPHLESS_TTF.len() as i64);
    assert_eq!(stream_bytes(&out, fd.get(b"FontFile2").unwrap()), GLYPHLESS_TTF);
    assert_eq!(GLYPHLESS_TTF.len(), 572);
}

#[test]
fn one_font_set_per_document() {
    let out = add(
        &doc(3, [0.0, 0.0, 612.0, 792.0], 0),
        &[page(1, vec![word("one", 10.0, 10.0, 30.0, 10.0)]), page(3, vec![word("three", 10.0, 10.0, 30.0, 10.0)])],
    );
    let a = ocr_fonts(&out, page_id(&out, 1));
    let c = ocr_fonts(&out, page_id(&out, 3));
    assert_eq!(a.len(), 1);
    assert_eq!(a[0].1, c[0].1);
    assert!(ocr_fonts(&out, page_id(&out, 2)).is_empty());
    let type0 = out
        .objects
        .values()
        .filter(|o| o.as_dict().is_ok_and(|d| d.get(b"Subtype").ok().and_then(|s| s.as_name().ok()) == Some(b"Type0")))
        .count();
    assert_eq!(type0, 1);
}

#[test]
fn to_unicode_reads_back_the_words_with_our_reader() {
    let texts = ["Héllo,", "été", "日本", "naïve-ﬁ", "𝔸𝔹", "Œuvre"];
    let words = texts.iter().enumerate().map(|(i, t)| word(t, 50.0, 700.0 - 20.0 * i as f64, 60.0, 12.0)).collect();
    let out = add(&letter(), &[page(1, words)]);
    let got: Vec<String> = words_drawn(&glyphs(&out, 1)).into_iter().map(|(_, t)| t).collect();
    assert_eq!(got, texts);
}

#[test]
fn to_unicode_maps_bmp_cids_to_themselves_in_blocks_of_at_most_100() {
    // 150 distinct BMP characters.
    let text: String = (0x4E00u32..0x4E00 + 150).filter_map(char::from_u32).collect();
    let out = add(&letter(), &[page(1, vec![word(&text, 10.0, 10.0, 500.0, 10.0)])]);
    let (_, id) = &ocr_fonts(&out, page_id(&out, 1))[0];
    let cmap = stream_bytes(&out, out.get_dictionary(*id).unwrap().get(b"ToUnicode").unwrap());
    let cmap = String::from_utf8(cmap).unwrap();
    assert!(cmap.contains("100 beginbfchar"), "{cmap}");
    assert!(cmap.contains("50 beginbfchar"), "{cmap}");
    assert!(cmap.contains("<4E00> <4E00>"), "{cmap}");
    assert!(cmap.contains("<0000> <FFFF>"), "codespace: {cmap}");
    assert!(!cmap.contains("beginbfrange"));
}

#[test]
fn astral_characters_take_one_cid_from_the_surrogate_block() {
    let out = add(&letter(), &[page(1, vec![word("a𝔸b𝔸😀", 10.0, 10.0, 50.0, 10.0)])]);
    let gs = glyphs(&out, 1);
    let codes: Vec<u32> = gs.iter().filter(|g| g.render_mode == 3).map(|g| g.code).collect();
    assert_eq!(codes, [0x61, 0xD800, 0x62, 0xD800, 0xD801]);
    let texts: Vec<&str> = gs.iter().filter(|g| g.render_mode == 3).map(|g| g.text.as_deref().unwrap()).collect();
    assert_eq!(texts, ["a", "𝔸", "b", "𝔸", "😀"]);
}

#[test]
fn astral_characters_past_the_surrogate_block_read_as_replacement() {
    // 2048 distinct astral characters fill D800..DFFF; the next one is U+FFFD.
    let words: Vec<OcrWord> = (0..2049u32)
        .map(|i| word(&char::from_u32(0x20000 + i).unwrap().to_string(), 10.0, 10.0, 10.0, 10.0))
        .collect();
    let out = add(&letter(), &[page(1, words)]);
    let gs: Vec<Glyph> = glyphs(&out, 1).into_iter().filter(|g| g.render_mode == 3).collect();
    assert_eq!(gs[2047].code, 0xDFFF);
    assert_eq!(gs[2047].text.as_deref(), Some("\u{207FF}"));
    assert_eq!(gs[2048].code, 0xFFFD);
}

#[test]
fn words_land_on_their_boxes_in_user_space() {
    // MediaBox not at the origin: visible (0, 0) is user (10, 20).
    let pdf = doc(1, [10.0, 20.0, 622.0, 812.0], 0);
    let words = vec![word("MANTIS", 72.0, 700.0, 120.0, 20.0), word("i", 300.0, 650.5, 3.0, 11.0)];
    let out = add(&pdf, &[page(1, words)]);
    let drawn = words_drawn(&glyphs(&out, 1));
    assert_eq!(drawn.len(), 2);
    assert_rect(&drawn[0].0, [82.0, 720.0, 202.0, 740.0]);
    assert_rect(&drawn[1].0, [310.0, 670.5, 313.0, 681.5]);
    let g = glyphs(&out, 1);
    let first = g.iter().find(|g| g.render_mode == 3).unwrap();
    // Size from the box height, baseline at 0.2 h, stretched to the width.
    assert_eq!(first.font_size, 20.0);
    assert!((first.origin.1 - 724.0).abs() < 1e-6);
    assert!((first.h_scale - 120.0 / (6.0 * 0.5 * 20.0)).abs() < 1e-6);
}

#[test]
fn a_known_baseline_is_used() {
    let mut w = word("typing", 100.0, 500.0, 60.0, 15.0);
    w.baseline = Some(504.0);
    let out = add(&letter(), &[page(1, vec![w])]);
    let g = glyphs(&out, 1);
    let first = g.iter().find(|g| g.render_mode == 3).unwrap();
    assert!((first.origin.1 - 504.0).abs() < 1e-6);
    assert!((first.origin.0 - 100.0).abs() < 1e-6);
    let drawn = words_drawn(&g);
    assert!((drawn[0].0.x1 - 160.0).abs() < 1e-4, "{:?}", drawn[0]);
}

#[test]
fn a_baseline_outside_the_box_is_clamped_into_it() {
    let mut w = word("x", 100.0, 500.0, 10.0, 10.0);
    w.baseline = Some(900.0);
    let out = add(&letter(), &[page(1, vec![w])]);
    let first = glyphs(&out, 1).into_iter().find(|g| g.render_mode == 3).unwrap();
    assert!((first.origin.1 - 510.0).abs() < 1e-6);
}

#[test]
fn rotated_page_maps_visible_boxes() {
    // Portrait MediaBox shown landscape: visible is 792 x 612.
    let pdf = doc(1, [0.0, 0.0, 612.0, 792.0], 90);
    let out = add(&pdf, &[page(1, vec![word("MANTIS", 100.0, 500.0, 120.0, 20.0)])]);
    let drawn = words_drawn(&glyphs(&out, 1));
    // Visible (x, y) is user (612 - y, x) under /Rotate 90.
    assert_rect(&drawn[0].0, [612.0 - 520.0, 100.0, 612.0 - 500.0, 220.0]);
    let found = redact_search(&add_text_layer(&pdf, &[page(1, vec![word("MANTIS", 100.0, 500.0, 120.0, 20.0)])]).unwrap(), "mantis", &SearchOptions::default()).unwrap();
    let r = found.matches[0].rects[0];
    assert_rect(&Rect { x0: r[0], y0: r[1], x1: r[0] + r[2], y1: r[1] + r[3] }, [100.0, 500.0, 220.0, 520.0]);
}

#[test]
fn text_is_invisible_render_mode_3() {
    let out = add(&letter(), &[page(1, vec![word("ghost", 10.0, 10.0, 30.0, 10.0)])]);
    let g: Vec<Glyph> = glyphs(&out, 1).into_iter().filter(|g| g.text.as_deref().is_some_and(|t| "ghost".contains(t))).collect();
    assert_eq!(g.len(), 5);
    assert!(g.iter().all(|g| g.render_mode == 3));
}

#[test]
fn existing_content_is_kept_byte_for_byte_inside_q_and_q() {
    let pdf = letter();
    let src = load_pdf(&pdf).unwrap();
    let src_page = src.get_dictionary(page_id(&src, 1)).unwrap();
    let original_ref = src_page.get(b"Contents").unwrap().as_reference().unwrap();
    let out = add(&pdf, &[page(1, vec![word("w", 10.0, 10.0, 10.0, 10.0)])]);
    let contents = out.get_dictionary(page_id(&out, 1)).unwrap().get(b"Contents").unwrap().as_array().unwrap().clone();
    assert_eq!(contents.len(), 3);
    assert_eq!(stream_bytes(&out, &contents[0]), b"q\n");
    assert_eq!(contents[1].as_reference().unwrap(), original_ref);
    assert_eq!(stream_bytes(&out, &contents[1]), [ORIGINAL, b"q\n"].concat());
    let tail = String::from_utf8(stream_bytes(&out, &contents[2])).unwrap();
    // The original leaves one `q` open: closed before the layer.
    assert!(tail.starts_with("\nQ\nQ\nq BT 3 Tr"), "{tail}");
    assert!(tail.trim_end().ends_with("ET Q"), "{tail}");
    // The layer stream is compressed.
    let tail_stream = resolve(&out, &contents[2]).as_stream().unwrap();
    assert_eq!(tail_stream.dict.get(b"Filter").unwrap().as_name().unwrap(), b"FlateDecode");
}

#[test]
fn shared_resources_are_not_mutated() {
    let pdf = doc(2, [0.0, 0.0, 612.0, 792.0], 0);
    let src = load_pdf(&pdf).unwrap();
    let shared = src.get_dictionary(page_id(&src, 1)).unwrap().get(b"Resources").unwrap().as_reference().unwrap();
    let before = src.get_object(shared).unwrap().clone();
    let out = add(&pdf, &[page(1, vec![word("w", 10.0, 10.0, 10.0, 10.0)])]);
    assert_eq!(out.get_object(shared).unwrap(), &before);
    let p2 = out.get_dictionary(page_id(&out, 2)).unwrap();
    assert_eq!(p2.get(b"Resources").unwrap().as_reference().unwrap(), shared);
    // Page 1 keeps the shared font under its own copy.
    let p1 = out.get_dictionary(page_id(&out, 1)).unwrap();
    let fonts = dict(&out, dict(&out, p1.get(b"Resources").unwrap()).get(b"Font").unwrap());
    assert!(fonts.has(b"F1"));
}

#[test]
fn pages_without_words_are_untouched() {
    let pdf = doc(2, [0.0, 0.0, 612.0, 792.0], 0);
    let src = load_pdf(&pdf).unwrap();
    let out = add(&pdf, &[page(1, vec![word("  ", 10.0, 10.0, 10.0, 10.0)]), page(2, vec![])]);
    for n in [1, 2] {
        assert_eq!(out.get_object(page_id(&out, n)).unwrap(), src.get_object(page_id(&src, n)).unwrap());
    }
}

#[test]
fn redact_search_finds_ocr_words() {
    let words = vec![
        word("MANTIS", 72.0, 700.0, 120.0, 20.0),
        word("OCR", 200.0, 700.0, 60.0, 20.0),
        word("été", 72.0, 650.0, 40.0, 14.0),
        word("日本", 72.0, 600.0, 30.0, 14.0),
    ];
    let out = add_text_layer(&letter(), &[page(1, words)]).unwrap();
    for (query, rect) in [
        ("mantis", [72.0, 700.0, 192.0, 720.0]),
        ("été", [72.0, 650.0, 112.0, 664.0]),
        ("日本", [72.0, 600.0, 102.0, 614.0]),
        ("mantis ocr", [72.0, 700.0, 260.0, 720.0]),
    ] {
        let found = redact_search(&out, query, &SearchOptions::default()).unwrap();
        assert_eq!(found.matches.len(), 1, "{query}");
        let r = found.matches[0].rects[0];
        assert_rect(&Rect { x0: r[0], y0: r[1], x1: r[0] + r[2], y1: r[1] + r[3] }, rect);
        assert!(found.undecodable_pages.is_empty());
        assert!(found.unknown_boxes.is_empty());
    }
}

#[test]
fn limits() {
    let pdf = doc(2, [0.0, 0.0, 612.0, 792.0], 0);
    let err = |pages: &[OcrPage]| add_text_layer(&pdf, pages).unwrap_err();
    let ok = word("a", 1.0, 1.0, 1.0, 1.0);
    assert_eq!(err(&vec![page(1, vec![]); MAX_PAGES + 1]), "Invalid OCR settings: pages");
    assert_eq!(err(&[page(1, vec![ok.clone(); MAX_WORDS + 1])]), "Invalid OCR settings: words");
    // Over the job total, with every page within its own limit.
    let mut many = vec![page(1, vec![word("", 1.0, 1.0, 1.0, 1.0); MAX_WORDS]); MAX_JOB_WORDS / MAX_WORDS];
    many.push(page(2, vec![word("", 1.0, 1.0, 1.0, 1.0)]));
    assert_eq!(err(&many), "Invalid OCR settings: words");
    drop(many);
    assert_eq!(err(&[page(0, vec![])]), "Invalid OCR settings: page");
    assert_eq!(err(&[page(3, vec![])]), "Invalid OCR settings: page");
    assert_eq!(err(&[page(1, vec![]), page(1, vec![])]), "Invalid OCR settings: page");
    let long: String = "a".repeat(MAX_WORD_UNITS + 1);
    assert_eq!(err(&[page(1, vec![word(&long, 1.0, 1.0, 1.0, 1.0)])]), "Invalid OCR settings: text");
    // 100 astral characters are 200 UTF-16 units: allowed; one more is not.
    let astral: String = "😀".repeat(MAX_WORD_UNITS / 2);
    assert!(add_text_layer(&pdf, &[page(1, vec![word(&astral, 1.0, 1.0, 1.0, 1.0)])]).is_ok());
    let astral = astral + "a";
    assert_eq!(err(&[page(1, vec![word(&astral, 1.0, 1.0, 1.0, 1.0)])]), "Invalid OCR settings: text");
    for bad in [
        word("a", f64::NAN, 1.0, 1.0, 1.0),
        word("a", 1.0, 2e6, 1.0, 1.0),
        word("a", 1.0, 1.0, 0.0, 1.0),
        word("a", 1.0, 1.0, 1.0, -1.0),
        word("a", 1.0, 1.0, 1.0, f64::INFINITY),
    ] {
        assert_eq!(err(&[page(1, vec![bad])]), "Invalid OCR settings: box");
    }
    let mut b = ok.clone();
    b.baseline = Some(f64::NAN);
    assert_eq!(err(&[page(1, vec![b])]), "Invalid OCR settings: baseline");
    // Within the limits.
    assert!(add_text_layer(&pdf, &[page(1, vec![ok.clone(); 1000]), page(2, vec![ok])]).is_ok());
}

#[test]
fn no_words_at_all_still_saves() {
    let pdf = letter();
    let out = add(&pdf, &[]);
    assert!(out.objects.values().all(|o| o.as_dict().map_or(true, |d| !d.has(b"ToUnicode"))));
}

fn spaced(text: &str, x: f64, y: f64, w: f64, h: f64) -> OcrWord {
    OcrWord { space_after: true, ..word(text, x, y, w, h) }
}

/// The space glyphs of page 1: (origin x, end x) in user space.
fn spaces(doc: &Document) -> Vec<(f64, f64)> {
    glyphs(doc, 1).iter().filter(|g| g.text.as_deref() == Some(" ")).map(|g| (g.origin.0, g.end.0)).collect()
}

#[test]
fn space_after_spans_the_gap_to_the_next_word() {
    let words = vec![spaced("MANTIS", 72.0, 700.0, 120.0, 20.0), word("OCR", 194.0, 700.0, 60.0, 20.0)];
    let out = add_text_layer(&letter(), &[page(1, words)]).unwrap();
    let doc = load_pdf(&out).unwrap();
    let s = spaces(&doc);
    assert_eq!(s.len(), 1);
    assert!((s[0].0 - 192.0).abs() < 1e-3 && (s[0].1 - 194.0).abs() < 1e-3, "{s:?}");
    // The 2 pt gap is 0.1 em: without the space glyph search reads "MANTISOCR".
    let found = redact_search(&out, "mantis ocr", &SearchOptions::default()).unwrap();
    assert_eq!(found.matches.len(), 1);
    let r = found.matches[0].rects[0];
    assert_rect(&Rect { x0: r[0], y0: r[1], x1: r[0] + r[2], y1: r[1] + r[3] }, [72.0, 700.0, 254.0, 720.0]);
    // Each word keeps its own box.
    let drawn = words_drawn(&glyphs(&doc, 1));
    assert_rect(&drawn[0].0, [72.0, 700.0, 192.0, 720.0]);
    assert_rect(&drawn[1].0, [194.0, 700.0, 254.0, 720.0]);
}

#[test]
fn space_after_with_an_unknown_gap_is_a_quarter_em() {
    // Last word, and a next word that overlaps: 0.25 em = 5 pt at 20 pt.
    let words = vec![
        spaced("one", 100.0, 700.0, 50.0, 20.0),
        spaced("two", 140.0, 700.0, 50.0, 20.0),
        spaced("three", 300.0, 650.0, 80.0, 20.0),
    ];
    let out = add(&letter(), &[page(1, words)]);
    let s = spaces(&out);
    assert_eq!(s.len(), 3);
    assert!((s[0].0 - 150.0).abs() < 1e-3 && (s[0].1 - 155.0).abs() < 1e-3, "{s:?}");
    assert!((s[2].0 - 380.0).abs() < 1e-3 && (s[2].1 - 385.0).abs() < 1e-3, "{s:?}");
}

#[test]
fn space_after_skips_blank_next_words() {
    let words = vec![spaced("a", 100.0, 700.0, 10.0, 20.0), word(" ", 112.0, 700.0, 2.0, 20.0), word("b", 120.0, 700.0, 10.0, 20.0)];
    let out = add(&letter(), &[page(1, words)]);
    let s = spaces(&out);
    assert!((s[0].1 - 120.0).abs() < 1e-3, "{s:?}");
}

/// One page, MediaBox [0 0 612 792], drawing `content`, with `extra` entries.
fn one_page(content: &[u8], extra: Dictionary) -> Vec<u8> {
    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();
    let c = doc.add_object(Stream::new(dictionary! {}, content.to_vec()));
    let mut page = dictionary! {
        "Type" => "Page", "Parent" => pages_id, "Contents" => c, "Resources" => dictionary! {},
        "MediaBox" => nums(&[0.0, 0.0, 612.0, 792.0]),
    };
    for (k, v) in extra {
        page.set(k, v);
    }
    let page = doc.add_object(page);
    doc.objects.insert(pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1 }));
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog);
    save_pdf(&mut doc).unwrap()
}

/// Two stray `Q` (popping past the page's state), a 3x scale, and a `q` left open.
const EXCESS_Q: &[u8] = b"Q Q 3 0 0 3 0 0 cm 1 0 0 rg 0 0 50 50 re f q 2 0 0 2 0 0 cm";

#[test]
fn stray_q_in_the_original_cannot_move_the_layer() {
    let out = add(&one_page(EXCESS_Q, dictionary! {}), &[page(1, vec![word("MANTIS", 72.0, 700.0, 120.0, 20.0)])]);
    let drawn = words_drawn(&glyphs(&out, 1));
    assert_rect(&drawn[0].0, [72.0, 700.0, 192.0, 720.0]);
    let contents = out.get_dictionary(page_id(&out, 1)).unwrap().get(b"Contents").unwrap().as_array().unwrap().clone();
    // As many extra `q` before the original as it has stray `Q`.
    assert_eq!(stream_bytes(&out, &contents[0]), b"q\nq\nq\n");
    assert_eq!(stream_bytes(&out, &contents[1]), EXCESS_Q);
}

#[test]
fn balanced_original_keeps_the_single_q_head() {
    let out = add(&one_page(ORIGINAL, dictionary! {}), &[page(1, vec![word("w", 10.0, 10.0, 10.0, 10.0)])]);
    let contents = out.get_dictionary(page_id(&out, 1)).unwrap().get(b"Contents").unwrap().as_array().unwrap().clone();
    assert_eq!(stream_bytes(&out, &contents[0]), b"q\n");
    assert_eq!(stream_bytes(&out, &contents[1]), ORIGINAL);
    assert!(String::from_utf8(stream_bytes(&out, &contents[2])).unwrap().starts_with("\nQ\nq BT 3 Tr"));
}

#[test]
fn boxes_under_a_hundredth_of_a_point_are_refused() {
    for bad in [word("a", 1.0, 1.0, 0.009, 10.0), word("a", 1.0, 1.0, 10.0, 0.009), word("a", 1.0, 1.0, 1e-300, 1e-300)] {
        assert_eq!(add_text_layer(&letter(), &[page(1, vec![bad])]).unwrap_err(), "Invalid OCR settings: box");
    }
}

#[test]
fn extreme_boxes_write_finite_nonzero_operands() {
    let long = "x".repeat(MAX_WORD_UNITS);
    let words = vec![
        spaced("a", -1e6, -1e6, 2e6, 0.01),
        spaced(&long, 1e6, 1e6, 0.01, 2e6),
        spaced("b", 0.0, 0.0, 0.01, 0.01),
        word("c", 1e6, 0.0, 0.01, 0.01),
    ];
    let out = add(&letter(), &[page(1, words)]);
    let contents = out.get_dictionary(page_id(&out, 1)).unwrap().get(b"Contents").unwrap().as_array().unwrap().clone();
    let tail = String::from_utf8(stream_bytes(&out, contents.last().unwrap())).unwrap();
    assert!(!tail.contains("inf") && !tail.contains("NaN") && !tail.contains('e'), "{tail}");
    let ops = lopdf::content::Content::decode(tail.as_bytes()).unwrap().operations;
    for op in ops.iter().filter(|op| op.operator == "Tf" || op.operator == "Tz") {
        let v = op.operands.last().unwrap().as_float().unwrap();
        assert!(v.is_finite() && v > 0.0, "{op:?}");
    }
    assert_eq!(ops.iter().filter(|op| op.operator == "Tf").count(), 3);
}

/// The user-space rect of visible box `[x, y, w, h]` on page `n`.
fn user_rect(doc: &Document, n: u32, [x, y, w, h]: [f64; 4]) -> [f64; 4] {
    let vb = crate::stamp::geometry::VisibleBox::of_page(doc, page_id(doc, n));
    let (ax, ay) = vb.to_user(x, y);
    let (bx, by) = vb.to_user(x + w, y + h);
    [ax.min(bx), ay.min(by), ax.max(bx), ay.max(by)]
}

#[test]
fn cropbox_offset_and_rotation_combine() {
    let pdf = one_page(b"", dictionary! { "CropBox" => nums(&[50.0, 60.0, 562.0, 732.0]), "Rotate" => 270 });
    let out = add(&pdf, &[page(1, vec![word("MANTIS", 100.0, 50.0, 120.0, 20.0)])]);
    let expected = user_rect(&out, 1, [100.0, 50.0, 120.0, 20.0]);
    // Rotate 270 over CropBox [50 60 562 732]: visible (x, y) is user (50 + y, 732 - x).
    assert_eq!(expected, [100.0, 512.0, 120.0, 632.0]);
    assert_rect(&words_drawn(&glyphs(&out, 1))[0].0, expected);
    let found = redact_search(&save_pdf(&mut out.clone()).unwrap(), "mantis", &SearchOptions::default()).unwrap();
    let r = found.matches[0].rects[0];
    assert_rect(&Rect { x0: r[0], y0: r[1], x1: r[0] + r[2], y1: r[1] + r[3] }, [100.0, 50.0, 220.0, 70.0]);
}

#[test]
fn page_inheriting_mediabox_and_rotate_from_pages() {
    let mut src = load_pdf(&crate::pdf_util::make_inherited_test_pdf_sized(2, 300, 400)).unwrap();
    let pages_id = src.catalog().unwrap().get(b"Pages").unwrap().as_reference().unwrap();
    src.get_dictionary_mut(pages_id).unwrap().set("Rotate", 90);
    let pdf = save_pdf(&mut src).unwrap();
    let out = add(&pdf, &[page(2, vec![word("MANTIS", 30.0, 200.0, 120.0, 20.0)])]);
    let leaf = out.get_dictionary(page_id(&out, 2)).unwrap();
    assert!(!leaf.has(b"MediaBox") && !leaf.has(b"Rotate"));
    let expected = user_rect(&out, 2, [30.0, 200.0, 120.0, 20.0]);
    // Rotate 90 over [0 0 300 400]: visible (x, y) is user (300 - y, x).
    assert_eq!(expected, [80.0, 30.0, 100.0, 150.0]);
    assert_rect(&words_drawn(&glyphs(&out, 2))[0].0, expected);
}

#[test]
fn page_listed_twice_gets_one_layer_with_both_entries_words() {
    let mut src = load_pdf(&letter()).unwrap();
    let pages_id = src.catalog().unwrap().get(b"Pages").unwrap().as_reference().unwrap();
    let p = page_id(&src, 1);
    let pages = src.get_dictionary_mut(pages_id).unwrap();
    pages.set("Kids", vec![p.into(), p.into()]);
    pages.set("Count", 2);
    let pdf = save_pdf(&mut src).unwrap();
    assert_eq!(load_pdf(&pdf).unwrap().get_pages().len(), 2);
    let out = add(&pdf, &[page(1, vec![word("one", 10.0, 700.0, 30.0, 10.0)]), page(2, vec![word("two", 10.0, 650.0, 30.0, 10.0)])]);
    let contents = out.get_dictionary(p).unwrap().get(b"Contents").unwrap().as_array().unwrap().clone();
    assert_eq!(contents.len(), 3);
    let drawn: Vec<String> = words_drawn(&glyphs(&out, 1)).into_iter().map(|(_, t)| t).collect();
    assert_eq!(drawn, ["one", "two"]);
}
