//! Interpreter tests: glyph, path, image, shading and form placement.

use super::*;
use crate::redact::MAX_PAGE_EVENTS;
use lopdf::{Stream, dictionary};

const EPS: f64 = 1e-9;

/// F1: TrueType with /Widths 32..=90 (space 250, A 500, B 600, C 700,
/// others 400), no descriptor.
fn simple_font() -> Dictionary {
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
    dictionary! {
        "Type" => "Font", "Subtype" => "TrueType", "BaseFont" => "Embedded",
        "FirstChar" => 32, "LastChar" => 90, "Widths" => widths,
    }
}

fn type0(doc: &mut Document, encoding: Object) -> Dictionary {
    let descriptor = doc.add_object(dictionary! {
        "Type" => "FontDescriptor", "FontName" => "CID", "Ascent" => 800, "Descent" => -200,
    });
    let w: Vec<Object> = vec![
        1.into(),
        Object::Array(vec![500.into(), 600.into()]),
        10.into(),
        20.into(),
        700.into(),
    ];
    let cid = doc.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "CIDFontType2", "BaseFont" => "CID",
        "W" => w, "DW" => 1000, "FontDescriptor" => descriptor,
    });
    dictionary! {
        "Type" => "Font", "Subtype" => "Type0", "BaseFont" => "CID",
        "Encoding" => encoding, "DescendantFonts" => vec![cid.into()],
    }
}

fn std_font(base: &str, encoding: Option<&str>) -> Dictionary {
    let mut d = dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => base };
    if let Some(e) = encoding {
        d.set("Encoding", Object::Name(e.as_bytes().to_vec()));
    }
    d
}

fn type3() -> Dictionary {
    let reals = |v: &[f64]| Object::Array(v.iter().map(|n| Object::Real(*n as f32)).collect());
    dictionary! {
        "Type" => "Font", "Subtype" => "Type3",
        "FontMatrix" => reals(&[0.5, 0.0, 0.0, 0.5, 0.0, 0.0]),
        "FontBBox" => reals(&[0.0, -1.0, 2.0, 3.0]),
        "FirstChar" => 65, "LastChar" => 66, "Widths" => vec![1.into(), 2.into()],
        "CharProcs" => dictionary! {},
        "Encoding" => dictionary! { "Type" => "Encoding", "Differences" => vec![65.into(), "a".into(), "b".into()] },
    }
}

fn fixture() -> (Document, Dictionary) {
    let mut doc = Document::with_version("1.7");
    let f1 = doc.add_object(simple_font());
    let f2 = type0(&mut doc, "Identity-H".into());
    let f3 = type0(&mut doc, "Identity-V".into());
    let f4 = type0(&mut doc, "UniGB-UCS2-H".into());
    let cmap = doc.add_object(Stream::new(dictionary! { "Type" => "CMap" }, b"begincmap endcmap".to_vec()));
    let f5 = type0(&mut doc, cmap.into());
    let im = doc.add_object(Stream::new(
        dictionary! { "Type" => "XObject", "Subtype" => "Image", "Width" => 1, "Height" => 1 },
        vec![0],
    ));
    let fm = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Form", "BBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
            "Matrix" => vec![1.into(), 0.into(), 0.into(), 1.into(), 5.into(), 5.into()],
        },
        b"0 0 m".to_vec(),
    ));
    let resources = dictionary! {
        "Font" => dictionary! {
            "F1" => f1, "F2" => f2, "F3" => f3, "F4" => f4, "F5" => f5,
            "H" => std_font("Helvetica", Some("WinAnsiEncoding")),
            "HS" => std_font("Helvetica", None),
            "HO" => std_font("Helvetica-Oblique", Some("WinAnsiEncoding")),
            "Sym" => std_font("Symbol", None),
            "T3" => type3(),
        },
        "XObject" => dictionary! { "Im1" => im, "Fm1" => fm },
        "Shading" => dictionary! {
            "Sh1" => dictionary! { "ShadingType" => 2, "BBox" => vec![0.into(), 0.into(), 10.into(), 10.into()] },
            "Sh2" => dictionary! { "ShadingType" => 2 },
        },
        "ExtGState" => dictionary! { "G1" => dictionary! { "LW" => 4 } },
    };
    (doc, resources)
}

fn events_with(content: &str, budget: &mut Budget) -> Result<Vec<Event>, Unsupported> {
    let (doc, resources) = fixture();
    let ops = decode_ops(content.as_bytes())?;
    Interp::new(&doc, resources).run(&ops, IDENTITY, budget)
}

fn events(content: &str) -> Result<Vec<Event>, Unsupported> {
    events_with(content, &mut Budget::page(1 << 20))
}

fn glyphs(content: &str) -> Vec<Glyph> {
    events(content)
        .unwrap()
        .into_iter()
        .filter_map(|e| match e {
            Event::Glyph(g) => Some(g),
            _ => None,
        })
        .collect()
}

fn assert_quad(q: &Quad, expected: [(f64, f64); 4]) {
    for (got, want) in q.0.iter().zip(expected) {
        assert!(
            (got.0 - want.0).abs() < EPS && (got.1 - want.1).abs() < EPS,
            "{q:?} != {expected:?}"
        );
    }
}

/// Box of a glyph advancing over x0..x1 on the baseline y at size 10:
/// the 0.9/-0.2 em fallback over the advance.
fn upright(x0: f64, x1: f64, y: f64) -> [(f64, f64); 4] {
    upright_pad(x0, x1, y, 0.0)
}

fn upright_pad(x0: f64, x1: f64, y: f64, pad: f64) -> [(f64, f64); 4] {
    [(x0 - pad, y - 2.0), (x1 + pad, y - 2.0), (x1 + pad, y + 9.0), (x0 - pad, y + 9.0)]
}

fn unsupported(content: &str) -> String {
    match events(content) {
        Err(Unsupported(reason)) => reason,
        Ok(ev) => panic!("{content}: expected Unsupported, got {ev:?}"),
    }
}

#[test]
fn td_and_tj_advance_with_char_word_spacing_and_scaling() {
    let g = glyphs("BT /F1 10 Tf 2 Tc 3 Tw 50 Tz 100 200 Td (A B) Tj ET");
    assert_eq!(g.len(), 3);
    assert_eq!(g.iter().map(|g| g.code).collect::<Vec<_>>(), vec![65, 32, 66]);
    assert_eq!(g.iter().map(|g| g.byte_range.clone()).collect::<Vec<_>>(), vec![0..1, 1..2, 2..3]);
    assert!(g.iter().all(|g| g.op_index == 6 && g.elem_index == 0 && g.render_mode == 0));
    // Th = 0.5: A advances (5 + 2) * 0.5 = 3.5; space (2.5 + 2 + 3) * 0.5 = 3.75.
    assert_quad(&g[0].box_user, upright(100.0, 102.5, 200.0));
    assert_quad(&g[1].box_user, upright(103.5, 104.75, 200.0));
    assert_quad(&g[2].box_user, upright(107.25, 110.25, 200.0));
    // The ink box adds 0.05 em each side (halved by Th 0.5).
    assert_quad(&g[0].ink_user, upright_pad(100.0, 102.5, 200.0, 0.25));
    assert_eq!((g[0].width, g[0].font_size, g[0].h_scale, g[0].char_spacing), (0.5, 10.0, 0.5, 2.0));
    assert_eq!((g[0].word_spacing, g[1].word_spacing, g[2].word_spacing), (0.0, 3.0, 0.0));
    assert_eq!((g[0].advance(), g[1].advance()), (3.5, 3.75));
}

#[test]
fn tj_numbers_move_the_text_position() {
    let g = glyphs("BT /F1 10 Tf [(A) -500 (B) 250 (C)] TJ ET");
    assert_eq!(g.iter().map(|g| g.elem_index).collect::<Vec<_>>(), vec![0, 2, 4]);
    assert!(g.iter().all(|g| g.op_index == 2));
    assert_quad(&g[0].box_user, upright(0.0, 5.0, 0.0));
    assert_quad(&g[1].box_user, upright(10.0, 16.0, 0.0));
    assert_quad(&g[2].box_user, upright(13.5, 20.5, 0.0));
}

#[test]
fn quote_operators_move_to_the_next_line_and_set_spacing() {
    let g = glyphs("BT /F1 10 Tf 12 TL 0 100 Td (A) ' (B) Tj 5 1 (C ) \" (A) Tj ET");
    assert_eq!(g.iter().map(|g| g.op_index).collect::<Vec<_>>(), vec![4, 5, 6, 6, 7]);
    assert_quad(&g[0].box_user, upright(0.0, 5.0, 88.0));
    assert_quad(&g[1].box_user, upright(5.0, 11.0, 88.0));
    // `"` sets Tw 5 and Tc 1 before showing.
    assert_quad(&g[2].box_user, upright(0.0, 7.0, 76.0));
    assert_eq!((g[2].char_spacing, g[3].word_spacing), (1.0, 5.0));
    assert_quad(&g[3].box_user, upright(8.0, 10.5, 76.0));
    assert_quad(&g[4].box_user, upright(16.5, 21.5, 76.0));
    assert_eq!(g[2].elem_index, 0);
}

#[test]
fn td_capital_sets_leading_and_t_star_uses_it() {
    let g = glyphs("BT /F1 10 Tf 10 50 TD (A) Tj T* (B) Tj ET");
    assert_quad(&g[0].box_user, upright(10.0, 15.0, 50.0));
    // TL = -50: T* moves by +50.
    assert_quad(&g[1].box_user, upright(10.0, 16.0, 100.0));
}

#[test]
fn ctm_scaling_and_rotation_with_save_restore() {
    let g = glyphs("q 3 0 0 3 0 0 cm Q 2 0 0 2 0 0 cm 0 1 -1 0 100 0 cm BT /F1 10 Tf (A) Tj ET");
    assert_quad(&g[0].box_user, [(204.0, 0.0), (204.0, 10.0), (182.0, 10.0), (182.0, 0.0)]);
}

#[test]
fn tm_with_shear_and_td_relative_to_line_matrix() {
    let g = glyphs("BT /F1 10 Tf 1 0 0.5 1 10 20 Tm (A) Tj 0 -10 Td (B) Tj ET");
    assert_quad(&g[0].box_user, [(9.0, 18.0), (14.0, 18.0), (19.5, 29.0), (14.5, 29.0)]);
    assert_quad(&g[1].box_user, [(4.0, 8.0), (10.0, 8.0), (15.5, 19.0), (9.5, 19.0)]);
}

#[test]
fn negative_font_size_flips_the_box_and_the_advance() {
    let g = glyphs("BT /F1 -10 Tf (AB) Tj ET");
    assert_quad(&g[0].box_user, [(0.0, 2.0), (-5.0, 2.0), (-5.0, -9.0), (0.0, -9.0)]);
    assert_quad(&g[1].box_user, [(-5.0, 2.0), (-11.0, 2.0), (-11.0, -9.0), (-5.0, -9.0)]);
    assert_eq!(g[0].advance(), -5.0);
}

#[test]
fn negative_horizontal_scaling_mirrors_the_box_and_the_advance() {
    let g = glyphs("BT /F1 10 Tf -50 Tz (AB) Tj ET");
    assert_quad(&g[0].box_user, [(0.0, -2.0), (-2.5, -2.0), (-2.5, 9.0), (0.0, 9.0)]);
    assert_quad(&g[1].box_user, [(-2.5, -2.0), (-5.5, -2.0), (-5.5, 9.0), (-2.5, 9.0)]);
    assert_eq!(g[0].advance(), -2.5);
}

#[test]
fn rise_shifts_the_glyph_box() {
    let g = glyphs("BT /F1 10 Tf 3 Ts 1 0 0.5 1 10 20 Tm (A) Tj ET");
    assert_quad(&g[0].box_user, [(10.5, 21.0), (15.5, 21.0), (21.0, 32.0), (16.0, 32.0)]);
}

#[test]
fn text_state_is_saved_and_restored() {
    let g = glyphs("BT /F1 10 Tf q 3 Tr 5 Tc /F1 20 Tf Q (AB) Tj ET");
    assert_eq!(g[0].render_mode, 0);
    assert_quad(&g[1].box_user, upright(5.0, 11.0, 0.0));
}

#[test]
fn invisible_text_is_reported_with_its_mode() {
    let g = glyphs("BT /F1 10 Tf 3 Tr (A) Tj ET");
    assert_eq!(g[0].render_mode, 3);
    assert_quad(&g[0].box_user, upright(0.0, 5.0, 0.0));
}

#[test]
fn identity_h_two_byte_codes_with_w_ranges() {
    let g = glyphs("BT /F2 10 Tf 3 Tw <00010002000F00300020> Tj ET");
    assert_eq!(g.iter().map(|g| g.code).collect::<Vec<_>>(), vec![1, 2, 15, 48, 32]);
    assert_eq!(g.iter().map(|g| g.byte_range.clone()).collect::<Vec<_>>(), vec![0..2, 2..4, 4..6, 6..8, 8..10]);
    assert_eq!(g.iter().map(|g| g.width).collect::<Vec<_>>(), vec![0.5, 0.6, 0.7, 1.0, 1.0]);
    // Descriptor ascent 0.8 / descent -0.2; Tw never applies to 2-byte codes.
    let xs = [0.0, 5.0, 11.0, 18.0, 28.0];
    for (glyph, x) in g.iter().zip(xs) {
        let x1 = x + glyph.width * 10.0;
        assert_quad(&glyph.box_user, [(x, -2.0), (x1, -2.0), (x1, 8.0), (x, 8.0)]);
        assert_eq!(glyph.word_spacing, 0.0);
    }
}

#[test]
fn identity_h_odd_byte_count_is_unsupported() {
    unsupported("BT /F2 10 Tf <000100> Tj ET");
}

#[test]
fn standard_helvetica_without_widths_uses_afm() {
    let g = glyphs("BT /H 10 Tf (Hi') Tj ET");
    // WinAnsi: H 722, i 222, quotesingle 191.
    let widths: Vec<f64> = g.iter().map(|g| g.width).collect();
    assert!((widths[0] - 0.722).abs() < EPS && (widths[1] - 0.222).abs() < EPS && (widths[2] - 0.191).abs() < EPS);
    // No descriptor: the AFM ascent 718 and descent -207.
    assert_quad(&g[1].box_user, [(7.22, -2.07), (9.44, -2.07), (9.44, 7.18), (7.22, 7.18)]);
    assert_quad(&g[2].box_user, [(9.44, -2.07), (11.35, -2.07), (11.35, 7.18), (9.44, 7.18)]);
    // Oblique shares the upright widths.
    assert!((glyphs("BT /HO 10 Tf (H) Tj ET")[0].width - 0.722).abs() < EPS);
}

#[test]
fn standard_encoding_maps_quotes_and_rejects_unknown_codes() {
    // StandardEncoding 0x27 is quoteright (222), 0x60 quoteleft (222).
    let g = glyphs("BT /HS 10 Tf (`') Tj ET");
    assert!((g[0].width - 0.222).abs() < EPS && (g[1].width - 0.222).abs() < EPS);
    unsupported("BT /HS 10 Tf (\\351) Tj ET");
}

#[test]
fn standard_font_without_metrics_is_unsupported() {
    unsupported("BT /Sym 10 Tf (a) Tj ET");
}

#[test]
fn type3_fonts_are_unsupported() {
    // Glyph procedures can paint anywhere; such pages are rasterized.
    assert!(unsupported("BT /T3 10 Tf (AB) Tj ET").contains("Type3"));
}

#[test]
fn vertical_and_other_cmaps_are_unsupported() {
    assert!(unsupported("BT /F3 10 Tf <0001> Tj ET").contains("vertical"), "Identity-V");
    assert!(unsupported("BT /F4 10 Tf <0001> Tj ET").contains("CMap"), "named CMap");
    assert!(unsupported("BT /F5 10 Tf <0001> Tj ET").contains("CMap"), "embedded CMap");
}

#[test]
fn op_budget_exceeded_is_unsupported() {
    let mut budget = Budget::page(1 << 20);
    budget.ops = 3;
    assert!(events_with("q Q q Q", &mut budget).is_err());
    let mut budget = Budget::page(1 << 20);
    budget.ops = 4;
    assert!(events_with("q Q q Q", &mut budget).is_ok());
    assert_eq!(budget.ops, 0);
}

#[test]
fn event_budget_exceeded_is_unsupported() {
    let mut budget = Budget::page(1 << 20);
    budget.events = 1;
    assert!(events_with("BT /F1 10 Tf (AB) Tj ET", &mut budget).is_err());
    assert_eq!(Budget::page(0).events, MAX_PAGE_EVENTS);
}

#[test]
fn decode_budget_exceeded_is_unsupported() {
    let mut doc = Document::with_version("1.7");
    let a = doc.add_object(Stream::new(dictionary! {}, b"q".to_vec()));
    let b = doc.add_object(Stream::new(dictionary! {}, b"Q".to_vec()));
    let items = vec![Object::Reference(a), Object::Reference(b)];
    let mut budget = Budget::page(10);
    let ops = content_ops(&doc, &items, &mut budget).unwrap();
    assert_eq!(ops.iter().map(|o| o.operator.as_str()).collect::<Vec<_>>(), vec!["q", "Q"]);
    assert_eq!(budget.decoded, 8);
    let mut budget = Budget::page(1);
    assert!(content_ops(&doc, &items, &mut budget).is_err());
}

#[test]
fn malformed_operands_are_unsupported_never_a_panic() {
    for content in [
        "BT /F1 Tf ET",
        "1 2 cm",
        "BT /F1 10 Tf [(A) /X] TJ ET",
        "BT (A) Tj ET",
        "BT /F1 10 Tf 5 Tj ET",
        "BT /F1 10 Tf ' ET",
        "BT /F1 10 Tf 1 (A) \" ET",
        "BT /Nope 10 Tf ET",
        "BT /F1 10 Tf 1 2 3 Td ET",
        "BT 1 2 3 4 5 Tm ET",
        "BT /F1 10 Tf (A) 3 Tz ET 2 TL x 1 Tc",
        "/F1 Tz",
        "0 0 m 1 1 l q S",
        "1 2 3 re f",
        "0 0 m 1 c S",
        "BT /XX 10 Tf ET",
        "/Fm1 /Fm1 Do",
        "/G1 gs (A) w",
    ] {
        let result = std::panic::catch_unwind(|| events(content));
        match result {
            Ok(Err(_)) => {}
            Ok(Ok(ev)) => panic!("{content}: expected Unsupported, got {ev:?}"),
            Err(_) => panic!("{content}: panicked"),
        }
    }
}

#[test]
fn missing_xobjects_are_unsupported() {
    assert!(unsupported("/Missing Do").contains("Missing"));
}

#[test]
fn page_resources_are_inherited_and_resolved() {
    let mut doc = Document::with_version("1.7");
    let fonts = doc.add_object(dictionary! { "F1" => simple_font() });
    let inherited = doc.add_object(dictionary! { "Font" => fonts });
    let pages_id = doc.new_object_id();
    let plain = doc.add_object(dictionary! { "Type" => "Page", "Parent" => pages_id });
    let own = doc.add_object(dictionary! {
        "Type" => "Page", "Parent" => pages_id, "Resources" => dictionary! { "XObject" => dictionary! {} },
    });
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages", "Kids" => vec![plain.into(), own.into()], "Count" => 2, "Resources" => inherited,
        }),
    );
    let resources = page_resources(&doc, plain);
    assert_eq!(resources.get(b"Font").unwrap(), &Object::Reference(fonts));
    let ops = decode_ops(b"BT /F1 10 Tf (A) Tj ET").unwrap();
    assert_eq!(Interp::new(&doc, resources).run(&ops, IDENTITY, &mut Budget::page(1 << 20)).unwrap().len(), 1);
    assert!(page_resources(&doc, own).has(b"XObject"));
    assert!(!page_resources(&doc, own).has(b"Font"));
    assert!(page_resources(&doc, (999, 0)).is_empty());
}

#[test]
fn marked_content_sequences_enclose_what_they_mark() {
    let ev = events("/Span <</MCID 0>> BDC BT /F1 10 Tf (A) Tj ET /Inner /P0 BDC 0 0 m 1 1 l S EMC EMC /X BMC /Sh2 sh EMC /Sh2 sh EMC")
        .unwrap();
    let marks: Vec<(usize, Option<usize>)> = ev
        .iter()
        .filter_map(|e| match e {
            Event::Marked(m) => Some((m.op_index, m.parent)),
            _ => None,
        })
        .collect();
    assert_eq!(marks, vec![(0, None), (5, Some(0)), (11, None)]);
    let marked: Vec<Option<usize>> = ev
        .iter()
        .filter_map(|e| match e {
            Event::Glyph(g) => Some(g.marked),
            Event::Path(p) => Some(p.marked),
            Event::Shading(s) => Some(s.marked),
            _ => None,
        })
        .collect();
    assert_eq!(marked, vec![Some(0), Some(5), Some(11), None]);
    assert!(events("/Span 1 BDC").is_err());
    assert!(events("BMC").is_err());
}

#[test]
fn text_shown_outside_bt_is_unsupported() {
    for content in ["BT /F1 10 Tf (AB) Tj ET (C) Tj", "BT /F1 10 Tf ET [(C)] TJ", "BT /F1 10 Tf ET 12 TL (C) '", "BT /F1 10 Tf ET 1 2 (C) \""] {
        assert!(unsupported(content).contains("outside"), "{content}");
    }
}

#[test]
fn harmless_oddities_are_tolerated() {
    for content in ["Q Q Q", "/Missing sh", "f", "foo bar 1 2 baz", "BT ET ET", "/Missing gs"] {
        assert_eq!(events(content).unwrap(), vec![], "{content}");
    }
}

#[test]
fn unparsable_or_too_deep_content_is_unsupported() {
    assert!(decode_ops(b"1 2 (unterminated").is_err());
    assert!(decode_ops(b"q ] Q").is_err());
    let deep = format!("{}{} pop", "[".repeat(10_000), "]".repeat(10_000));
    assert!(decode_ops(deep.as_bytes()).is_err());
    let deep = format!("{} pop", "<<".repeat(10_000));
    assert!(decode_ops(deep.as_bytes()).is_err());
}

#[test]
fn inline_images_decode_with_filters_and_are_placed() {
    let content = "q 10 0 0 20 5 5 cm BI /W 2 /H 1 /CS /G /BPC 8 /F /AHx ID 00FF> EI Q (BI) Tj";
    let ops = decode_ops(content.as_bytes()).unwrap();
    assert_eq!(ops.iter().map(|o| o.operator.as_str()).collect::<Vec<_>>(), vec!["q", "cm", "BI", "Q", "Tj"]);
    let Object::Stream(image) = &ops[2].operands[0] else { panic!("{:?}", ops[2]) };
    assert_eq!(image.content, b"00FF>");
    assert_eq!(image.dict.get(b"W").unwrap(), &Object::Integer(2));
    assert_eq!(image.dict.get(b"F").unwrap(), &Object::Name(b"AHx".to_vec()));
    let ev = events("q 10 0 0 20 5 5 cm BI /W 2 /H 1 /CS /G /BPC 8 /F /AHx ID 00FF> EI Q").unwrap();
    let [Event::Image(img)] = ev.as_slice() else { panic!("{ev:?}") };
    assert_eq!((img.op_index, &img.source), (2, &ImageSource::Inline));
    assert_quad(&img.quad_user, [(5.0, 5.0), (15.0, 5.0), (15.0, 25.0), (5.0, 25.0)]);
}

#[test]
fn unfiltered_inline_image_data_must_have_the_exact_length() {
    let image = |dict: &str, data: &[u8]| {
        let mut c = format!("BI {dict} ID ").into_bytes();
        c.extend_from_slice(data);
        c.extend_from_slice(b" EI");
        decode_ops(&c)
    };
    assert!(image("/W 2 /H 2 /CS /G /BPC 8", b"abcd").is_ok());
    assert!(image("/W 2 /H 2 /CS /G /BPC 8", b"abc").is_err());
    assert!(image("/W 2 /H 2 /CS /G /BPC 8", b"abcde").is_err());
    assert!(image("/W 1 /H 1 /CS /RGB /BPC 8", b"abc").is_ok());
    assert!(image("/Width 1 /Height 2 /ColorSpace /DeviceCMYK /BitsPerComponent 8", b"abcdefgh").is_ok());
    assert!(image("/W 9 /H 2 /CS /G /BPC 1", b"abcd").is_ok());
    assert!(image("/W 8 /H 1 /IM true", b"a").is_ok());
    assert!(image("/W 3 /H 1 /CS [/I /RGB 1 <000000FFFFFF>] /BPC 8", b"abc").is_ok());
    assert!(image("/W 3 /H 1 /CS /I /BPC 4", b"ab").is_ok());
    // Named colour spaces, a missing size or depth: length unknown.
    assert!(image("/W 1 /H 1 /CS /CS0 /BPC 8", b"a").is_err());
    assert!(image("/W 1 /CS /G /BPC 8", b"a").is_err());
    assert!(image("/W 1 /H 1 /CS /G", b"a").is_err());
    // Filtered data cannot be measured before decoding.
    assert!(image("/W 9 /H 9 /CS /G /BPC 8 /F /AHx", b"00>").is_ok());
}

#[test]
fn inline_images_are_written_back_byte_for_byte() {
    let raw: &[u8] = b"BI /W 2 /H 1 /CS /G /BPC 8 /D [1 0] ID \x00\xff EI";
    let content = [&b"q "[..], raw, b" Q"].concat();
    let encoded = encode_ops(&decode_ops(&content).unwrap());
    assert!(encoded.windows(raw.len()).any(|w| w == raw), "{}", String::from_utf8_lossy(&encoded));
}

#[test]
fn image_and_form_xobjects() {
    let ev = events("q 100 0 0 50 10 20 cm /Im1 Do Q 2 0 0 2 0 0 cm /Fm1 Do").unwrap();
    let [Event::Image(img), Event::Form(form)] = ev.as_slice() else { panic!("{ev:?}") };
    assert_eq!((img.op_index, &img.source), (2, &ImageSource::XObject(b"Im1".to_vec())));
    assert_quad(&img.quad_user, [(10.0, 20.0), (110.0, 20.0), (110.0, 70.0), (10.0, 70.0)]);
    assert_eq!((form.op_index, form.name.as_slice()), (5, &b"Fm1"[..]));
    assert_eq!(form.matrix, [2.0, 0.0, 0.0, 2.0, 10.0, 10.0]);
}

#[test]
fn shadings_with_and_without_bbox() {
    let ev = events("1 0 0 1 5 5 cm /Sh1 sh /Sh2 sh").unwrap();
    let [Event::Shading(a), Event::Shading(b)] = ev.as_slice() else { panic!("{ev:?}") };
    assert_eq!((a.op_index, a.bbox_user), (1, Some(Rect { x0: 5.0, y0: 5.0, x1: 15.0, y1: 15.0 })));
    assert_eq!((b.op_index, b.name.as_slice(), b.bbox_user), (2, &b"Sh2"[..], None));
}

fn path(content: &str) -> PathPaint {
    let ev = events(content).unwrap();
    let [Event::Path(p)] = ev.as_slice() else { panic!("{content}: {ev:?}") };
    p.clone()
}

fn assert_rect(r: Option<Rect>, [x0, y0, x1, y1]: [f64; 4]) {
    let r = r.expect("bbox");
    assert!(
        (r.x0 - x0).abs() < EPS && (r.y0 - y0).abs() < EPS && (r.x1 - x1).abs() < EPS && (r.y1 - y1).abs() < EPS,
        "{r:?} != {:?}",
        [x0, y0, x1, y1]
    );
}

#[test]
fn filled_path_range_and_bbox() {
    let p = path("1 0 0 1 10 10 cm 0 0 m 10 0 l 10 5 l h f");
    assert_eq!((p.op_range.clone(), p.painted, p.clip), (1..6, true, false));
    assert_rect(p.bbox_user, [10.0, 10.0, 20.0, 15.0]);
    assert_rect(path("15 5 -10 20 re f").bbox_user, [5.0, 5.0, 15.0, 25.0]);
    assert_rect(path("0 0 m 10 20 30 -5 40 0 c f").bbox_user, [0.0, -5.0, 40.0, 20.0]);
    assert_rect(path("0 0 m 10 20 40 0 v 5 -3 50 1 y f*").bbox_user, [0.0, -3.0, 50.0, 20.0]);
}

#[test]
fn stroked_path_bbox_includes_the_stroke() {
    // Round joins: half width times sqrt(2) for square caps.
    let h = std::f64::consts::SQRT_2;
    assert_rect(path("2 w 1 j 0 0 m 10 0 l S").bbox_user, [-h, -h, 10.0 + h, h]);
    // Miter joins reach half width times the miter limit (default 10).
    assert_rect(path("2 w 0 0 m 10 0 l S").bbox_user, [-10.0, -10.0, 20.0, 10.0]);
    assert_rect(path("2 w 2 M 0 0 m 10 0 l s").bbox_user, [-2.0, -2.0, 12.0, 2.0]);
    // Line width from an ExtGState (LW 4), scaled by the CTM.
    assert_rect(path("/G1 gs 1 j 2 0 0 2 0 0 cm 0 0 m 10 0 l B").bbox_user, [-4.0 * h, -4.0 * h, 20.0 + 4.0 * h, 4.0 * h]);
    // A zero width line still covers half a unit.
    assert_rect(path("0 w 1 j 0 0 m 10 0 l S").bbox_user, [-0.5, -0.5, 10.5, 0.5]);
}

#[test]
fn clip_paths_are_marked() {
    let p = path("0 0 m 10 0 l 10 10 l W n");
    assert_eq!((p.op_range.clone(), p.painted, p.clip, p.single_rect), (0..5, false, true, false));
    let p = path("0 0 10 10 re W* f");
    assert_eq!((p.op_range.clone(), p.painted, p.clip, p.single_rect), (0..3, true, true, true));
    assert!(path("0 0 10 10 re h W n").single_rect);
    // Several rectangles can spell letters.
    assert!(!path("0 0 10 10 re 20 20 5 5 re W n").single_rect);
}

#[test]
fn save_depth_is_bounded() {
    let content = "q ".repeat(100_000);
    assert!(events(&content).is_err());
}

#[test]
fn tj_adjustment_keeps_following_glyphs_in_place() {
    let base = glyphs("BT /F1 10 Tf 1 Tc 2 Tw 50 Tz [(A B)] TJ ET");
    let adj: Vec<f64> = base.iter().map(|g| g.tj_adjustment().unwrap()).collect();
    // Th does not enter the number: -(w0 Tfs + Tc + Tw) * 1000 / Tfs.
    assert_eq!(adj, vec![-600.0, -550.0, -700.0]);
    let without_a = glyphs(&format!("BT /F1 10 Tf 1 Tc 2 Tw 50 Tz [{} ( B)] TJ ET", adj[0]));
    assert_eq!(without_a[1].box_user, base[2].box_user);
    let without_space = glyphs(&format!("BT /F1 10 Tf 1 Tc 2 Tw 50 Tz [(A) {} (B)] TJ ET", adj[1]));
    assert_eq!(without_space[1].box_user, base[2].box_user);
    let zero = Glyph { font_size: 0.0, ..base[0].clone() };
    assert_eq!(zero.tj_adjustment(), None);
}

#[test]
fn quad_intersection_needs_positive_area() {
    let r = Rect { x0: 0.0, y0: 0.0, x1: 10.0, y1: 10.0 };
    let square = |x0: f64, y0: f64, x1: f64, y1: f64| Quad([(x0, y0), (x1, y0), (x1, y1), (x0, y1)]);
    assert!(square(5.0, 5.0, 15.0, 15.0).intersects(&r));
    assert!(square(-5.0, -5.0, 20.0, 20.0).intersects(&r));
    assert!(!square(10.0, 0.0, 20.0, 10.0).intersects(&r), "touching edge");
    assert!(!square(11.0, 0.0, 20.0, 10.0).intersects(&r));
    // A diamond whose bounding box overlaps the corner but not the rect.
    let diamond = Quad([(15.0, 9.0), (21.0, 15.0), (15.0, 21.0), (9.0, 15.0)]);
    assert!(!diamond.intersects(&r));
    assert_eq!(diamond.bbox(), Rect { x0: 9.0, y0: 9.0, x1: 21.0, y1: 21.0 });
    let diamond = Quad([(10.0, 4.0), (16.0, 10.0), (10.0, 16.0), (4.0, 10.0)]);
    assert!(diamond.intersects(&r));
    // Degenerate quads (a segment, a point) count when they touch the
    // rect at all: zero-size text and singular images still leak.
    assert!(square(5.0, 5.0, 5.0, 8.0).intersects(&r));
    assert!(square(5.0, 5.0, 5.0, 5.0).intersects(&r));
    assert!(square(10.0, 10.0, 10.0, 10.0).intersects(&r), "point on the edge");
    assert!(!square(10.5, 5.0, 10.5, 5.0).intersects(&r));
    // No absolute epsilon: a tiny but real quad is tested as a quad.
    let tiny = Quad([(5.0, 5.0), (5.0 + 1e-7, 5.0), (5.0 + 1e-7, 5.0 + 1e-7), (5.0, 5.0 + 1e-7)]);
    assert!(tiny.intersects(&r));
    let tiny_diamond = Quad([(10.0 + 3e-7, 0.0), (10.0 + 6e-7, 3e-7), (10.0 + 3e-7, 6e-7), (10.0, 3e-7)]);
    assert!(!tiny_diamond.intersects(&r), "tiny quad touching the edge only");
}

#[test]
fn huge_or_non_finite_geometry_is_unsupported() {
    let big = "100000000000000000000000000000000000000.0";
    for content in [
        format!("{big} 0 0 1 0 0 cm {big} 0 0 1 0 0 cm"),
        "10000000000 0 0 1 0 0 cm".to_string(),
        "BT 1 0 0 1 2000000000 0 Tm ET".to_string(),
        "BT 0 2000000000 Td ET".to_string(),
        "BT 0 2000000000 TD ET".to_string(),
        format!("BT /F1 1000000 Tf {big} Tc (AAAA) Tj ET"),
        "BT /F1 10 Tf [(A) -1000000000000000 (A)] TJ ET".to_string(),
        format!("{big} 0 0 1 0 0 cm /Im1 Do"),
        "0 0 m 2000000000 0 l S".to_string(),
    ] {
        assert!(unsupported(&content).contains("out of range"), "{content}");
    }
    // Large but sane coordinates are fine.
    assert!(events("BT /F1 10 Tf 1 0 0 1 900000000 0 Tm (A) Tj ET").is_ok());
}

#[test]
fn zero_size_text_and_singular_images_still_hit() {
    let ev = events("BT /F1 0 Tf (A) Tj ET 0 0 0 0 5 5 cm /Im1 Do").unwrap();
    let r = Rect { x0: 0.0, y0: 0.0, x1: 10.0, y1: 10.0 };
    let [Event::Glyph(g), Event::Image(img)] = ev.as_slice() else { panic!("{ev:?}") };
    assert!(g.box_user.intersects(&r));
    assert!(img.quad_user.intersects(&r));
}

#[test]
fn stroked_text_box_grows_by_the_stroke_reach() {
    // Line width 4, round joins: half width 2 times sqrt(2).
    let reach = 2.0 * std::f64::consts::SQRT_2;
    for mode in [1, 2, 5, 6] {
        let g = glyphs(&format!("BT /F1 10 Tf {mode} Tr 4 w 1 j (A) Tj ET"));
        assert_quad(
            &g[0].box_user,
            [(-reach, -2.0 - reach), (5.0 + reach, -2.0 - reach), (5.0 + reach, 9.0 + reach), (-reach, 9.0 + reach)],
        );
    }
    for mode in [0, 3, 4, 7] {
        let g = glyphs(&format!("BT /F1 10 Tf {mode} Tr 4 w 1 j (A) Tj ET"));
        assert_quad(&g[0].box_user, upright(0.0, 5.0, 0.0));
    }
}
