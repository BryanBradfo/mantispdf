//! Spec section 2 (Rust, layout part): shaping, bidi, CJK breaks, fallback,
//! limits and hostile bytes. Fixtures are small OFL subsets of the Noto fonts
//! (`tests/fonts/`, layout tables kept).

use super::*;
use crate::edit_ops::Align;

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

/// Face order of a Noto Sans box: family, Arabic, Hebrew, Devanagari, Thai, CJK.
fn all_faces() -> Vec<Face<'static>> {
    load_faces(&[SANS, ARABIC, HEBREW, DEVANAGARI, THAI, SC]).expect("fixtures load")
}

fn params(size: f64, width: f64, align: Option<Align>) -> LayoutParams {
    LayoutParams { size, width, align, line_height: 1.2 }
}

fn lay(faces: &[Face], text: &str, p: LayoutParams) -> Layout {
    layout_text(faces, text, &p, &mut ShapeBudget::per_job()).expect("layout")
}

/// One wide line, default alignment.
fn one_line(faces: &[Face], text: &str) -> Line {
    let layout = lay(faces, text, params(10.0, 10_000.0, None));
    assert_eq!(layout.lines.len(), 1, "{text:?} should fit on one line");
    layout.lines.into_iter().next().unwrap()
}

/// Glyph texts in visual order (left to right), joined.
fn visual_text(line: &Line) -> String {
    line.runs.iter().flat_map(|r| r.glyphs.iter()).map(|g| g.cluster_text.as_str()).collect()
}

fn gids(line: &Line) -> Vec<u16> {
    line.runs.iter().flat_map(|r| r.glyphs.iter()).map(|g| g.gid).collect()
}

fn glyph_count(line: &Line) -> usize {
    line.runs.iter().map(|r| r.glyphs.len()).sum()
}

fn line_texts(layout: &Layout) -> Vec<String> {
    layout.lines.iter().map(visual_text).collect()
}

// ---- faces and limits ----

#[test]
fn fixtures_load() {
    assert_eq!(all_faces().len(), 6);
}

#[test]
fn too_many_fonts() {
    let fonts = vec![HEBREW; MAX_FONTS + 1];
    assert_eq!(load_faces(&fonts).err(), Some(LayoutError::TooManyFonts));
    assert!(load_faces(&fonts[..MAX_FONTS]).is_ok());
}

#[test]
fn font_bytes_budget() {
    let big = vec![0u8; MAX_FONT_BYTES / 2 + 1];
    assert_eq!(load_faces(&[&big, &big]).err(), Some(LayoutError::FontBytes));
}

#[test]
fn bad_font_reports_its_index() {
    assert_eq!(load_faces(&[SANS, b"not a font"]).err(), Some(LayoutError::BadFont(1)));
    assert_eq!(load_faces(&[&[]]).err(), Some(LayoutError::BadFont(0)));
    assert_eq!(LayoutError::BadFont(3).field(), "font");
    assert_eq!(LayoutError::Budget.field(), "text");
}

#[test]
fn shaping_budget() {
    let faces = all_faces();
    let p = params(10.0, 100.0, None);
    assert_eq!(layout_text(&faces, "0123456789", &p, &mut ShapeBudget::new(5)).err(), Some(LayoutError::Budget));
    // The budget is shared by the calls of one job.
    let mut budget = ShapeBudget::new(60);
    let mut spent = 0;
    while layout_text(&faces, "0123456789", &p, &mut budget).is_ok() {
        spent += 1;
        assert!(spent < 10, "budget never runs out");
    }
    assert!(spent >= 1);
}

#[test]
fn bad_params() {
    let faces = all_faces();
    for p in [
        params(f64::NAN, 100.0, None),
        params(0.0, 100.0, None),
        params(10.0, f64::INFINITY, None),
        params(10.0, -1.0, None),
        LayoutParams { line_height: 0.0, ..params(10.0, 100.0, None) },
    ] {
        assert_eq!(layout_text(&faces, "a", &p, &mut ShapeBudget::per_job()).err(), Some(LayoutError::Params));
    }
    assert_eq!(layout_text(&[], "a", &params(10.0, 100.0, None), &mut ShapeBudget::per_job()).err(), Some(LayoutError::BadFont(0)));
}

// ---- shaping ----

/// Glyphs with an advance: Noto Sans Arabic draws the dots as separate zero-width marks.
fn bases(line: &Line) -> Vec<u16> {
    line.runs.iter().flat_map(|r| r.glyphs.iter()).filter(|g| g.x_advance > 0.0).map(|g| g.gid).collect()
}

#[test]
fn arabic_joined_forms_differ_from_isolated() {
    let faces = all_faces();
    let isolated = bases(&one_line(&faces, "ب"));
    assert_eq!(isolated.len(), 1);
    // Three behs: final, medial, initial in visual order.
    let joined = bases(&one_line(&faces, "ببب"));
    assert_eq!(joined.len(), 3);
    assert!(joined.iter().all(|g| *g != isolated[0]), "joined {joined:?} vs isolated {isolated:?}");
    assert_ne!(joined[0], joined[1]);
    assert_ne!(joined[1], joined[2]);
}

#[test]
fn arabic_text_comes_back_by_cluster() {
    let faces = all_faces();
    let line = one_line(&faces, "السلام عليكم");
    // RTL: the visual order is the logical order reversed, cluster by cluster.
    let clusters: Vec<&str> =
        line.runs.iter().flat_map(|r| r.glyphs.iter()).map(|g| g.cluster_text.as_str()).filter(|t| !t.is_empty()).collect();
    let logical: String = clusters.iter().rev().copied().collect();
    assert_eq!(logical, "السلام عليكم");
}

#[test]
fn arabic_paragraph_is_rtl_and_right_aligned_by_default() {
    let faces = all_faces();
    let layout = lay(&faces, "مرحبا بالعالم", params(12.0, 300.0, None));
    let line = &layout.lines[0];
    assert!(line.rtl);
    assert!(line.runs.iter().all(|r| r.rtl && r.face == 1), "{:?}", line.runs.iter().map(|r| (r.face, r.rtl)).collect::<Vec<_>>());
    assert!((line.x + line.width - 300.0).abs() < 1e-9, "right aligned: x {} w {}", line.x, line.width);
    // An explicit alignment wins.
    let left = lay(&faces, "مرحبا بالعالم", params(12.0, 300.0, Some(Align::Left)));
    assert_eq!(left.lines[0].x, 0.0);
}

#[test]
fn hebrew_is_reversed_on_the_line() {
    let faces = all_faces();
    let line = one_line(&faces, "שלום");
    assert_eq!(visual_text(&line), "םולש");
    assert!(line.rtl);
}

#[test]
fn mixed_ltr_paragraph_with_hebrew_word() {
    let faces = all_faces();
    let line = one_line(&faces, "abc שלום def");
    assert!(!line.rtl);
    assert_eq!(line.x, 0.0);
    assert_eq!(visual_text(&line), "abc םולש def");
    let hebrew: Vec<&Run> = line.runs.iter().filter(|r| r.face == 2 && r.glyphs.iter().any(|g| g.cluster_text == "ש")).collect();
    assert_eq!(hebrew.len(), 1);
    assert!(hebrew[0].rtl);
    assert_eq!(line.runs[0].face, 0);
    assert!(!line.runs[0].rtl);
}

#[test]
fn mixed_rtl_paragraph_with_latin_word() {
    let faces = all_faces();
    let line = one_line(&faces, "שלום abc");
    assert!(line.rtl);
    assert_eq!(visual_text(&line), "abc םולש");
}

#[test]
fn devanagari_conjunct() {
    let faces = all_faces();
    let line = one_line(&faces, "क्ष");
    assert!(glyph_count(&line) < 3, "ka + virama + ssa forms a conjunct, got {:?}", gids(&line));
    assert_eq!(visual_text(&line), "क्ष");
    assert!(line.runs.iter().all(|r| r.face == 3));
    // The i-matra is drawn before its consonant but its text stays whole.
    assert_eq!(visual_text(&one_line(&faces, "नमस्ते")), "नमस्ते");
    assert_eq!(visual_text(&one_line(&faces, "हिन्दी")), "हिन्दी");
}

#[test]
fn thai_marks_take_no_width() {
    let faces = all_faces();
    let base = one_line(&faces, "ท");
    let marked = one_line(&faces, "ที่");
    assert_eq!(glyph_count(&marked), 3);
    assert!((marked.width - base.width).abs() < 1e-9, "marks add width: {} vs {}", marked.width, base.width);
    assert_eq!(visual_text(&marked), "ที่");
    assert!(marked.runs.iter().all(|r| r.face == 4));
}

#[test]
fn glyph_metrics_scale_with_size() {
    let faces = all_faces();
    let small = one_line(&faces, "Hello");
    let big = lay(&faces, "Hello", params(20.0, 10_000.0, None)).lines.remove(0);
    assert!((big.width - 2.0 * small.width).abs() < 1e-9);
    let sum: f64 = small.runs[0].glyphs.iter().map(|g| g.x_advance).sum();
    assert!((sum - small.width).abs() < 1e-9);
}

// ---- fallback ----

#[test]
fn fallback_per_character() {
    let faces = all_faces();
    let line = one_line(&faces, "Hi 你好 мир");
    let run_faces: Vec<usize> = line.runs.iter().map(|r| r.face).collect();
    assert_eq!(run_faces, [0, 5, 0]);
    assert_eq!(visual_text(&line), "Hi 你好 мир");
    assert!(lay(&faces, "Hi 你好 мир", params(10.0, 1000.0, None)).missing.is_empty());
}

#[test]
fn family_comes_first() {
    // Both faces cover Latin digits and space; the first one wins.
    let faces = load_faces(&[SANS, SC]).unwrap();
    assert!(one_line(&faces, "12 34").runs.iter().all(|r| r.face == 0));
    let swapped = load_faces(&[SC, SANS]).unwrap();
    assert!(one_line(&swapped, "12 34").runs.iter().all(|r| r.face == 0));
    assert_eq!(one_line(&swapped, "Привет").runs[0].face, 1);
}

#[test]
fn uncovered_characters_are_reported() {
    let faces = all_faces();
    let layout = lay(&faces, "a😀b😀ক", params(10.0, 1000.0, None));
    assert_eq!(layout.missing, ['😀', 'ক']);
    let line = &layout.lines[0];
    assert_eq!(visual_text(line), "a😀b😀ক");
    let notdef: Vec<&Glyph> = line.runs.iter().flat_map(|r| r.glyphs.iter()).filter(|g| g.cluster_text == "😀").collect();
    assert!(notdef.iter().all(|g| g.gid == 0));
    assert!(line.runs.iter().all(|r| r.face == 0));
}

#[test]
fn combining_mark_stays_with_its_base() {
    // U+0301 is in Noto Sans (first in order) and in the Hebrew face: after a
    // Hebrew letter it stays in the Hebrew run so it shapes with its base.
    let faces = all_faces();
    let line = one_line(&faces, "ש\u{301}");
    assert_eq!(line.runs.iter().map(|r| r.face).collect::<Vec<_>>(), [2]);
    assert_eq!(visual_text(&line), "ש\u{301}");
    // A space after an Arabic word stays in the Arabic run too.
    let arabic = one_line(&faces, "مرحبا بالعالم");
    assert_eq!(arabic.runs.len(), 1);
}

// ---- line breaking and placement ----

#[test]
fn cjk_breaks_without_spaces() {
    let faces = all_faces();
    // Ideographs are 1 em wide: 10 pt each, five per 50 pt line.
    let text = "我们在测试中文换行没有空格的句子";
    let layout = lay(&faces, text, params(10.0, 50.0, None));
    let counts: Vec<usize> = line_texts(&layout).iter().map(|l| l.chars().count()).collect();
    assert_eq!(counts, [5, 5, 5, 1]);
    assert_eq!(line_texts(&layout).concat(), text);
    assert!(layout.lines.iter().all(|l| l.width <= 50.0 + 1e-9));
}

#[test]
fn cjk_comma_never_starts_a_line() {
    let faces = all_faces();
    let layout = lay(&faces, "你好，世界", params(10.0, 20.0, None));
    let lines = line_texts(&layout);
    assert_eq!(lines.concat(), "你好，世界");
    assert!(lines.iter().all(|l| !l.starts_with('，')), "{lines:?}");
}

#[test]
fn latin_wraps_at_spaces_and_drops_trailing_blanks() {
    let faces = all_faces();
    let hello = one_line(&faces, "Hello world").width;
    let layout = lay(&faces, "Hello world foo", params(10.0, hello, None));
    assert_eq!(line_texts(&layout), ["Hello world", "foo"]);
    assert!((layout.lines[0].width - hello).abs() < 1e-9);
}

#[test]
fn long_word_breaks_by_clusters() {
    let faces = all_faces();
    let layout = lay(&faces, "abcdefghij", params(10.0, 18.0, None));
    let lines = line_texts(&layout);
    assert!(lines.len() > 2, "{lines:?}");
    assert!(lines.iter().all(|l| !l.is_empty()));
    assert_eq!(lines.concat(), "abcdefghij");
    // Zero width: one cluster per line, never an empty or endless layout.
    let zero = lay(&faces, "abc", params(10.0, 0.0, None));
    assert_eq!(line_texts(&zero), ["a", "b", "c"]);
}

#[test]
fn paragraphs_and_baselines() {
    let faces = all_faces();
    let layout = lay(&faces, "a\r\n\nb\rc", params(10.0, 100.0, Some(Align::Left)));
    assert_eq!(line_texts(&layout), ["a", "", "b", "c"]);
    assert!(layout.lines[1].runs.is_empty());
    let upem = faces[0].units_per_em();
    let first = faces[0].ascender() * 10.0 / upem;
    for (i, line) in layout.lines.iter().enumerate() {
        assert!((line.baseline_y - (first + i as f64 * 12.0)).abs() < 1e-9, "line {i}: {}", line.baseline_y);
    }
    let empty = lay(&faces, "", params(10.0, 100.0, None));
    assert_eq!(empty.lines.len(), 1);
    assert!(empty.lines[0].runs.is_empty());
}

#[test]
fn center_and_right_alignment() {
    let faces = all_faces();
    let w = one_line(&faces, "ab").width;
    let center = lay(&faces, "ab", params(10.0, 100.0, Some(Align::Center)));
    assert!((center.lines[0].x - (100.0 - w) / 2.0).abs() < 1e-9);
    let right = lay(&faces, "ab", params(10.0, 100.0, Some(Align::Right)));
    assert!((right.lines[0].x - (100.0 - w)).abs() < 1e-9);
}

#[test]
fn each_paragraph_has_its_own_direction() {
    let faces = all_faces();
    let layout = lay(&faces, "abc\nשלום", params(10.0, 200.0, None));
    assert!(!layout.lines[0].rtl);
    assert!(layout.lines[1].rtl);
    assert_eq!(layout.lines[0].x, 0.0);
    assert!((layout.lines[1].x + layout.lines[1].width - 200.0).abs() < 1e-9);
}

// ---- hostile input ----

/// Deterministic xorshift, no dependency.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

const HOSTILE_TEXT: &str = "Hi мир مرحبا שלום क्ष ที่ 你好\u{202E}abc\u{200D}\u{301}\u{FE0F} \t\u{0}";

fn survive(fonts: &[&[u8]]) {
    if let Ok(faces) = load_faces(fonts) {
        for width in [0.0, 30.0, 1000.0] {
            let _ = layout_text(&faces, HOSTILE_TEXT, &params(10.0, width, None), &mut ShapeBudget::per_job());
        }
    }
}

#[test]
fn hostile_font_bytes_never_panic() {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    for font in [SANS, ARABIC, HEBREW, DEVANAGARI, THAI, SC] {
        // Truncations, including inside the table directory.
        for cut in (0..font.len()).step_by(font.len() / 97 + 1).chain(0..64) {
            survive(&[&font[..cut], SANS]);
        }
        // Random byte flips.
        for _ in 0..150 {
            let mut bad = font.to_vec();
            for _ in 0..1 + rng.next() % 16 {
                let at = (rng.next() as usize) % bad.len();
                bad[at] = rng.next() as u8;
            }
            survive(&[&bad]);
            survive(&[SANS, &bad]);
        }
    }
    // Pure noise.
    for len in [12, 100, 4096] {
        let noise: Vec<u8> = (0..len).map(|_| rng.next() as u8).collect();
        survive(&[&noise]);
    }
}

#[test]
fn hostile_text_never_panics() {
    let faces = all_faces();
    let texts = [
        "\u{301}\u{301}\u{301}",
        "\u{202E}\u{202D}\u{2067}\u{2069}abc\u{200F}",
        "\u{200D}\u{200C}\u{FE0F}",
        "\u{2028}\u{2029}\u{85}\u{B}\u{C}",
        "ب\u{64E}\u{64E}\u{64E}\u{64E}\u{64E}",
        "्््््",
        "   ",
        "\t\t",
    ];
    for t in texts {
        for width in [0.0, 5.0, 500.0] {
            let layout = lay(&faces, t, params(10.0, width, None));
            assert!(!layout.lines.is_empty(), "{t:?}");
        }
    }
    let long = "مرحبا abc 你好 ".repeat(400);
    let layout = lay(&faces, &long, params(10.0, 120.0, None));
    assert!(layout.lines.len() > 10);
}
