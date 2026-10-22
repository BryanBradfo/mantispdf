//! Fill form with values the standard fonts cannot encode (spec 1.6): Noto
//! appearances, /V as UTF-16BE, comb cells per grapheme, multiline, flatten,
//! and the font checks.

use super::fill::fill_form_with_fonts;
use super::tree::tests::{base, finish, widget, with};
use super::unicode::{FieldFont, FormFonts};
use super::{Value, list_form};
use crate::pdf_util::{load_pdf, save_pdf};
use crate::redact::search::{SearchOptions, redact_search};
use crate::rebuild::deref;
use lopdf::{Document, Object, ObjectId};

macro_rules! font {
    ($file:literal) => {
        include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fonts/", $file)).to_vec()
    };
}

fn fonts(fields: &[(u32, FieldFont)]) -> FormFonts {
    FormFonts {
        files: vec![font!("NotoSans-subset.ttf"), font!("NotoSansArabic-subset.ttf"), font!("NotoSansSC-subset.ttf")],
        fields: fields.iter().cloned().collect(),
    }
}

fn chain(faces: &[usize]) -> FieldFont {
    FieldFont { faces: faces.to_vec(), fake_bold: Vec::new() }
}

/// A one-page form: text fields with `(flags, extra entries)`, 200 x 20 pt each, one below the other.
fn form(fields: Vec<Vec<(&str, Object)>>) -> (Vec<u8>, Vec<ObjectId>) {
    let (mut doc, page) = base(0);
    let mut ids = Vec::new();
    for (i, extra) in fields.into_iter().enumerate() {
        let top = 760 - 60 * i as i64;
        let mut entries = vec![
            ("FT", "Tx".into()),
            ("T", Object::string_literal(format!("f{i}"))),
            ("DA", Object::string_literal("/Helv 12 Tf 0 g")),
        ];
        entries.extend(extra);
        ids.push(doc.add_object(with(widget(page, [100, top - 20, 300, top]), entries)));
    }
    finish(&mut doc, page, &ids, &ids, vec![]);
    (save_pdf(&mut doc).unwrap(), ids)
}

fn search(pdf: &[u8], query: &str) -> usize {
    redact_search(pdf, query, &SearchOptions { whole_word: false, case_sensitive: true }).unwrap().matches.len()
}

/// The normal appearance content of field `id` and the BaseFonts of its fonts.
fn appearance(pdf: &[u8], id: ObjectId) -> (String, Vec<String>) {
    let doc = load_pdf(pdf).unwrap();
    let field = doc.get_dictionary(id).unwrap();
    let ap = deref(&doc, field.get(b"AP").unwrap()).unwrap().as_dict().unwrap();
    let stream = doc.get_object(ap.get(b"N").unwrap().as_reference().unwrap()).unwrap().as_stream().unwrap();
    let res = stream.dict.get(b"Resources").unwrap().as_dict().unwrap().get(b"Font").unwrap().as_dict().unwrap();
    let names = res
        .iter()
        .map(|(_, f)| {
            let f = doc.get_dictionary(f.as_reference().unwrap()).unwrap();
            String::from_utf8_lossy(f.get(b"BaseFont").unwrap().as_name().unwrap()).into_owned()
        })
        .collect();
    let content = stream.decompressed_content().unwrap_or_else(|_| stream.content.clone());
    (String::from_utf8_lossy(&content).into_owned(), names)
}

#[test]
fn unicode_value_gets_a_noto_appearance_and_a_utf16_value() {
    let (pdf, ids) = form(vec![vec![]]);
    let value = "Привет 你好";
    let out = fill_form_with_fonts(&pdf, &[(0, Value::Text(value.into()))], false, &fonts(&[(0, chain(&[0, 2]))])).unwrap();
    let doc = load_pdf(&out).unwrap();
    let v = doc.get_dictionary(ids[0]).unwrap().get(b"V").unwrap().as_str().unwrap().to_vec();
    assert_eq!(&v[..2], &[0xFE, 0xFF], "UTF-16BE with a byte order mark");
    let (content, fonts) = appearance(&out, ids[0]);
    assert!(content.starts_with("/Tx BMC\nq\n1 1 198 18 re W n\n0 g\n0 G\n"), "{content}");
    assert!(content.contains("] TJ"), "{content}");
    assert_eq!(fonts.len(), 2, "{fonts:?}");
    assert!(fonts.iter().all(|f| f.as_bytes()[6] == b'+'), "{fonts:?}");
    assert_eq!(list_form(&out).unwrap().fields[0].value, Value::Text(value.into()));
    assert_eq!(search(&out, "Привет"), 1);
    assert_eq!(search(&out, "你好"), 1);
}

#[test]
fn without_fonts_a_unicode_value_is_still_refused() {
    let (pdf, _) = form(vec![vec![]]);
    let err = fill_form_with_fonts(&pdf, &[(0, Value::Text("你好".into()))], false, &FormFonts::default()).unwrap_err();
    assert!(err.starts_with("Characters not supported by the standard PDF fonts"), "{err}");
}

#[test]
fn winansi_values_keep_the_standard_font_even_with_fonts() {
    let (pdf, ids) = form(vec![vec![]]);
    let out = fill_form_with_fonts(&pdf, &[(0, Value::Text("Hi".into()))], false, &fonts(&[(0, chain(&[0]))])).unwrap();
    let (content, fonts) = appearance(&out, ids[0]);
    assert_eq!(content, "/Tx BMC\nq\n1 1 198 18 re W n\nBT\n/Helv 12 Tf\n0 g\n2 6.934 Td\n(Hi) Tj\nET\nQ\nEMC\n");
    assert_eq!(fonts, ["Helvetica"]);
}

#[test]
fn comb_cells_hold_one_grapheme_each() {
    // MaxLen counts code points (/V, as Acrobat): "क्षमा" is five, in a MaxLen 6 field of six
    // cells; it draws two graphemes, one per cell.
    let comb = |max: i64| vec![("Ff", Object::Integer(1 << 24)), ("MaxLen", max.into())];
    let (pdf, ids) = form(vec![comb(6), comb(4)]);
    let out = fill_form_with_fonts(&pdf, &[(0, Value::Text("क्षमा".into()))], false, &fonts(&[(0, chain(&[0]))])).unwrap();
    let (content, _) = appearance(&out, ids[0]);
    assert_eq!(content.matches(" Tm\n").count(), 2, "{content}");
    // Cells are 200 / 6 pt wide: each grapheme centred in its own.
    let cell = 200.0 / 6.0;
    let xs: Vec<f64> = content.lines().filter(|l| l.ends_with(" Tm")).map(|l| l.split(' ').nth(4).unwrap().parse().unwrap()).collect();
    assert!(xs[0] > 0.0 && xs[0] < cell && xs[1] > cell && xs[1] < 2.0 * cell, "{xs:?}");
    assert_eq!(search(&out, "क्ष"), 1);
    // Five code points do not fit MaxLen 4, however few graphemes they make.
    let err = fill_form_with_fonts(&pdf, &[(1, Value::Text("क्षमा".into()))], false, &fonts(&[(1, chain(&[0]))])).unwrap_err();
    assert_eq!(err, "Invalid form settings: max-length");
}

#[test]
fn multiline_values_wrap_and_shrink_to_fit() {
    let value = "我们在测试中文换行没有空格的句子我们在测试中文换行没有空格的句子";
    let fixed = vec![("Ff", Object::Integer(1 << 12))];
    let auto = vec![("Ff", Object::Integer(1 << 12)), ("DA", Object::string_literal("/Helv 0 Tf 0 g"))];
    let (pdf, ids) = form(vec![fixed, auto]);
    let values = [(0, Value::Text(value.into())), (1, Value::Text(value.into()))];
    let out = fill_form_with_fonts(&pdf, &values, false, &fonts(&[(0, chain(&[0, 2])), (1, chain(&[0, 2]))])).unwrap();
    // 12 pt: 32 ideographs need 384 pt, the box 196 (16 a line): two lines, top down.
    let (content, _) = appearance(&out, ids[0]);
    let ys: Vec<f64> = content.lines().filter(|l| l.ends_with(" Tm")).map(|l| l.split(' ').nth(5).unwrap().parse().unwrap()).collect();
    assert_eq!(ys.len(), 2, "{content}");
    assert!(ys.windows(2).all(|w| w[0] > w[1]), "{ys:?}");
    // Auto size: shrinks until the text fits the 20 pt high box.
    let (content, _) = appearance(&out, ids[1]);
    let size: f64 = content.lines().find(|l| l.ends_with(" Tf")).unwrap().split(' ').nth(1).unwrap().parse().unwrap();
    assert!((4.0..12.0).contains(&size), "{size}");
    assert_eq!(search(&out, "测试"), 4);
}

#[test]
fn flattened_unicode_values_stay_searchable() {
    let (pdf, _) = form(vec![vec![], vec![]]);
    let values = [(0, Value::Text("مرحبا بالعالم".into())), (1, Value::Text("Ελληνικά".into()))];
    let fields = [(0, chain(&[0, 1])), (1, chain(&[0]))];
    let out = fill_form_with_fonts(&pdf, &values, true, &fonts(&fields)).unwrap();
    assert!(list_form(&out).unwrap().fields.is_empty());
    assert_eq!(search(&out, "مرحبا"), 1);
    assert_eq!(search(&out, "Ελληνικά"), 1);
}

#[test]
fn kept_unicode_values_flatten_with_fonts_and_refuse_without() {
    // A value already in the file, with no appearance.
    let mut utf16 = vec![0xFE, 0xFF];
    for u in "你好".encode_utf16() {
        utf16.extend_from_slice(&u.to_be_bytes());
    }
    let kept = vec![("V", Object::String(utf16, lopdf::StringFormat::Hexadecimal))];
    let (pdf, _) = form(vec![kept]);
    let err = fill_form_with_fonts(&pdf, &[], true, &FormFonts::default()).unwrap_err();
    assert!(err.starts_with("Cannot flatten field"), "{err}");
    let out = fill_form_with_fonts(&pdf, &[], true, &fonts(&[(0, chain(&[0, 2]))])).unwrap();
    assert_eq!(search(&out, "你好"), 1);
}

#[test]
fn synthetic_bold_for_faces_without_bold() {
    let (pdf, ids) = form(vec![vec![("DA", Object::string_literal("/HeBo 12 Tf 0 g"))]]);
    let font = FieldFont { faces: vec![0, 2], fake_bold: vec![2] };
    let out = fill_form_with_fonts(&pdf, &[(0, Value::Text("Hi 你好".into()))], false, &fonts(&[(0, font)])).unwrap();
    let (content, _) = appearance(&out, ids[0]);
    assert_eq!(content.matches("2 Tr").count(), 1, "{content}");
}

#[test]
fn font_errors() {
    let (pdf, _) = form(vec![vec![]]);
    let value = [(0, Value::Text("你好".into()))];
    // A face index past the files, an empty chain, a field that does not exist, bytes that are not a font.
    for bad in [
        fonts(&[(0, chain(&[0, 9]))]),
        fonts(&[(0, chain(&[]))]),
        fonts(&[(0, chain(&[0])), (7, chain(&[0]))]),
        FormFonts { files: vec![b"junk".to_vec()], fields: [(0, chain(&[0]))].into_iter().collect() },
    ] {
        assert_eq!(fill_form_with_fonts(&pdf, &value, false, &bad).unwrap_err(), "Invalid form settings: font");
    }
}

#[test]
fn untouched_documents_without_fonts_are_not_parsed() {
    // A job carrying junk font files but no field using them never reads them.
    let (pdf, _) = form(vec![vec![]]);
    let junk = FormFonts { files: vec![b"junk".to_vec()], fields: Default::default() };
    assert!(fill_form_with_fonts(&pdf, &[(0, Value::Text("ok".into()))], false, &junk).is_ok());
    let _ = Document::with_version("1.7");
}

#[test]
fn list_box_options_in_other_scripts_are_drawn() {
    // A list box (Ch, not combo) whose options are Cyrillic and Chinese.
    let utf16 = |s: &str| {
        let mut b = vec![0xFE, 0xFF];
        for u in s.encode_utf16() {
            b.extend_from_slice(&u.to_be_bytes());
        }
        Object::String(b, lopdf::StringFormat::Hexadecimal)
    };
    let opt = Object::Array(vec![
        Object::Array(vec![Object::string_literal("a"), utf16("Привет")]),
        Object::Array(vec![Object::string_literal("b"), utf16("你好")]),
    ]);
    let (mut doc, page) = base(0);
    let list = doc.add_object(with(widget(page, [100, 600, 300, 680]), vec![
        ("FT", "Ch".into()),
        ("T", Object::string_literal("pick")),
        ("DA", Object::string_literal("/Helv 12 Tf 0 g")),
        ("Opt", opt),
    ]));
    finish(&mut doc, page, &[list], &[list], vec![]);
    let pdf = save_pdf(&mut doc).unwrap();
    let out = fill_form_with_fonts(&pdf, &[(0, Value::Names(vec!["b".into()]))], false, &fonts(&[(0, chain(&[0, 2]))])).unwrap();
    let (content, faces) = appearance(&out, list);
    assert_eq!(faces.len(), 2, "{faces:?}");
    assert!(content.contains("0.6 0.75 0.95 rg"), "the selected row is highlighted: {content}");
    assert_eq!(search(&out, "Привет"), 1);
    assert_eq!(search(&out, "你好"), 1);
    // Flattened too.
    let flat = fill_form_with_fonts(&pdf, &[(0, Value::Names(vec!["b".into()]))], true, &fonts(&[(0, chain(&[0, 2]))])).unwrap();
    assert_eq!(search(&flat, "你好"), 1);
}

#[test]
fn three_long_multiline_values_fit_the_shaping_budget() {
    // Three auto-size multiline fields of 20,000 characters each: the auto size is searched
    // with a few layouts per widget, within one job's shaping budget.
    let multi = || vec![("Ff", Object::Integer(1 << 12)), ("DA", Object::string_literal("/Helv 0 Tf 0 g"))];
    let (pdf, ids) = form(vec![multi(), multi(), multi()]);
    let long: String = "你好世界我们在测试".chars().cycle().take(super::MAX_VALUE_CHARS).collect();
    let values: Vec<(u32, Value)> = (0..3).map(|i| (i, Value::Text(long.clone()))).collect();
    let fields: Vec<(u32, FieldFont)> = (0..3).map(|i| (i, chain(&[0, 2]))).collect();
    let out = fill_form_with_fonts(&pdf, &values, false, &fonts(&fields)).unwrap();
    for id in ids {
        let (content, _) = appearance(&out, id);
        let size: f64 = content.lines().find(|l| l.ends_with(" Tf")).unwrap().split(' ').nth(1).unwrap().parse().unwrap();
        assert_eq!(size, 4.0, "far too long to fit: the smallest size");
    }
}
