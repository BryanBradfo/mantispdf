//! Engine-side text search: matches are unions of the exact glyph boxes the
//! redactor removes, so searching then redacting leaves nothing behind.

use super::search::{Context, SearchOptions, redact_search};
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
        ("WWWWiiiii", "WWWW", "iiiii"),
        ("JOHN SMITH, a tall man", "smith", "JOHN a tall man"),
    ] {
        let pdf = bytes(one_page(&format!("BT /H 10 Tf 100 700 Td ({text}) Tj ET"), with_helvetica));
        let remaining = search_and_redact(&pdf, query);
        // Only the match goes (and a space between words at most).
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

/// A Helvetica font /H whose /ToUnicode is `cmap`.
fn tounicode_font(doc: &mut Document, cmap: &str) -> Dictionary {
    let tu = doc.add_object(Stream::new(dictionary! {}, cmap.as_bytes().to_vec()));
    let font = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica", "ToUnicode" => tu });
    dictionary! { "Font" => dictionary! { "H" => font } }
}

fn hits(pdf: &[u8], query: &str) -> usize {
    redact_search(pdf, query, &opts()).unwrap().pages.iter().map(|p| p.rects.len()).sum()
}

#[test]
fn ligatures_read_as_their_letters() {
    let cmap = "1 beginbfchar <01> <FB01> endbfchar 1 beginbfrange <20> <7E> <0020> endbfrange";
    let pdf = bytes(one_page("BT /H 10 Tf 100 700 Td (con\\001dential) Tj ET", |d| tounicode_font(d, cmap)));
    assert_eq!(hits(&pdf, "confidential"), 1);
    assert_eq!(hits(&pdf, "con\u{FB01}dential"), 1, "the query is folded too");
    // Removing the match takes the ligature glyph too.
    let left = search_and_redact(&pdf, "fide");
    // (Code 1 has no Helvetica width, so its box is wide: neighbours go too.)
    assert!(!left.contains('\u{1}') && !left.contains("de") && left.starts_with('c') && left.ends_with("tial"), "{left:?}");
}

#[test]
fn whitespace_runs_read_as_one_space() {
    let pdf = bytes(one_page("BT /H 10 Tf 100 700 Td [(John ) -400 (Smith)] TJ ET", with_helvetica));
    assert_eq!(hits(&pdf, "john smith"), 1);
    assert_eq!(hits(&pdf, "john   smith"), 1);
    let pdf = bytes(one_page("BT /H 10 Tf 100 700 Td (John   Smith) Tj ET", with_helvetica));
    assert_eq!(hits(&pdf, "john smith"), 1);
}

fn undecodable(pdf: &[u8]) -> Vec<u32> {
    redact_search(pdf, "x", &opts()).unwrap().undecodable_pages
}

#[test]
fn fonts_whose_text_cannot_be_trusted_flag_the_page() {
    // A symbolic TrueType font without /ToUnicode: its codes are glyph ids.
    let symbolic = |flags: i64, encoding: bool| {
        bytes(one_page("BT /H 10 Tf 100 700 Td (+\\(&5) Tj ET", |d| {
            let desc = d.add_object(dictionary! { "Type" => "FontDescriptor", "FontName" => "Arial", "Flags" => flags });
            let mut font = dictionary! {
                "Type" => "Font", "Subtype" => "TrueType", "BaseFont" => "Arial", "FirstChar" => 32, "LastChar" => 126,
                "Widths" => vec![Object::Integer(500); 95], "FontDescriptor" => desc,
            };
            if encoding {
                font.set("Encoding", "WinAnsiEncoding");
            }
            let font = d.add_object(font);
            dictionary! { "Font" => dictionary! { "H" => font } }
        }))
    };
    assert_eq!(undecodable(&symbolic(4, true)), vec![1], "symbolic flag");
    assert_eq!(undecodable(&symbolic(32, false)), vec![1], "TrueType without /Encoding");
    assert!(undecodable(&symbolic(32, true)).is_empty(), "a plain WinAnsi TrueType is fine");
    // A /ToUnicode mapping into the Private Use Area, and one that does not parse.
    let pua = bytes(one_page("BT /H 10 Tf 100 700 Td (SECRET) Tj ET", |d| tounicode_font(d, "1 beginbfrange <20> <7E> <E000> endbfrange")));
    assert_eq!(undecodable(&pua), vec![1]);
    let garbage = bytes(one_page("BT /H 10 Tf 100 700 Td (SECRET) Tj ET", |d| tounicode_font(d, "<<<< garbage ) ( [")));
    assert_eq!(undecodable(&garbage), vec![1]);
}

#[test]
fn queries_with_a_replacement_character_are_refused() {
    let pdf = bytes(one_page("BT /H 10 Tf 100 700 Td (abc) Tj ET", with_helvetica));
    assert_eq!(redact_search(&pdf, "a\u{FFFD}", &opts()).unwrap_err(), "Invalid redact settings: query");
}

#[test]
fn matching_is_linear_and_non_overlapping() {
    let pdf = bytes(one_page("BT /H 10 Tf 0.01 Tz 100 700 Td (aaab ababab aaaa) Tj ET", with_helvetica));
    assert_eq!(hits(&pdf, "aab"), 1);
    assert_eq!(hits(&pdf, "abab"), 1);
    assert_eq!(hits(&pdf, "aa"), 3);
    let found = redact_search(&pdf, "ab", &SearchOptions { whole_word: true, case_sensitive: false }).unwrap();
    assert!(found.pages.is_empty());
}

#[test]
fn pages_past_the_job_character_budget_are_unsearched() {
    let doc = two_pages("BT /H 10 Tf 100 700 Td (SECRET page text here) Tj ET");
    let found = super::search::redact_search_within(&bytes(doc), "secret", &opts(), 30).unwrap();
    assert_eq!(found.pages.iter().map(|p| p.page).collect::<Vec<_>>(), vec![1]);
    assert!(found.truncated);
    assert_eq!(found.unsearched_pages, vec![2]);
}

/// A page with "Name:" and a text field widget whose appearance shows
/// `value` in /Rect `rect`.
fn widget_page(value: &str, rect: [i64; 4]) -> Document {
    let mut doc = one_page("BT /H 10 Tf 100 600 Td (Name:) Tj ET", with_helvetica);
    let page: ObjectId = doc.get_pages()[&1];
    let font = doc.add_object(helvetica());
    let ap = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Form", "BBox" => rect_array([0, 0, rect[2] - rect[0], rect[3] - rect[1]]),
            "Resources" => dictionary! { "Font" => dictionary! { "H" => font } },
        },
        format!("/Tx BMC BT /H 10 Tf 2 5 Td ({value}) Tj ET EMC").into_bytes(),
    ));
    let widget = doc.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Widget", "FT" => "Tx", "T" => Object::String(b"name".to_vec(), StringFormat::Literal),
        "V" => Object::String(value.as_bytes().to_vec(), StringFormat::Literal), "Rect" => rect_array(rect),
        "AP" => dictionary! { "N" => ap }, "P" => page,
    });
    doc.get_dictionary_mut(page).unwrap().set("Annots", vec![widget.into()]);
    let root = doc.trailer.get(b"Root").unwrap().as_reference().unwrap();
    doc.get_dictionary_mut(root).unwrap().set("AcroForm", dictionary! { "Fields" => vec![widget.into()] });
    doc
}

#[test]
fn field_values_are_found_and_redacted() {
    let pdf = bytes(widget_page("John Smith", [150, 595, 350, 615]));
    assert_eq!(hits(&pdf, "john smith"), 1);
    let left = search_and_redact(&pdf, "john smith");
    assert!(!left.contains("John") && !left.contains("Smith") && left.contains("Name"), "{left:?}");
}

#[test]
fn a_page_with_a_far_away_widget_passes_verification() {
    let pdf = bytes(widget_page("Other", [300, 300, 500, 320]));
    let job = RedactJob { rects: vec![RedactRect { page: 1, rect: [95.0, 595.0, 40.0, 15.0] }], fill: Fill::Black, remove_metadata: true, rasters: Vec::new() };
    let (out, _) = redact(&pdf, job).unwrap();
    let out = load_pdf(&out).unwrap();
    let text: String = page_glyphs(&out, out.get_pages()[&1]).unwrap().iter().map(|g| char::from_u32(g.code).unwrap()).collect();
    assert!(text.contains("Other") && !text.contains("Name"), "{text:?}");
}

/// A one-page PDF showing (AB) in simple font `font` (built by `make`).
fn ab_page(make: impl FnOnce(&mut Document) -> Dictionary) -> Vec<u8> {
    bytes(one_page("BT /H 10 Tf 100 700 Td (AB) Tj ET", |d| {
        let font = make(d);
        let font = d.add_object(font);
        dictionary! { "Font" => dictionary! { "H" => font } }
    }))
}

fn simple_font(subtype: &str, flags: Option<Object>, encoding: Option<Object>, to_unicode: Option<ObjectId>, d: &mut Document) -> Dictionary {
    let mut desc = dictionary! { "Type" => "FontDescriptor", "FontName" => "X" };
    if let Some(f) = flags {
        desc.set("Flags", f);
    }
    let desc = d.add_object(desc);
    let mut font = dictionary! {
        "Type" => "Font", "Subtype" => Object::Name(subtype.as_bytes().to_vec()), "BaseFont" => "X",
        "FirstChar" => 65, "LastChar" => 66, "Widths" => vec![500.into(), 500.into()], "FontDescriptor" => desc,
    };
    if let Some(e) = encoding {
        font.set("Encoding", e);
    }
    if let Some(t) = to_unicode {
        font.set("ToUnicode", t);
    }
    font
}

#[test]
fn private_use_and_symbolic_fonts_fail_closed() {
    // One code of two maps into the Private Use Area: that glyph is unknown.
    let pdf = ab_page(|d| {
        let tu = d.add_object(Stream::new(dictionary! {}, b"2 beginbfchar <41> <E000> <42> <0042> endbfchar".to_vec()));
        simple_font("Type1", None, Some("WinAnsiEncoding".into()), Some(tu), d)
    });
    assert_eq!(undecodable(&pdf), vec![1], "PUA glyph");
    // A symbolic font: only /ToUnicode counts, its encoding never does.
    let pdf = ab_page(|d| {
        let tu = d.add_object(Stream::new(dictionary! {}, b"1 beginbfchar <41> <0041> endbfchar".to_vec()));
        simple_font("Type1", Some(4.into()), Some("WinAnsiEncoding".into()), Some(tu), d)
    });
    assert_eq!(undecodable(&pdf), vec![1], "symbolic, B not in /ToUnicode");
    // Unrecognised encodings count as none: symbolic.
    let bogus = |subtype: &'static str| ab_page(move |d| simple_font(subtype, Some(32.into()), Some("Bogus".into()), None, d));
    assert_eq!(undecodable(&bogus("TrueType")), vec![1]);
    assert_eq!(undecodable(&bogus("Type1")), vec![1]);
    let empty_dict = ab_page(|d| simple_font("Type1", Some(32.into()), Some(Object::Dictionary(dictionary! {})), None, d));
    assert_eq!(undecodable(&empty_dict), vec![1]);
    // /Flags as a real is rounded; anything else is symbolic.
    let real = |flags: f32| ab_page(move |d| simple_font("Type1", Some(Object::Real(flags)), Some("WinAnsiEncoding".into()), None, d));
    assert_eq!(undecodable(&real(4.0)), vec![1]);
    assert!(undecodable(&real(32.0)).is_empty());
    let text_flags = ab_page(|d| simple_font("Type1", Some(Object::String(b"4".to_vec(), StringFormat::Literal)), Some("WinAnsiEncoding".into()), None, d));
    assert_eq!(undecodable(&text_flags), vec![1]);
}

/// (SECRET) in Helvetica whose /ToUnicode is `cmap`.
fn secret_with_cmap(cmap: &str) -> Vec<u8> {
    bytes(one_page("BT /H 10 Tf 100 700 Td (SECRET) Tj ET", |d| {
        let tu = d.add_object(Stream::new(dictionary! {}, cmap.as_bytes().to_vec()));
        let font = d.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica", "Encoding" => "WinAnsiEncoding", "ToUnicode" => tu,
        });
        dictionary! { "Font" => dictionary! { "H" => font } }
    }))
}

#[test]
fn real_world_cmaps_are_read() {
    let cmaps = [
        // Word / Ghostscript style.
        "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo\n<< /Registry (Adobe)\n/Ordering (UCS)\n/Supplement 0\n>> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<00> <FF>\nendcodespacerange\n2 beginbfchar\n<53> <0053>\n<45> <0045>\nendbfchar\n1 beginbfrange\n<52> <54> <0052>\nendbfrange\n1 beginbfchar\n<43> <0043>\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n",
        // pdfTeX: %-comment lines.
        "%!PS-Adobe-3.0 Resource-CMap\n%%DocumentNeededResources: ProcSet (CIDInit)\n%%IncludeResource: ProcSet (CIDInit)\n%%BeginResource: CMap (TeX-OT1-0)\n%%Title: (TeX-OT1-0 TeX OT1 0)\n%%Version: 1.000\n%%EndComments\n/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo\n<< /Registry (TeX)\n/Ordering (OT1)\n/Supplement 0\n>> def\n/CMapName /TeX-OT1-0 def\n/CMapType 2 def\n1 begincodespacerange\n<00> <7F>\nendcodespacerange\n3 beginbfchar\n<53> <0053>\n<45> <0045>\n<43> <0043>\nendbfchar\n1 beginbfrange\n<52> <54> <0052>\nendbfrange\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n%%EndResource\n%%EOF\n",
        // A PostScript procedure after the maps.
        "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /X def /CMapType 2 def 1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfrange <41> <5A> <0041> endbfrange endcmap CMapName currentdict /CMap defineresource pop end end /foo { 1 2 add { (}) } if } bind def",
    ];
    for (i, cmap) in cmaps.iter().enumerate() {
        let found = redact_search(&secret_with_cmap(cmap), "secret", &opts()).unwrap();
        assert_eq!((found.pages.len(), found.undecodable_pages.clone()), (1, vec![]), "cmap {i}");
    }
    // A map block that does not parse still fails closed.
    for broken in ["1 beginbfchar <53> endbfchar", "1 beginbfchar <53> <00G3> endbfchar", "1 beginbfrange <41> <5A> /x endbfrange", "1 beginbfchar <53> <0053>"] {
        assert_eq!(redact_search(&secret_with_cmap(broken), "secret", &opts()).unwrap().undecodable_pages, vec![1], "{broken}");
    }
}

#[test]
fn a_real_pdftex_paper_is_searchable() {
    let path = "/home/wingleet/Bureau/projects/interesting/2604.11201v2.pdf";
    let Ok(pdf) = std::fs::read(path) else {
        eprintln!("skipped: {path} not found");
        return;
    };
    let found = redact_search(&pdf, "benchmark", &opts()).unwrap();
    assert!(found.pages.iter().any(|p| p.page == 1), "pdftotext finds it on page 1");
    assert!(!found.undecodable_pages.contains(&1), "{:?}", found.undecodable_pages);
    eprintln!("undecodable pages of the paper: {:?}", found.undecodable_pages);
}

#[test]
fn a_tall_font_bbox_does_not_take_the_next_line() {
    // Size 10 at 11 pt leading; the descriptor's /FontBBox reaches 1.15 em.
    let doc = one_page("BT /T 10 Tf 100 700 Td (AAAA) Tj 0 -11 Td (BBBB) Tj ET", |d| {
        let desc = d.add_object(dictionary! {
            "Type" => "FontDescriptor", "FontName" => "T", "Flags" => 32, "Ascent" => 900, "Descent" => -200,
            "FontBBox" => rect_array([-100, -300, 1000, 1150]),
        });
        let font = d.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "T", "Encoding" => "WinAnsiEncoding",
            "FirstChar" => 65, "LastChar" => 66, "Widths" => vec![600.into(), 600.into()], "FontDescriptor" => desc,
        });
        dictionary! { "Font" => dictionary! { "T" => font } }
    });
    let pdf = bytes(doc);
    // The area covers line 1 from just above line 2's ascent (689 + 9 = 698).
    let job = RedactJob { rects: vec![RedactRect { page: 1, rect: [95.0, 699.0, 40.0, 12.0] }], fill: Fill::Black, remove_metadata: true, rasters: Vec::new() };
    let (out, _) = redact(&pdf, job).unwrap();
    let out = load_pdf(&out).unwrap();
    let text: String = page_glyphs(&out, out.get_pages()[&1]).unwrap().iter().map(|g| char::from_u32(g.code).unwrap()).collect();
    assert_eq!(text, "BBBB");
}

/// Search `query` in `text` (Helvetica 20), redact the matches: the text
/// left and the pages widened.
fn search_redact_widen(text: &str, query: &str) -> (String, Vec<u32>) {
    let pdf = bytes(one_page(&format!("BT /H 20 Tf 100 700 Td ({text}) Tj ET"), with_helvetica));
    let found = redact_search(&pdf, query, &opts()).unwrap();
    let rects = found.pages.iter().flat_map(|p| p.rects.iter().map(|r| RedactRect { page: p.page, rect: *r })).collect();
    let job = RedactJob { rects, fill: Fill::Black, remove_metadata: true, rasters: Vec::new() };
    let (out, summary) = redact(&pdf, job).unwrap();
    let out = load_pdf(&out).unwrap();
    let left = page_glyphs(&out, out.get_pages()[&1]).unwrap().iter().map(|g| char::from_u32(g.code).unwrap()).collect();
    (left, summary.pages_widened)
}

#[test]
fn search_takes_exactly_the_matched_glyphs() {
    assert_eq!(search_redact_widen("\\(World\\),", "World"), ("(),".to_string(), vec![]));
    assert_eq!(search_redact_widen("concatenate", "cat"), ("conenate".to_string(), vec![]));
}

#[test]
fn type3_text_is_unknown_but_the_rest_of_the_page_is_searched() {
    let doc = one_page("BT /H 10 Tf 100 700 Td (Visible words) Tj ET BT /T 24 Tf 100 600 Td (abc) Tj ET", |d| {
        let fonts = with_helvetica(d);
        let square = d.add_object(Stream::new(dictionary! {}, b"750 0 0 0 750 750 d1 0 0 750 750 re f".to_vec()));
        let t3 = d.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type3", "FontMatrix" => vec![Object::Real(0.001), 0.into(), 0.into(), Object::Real(0.001), 0.into(), 0.into()],
            "FontBBox" => rect_array([0, 0, 750, 750]), "FirstChar" => 97, "LastChar" => 99, "Widths" => vec![750.into(), 750.into(), 750.into()],
            "Encoding" => dictionary! { "Differences" => vec![97.into(), "a".into(), "b".into(), "c".into()] },
            "CharProcs" => dictionary! { "a" => square, "b" => square, "c" => square },
        });
        let mut fonts = fonts;
        fonts.get_mut(b"Font").unwrap().as_dict_mut().unwrap().set("T", t3);
        fonts
    });
    let found = redact_search(&bytes(doc), "visible", &opts()).unwrap();
    assert_eq!(found.pages.iter().map(|p| p.page).collect::<Vec<_>>(), vec![1]);
    assert_eq!(found.undecodable_pages, vec![1]);
    // Where the unknown text is: one box for the run of three Type3 glyphs.
    assert_eq!(found.unknown_boxes.len(), 1);
    assert_eq!(found.unknown_boxes[0].page, 1);
    let [[x, y, w, h]] = found.unknown_boxes[0].rects[..] else { panic!("{:?}", found.unknown_boxes) };
    assert!((x - 100.0).abs() < 1e-6 && (w - 54.0).abs() < 1e-4, "{x} {w}");
    assert!(y <= 600.0 && y + h >= 600.0 + 0.7 * 24.0, "{y} {h}");
}

#[test]
fn matches_come_with_their_rects_and_context() {
    let doc = one_page("BT /H 10 Tf 100 700 Td (The Quick brown fox jumps over the lazy dog and more text) Tj 0 -20 Td (lazy) Tj ET", with_helvetica);
    let found = redact_search(&bytes(doc), "LAZY", &opts()).unwrap();
    assert_eq!(found.matches.len(), 2);
    let first = &found.matches[0];
    assert_eq!(first.page, 1);
    assert_eq!(first.rects, vec![found.pages[0].rects[0]]);
    assert_eq!(first.context, Context { before: " fox jumps over the ".into(), text: "lazy".into(), after: " dog and more text l".into() });
    // The line break reads as a space.
    assert_eq!(found.matches[1].context.before, "y dog and more text ");
    let found = redact_search(&bytes(one_page("BT /H 10 Tf 100 700 Td (The Quick brown fox jumps over) Tj ET", with_helvetica)), "quick", &opts()).unwrap();
    // The text as drawn, not as folded for matching.
    assert_eq!(found.matches[0].context, Context { before: "The ".into(), text: "Quick".into(), after: " brown fox jumps ove".into() });
}

/// The glyphs left after redacting `rect` (visible = user space here).
fn redact_left(pdf: &[u8], rect: [f64; 4]) -> String {
    let job = RedactJob { rects: vec![RedactRect { page: 1, rect }], fill: Fill::Black, remove_metadata: true, rasters: Vec::new() };
    let (out, _) = redact(pdf, job).unwrap();
    let out = load_pdf(&out).unwrap();
    page_glyphs(&out, out.get_pages()[&1]).unwrap().iter().map(|g| char::from_u32(g.code).unwrap()).collect()
}

#[test]
fn bogus_tiny_widths_use_a_plausible_width_for_the_removal_box() {
    // /Widths of 11/1000 while Tc spaces the glyphs 12 pt apart at 20 pt:
    // the 'A' inks 100..113 pt whatever its declared 0.22 pt advance.
    let doc = one_page("BT /T 20 Tf 12 Tc 100 300 Td (ABCDEFGH) Tj ET", |d| {
        let widths: Vec<Object> = (0..256).map(|_| Object::Integer(11)).collect();
        let font = d.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica", "Encoding" => "WinAnsiEncoding",
            "FirstChar" => 0, "LastChar" => 255, "Widths" => widths,
        });
        dictionary! { "Font" => dictionary! { "T" => font } }
    });
    assert_eq!(redact_left(&bytes(doc), [101.0, 295.0, 10.0, 20.0]), "BCDEFGH");
}

/// Search `query` in a page drawing `content` (Helvetica as /H), redact
/// the matches: the text left.
fn search_redact_content(content: &str, query: &str) -> String {
    let pdf = bytes(one_page(content, with_helvetica));
    let found = redact_search(&pdf, query, &opts()).unwrap();
    assert!(!found.pages.is_empty(), "{query} not found");
    let rects = found.pages.iter().flat_map(|p| p.rects.iter().map(|r| RedactRect { page: p.page, rect: *r })).collect();
    let job = RedactJob { rects, fill: Fill::Black, remove_metadata: true, rasters: Vec::new() };
    let (out, _) = redact(&pdf, job).unwrap();
    let out = load_pdf(&out).unwrap();
    page_glyphs(&out, out.get_pages()[&1]).unwrap().iter().map(|g| char::from_u32(g.code).unwrap()).collect()
}

#[test]
fn a_match_rect_never_cuts_a_matched_glyph() {
    // Each glyph pulled 0.15 em into the one before it: stopping the rect at
    // the neighbour would cut the matched glyph next to it, so the whole
    // union is marked and the overlapping neighbour goes too.
    let were = "BT /H 20 Tf 100 700 Td [(W) 150 (e) 150 (r) 150 (e)] TJ ET";
    let pdf = bytes(one_page(were, with_helvetica));
    let glyphs = {
        let doc = load_pdf(&pdf).unwrap();
        page_glyphs(&doc, doc.get_pages()[&1]).unwrap()
    };
    let found = redact_search(&pdf, "We", &opts()).unwrap();
    let [x, y, w, h] = found.pages[0].rects[0];
    for g in &glyphs[..2] {
        let b = g.box_user.bbox();
        assert!(b.x0 >= x - 1e-9 && b.x1 <= x + w + 1e-9 && b.y0 >= y - 1e-9 && b.y1 <= y + h + 1e-9, "{b:?} outside the match rect");
    }
    assert_eq!(search_redact_content(were, "We"), "e");
    assert_eq!(search_redact_content(were, "re"), "W");
}

/// /H (Helvetica) and /T, a Type3 font of three squares (codes a, b, c).
fn with_helvetica_and_type3(d: &mut Document) -> Dictionary {
    let mut fonts = with_helvetica(d);
    let square = d.add_object(Stream::new(dictionary! {}, b"750 0 0 0 750 750 d1 0 0 750 750 re f".to_vec()));
    let t3 = d.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "Type3", "FontMatrix" => vec![Object::Real(0.001), 0.into(), 0.into(), Object::Real(0.001), 0.into(), 0.into()],
        "FontBBox" => rect_array([0, 0, 750, 750]), "FirstChar" => 97, "LastChar" => 99, "Widths" => vec![750.into(), 750.into(), 750.into()],
        "Encoding" => dictionary! { "Differences" => vec![97.into(), "a".into(), "b".into(), "c".into()] },
        "CharProcs" => dictionary! { "a" => square, "b" => square, "c" => square },
    });
    fonts.get_mut(b"Font").unwrap().as_dict_mut().unwrap().set("T", t3);
    fonts
}

#[test]
fn pages_whose_unknown_boxes_are_complete_are_listed() {
    // Every unknown glyph boxed (and a page with none): complete.
    let doc = one_page("BT /H 10 Tf 100 700 Td (Visible) Tj ET BT /T 24 Tf 100 600 Td (abc) Tj ET", with_helvetica_and_type3);
    assert_eq!(redact_search(&bytes(doc), "visible", &opts()).unwrap().unknown_complete, vec![1]);
    let doc = one_page("BT /H 10 Tf 100 700 Td (Visible) Tj ET", with_helvetica);
    assert_eq!(redact_search(&bytes(doc), "visible", &opts()).unwrap().unknown_complete, vec![1]);
    // A page the interpreter cannot read: not complete.
    let doc = one_page("BT /V 10 Tf 100 700 Td <0041> Tj ET", |d| {
        let cid = d.add_object(dictionary! { "Type" => "Font", "Subtype" => "CIDFontType0" });
        let font = d.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type0", "Encoding" => "Identity-V", "DescendantFonts" => vec![cid.into()] });
        dictionary! { "Font" => dictionary! { "V" => font } }
    });
    let found = redact_search(&bytes(doc), "a", &opts()).unwrap();
    assert_eq!((found.undecodable_pages, found.unknown_complete), (vec![1], vec![]));
    // More unknown runs than the box cap: not complete.
    let runs = "/T 10 Tf (a) Tj /H 10 Tf (x) Tj ".repeat(MAX_RECTS + 1);
    let doc = one_page(&format!("BT 0 700 Td 0.001 Tz {runs} ET"), with_helvetica_and_type3);
    let found = redact_search(&bytes(doc), "x", &opts()).unwrap();
    assert_eq!(found.unknown_boxes.iter().map(|p| p.rects.len()).sum::<usize>(), MAX_RECTS);
    assert_eq!(found.unknown_complete, Vec::<u32>::new());
}

#[test]
fn pages_not_fully_searched_are_never_complete() {
    // Past the job's character budget: page 2 is unsearched.
    let doc = two_pages("BT /H 10 Tf 100 700 Td (a secret here and more) Tj ET");
    let found = super::search::redact_search_within(&bytes(doc), "secret", &opts(), 30).unwrap();
    assert_eq!(found.unsearched_pages, vec![2]);
    assert_eq!(found.unknown_complete, vec![1]);
    // Matches stopped at the rect cap on page 1: it and page 2 are unsearched.
    let many = "(x ) Tj ".repeat(MAX_RECTS + 1);
    let doc = two_pages(&format!("BT /H 10 Tf 0 700 Td 0.001 Tz {many} ET"));
    let found = redact_search(&bytes(doc), "x", &opts()).unwrap();
    assert!(found.truncated);
    assert_eq!(found.unsearched_pages, vec![1, 2]);
    assert_eq!(found.unknown_complete, Vec::<u32>::new());
}

/// Resources with a 1x1 gray image `Im1`.
fn with_image(doc: &mut Document) -> Dictionary {
    let image = doc.add_object(Stream::new(
        dictionary! { "Type" => "XObject", "Subtype" => "Image", "Width" => 1, "Height" => 1, "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8 },
        vec![0],
    ));
    let font = doc.add_object(helvetica());
    dictionary! { "XObject" => dictionary! { "Im1" => image }, "Font" => dictionary! { "H" => font } }
}

#[test]
fn pages_with_an_image_and_no_text_are_reported_textless() {
    for (content, textless) in [
        // A scan: an image, no glyph at all.
        ("q 612 0 0 792 0 0 cm /Im1 Do Q", true),
        // Text over the image: searchable.
        ("q 612 0 0 792 0 0 cm /Im1 Do Q BT /H 12 Tf 72 700 Td (Hello) Tj ET", false),
        // Invisible text (an OCR layer) counts as text.
        ("q 612 0 0 792 0 0 cm /Im1 Do Q BT 3 Tr /H 12 Tf 72 700 Td (Hello) Tj ET", false),
        // Neither: an empty page is not a scan.
        ("0 0 10 10 re f", false),
    ] {
        let pdf = bytes(one_page(content, with_image));
        for query in ["Hello", ""] {
            let found = redact_search(&pdf, query, &opts()).unwrap();
            assert_eq!(found.textless_pages, if textless { vec![1] } else { vec![] }, "{content} / {query:?}");
        }
    }
}

#[test]
fn an_image_inside_a_form_makes_a_textless_page() {
    let pdf = bytes(one_page("/Fm1 Do", |doc| {
        let inner = with_image(doc);
        let form = doc.add_object(Stream::new(
            dictionary! { "Type" => "XObject", "Subtype" => "Form", "BBox" => rect_array([0, 0, 612, 792]), "Resources" => inner },
            b"q 612 0 0 792 0 0 cm /Im1 Do Q".to_vec(),
        ));
        dictionary! { "XObject" => dictionary! { "Fm1" => form } }
    }));
    assert_eq!(redact_search(&pdf, "x", &opts()).unwrap().textless_pages, vec![1]);
}

/// A page as a typical producer writes right-to-left text: a Type0 font
/// (Identity-H, ToUnicode one letter per CID, no font program needed to
/// search) and the glyphs drawn in visual order, left to right. `lines` are
/// each drawn as given (already visual).
fn visual_order_page(lines: &[&str]) -> Vec<u8> {
    let mut letters: Vec<char> = lines.iter().flat_map(|l| l.chars()).filter(|c| *c != ' ').collect();
    letters.sort_unstable();
    letters.dedup();
    let cid = |c: char| letters.iter().position(|&l| l == c).unwrap() + 1;
    let mut cmap = format!("/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange {} beginbfchar\n", letters.len());
    for (i, c) in letters.iter().enumerate() {
        cmap.push_str(&format!("<{:04X}> <{:04X}>\n", i + 1, *c as u32));
    }
    cmap.push_str("endbfchar endcmap CMapName currentdict /CMap defineresource pop end end");
    let mut content = String::new();
    for (n, line) in lines.iter().enumerate() {
        // One TJ per line; a space is a 300-unit gap (no space glyph).
        content.push_str(&format!("BT /R 12 Tf 100 {} Td [", 700 - 20 * n as i64));
        for c in line.chars() {
            if c == ' ' {
                content.push_str(" -300 ");
            } else {
                content.push_str(&format!("<{:04X}>", cid(c)));
            }
        }
        content.push_str("] TJ ET\n");
    }
    bytes(one_page(&content, |doc| {
        let to_unicode = doc.add_object(Stream::new(dictionary! {}, cmap.into_bytes()));
        let descendant = doc.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "CIDFontType2", "BaseFont" => "RtlTest", "DW" => 500,
            "CIDSystemInfo" => dictionary! { "Registry" => Object::string_literal("Adobe"), "Ordering" => Object::string_literal("Identity"), "Supplement" => 0 },
        });
        let font = doc.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type0", "BaseFont" => "RtlTest", "Encoding" => "Identity-H",
            "DescendantFonts" => vec![descendant.into()], "ToUnicode" => to_unicode,
        });
        dictionary! { "Font" => dictionary! { "R" => font } }
    }))
}

/// The page's text in drawing order, through the fonts' ToUnicode.
fn drawn(pdf: &[u8]) -> String {
    let doc = load_pdf(pdf).unwrap();
    let cache = std::rc::Rc::new(std::cell::RefCell::new(super::unicode::TextCache::new(JOB_DECODED)));
    super::verify::page_text_glyphs(&doc, doc.get_pages()[&1], &mut Budget::page(JOB_DECODED), &cache)
        .unwrap()
        .iter()
        .map(|g| g.text.as_deref().unwrap_or("?").to_string())
        .collect()
}

#[test]
fn right_to_left_text_drawn_in_visual_order_is_found_in_reading_order() {
    // "שלום עולם" and "مرحبا بالعالم" drawn visually; "abc שלום def" and an
    // Arabic line with a number keep their left-to-right parts.
    let pdf = visual_order_page(&["םלוע םולש", "ملاعلاب ابحرم", "abc םולש def", "ءاقل 2024 ماع"]);
    for (query, count) in
        [("שלום", 2), ("עולם", 1), ("שלום עולם", 1), ("مرحبا", 1), ("بالعالم", 1), ("abc שלום def", 1), ("عام 2024", 1), ("abc", 1)]
    {
        let found = redact_search(&pdf, query, &opts()).unwrap();
        assert_eq!(found.matches.len(), count, "{query}");
    }
    // Whole words, and the drawn (visual) order still matches too.
    let whole = SearchOptions { whole_word: true, case_sensitive: false };
    assert_eq!(redact_search(&pdf, "שלום", &whole).unwrap().matches.len(), 2);
    assert_eq!(redact_search(&pdf, "םולש", &opts()).unwrap().matches.len(), 2);
    // The context reads in reading order.
    let found = redact_search(&pdf, "עולם", &opts()).unwrap();
    assert_eq!(found.matches[0].context.text, "עולם");
    // A match found in both orders (a palindrome) is marked once.
    let pal = visual_order_page(&["אבא"]);
    assert_eq!(redact_search(&pal, "אבא", &opts()).unwrap().matches.len(), 1);
}

#[test]
fn right_to_left_matches_are_redacted() {
    let pdf = visual_order_page(&["םלוע םולש", "abc םולש def"]);
    let found = redact_search(&pdf, "שלום", &opts()).unwrap();
    assert_eq!(found.matches.len(), 2);
    let rects = found.pages.iter().flat_map(|p| p.rects.iter().map(|r| RedactRect { page: p.page, rect: *r })).collect();
    let (out, _) = redact(&pdf, RedactJob { rects, fill: Fill::Black, remove_metadata: true, rasters: Vec::new() }).unwrap();
    let left = drawn(&out);
    // Both "שלום" gone (drawn "םולש"), "עולם" and the Latin words kept.
    assert_eq!(left, "םלועabcdef");
}

#[test]
fn one_letter_matches_in_both_reading_orders_stay_bounded() {
    // 120,000 one-letter matches, each found in drawing and in reading order:
    // collecting stops at MAX_RECTS kept matches instead of holding them all.
    let line = "א".repeat(400);
    let lines: Vec<&str> = std::iter::repeat_n(line.as_str(), 300).collect();
    let pdf = visual_order_page(&lines);
    let started = std::time::Instant::now();
    let found = redact_search(&pdf, "א", &opts()).unwrap();
    assert_eq!(found.matches.len(), MAX_RECTS);
    assert_eq!(found.pages[0].rects.len(), MAX_RECTS);
    assert!(found.truncated);
    assert_eq!(found.unsearched_pages, [1]);
    assert!(started.elapsed() < std::time::Duration::from_secs(20), "{:?}", started.elapsed());
}
