//! Engine-side text search: matches are unions of the exact glyph boxes the
//! redactor removes, so searching then redacting leaves nothing behind.

use super::search::{SearchOptions, redact_search};
use super::verify::page_glyphs;
use super::*;
use crate::pdf_util::{load_pdf, save_pdf};
use lopdf::{Dictionary, Document, Object, ObjectId, Stream, StringFormat, dictionary};

fn helvetica() -> Dictionary {
    dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica", "Encoding" => "WinAnsiEncoding" }
}

fn rect_array(v: [i64; 4]) -> Object {
    Object::Array(v.iter().map(|n| Object::Integer(*n)).collect())
}

/// One page with `content` and `resources`, MediaBox [0 0 612 792].
fn one_page(content: &str, resources: impl FnOnce(&mut Document) -> Dictionary) -> Document {
    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();
    let res = resources(&mut doc);
    let c = doc.add_object(Stream::new(dictionary! {}, content.as_bytes().to_vec()));
    let page = doc.add_object(dictionary! { "Type" => "Page", "Parent" => pages_id, "Contents" => c, "Resources" => res });
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1, "MediaBox" => rect_array([0, 0, 612, 792]),
        }),
    );
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog);
    doc
}

fn with_helvetica(doc: &mut Document) -> Dictionary {
    let font = doc.add_object(helvetica());
    dictionary! { "Font" => dictionary! { "H" => font } }
}

fn bytes(mut doc: Document) -> Vec<u8> {
    save_pdf(&mut doc).unwrap()
}

fn opts() -> SearchOptions {
    SearchOptions { whole_word: false, case_sensitive: false }
}

/// Search `query`, redact every match, return the page's remaining text.
fn search_and_redact(pdf: &[u8], query: &str) -> String {
    let found = redact_search(pdf, query, &opts()).unwrap();
    assert!(!found.pages.is_empty(), "{query} not found");
    let rects = found
        .pages
        .iter()
        .flat_map(|p| p.rects.iter().map(|r| RedactRect { page: p.page, rect: *r }))
        .collect();
    let job = RedactJob { rects, fill: Fill::Black, remove_metadata: true, rasters: Vec::new() };
    let (out, _) = redact(pdf, job).unwrap();
    let out = load_pdf(&out).unwrap();
    let page: ObjectId = out.get_pages()[&1];
    page_glyphs(&out, page).unwrap().iter().map(|g| char::from_u32(g.code).unwrap()).collect()
}

#[test]
fn searched_words_are_removed_entirely() {
    // Splitting items by character count left part of these behind.
    for (text, query, left) in [
        ("MAXIMUM limit", "maximum", "limit"),
        ("WWWWiiiii", "WWWW", "iiii"),
        ("JOHN SMITH, a tall man", "smith", "JOHN a tall man"),
    ] {
        let pdf = bytes(one_page(&format!("BT /H 10 Tf 100 700 Td ({text}) Tj ET"), with_helvetica));
        let remaining = search_and_redact(&pdf, query);
        // Only the match and the boxes touching it (a space, a comma, one
        // neighbouring letter at most) go.
        let words: Vec<&str> = remaining.split([' ', ',']).filter(|w| !w.is_empty()).collect();
        assert_eq!(words.join(" "), left, "{text}: searching {query} left {remaining:?}");
    }
}

#[test]
fn matches_are_case_insensitive_whole_word_optional_and_cross_shows() {
    let pdf = bytes(one_page(
        "BT /H 10 Tf 100 700 Td (password pass) Tj 0 -20 Td (Hello) Tj 0 -14 Td (World) Tj ET",
        with_helvetica,
    ));
    let count = |q: &str, whole_word: bool| -> usize {
        let found = redact_search(&pdf, q, &SearchOptions { whole_word, case_sensitive: false }).unwrap();
        found.pages.iter().map(|p| p.rects.len()).sum()
    };
    assert_eq!(count("PASS", false), 2);
    assert_eq!(count("pass", true), 1);
    // A line break reads as a space; one rect per line.
    assert_eq!(count("hello world", false), 2);
    assert_eq!(count("helloworld", false), 0);
    assert_eq!(count("", false), 0);
}

#[test]
fn tounicode_bfrange_both_forms_and_bfchar() {
    let cmap = "/CIDInit /ProcSet findresource begin 12 dict begin begincmap \
        1 begincodespacerange <0000> <FFFF> endcodespacerange \
        1 beginbfchar <0020> <0020> endbfchar \
        2 beginbfrange <0001> <0005> <0041> <0010> <0011> [<0058> <0059>] endbfrange \
        endcmap CMapName currentdict /CMap defineresource pop end end";
    let doc = one_page("BT /F 10 Tf 100 700 Td <0001000200200010> Tj ET", |doc| {
        let to_unicode = doc.add_object(Stream::new(dictionary! {}, cmap.as_bytes().to_vec()));
        let cid = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "CIDFontType2", "BaseFont" => "X", "DW" => 500 });
        let font = doc.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type0", "BaseFont" => "X", "Encoding" => "Identity-H",
            "DescendantFonts" => vec![cid.into()], "ToUnicode" => to_unicode,
        });
        dictionary! { "Font" => dictionary! { "F" => font } }
    });
    let found = redact_search(&bytes(doc), "b x", &opts()).unwrap();
    assert_eq!(found.pages.len(), 1);
    assert_eq!(found.pages[0].rects.len(), 1);
    assert!(found.undecodable_pages.is_empty());
}

#[test]
fn differences_with_glyph_names() {
    let doc = one_page("BT /F 10 Tf 100 700 Td (AB) Tj ET", |doc| {
        let font = doc.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Embedded", "FirstChar" => 65, "LastChar" => 66,
            "Widths" => vec![500.into(), 500.into()],
            "Encoding" => dictionary! { "Type" => "Encoding", "BaseEncoding" => "WinAnsiEncoding",
                "Differences" => vec![65.into(), "Z".into(), "uni0042".into()] },
        });
        dictionary! { "Font" => dictionary! { "F" => font } }
    });
    let found = redact_search(&bytes(doc), "zb", &opts()).unwrap();
    assert_eq!(found.pages.iter().map(|p| p.rects.len()).sum::<usize>(), 1);
}

#[test]
fn text_inside_forms_is_found() {
    let doc = one_page("q 1 0 0 1 100 400 cm /Fm Do Q", |doc| {
        let fonts = with_helvetica(doc);
        let form = doc.add_object(Stream::new(
            dictionary! { "Type" => "XObject", "Subtype" => "Form", "BBox" => rect_array([0, 0, 300, 100]), "Resources" => fonts },
            b"BT /H 10 Tf 10 50 Td (SECRET DATA) Tj ET".to_vec(),
        ));
        dictionary! { "XObject" => dictionary! { "Fm" => form } }
    });
    let pdf = bytes(doc);
    let left = search_and_redact(&pdf, "secret");
    assert_eq!(left.trim_start(), "DATA");
}

#[test]
fn rotated_pages_give_visible_space_rects_that_redact_the_match() {
    let mut doc = one_page("BT /H 10 Tf 100 700 Td (Hello World) Tj ET", with_helvetica);
    let page = doc.get_pages()[&1];
    doc.get_dictionary_mut(page).unwrap().set("Rotate", 90);
    let pdf = bytes(doc);
    let found = redact_search(&pdf, "world", &opts()).unwrap();
    // Rotate 90: visible (vx, vy) = (y, 612 - x); the text runs down the visible page.
    let [x, y, w, h] = found.pages[0].rects[0];
    assert!(w < h && x > 690.0 && x < 700.0 && y > 400.0 && y < 500.0, "{:?}", [x, y, w, h]);
    // The neighbouring space's box touches the match's: it may go too.
    assert_eq!(search_and_redact(&pdf, "world").trim_end(), "Hello");
}

#[test]
fn pages_whose_text_cannot_be_read_are_reported() {
    // Identity-H without ToUnicode: the codes are glyph ids.
    let doc = one_page("BT /F 10 Tf <0001> Tj ET", |doc| {
        let cid = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "CIDFontType2", "BaseFont" => "X" });
        let font = doc.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type0", "BaseFont" => "X", "Encoding" => "Identity-H",
            "DescendantFonts" => vec![cid.into()],
        });
        dictionary! { "Font" => dictionary! { "F" => font } }
    });
    let found = redact_search(&bytes(doc), "a", &opts()).unwrap();
    assert_eq!(found.undecodable_pages, vec![1]);
    // A page the interpreter cannot read at all (Type3).
    let doc = one_page("BT /T 10 Tf (x) Tj ET", |doc| {
        let t3 = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type3" });
        dictionary! { "Font" => dictionary! { "T" => t3 } }
    });
    assert_eq!(redact_search(&bytes(doc), "x", &opts()).unwrap().undecodable_pages, vec![1]);
    let _ = StringFormat::Literal;
}

#[test]
fn too_many_matches_are_reported_as_truncated() {
    let many = "a ".repeat(MAX_RECTS + 5);
    let mut doc = one_page(&format!("BT /H 10 Tf 0.01 Tz 10 700 Td ({many}) Tj ET"), with_helvetica);
    // A second page, never searched.
    let pages_id = doc.catalog().unwrap().get(b"Pages").unwrap().as_reference().unwrap();
    let first = doc.get_pages()[&1];
    let second = doc.add_object(doc.get_dictionary(first).unwrap().clone());
    let pages = doc.get_dictionary_mut(pages_id).unwrap();
    pages.set("Kids", vec![first.into(), second.into()]);
    pages.set("Count", 2);
    let found = redact_search(&bytes(doc), "a", &opts()).unwrap();
    assert!(found.truncated);
    assert_eq!(found.unsearched_pages, vec![1, 2]);
    assert_eq!(found.pages.iter().map(|p| p.rects.len()).sum::<usize>(), MAX_RECTS);
}

#[test]
fn pages_with_too_much_text_are_undecodable() {
    // 70000 glyphs of 32 characters each: past 2 M characters.
    let codes = "01".repeat(70_000);
    let doc = one_page(&format!("BT /F 1 Tf <{codes}> Tj ET"), |doc| {
        let long = "0041".repeat(32);
        let cmap = doc.add_object(Stream::new(dictionary! {}, format!("1 beginbfchar <01> <{long}> endbfchar").into_bytes()));
        let font = doc.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "TrueType", "BaseFont" => "X", "FirstChar" => 1, "LastChar" => 1,
            "Widths" => vec![500.into()], "ToUnicode" => cmap,
        });
        dictionary! { "Font" => dictionary! { "F" => font } }
    });
    let found = redact_search(&bytes(doc), "aaaa", &opts()).unwrap();
    assert_eq!(found.undecodable_pages, vec![1]);
    assert!(found.pages.is_empty());
}

fn two_pages(content: &str) -> Document {
    let mut doc = one_page(content, with_helvetica);
    let pages_id = doc.catalog().unwrap().get(b"Pages").unwrap().as_reference().unwrap();
    let first = doc.get_pages()[&1];
    let second = doc.add_object(doc.get_dictionary(first).unwrap().clone());
    let pages = doc.get_dictionary_mut(pages_id).unwrap();
    pages.set("Kids", vec![first.into(), second.into()]);
    pages.set("Count", 2);
    doc
}

fn rect_count(found: &super::search::SearchResult) -> usize {
    found.pages.iter().map(|p| p.rects.len()).sum()
}

#[test]
fn a_match_that_does_not_fit_is_dropped_whole() {
    // MAX_RECTS - 1 one-line matches, then one across two lines (2 rects).
    let line = format!("{}x", "x y ".repeat(MAX_RECTS - 1));
    let doc = one_page(&format!("BT /H 10 Tf 0.01 Tz 10 700 Td ({line}) Tj 0 -20 Td (y) Tj ET"), with_helvetica);
    let found = redact_search(&bytes(doc), "x y", &opts()).unwrap();
    assert_eq!(rect_count(&found), MAX_RECTS - 1, "never half a match");
    assert!(found.truncated);
    assert_eq!(found.unsearched_pages, vec![1]);
}

#[test]
fn pages_after_the_limit_are_not_searched() {
    // Page 1 fills the limit exactly; page 2 is never searched.
    let doc = two_pages(&format!("BT /H 10 Tf 0.01 Tz 10 700 Td ({}) Tj ET", "x y ".repeat(MAX_RECTS)));
    let found = redact_search(&bytes(doc), "x y", &opts()).unwrap();
    assert_eq!(rect_count(&found), MAX_RECTS);
    assert!(found.truncated);
    assert_eq!(found.unsearched_pages, vec![2]);
}

#[test]
fn unreadable_tounicode_makes_the_page_undecodable() {
    let doc = one_page("BT /F 10 Tf 100 700 Td (a) Tj ET", |doc| {
        let broken = doc.add_object(Stream::new(dictionary! { "Filter" => "FlateDecode" }, b"not zlib".to_vec()));
        let font = doc.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica", "Encoding" => "WinAnsiEncoding",
            "ToUnicode" => broken,
        });
        dictionary! { "Font" => dictionary! { "F" => font } }
    });
    let found = redact_search(&bytes(doc), "a", &opts()).unwrap();
    assert_eq!(found.undecodable_pages, vec![1]);
    assert!(found.pages.is_empty());
}

#[test]
fn zero_size_matches_get_rects_redaction_accepts() {
    for content in ["BT /H 0 Tf 100 700 Td (SECRET) Tj ET", "BT /H 10 Tf 0 Tz 100 700 Td (SECRET) Tj ET"] {
        let pdf = bytes(one_page(content, with_helvetica));
        let found = redact_search(&pdf, "secret", &opts()).unwrap();
        for r in found.pages.iter().flat_map(|p| &p.rects) {
            assert!(r[2] >= 1.0 && r[3] >= 1.0, "{content}: {r:?}");
        }
        assert_eq!(search_and_redact(&pdf, "secret"), "", "{content}");
    }
}
