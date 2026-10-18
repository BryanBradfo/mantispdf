//! `redact_content` end to end on decoded content: interpret, redact,
//! encode, decode again and interpret the result.

use super::interp::{Event, Glyph, IDENTITY, Interp, decode_ops, encode_ops};
use super::*;
use lopdf::{Dictionary, Document, Object, dictionary};

const TOLERANCE: f64 = 1e-6;
/// lopdf keeps reals as f32, so the one number standing in for a removed
/// run is exact only to 2^-24 of its size; kept glyphs after it may move by
/// that much relative to their distance from the origin (1e-4 pt on a
/// 1000 pt line). Positions are compared within TOLERANCE plus this.
const F32_RELATIVE: f64 = 1.0 / (1u64 << 23) as f64;

fn fixture() -> (Document, Dictionary) {
    let mut doc = Document::with_version("1.7");
    let widths: Vec<Object> = (32..=90)
        .map(|c| match c {
            32 => 250,
            65 => 500,
            66 => 600,
            67 => 700,
            _ => 400,
        })
        .map(Object::Integer)
        .collect();
    let f1 = doc.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "TrueType", "BaseFont" => "Embedded",
        "FirstChar" => 32, "LastChar" => 90, "Widths" => widths,
    });
    let cid = doc.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "CIDFontType2", "BaseFont" => "CID",
        "W" => vec![1.into(), Object::Array(vec![500.into(), 600.into()])],
    });
    let f2 = doc.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "Type0", "BaseFont" => "CID",
        "Encoding" => "Identity-H", "DescendantFonts" => vec![cid.into()],
    });
    let bbox = |v: [i64; 4]| Object::Array(v.iter().map(|n| Object::Integer(*n)).collect());
    let resources = dictionary! {
        "Font" => dictionary! {
            "F1" => f1, "F2" => f2,
            "H" => dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica", "Encoding" => "WinAnsiEncoding" },
        },
        "Shading" => dictionary! {
            "Far" => dictionary! { "ShadingType" => 2, "BBox" => bbox([100, 100, 110, 110]) },
            "Everywhere" => dictionary! { "ShadingType" => 2 },
            "Near" => dictionary! { "ShadingType" => 2, "BBox" => bbox([40, 40, 50, 50]) },
        },
    };
    (doc, resources)
}

fn interpret(doc: &Document, resources: &Dictionary, content: &[u8]) -> Vec<Event> {
    let ops = decode_ops(content).unwrap();
    Interp::new(doc, resources.clone()).run(&ops, IDENTITY, &mut Budget::page(1 << 20)).unwrap()
}

fn glyphs_of(events: &[Event]) -> Vec<Glyph> {
    events
        .iter()
        .filter_map(|e| match e {
            Event::Glyph(g) => Some(g.clone()),
            _ => None,
        })
        .collect()
}

struct Out {
    content: Vec<u8>,
    report: Report,
    before: Vec<Glyph>,
    after: Vec<Glyph>,
    after_events: Vec<Event>,
}

fn try_redact(content: &[u8], rects: &[Rect]) -> Result<(Vec<lopdf::content::Operation>, Report), Unsupported> {
    let (mut doc, resources) = fixture();
    let ops = decode_ops(content).unwrap();
    let events = Interp::new(&doc, resources.clone()).run(&ops, IDENTITY, &mut Budget::page(1 << 20)).unwrap();
    let mut page_resources = resources;
    let mut budget = Budget::page(1 << 20);
    let mut page = PageEdit::new(&mut doc, &mut page_resources, Fill::Black, &mut budget);
    redact_content(&mut page, &ops, &events, rects)
}

fn redact(content: &[u8], rects: &[Rect]) -> Out {
    let (mut doc, resources) = fixture();
    let ops = decode_ops(content).unwrap();
    let events = Interp::new(&doc, resources.clone()).run(&ops, IDENTITY, &mut Budget::page(1 << 20)).unwrap();
    let mut resources = resources;
    let mut budget = Budget::page(1 << 20);
    let mut page = PageEdit::new(&mut doc, &mut resources, Fill::Black, &mut budget);
    let (new_ops, report) = redact_content(&mut page, &ops, &events, rects).unwrap();
    let content = encode_ops(&new_ops);
    assert_no_number_runs(&content);
    let after_events = interpret(&doc, &resources, &content);
    Out { content, report, before: glyphs_of(&events), after: glyphs_of(&after_events), after_events }
}

/// The TJ arrays of `content`, as written.
fn tj_arrays(content: &[u8]) -> Vec<Vec<Object>> {
    decode_ops(content)
        .unwrap()
        .into_iter()
        .filter_map(|op| match (op.operator.as_str(), op.operands.as_slice()) {
            ("TJ", [Object::Array(items)]) => Some(items.clone()),
            _ => None,
        })
        .collect()
}

fn is_number(o: &Object) -> bool {
    matches!(o, Object::Integer(_) | Object::Real(_))
}

/// Removed text never leaves per-glyph widths: no two numbers in a row.
fn assert_no_number_runs(content: &[u8]) {
    for items in tj_arrays(content) {
        assert!(
            !items.windows(2).any(|w| is_number(&w[0]) && is_number(&w[1])),
            "{}",
            String::from_utf8_lossy(content)
        );
    }
}

fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Rect {
    Rect { x0, y0, x1, y1 }
}

fn text(glyphs: &[Glyph]) -> String {
    glyphs.iter().map(|g| char::from_u32(g.code).unwrap()).collect()
}

/// No glyph left in a rect; every glyph outside all rects still there, in
/// order, at the same place.
fn assert_kept_in_place(out: &Out, rects: &[Rect]) {
    let hit = |g: &Glyph| rects.iter().any(|r| g.box_user.intersects(r));
    assert!(!out.after.iter().any(hit), "glyph left in a rect: {}", String::from_utf8_lossy(&out.content));
    let kept: Vec<&Glyph> = out.before.iter().filter(|g| !hit(g)).collect();
    assert_eq!(kept.len(), out.after.len(), "{}", String::from_utf8_lossy(&out.content));
    for (want, got) in kept.iter().zip(&out.after) {
        assert_eq!((want.code, want.render_mode), (got.code, got.render_mode));
        for (a, b) in want.box_user.0.iter().zip(got.box_user.0) {
            let tolerance = TOLERANCE + F32_RELATIVE * (a.0.abs() + a.1.abs());
            assert!(
                (a.0 - b.0).abs() < tolerance && (a.1 - b.1).abs() < tolerance,
                "{want:?} moved to {got:?}\n{}",
                String::from_utf8_lossy(&out.content)
            );
        }
    }
    assert_eq!(out.report.glyphs_removed, out.before.len() - kept.len());
}

#[test]
fn hello_world_loses_world_and_keeps_hello_in_place() {
    let rects = [rect(127.0, 700.0, 170.0, 705.0)];
    let out = redact(b"BT /H 10 Tf 100 700 Td (Hello World) Tj ET", &rects);
    assert_eq!(text(&out.before), "Hello World");
    assert_eq!(text(&out.after), "Hello ");
    assert_eq!(out.report.glyphs_removed, 5);
    assert_kept_in_place(&out, &rects);
}

#[test]
fn rect_over_the_middle_of_a_word_removes_only_covered_glyphs() {
    // Boxes reach 1 unit past the advance: e ends at 113.78, the l's span
    // 111.78..118.22, o starts at 116.22.
    let rects = [rect(114.0, 700.0, 116.0, 705.0)];
    let out = redact(b"BT /H 10 Tf 100 700 Td (Hello World) Tj ET", &rects);
    assert_eq!(text(&out.after), "Heo World");
    assert_kept_in_place(&out, &rects);
}

#[test]
fn word_spacing_still_applies_to_kept_spaces() {
    // A 0..5, space +7.5, B 12.5..18.5, space +7.5, C at 26 (box from 25.5).
    let rects = [rect(14.0, 0.0, 17.0, 5.0)];
    let out = redact(b"BT /F1 10 Tf 5 Tw 0 0 Td (A B C) Tj ET", &rects);
    assert_eq!(text(&out.after), "A  C");
    assert_eq!((out.after[1].word_spacing, out.after[2].word_spacing), (5.0, 5.0));
    assert!((out.after[3].box_user.0[0].0 - 25.5).abs() < TOLERANCE);
    assert_kept_in_place(&out, &rects);
}

#[test]
fn invisible_text_is_removed() {
    let rects = [rect(6.0, 0.0, 10.0, 5.0)];
    let out = redact(b"BT /F1 10 Tf 3 Tr (AB) Tj ET", &rects);
    assert_eq!(text(&out.after), "A");
    assert_eq!(out.after[0].render_mode, 3);
    assert_kept_in_place(&out, &rects);
}

#[test]
fn horizontal_scaling_rise_and_char_spacing() {
    // Th 0.5: A 0..2.5 advancing 3.5, B 3.5..6.5; rise 4: y 2..13.
    let rects = [rect(4.0, 3.0, 6.0, 5.0)];
    let out = redact(b"BT /F1 10 Tf 50 Tz 4 Ts 2 Tc (ABC) Tj ET", &rects);
    assert_eq!(text(&out.after), "AC");
    assert_kept_in_place(&out, &rects);
}

#[test]
fn quote_operators_keep_their_line_moves_and_spacing() {
    // Line 1 (y 88) holds AB, removed entirely; line 2 (y 76) "C B" loses B.
    let rects = [rect(0.0, 86.0, 20.0, 95.0), rect(16.0, 74.0, 20.0, 80.0)];
    let content = b"BT /F1 10 Tf 12 TL 0 100 Td (AB) ' 5 1 (C B) \" (A) ' ET";
    let out = redact(content, &rects);
    assert_eq!(text(&out.before), "ABC BA");
    assert_eq!(text(&out.after), "C A");
    assert_eq!(out.after[1].word_spacing, 5.0);
    assert!(String::from_utf8_lossy(&out.content).contains("T*"));
    assert_kept_in_place(&out, &rects);
}

#[test]
fn fully_removed_show_keeps_its_advance() {
    let rects = [rect(0.0, 0.0, 9.5, 5.0)];
    let out = redact(b"BT /F1 10 Tf (AB) Tj (C) Tj [(A) -300 (B)] TJ ET", &rects);
    assert_eq!(text(&out.after), "CAB");
    assert_kept_in_place(&out, &rects);
}

#[test]
fn tj_numbers_are_kept_and_removed_glyphs_become_numbers() {
    // A 0..5, B 5..11, -250.5 moves 2.505, C 13.505..20.505, A after it.
    let rects = [rect(14.0, 0.0, 19.0, 5.0)];
    let out = redact(b"BT /F1 10 Tf [(AB) -250.5 (CA)] TJ ET", &rects);
    assert_eq!(text(&out.after), "ABA");
    assert_kept_in_place(&out, &rects);
}

#[test]
fn identity_h_codes_are_cut_on_two_byte_boundaries() {
    let rects = [rect(6.0, 0.0, 10.0, 5.0)];
    let out = redact(b"BT /F2 10 Tf <000100020001> Tj ET", &rects);
    assert_eq!(out.after.iter().map(|g| g.code).collect::<Vec<_>>(), vec![1, 1]);
    assert!((out.after[1].box_user.0[0].0 - 10.5).abs() < TOLERANCE);
    assert_kept_in_place(&out, &rects);
}

fn paths(events: &[Event]) -> Vec<super::interp::PathPaint> {
    events
        .iter()
        .filter_map(|e| match e {
            Event::Path(p) => Some(p.clone()),
            _ => None,
        })
        .collect()
}

#[test]
fn paths_inside_or_crossing_are_removed_outside_kept() {
    let rects = [rect(40.0, 40.0, 55.0, 55.0)];
    let out = redact(b"42 42 5 5 re f 0 0 10 10 re f 0 50 m 100 50 l S", &rects);
    assert_eq!(out.report.paths_removed, 2);
    let kept = paths(&out.after_events);
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].bbox_user, Some(rect(0.0, 0.0, 10.0, 10.0)));
}

#[test]
fn clip_paths_are_kept_and_painting_clips_lose_only_their_paint() {
    let rects = [rect(40.0, 40.0, 55.0, 55.0)];
    let out = redact(b"q 0 0 100 100 re W n 0 0 100 100 re W f 1 1 m 2 2 l S Q", &rects);
    assert_eq!(out.report.paths_removed, 1);
    let kept = paths(&out.after_events);
    assert_eq!(kept.iter().map(|p| (p.painted, p.clip)).collect::<Vec<_>>(), vec![(false, true), (false, true), (true, false)]);
}

#[test]
fn rectangle_clips_under_a_rect_are_kept() {
    let rects = [rect(40.0, 40.0, 55.0, 55.0)];
    let out = redact(b"q 0 0 100 100 re W n 10 10 80 80 re h W f Q", &rects);
    let kept = paths(&out.after_events);
    assert_eq!(kept.iter().map(|p| (p.painted, p.clip)).collect::<Vec<_>>(), vec![(false, true), (false, true)]);
    assert_eq!(kept[1].bbox_user, Some(rect(10.0, 10.0, 90.0, 90.0)));
}

#[test]
fn shaped_clips_under_a_rect_make_the_page_unsupported() {
    let rects = [rect(40.0, 40.0, 55.0, 55.0)];
    for content in [
        &b"q 0 0 m 50 100 100 0 0 0 c h W n Q"[..],
        b"q 0 0 m 100 0 l 50 100 l h W n Q",
        b"q 0 0 m 100 0 l 50 100 l h W* f Q",
        b"q 0 0 100 100 re 30 30 m 60 60 l 30 60 l h W n Q",
        b"q 40 40 2 10 re 44 40 2 10 re 40 48 6 2 re W n Q",
        b"q 0 0 100 100 re 10 10 20 20 re W f Q",
    ] {
        let err = try_redact(content, &rects).unwrap_err();
        assert!(err.0.contains("clip"), "{}: {err:?}", String::from_utf8_lossy(content));
    }
    // The same clip away from every rect stays.
    let out = redact(b"q 200 200 m 250 300 300 200 200 200 c h W n Q", &rects);
    assert_eq!(paths(&out.after_events).len(), 1);
}

#[test]
fn shadings_over_a_rect_or_unbounded_are_removed() {
    let rects = [rect(40.0, 40.0, 55.0, 55.0)];
    let out = redact(b"/Far sh /Everywhere sh /Near sh", &rects);
    assert_eq!(out.report.shadings_removed, 2);
    let names: Vec<Vec<u8>> = out
        .after_events
        .iter()
        .filter_map(|e| match e {
            Event::Shading(s) => Some(s.name.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(names, vec![b"Far".to_vec()]);
}

#[test]
fn covered_inline_images_that_cannot_be_decoded_need_a_raster() {
    let rects = [rect(40.0, 40.0, 55.0, 55.0)];
    // ASCIIHex cannot be decoded here: the page needs a raster.
    let content: &[u8] = b"q 10 0 0 10 42 42 cm BI /W 2 /H 1 /CS /G /BPC 8 /F /AHx ID 00FF> EI Q";
    let err = try_redact(content, &rects).unwrap_err();
    assert!(err.0.contains("image that cannot be edited"), "{err:?}");
    // Uncovered, it is written back as it was.
    let content: &[u8] = b"q 10 0 0 10 42 42 cm BI /W 2 /H 1 /CS /G /BPC 8 /F /AHx ID 00FF> EI Q \
        q 10 0 0 10 0 0 cm BI /W 1 /H 1 /CS /G /BPC 8 ID \x00 EI Q";
    let out = redact(content, &[rect(100.0, 100.0, 110.0, 110.0)]);
    let ops = decode_ops(&out.content).unwrap();
    assert_eq!(ops.iter().filter(|o| o.operator == "BI").count(), 2);
}

#[test]
fn encode_round_trips_decoded_content() {
    let content: &[u8] = b"/P <</MCID 0>> BDC BT /F1 10 Tf (a\\(b\\)c\\\\) Tj <00FF> Tj [(x) 1.5 (y) -0.25] TJ ET EMC \
        BI /W 3 /H 1 /CS /G /BPC 8 ID E I EI 1 0 0 1 0.5 -2 cm 0 0 m 1 2 l S";
    let ops = decode_ops(content).unwrap();
    let again = decode_ops(&encode_ops(&ops)).unwrap();
    assert_eq!(format!("{ops:?}"), format!("{again:?}"));
}

#[test]
fn no_rects_change_nothing() {
    let content = b"BT /F1 10 Tf (AB) ' ET 0 0 m 5 5 l S /Everywhere sh";
    let out = redact(content, &[]);
    assert_eq!(out.report, Report::default());
    assert_eq!(format!("{:?}", decode_ops(content).unwrap()), format!("{:?}", decode_ops(&out.content).unwrap()));
}

/// Deterministic pseudo-random numbers in [0, 1).
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (self.0 >> 11) as f64 / (1u64 << 53) as f64
    }
}

#[test]
fn kept_glyphs_never_move_under_random_rects() {
    let contents: [&[u8]; 8] = [
        b"BT /H 11 Tf 72 700 Td (The quick brown fox jumps over the lazy dog) Tj ET",
        b"BT /H 9 Tf 1.5 Tc 4 Tw 80 Tz 3 Ts 50 600 Td [(Kerned) -120 (text with) 333.3 (spaces)] TJ ET",
        b"BT /F1 12 Tf 14 TL 20 500 Td (AB C) ' 2 0.5 (C BA) \" (BBB) ' ET",
        b"0 1 -1 0 300 0 cm BT /H 10 Tf 100 100 Td (Rotated line of text) Tj ET",
        b"BT /H 1 Tf 12 0 3 12 40 300 Tm (Sheared with a unit font size) Tj ET",
        b"BT /F2 10 Tf 2 Tc 30 30 Td <0001000200010002000100020001> Tj ET",
        b"2 0 0 2 10 10 cm BT /H 7 Tf 3 Tr 120 Tz (Invisible scaled) Tj ET",
        b"BT /H 10 Tf -1 Tc 10 10 Td [(Neg) -1000 (ative) 2000 (spacing)] TJ ET",
    ];
    let (doc, resources) = fixture();
    let mut rng = Lcg(42);
    let (mut removed, mut kept) = (0, 0);
    for content in contents {
        let glyphs = glyphs_of(&interpret(&doc, &resources, content));
        for _ in 0..40 {
            let rects: Vec<Rect> = (0..1 + (rng.next() * 3.0) as usize)
                .map(|_| {
                    let g = &glyphs[(rng.next() * glyphs.len() as f64) as usize];
                    let b = g.box_user.bbox();
                    let (w, h) = (b.x1 - b.x0, b.y1 - b.y0);
                    let x0 = b.x0 + w * (rng.next() * 1.2 - 0.6);
                    let y0 = b.y0 + h * (rng.next() * 1.2 - 0.2);
                    rect(x0, y0, x0 + w * rng.next() * 4.0 + 0.1, y0 + h * rng.next() * 0.6 + 0.1)
                })
                .collect();
            let out = redact(content, &rects);
            assert_kept_in_place(&out, &rects);
            removed += out.report.glyphs_removed;
            kept += out.after.len();
        }
    }
    assert!(removed > 1000 && kept > 1000, "removed {removed}, kept {kept}");
}

#[test]
fn zero_size_text_under_a_rect_is_removed() {
    for (content, area) in [
        (&b"BT /F1 0 Tf 10 10 Td (SECRET) Tj ET"[..], rect(5.0, 5.0, 15.0, 15.0)),
        (b"BT /F1 10 Tf 0 Tz 10 10 Td (SECRET) Tj ET", rect(5.0, 5.0, 15.0, 15.0)),
        (b"0 0 0 0 0 0 cm BT /F1 10 Tf 10 10 Td (SECRET) Tj ET", rect(-5.0, -5.0, 5.0, 5.0)),
        (b"1 0 0 0 0 0 cm BT /F1 10 Tf 10 10 Td (SECRET) Tj ET", rect(5.0, -5.0, 40.0, 5.0)),
    ] {
        let out = redact(content, &[area]);
        assert_eq!(out.report.glyphs_removed, 6, "{}", String::from_utf8_lossy(content));
        assert!(out.after.is_empty(), "{}", String::from_utf8_lossy(&out.content));
        assert!(!String::from_utf8_lossy(&out.content).contains("SECRET"));
    }
}

#[test]
fn negative_size_and_scaling_keep_kept_glyphs_in_place() {
    // A covers x -6..1 (size -10) or -3..0.5 (Tz -50); B lies further left.
    for (content, area) in [
        (&b"BT /F1 -10 Tf (ABC) Tj ET"[..], rect(-3.0, -5.0, 0.0, 0.0)),
        (b"BT /F1 10 Tf -50 Tz (ABC) Tj ET", rect(-1.0, 0.0, 0.0, 5.0)),
    ] {
        let rects = [area];
        let out = redact(content, &rects);
        assert_eq!(text(&out.after), "BC", "{}", String::from_utf8_lossy(&out.content));
        assert_kept_in_place(&out, &rects);
    }
}

#[test]
fn zero_size_show_operations_are_dropped_whole() {
    // Tfs 0 with Tc 2: A collapses to (10, 10), B to (12, 10). Only A is
    // under the rect, but no number can replace it: the whole show goes.
    let rects = [rect(9.0, 9.0, 11.0, 11.0)];
    let out = redact(b"BT /F1 0 Tf 2 Tc 10 10 Td (AB) Tj ET", &rects);
    assert!(out.after.is_empty());
    assert_eq!(out.report.glyphs_removed, 2);
    // A quote keeps its line move.
    let out = redact(b"BT /F1 0 Tf 12 TL 10 22 Td (AB) ' /F1 10 Tf 20 0 Td (C) Tj ET", &rects);
    assert_eq!(text(&out.after), "C");
    assert!((out.after[0].box_user.0[0].1 - 8.0).abs() < TOLERANCE, "C stays on the line at y 10");
    assert_eq!(out.report.glyphs_removed, 2);
}

/// Helvetica 10 at (100, 700): "AB " ends at 116.12, SECRET spans
/// 116.12..156.68 (boxes 1 unit wider); this rect covers exactly SECRET.
const SECRET: Rect = Rect { x0: 117.5, y0: 700.0, x1: 155.5, y1: 705.0 };

#[test]
fn a_removed_run_becomes_one_number() {
    let out = redact(b"BT /H 10 Tf 100 700 Td (AB SECRET CD) Tj ET", &[SECRET]);
    assert_eq!(text(&out.after), "AB  CD");
    let arrays = tj_arrays(&out.content);
    assert_eq!(arrays.len(), 1);
    assert_eq!(arrays[0].iter().filter(|o| is_number(o)).count(), 1, "{:?}", arrays[0]);
    assert_kept_in_place(&out, &[SECRET]);
}

#[test]
fn trailing_removals_leave_no_number_unless_later_text_depends_on_it() {
    let numbers = |content: &[u8]| -> Vec<usize> {
        let out = redact(content, &[SECRET]);
        assert_kept_in_place(&out, &[SECRET]);
        tj_arrays(&out.content).iter().map(|a| a.iter().filter(|o| is_number(o)).count()).collect()
    };
    assert_eq!(numbers(b"BT /H 10 Tf 100 700 Td (AB SECRET) Tj ET"), vec![0]);
    assert_eq!(numbers(b"BT /H 10 Tf 100 700 Td (AB SECRET) Tj 0 -20 Td (X) Tj ET"), vec![0]);
    assert_eq!(numbers(b"BT /H 10 Tf 100 700 Td (AB SECRET) Tj 12 TL (X) ' ET"), vec![0]);
    // The distance moves to the next kept show, as its leading number.
    assert_eq!(numbers(b"BT /H 10 Tf 100 700 Td (AB SECRET) Tj /H 9 Tf (X) Tj ET"), vec![0, 1]);
    // A show removed entirely: one number when later text depends on it,
    // nothing otherwise.
    assert_eq!(numbers(b"BT /H 10 Tf 100 700 Td (AB ) Tj (SECRET) Tj (X) Tj ET"), vec![1]);
    assert_eq!(numbers(b"BT /H 10 Tf 100 700 Td (AB ) Tj (SECRET) Tj ET"), Vec::<usize>::new());
    // Original numbers next to a removed run merge into it.
    assert_eq!(numbers(b"BT /H 10 Tf 100 700 Td [(AB ) -10 (SECRET) 20 ( CD)] TJ ET"), vec![1]);
}

fn bdc_properties(content: &[u8]) -> Vec<Object> {
    decode_ops(content)
        .unwrap()
        .into_iter()
        .filter(|op| op.operator == "BDC")
        .map(|op| op.operands[1].clone())
        .collect()
}

#[test]
fn marked_content_around_removed_text_loses_its_replacement_text() {
    let rects = [rect(127.0, 700.0, 170.0, 705.0)];
    let content = b"/Span <</ActualText (Hello World) /Lang (en)>> BDC /P <</Alt (World) /MCID 3>> BDC \
        /Span <</E (W.)>> BDC BT /H 10 Tf 100 700 Td (Hello World) Tj ET EMC EMC EMC \
        /Span <</ActualText (Kept)>> BDC BT /H 10 Tf 100 600 Td (Kept) Tj ET EMC";
    let out = redact(content, &rects);
    let props = bdc_properties(&out.content);
    let dicts: Vec<&lopdf::Dictionary> = props.iter().map(|p| p.as_dict().unwrap()).collect();
    assert_eq!(dicts.len(), 4);
    assert!(!dicts[0].has(b"ActualText") && dicts[0].has(b"Lang"));
    assert!(!dicts[1].has(b"Alt") && dicts[1].has(b"MCID"));
    assert!(!dicts[2].has(b"E"));
    assert!(dicts[3].has(b"ActualText"), "a sequence without removals keeps its text");
    assert!(out.report.named_properties.is_empty());
}

#[test]
fn marked_content_around_removed_graphics_loses_its_alt_text() {
    let rects = [rect(40.0, 40.0, 55.0, 55.0)];
    let out = redact(b"/Figure <</Alt (A chart of secrets)>> BDC 42 42 5 5 re f EMC", &rects);
    assert!(!bdc_properties(&out.content)[0].as_dict().unwrap().has(b"Alt"));
}

#[test]
fn named_properties_around_removals_are_reported() {
    let rects = [rect(127.0, 700.0, 170.0, 705.0)];
    let out = redact(b"/Span /MC0 BDC /Span /MC1 BDC BT /H 10 Tf 100 700 Td (Hello World) Tj ET EMC EMC /Span /MC2 BDC EMC", &rects);
    let names: Vec<&[u8]> = out.report.named_properties.iter().map(|n| n.as_slice()).collect();
    assert_eq!(names, vec![&b"MC0"[..], b"MC1"]);
}

#[test]
fn dropping_a_zero_size_show_that_later_text_depends_on_is_unsupported() {
    let rects = [rect(9.0, 9.0, 11.0, 11.0)];
    // Tc 2 gives the dropped show an advance the following Tj relies on.
    let err = try_redact(b"BT /F1 0 Tf 2 Tc 10 10 Td (AB) Tj /F1 10 Tf (C) Tj ET", &rects).unwrap_err();
    assert!(err.0.contains("zero-size"), "{err:?}");
    // Nothing depends on it, or it does not advance: dropped.
    assert!(try_redact(b"BT /F1 0 Tf 2 Tc 10 10 Td (AB) Tj 0 30 Td /F1 10 Tf (C) Tj ET", &rects).is_ok());
    assert!(try_redact(b"BT /F1 0 Tf 10 10 Td (AB) Tj /F1 10 Tf 20 0 Td (C) Tj ET", &rects).is_ok());
    assert!(try_redact(b"BT /F1 0 Tf 10 10 Td (AB) Tj /F1 10 Tf (C) Tj ET", &rects).is_ok());
}

#[test]
fn et_is_not_a_position_barrier() {
    let ops = decode_ops(b"BT (A) Tj ET (B) Tj BT (C) Tj ET").unwrap();
    assert!(super::text::later_text_depends(&ops, 1), "ET does not reset the text position");
    assert!(!super::text::later_text_depends(&ops, 3), "BT does");
}

fn number_count(content: &[u8]) -> usize {
    tj_arrays(content).iter().map(|a| a.iter().filter(|o| is_number(o)).count()).sum()
}

#[test]
fn consecutive_removed_shows_leave_at_most_one_number() {
    // One glyph per show: per-op numbers would spell out each width.
    let content = b"BT /H 10 Tf 100 700 Td (AB ) Tj (S) Tj (E) Tj (C) Tj (R) Tj (E) Tj (T) Tj ( CD) Tj ET";
    let out = redact(content, &[SECRET]);
    assert_eq!(text(&out.after), "AB  CD");
    assert_eq!(number_count(&out.content), 1, "{}", String::from_utf8_lossy(&out.content));
    assert_kept_in_place(&out, &[SECRET]);
    // Colour, font and spacing operators in between do not split the run.
    let content = b"BT /H 10 Tf 100 700 Td (AB ) Tj (SE) Tj 0 g (CR) Tj /H 10 Tf 0 Tc (ET) Tj ( CD) Tj ET";
    let out = redact(content, &[SECRET]);
    assert_eq!(number_count(&out.content), 1, "{}", String::from_utf8_lossy(&out.content));
    assert_kept_in_place(&out, &[SECRET]);
    // Nothing after the run depends on it: no number at all.
    let content = b"BT /H 10 Tf 100 700 Td (AB ) Tj (SE) Tj 0 g (CRET) Tj 0 -20 Td (X) Tj ET";
    let out = redact(content, &[SECRET]);
    assert_eq!(number_count(&out.content), 0, "{}", String::from_utf8_lossy(&out.content));
    assert_kept_in_place(&out, &[SECRET]);
}

#[test]
fn the_carried_distance_is_converted_with_the_next_shows_size() {
    // The kept show after the run uses another size and scaling.
    let content = b"BT /H 10 Tf 100 700 Td (AB ) Tj (SECRET) Tj /H 20 Tf 50 Tz ( CD) Tj ET";
    let out = redact(content, &[SECRET]);
    assert_eq!(number_count(&out.content), 1);
    assert_kept_in_place(&out, &[SECRET]);
    // A size of 0 there cannot carry it.
    let err = try_redact(b"BT /H 10 Tf 100 700 Td (AB ) Tj (SECRET) Tj /H 0 Tf ( CD) Tj ET", &[SECRET]).unwrap_err();
    assert!(err.0.contains("size"), "{err:?}");
}

#[test]
fn unpainted_paths_under_a_rect_are_dropped() {
    let rects = [rect(40.0, 40.0, 55.0, 55.0)];
    let out = redact(b"42 42 5 5 re n 0 0 m 50 50 l n 0 0 10 10 re n", &rects);
    assert_eq!(out.report.paths_removed, 2);
    let kept = paths(&out.after_events);
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].bbox_user, Some(rect(0.0, 0.0, 10.0, 10.0)));
}

#[test]
fn removing_clipping_text_is_unsupported() {
    let rects = [rect(6.0, 0.0, 10.0, 5.0)];
    for mode in 4..=7 {
        let content = format!("BT /F1 10 Tf {mode} Tr (AB) Tj ET");
        let err = try_redact(content.as_bytes(), &rects).unwrap_err();
        assert!(err.0.contains("clip"), "Tr {mode}: {err:?}");
    }
    // Clipping text away from the rects stays.
    assert!(try_redact(b"BT /F1 10 Tf 7 Tr 100 100 Td (AB) Tj ET", &rects).is_ok());
}
