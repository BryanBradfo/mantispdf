//! `redact_content` end to end on decoded content: interpret, redact,
//! encode, decode again and interpret the result.

use super::interp::{Event, Glyph, IDENTITY, Interp, decode_ops, encode_ops};
use super::*;
use lopdf::{Dictionary, Document, Object, Stream, dictionary};

const TOLERANCE: f64 = 1e-6;

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

fn redact(content: &[u8], rects: &[Rect]) -> Out {
    let (doc, resources) = fixture();
    let ops = decode_ops(content).unwrap();
    let events = Interp::new(&doc, resources.clone()).run(&ops, IDENTITY, &mut Budget::page(1 << 20)).unwrap();
    let (new_ops, report) = redact_content(&ops, &events, rects).unwrap();
    let content = encode_ops(&new_ops);
    let after_events = interpret(&doc, &resources, &content);
    Out { content, report, before: glyphs_of(&events), after: glyphs_of(&after_events), after_events }
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
            assert!(
                (a.0 - b.0).abs() < TOLERANCE && (a.1 - b.1).abs() < TOLERANCE,
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
    // A 0..5, space +7.5, B 12.5..18.5, space +7.5, C at 26 (box from 25).
    let rects = [rect(14.0, 0.0, 17.0, 5.0)];
    let out = redact(b"BT /F1 10 Tf 5 Tw 0 0 Td (A B C) Tj ET", &rects);
    assert_eq!(text(&out.after), "A  C");
    assert_eq!((out.after[1].word_spacing, out.after[2].word_spacing), (5.0, 5.0));
    assert!((out.after[3].box_user.0[0].0 - 25.0).abs() < TOLERANCE);
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
    assert!((out.after[1].box_user.0[0].0 - 10.0).abs() < TOLERANCE);
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
fn covered_inline_images_are_removed_others_written_back_unchanged() {
    let rects = [rect(40.0, 40.0, 55.0, 55.0)];
    let content: &[u8] = b"q 10 0 0 10 42 42 cm BI /W 1 /H 1 /CS /G /BPC 8 ID \x00 EI Q \
        q 10 0 0 10 0 0 cm BI /W 2 /H 1 /CS /G /BPC 8 /F /AHx ID 00FF> EI Q";
    let out = redact(content, &rects);
    assert_eq!(out.report.inline_images_removed, 1);
    let ops = decode_ops(&out.content).unwrap();
    let images: Vec<&Stream> = ops
        .iter()
        .filter_map(|o| match (o.operator.as_str(), o.operands.as_slice()) {
            ("BI", [Object::Stream(s), ..]) => Some(s),
            _ => None,
        })
        .collect();
    assert_eq!(images.len(), 1);
    assert_eq!(images[0].content, b"00FF>");
    assert_eq!(images[0].dict.get(b"W").unwrap(), &Object::Integer(2));
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
