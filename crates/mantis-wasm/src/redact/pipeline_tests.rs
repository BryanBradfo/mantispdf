//! `redact_plan` and `redact` on whole documents: forms, annotations,
//! assembly through the 2c rebuild, hidden data and verification.

use super::interp::{Glyph, Rect};
use super::verify::page_glyphs;
use super::*;
use crate::pdf_util::{load_pdf, save_pdf};
use lopdf::{Dictionary, Document, Object, ObjectId, Stream, StringFormat, dictionary};

fn helvetica() -> Dictionary {
    dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica", "Encoding" => "WinAnsiEncoding" }
}

fn stream(content: &str) -> Stream {
    Stream::new(dictionary! {}, content.as_bytes().to_vec())
}

fn text(s: &str) -> Object {
    Object::String(s.as_bytes().to_vec(), StringFormat::Literal)
}

fn rect_array(v: [i64; 4]) -> Object {
    Object::Array(v.iter().map(|n| Object::Integer(*n)).collect())
}

/// Page 1: "Hello World" (Helvetica 10 at 100, 700) with two links and a
/// comment, a thumbnail, piece info, metadata and an /AA. Pages 2 and 3 draw
/// the same form (shared resources): "SECRET DATA" at (110, 450).
/// The catalog has XMP metadata, JavaScript, attachments, an /OpenAction and
/// a structure tree; the trailer an /Info.
fn fixture() -> Document {
    let mut doc = Document::with_version("1.7");
    let font = doc.add_object(helvetica());
    let fonts = dictionary! { "H" => font };
    let form = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Form", "BBox" => rect_array([0, 0, 300, 100]),
            "Resources" => dictionary! { "Font" => fonts.clone() },
        },
        b"BT /H 10 Tf 10 50 Td (SECRET DATA) Tj ET".to_vec(),
    ));
    let shared = doc.add_object(dictionary! { "XObject" => dictionary! { "Fm1" => form } });
    let pages_id = doc.new_object_id();
    let js = doc.add_object(dictionary! { "S" => "JavaScript", "JS" => text("app.alert('secret')") });
    let link = |doc: &mut Document, r: [i64; 4]| {
        doc.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Link", "Rect" => rect_array(r),
            "A" => dictionary! { "S" => "URI", "URI" => text("https://example.com") },
        })
    };
    let link_in = link(&mut doc, [130, 698, 140, 710]);
    let link_out = link(&mut doc, [10, 10, 50, 30]);
    let square = doc.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Square", "Rect" => rect_array([300, 300, 320, 320]), "Contents" => text("note"),
    });
    let thumb = doc.add_object(stream("thumbnail"));
    let page_meta = doc.add_object(stream("<x:xmpmeta>page secret</x:xmpmeta>"));
    let c1 = doc.add_object(stream("BT /H 10 Tf 100 700 Td (Hello World) Tj ET"));
    let page1 = doc.add_object(dictionary! {
        "Type" => "Page", "Parent" => pages_id, "Contents" => c1,
        "Resources" => dictionary! { "Font" => fonts.clone() },
        "Annots" => vec![link_in.into(), link_out.into(), square.into()],
        "Thumb" => thumb, "PieceInfo" => dictionary! { "App" => dictionary! { "Private" => text("secret") } },
        "Metadata" => page_meta, "AA" => dictionary! { "O" => js }, "StructParents" => 0,
    });
    let c2 = doc.add_object(stream("q 1 0 0 1 100 400 cm /Fm1 Do Q"));
    let c3 = doc.add_object(stream("q 1 0 0 1 100 400 cm /Fm1 Do Q"));
    let page2 = doc.add_object(dictionary! { "Type" => "Page", "Parent" => pages_id, "Contents" => c2, "Resources" => shared });
    let page3 = doc.add_object(dictionary! { "Type" => "Page", "Parent" => pages_id, "Contents" => c3, "Resources" => shared });
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages", "Kids" => vec![page1.into(), page2.into(), page3.into()], "Count" => 3,
            "MediaBox" => rect_array([0, 0, 612, 792]),
        }),
    );
    let xmp = doc.add_object(stream("<x:xmpmeta>document secret</x:xmpmeta>"));
    let attachment = doc.add_object(dictionary! { "Type" => "Filespec", "F" => text("secret.txt") });
    let struct_root = doc.add_object(dictionary! {
        "Type" => "StructTreeRoot",
        "K" => dictionary! { "S" => "P", "ActualText" => text("Hello World"), "Alt" => text("World") },
    });
    let catalog = doc.add_object(dictionary! {
        "Type" => "Catalog", "Pages" => pages_id, "Metadata" => xmp, "OpenAction" => js,
        "Names" => dictionary! {
            "JavaScript" => dictionary! { "Names" => vec![text("init"), js.into()] },
            "EmbeddedFiles" => dictionary! { "Names" => vec![text("secret.txt"), attachment.into()] },
        },
        "StructTreeRoot" => struct_root, "MarkInfo" => dictionary! { "Marked" => true },
    });
    doc.trailer.set("Root", catalog);
    let info = doc.add_object(dictionary! { "Title" => text("Secret report"), "Author" => text("Agent") });
    doc.trailer.set("Info", info);
    doc
}

fn bytes(mut doc: Document) -> Vec<u8> {
    save_pdf(&mut doc).unwrap()
}

/// A visible-space area on a page (1-based).
fn area(page: u32, x: f64, y: f64, w: f64, h: f64) -> RedactRect {
    RedactRect { page, rect: [x, y, w, h] }
}

fn job(rects: Vec<RedactRect>) -> RedactJob {
    RedactJob { rects, fill: Fill::Black, remove_metadata: true, rasters: Vec::new() }
}

/// "World" on page 1 (the space before it stays clear).
fn world() -> RedactRect {
    area(1, 127.0, 700.0, 30.0, 5.0)
}

/// "SECRET" in the form drawn on page 2.
fn secret_on_page_2() -> RedactRect {
    area(2, 111.0, 450.0, 38.0, 5.0)
}

fn page_ids(doc: &Document) -> Vec<ObjectId> {
    doc.get_pages().into_values().collect()
}

fn text_of(doc: &Document, page: ObjectId) -> String {
    let glyphs: Vec<Glyph> = page_glyphs(doc, page).unwrap();
    glyphs.iter().map(|g| char::from_u32(g.code).unwrap()).collect()
}

fn run(doc: Document, rects: Vec<RedactRect>) -> (Document, RedactSummary) {
    let (out, summary) = redact(&bytes(doc), job(rects)).unwrap();
    (load_pdf(&out).unwrap(), summary)
}

#[test]
fn page_text_is_removed_and_other_pages_untouched() {
    let (out, summary) = run(fixture(), vec![world()]);
    let pages = page_ids(&out);
    assert_eq!(text_of(&out, pages[0]), "Hello ");
    assert_eq!(text_of(&out, pages[1]), "SECRET DATA");
    assert_eq!(text_of(&out, pages[2]), "SECRET DATA");
    assert_eq!(summary.glyphs_removed, 5);
    assert_eq!(summary.pages_redacted, vec![1]);
}

#[test]
fn text_inside_a_form_is_removed_and_the_shared_form_kept_elsewhere() {
    let (out, summary) = run(fixture(), vec![secret_on_page_2()]);
    let pages = page_ids(&out);
    assert_eq!(text_of(&out, pages[1]), " DATA");
    assert_eq!(text_of(&out, pages[2]), "SECRET DATA");
    assert_eq!(summary.glyphs_removed, 6);
    assert_eq!(summary.forms_redacted, 1);
}

#[test]
fn form_text_is_removed_on_the_source_without_touching_the_shared_objects() {
    let mut doc = fixture();
    let before: Vec<(ObjectId, Object)> = doc.objects.iter().map(|(id, o)| (*id, o.clone())).collect();
    let page2 = page_ids(&doc)[1];
    let rects = page_rects_user(&doc, page2, &[secret_on_page_2()]);
    let mut budget = Budget::page(64 << 20);
    redact_page(&mut doc, page2, &rects, Fill::Black, &mut budget).unwrap();
    for (id, object) in before {
        if id != page2 {
            assert_eq!(doc.objects.get(&id), Some(&object), "object {id:?} changed");
        }
    }
}

#[test]
fn annotations_under_an_area_are_removed_others_kept_by_policy() {
    let (out, summary) = run(fixture(), vec![world()]);
    let page = out.get_dictionary(page_ids(&out)[0]).unwrap();
    let annots = page.get(b"Annots").map(|a| out.dereference(a).unwrap().1.as_array().unwrap().clone()).unwrap_or_default();
    let rects: Vec<Vec<f32>> = annots
        .iter()
        .map(|a| {
            let d = out.dereference(a).unwrap().1.as_dict().unwrap();
            d.get(b"Rect").unwrap().as_array().unwrap().iter().map(|n| n.as_float().unwrap()).collect()
        })
        .collect();
    // The inside link is gone; the outside link stays; comments never survive.
    assert_eq!(rects, vec![vec![10.0, 10.0, 50.0, 30.0]]);
    assert_eq!(summary.annotations_removed, 1);
}

fn catalog(doc: &Document) -> &Dictionary {
    doc.catalog().unwrap()
}

#[test]
fn hidden_data_is_gone() {
    let (out, _) = run(fixture(), vec![world()]);
    let root = catalog(&out);
    for key in [&b"Metadata"[..], b"OpenAction", b"Names", b"StructTreeRoot", b"AA"] {
        assert!(!root.has(key), "catalog keeps {}", String::from_utf8_lossy(key));
    }
    assert!(out.trailer.get(b"Info").is_err(), "Info removed");
    let page = out.get_dictionary(page_ids(&out)[0]).unwrap();
    for key in [&b"Thumb"[..], b"PieceInfo", b"Metadata", b"AA", b"StructParents"] {
        assert!(!page.has(key), "page keeps {}", String::from_utf8_lossy(key));
    }
    // Nothing anywhere still carries the secrets.
    let mut raw = bytes(out);
    raw.retain(|b| *b != 0);
    let raw = String::from_utf8_lossy(&raw);
    for secret in ["app.alert", "secret.txt", "document secret", "page secret", "Secret report", "World)", "Private"] {
        assert!(!raw.contains(secret), "{secret} survived");
    }
}

#[test]
fn info_can_be_kept_on_request() {
    let mut j = job(vec![world()]);
    j.remove_metadata = false;
    let (out, _) = redact(&bytes(fixture()), j).unwrap();
    let out = load_pdf(&out).unwrap();
    let info = out.trailer.get(b"Info").and_then(|i| out.dereference(i)).unwrap().1.as_dict().unwrap().clone();
    assert_eq!(info.get(b"Title").unwrap().as_str().unwrap(), b"Secret report");
    assert!(catalog(&out).get(b"Metadata").is_err(), "XMP still goes");
}

#[test]
fn verification_catches_a_planted_leak() {
    plant_leak_for_tests(true);
    let result = redact(&bytes(fixture()), job(vec![world()]));
    plant_leak_for_tests(false);
    assert_eq!(result.unwrap_err(), "Redaction verification failed on page 1");
}

#[test]
fn plan_reports_pages_that_need_a_raster() {
    let mut doc = fixture();
    // Page 3 now uses a Type3 font.
    let page3 = page_ids(&doc)[2];
    let t3 = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type3" });
    let c = doc.add_object(stream("BT /T 10 Tf (x) Tj ET"));
    let d = doc.get_dictionary_mut(page3).unwrap();
    d.set("Contents", c);
    d.set("Resources", dictionary! { "Font" => dictionary! { "T" => t3 } });
    let plan = redact_plan(&bytes(doc), &[world(), area(3, 0.0, 0.0, 10.0, 10.0), area(1, 0.0, 0.0, 5.0, 5.0)]).unwrap();
    assert_eq!(plan.len(), 2);
    assert_eq!((plan[0].page, plan[0].reason.as_deref()), (1, None));
    assert_eq!(plan[1].page, 3);
    assert!(plan[1].reason.as_deref().unwrap().contains("Type3"));
    // Redacting without a raster for it is refused.
    let err = redact(&bytes(fixture_with_type3()), job(vec![area(3, 0.0, 0.0, 10.0, 10.0)])).unwrap_err();
    assert!(err.starts_with("Invalid redact settings: raster (page 3: font T: Type3"), "{err}");
}

fn fixture_with_type3() -> Document {
    let mut doc = fixture();
    let page3 = page_ids(&doc)[2];
    let t3 = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type3" });
    let c = doc.add_object(stream("BT /T 10 Tf (x) Tj ET"));
    let d = doc.get_dictionary_mut(page3).unwrap();
    d.set("Contents", c);
    d.set("Resources", dictionary! { "Font" => dictionary! { "T" => t3 } });
    doc
}

#[test]
fn settings_are_validated() {
    let pdf = bytes(fixture());
    let err = |rects: Vec<RedactRect>| redact(&pdf, job(rects)).unwrap_err();
    assert_eq!(err(vec![area(0, 0.0, 0.0, 1.0, 1.0)]), "Invalid redact settings: rects[0].page");
    assert_eq!(err(vec![world(), area(4, 0.0, 0.0, 1.0, 1.0)]), "Invalid redact settings: rects[1].page");
    assert_eq!(err(vec![area(1, f64::NAN, 0.0, 1.0, 1.0)]), "Invalid redact settings: rects[0].x");
    assert_eq!(err(vec![area(1, 0.0, 2e6, 1.0, 1.0)]), "Invalid redact settings: rects[0].y");
    assert_eq!(err(vec![area(1, 0.0, 0.0, 0.0, 1.0)]), "Invalid redact settings: rects[0].width");
    assert_eq!(err(vec![area(1, 0.0, 0.0, 1.0, -1.0)]), "Invalid redact settings: rects[0].height");
    assert_eq!(err(vec![world(); 10_001]), "Invalid redact settings: rects");
    assert_eq!(redact_plan(&pdf, &[area(9, 0.0, 0.0, 1.0, 1.0)]).unwrap_err(), "Invalid redact settings: rects[0].page");
}

#[test]
fn visible_areas_map_to_user_space_on_rotated_pages() {
    let mut doc = fixture();
    let page1 = page_ids(&doc)[0];
    doc.get_dictionary_mut(page1).unwrap().set("Rotate", 90);
    // Rotate 90 on [0 0 612 792]: visible (vx, vy) is user (612 - vy, vx).
    let rects = page_rects_user(&doc, page1, &[area(1, 700.0, 485.0, 5.0, 30.0)]);
    assert_eq!(rects, vec![Rect { x0: 97.0, y0: 700.0, x1: 127.0, y1: 705.0 }]);
}

#[test]
fn named_properties_get_private_stripped_copies_ocgs_stay_shared() {
    let mut doc = fixture();
    let page1 = page_ids(&doc)[0];
    let ocg = doc.add_object(dictionary! { "Type" => "OCG", "Name" => text("Layer") });
    let span = doc.add_object(dictionary! { "ActualText" => text("World"), "Lang" => text("en") });
    let c = doc.add_object(stream("/OC /L0 BDC /Span /MC0 BDC BT /H 10 Tf 100 700 Td (Hello World) Tj ET EMC EMC"));
    let font = doc.add_object(helvetica());
    let d = doc.get_dictionary_mut(page1).unwrap();
    d.set("Contents", c);
    d.set("Resources", dictionary! { "Font" => dictionary! { "H" => font }, "Properties" => dictionary! { "L0" => ocg, "MC0" => span } });
    let rects = page_rects_user(&doc, page1, &[world()]);
    redact_page(&mut doc, page1, &rects, Fill::Black, &mut Budget::page(64 << 20)).unwrap();
    let res = doc.get_dictionary(page1).unwrap().get(b"Resources").unwrap().as_dict().unwrap().clone();
    let props = super::interp::page_resources_dict(&doc, &res, b"Properties");
    assert_eq!(props.get(b"L0").unwrap(), &Object::Reference(ocg), "the OCG keeps its identity");
    let mc0 = props.get(b"MC0").unwrap();
    assert_ne!(mc0, &Object::Reference(span), "a private copy");
    let mc0 = doc.dereference(mc0).unwrap().1.as_dict().unwrap();
    assert!(!mc0.has(b"ActualText") && mc0.has(b"Lang"));
    assert!(doc.get_dictionary(span).unwrap().has(b"ActualText"), "the original stays for other users");
}

#[test]
fn images_inside_forms_are_redacted_copy_on_write() {
    let mut doc = fixture();
    let page2 = page_ids(&doc)[1];
    let image = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Image", "Width" => 2, "Height" => 1,
            "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8,
        },
        vec![200, 200],
    ));
    let form = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Form", "BBox" => rect_array([0, 0, 100, 100]),
            "Resources" => dictionary! { "XObject" => dictionary! { "Im" => image } },
        },
        b"q 20 0 0 10 0 0 cm /Im Do Q".to_vec(),
    ));
    let c = doc.add_object(stream("q 1 0 0 1 100 100 cm /Fm Do Q"));
    let d = doc.get_dictionary_mut(page2).unwrap();
    d.set("Contents", c);
    d.set("Resources", dictionary! { "XObject" => dictionary! { "Fm" => form } });
    let rects = page_rects_user(&doc, page2, &[area(2, 100.0, 100.0, 10.0, 10.0)]);
    let report = redact_page(&mut doc, page2, &rects, Fill::Black, &mut Budget::page(64 << 20)).unwrap();
    assert_eq!((report.images_redacted, report.forms_redacted), (1, 1));
    assert_eq!(doc.get_object(image).unwrap().as_stream().unwrap().content, vec![200, 200], "original image kept");
    assert_eq!(
        doc.get_object(form).unwrap().as_stream().unwrap().content,
        b"q 20 0 0 10 0 0 cm /Im Do Q".to_vec(),
        "original form kept"
    );
}

#[test]
fn form_cycles_and_depth_are_unsupported() {
    let mut doc = fixture();
    let page2 = page_ids(&doc)[1];
    let id = doc.new_object_id();
    doc.objects.insert(
        id,
        Object::Stream(Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Form", "BBox" => rect_array([0, 0, 10, 10]),
                "Resources" => dictionary! { "XObject" => dictionary! { "Me" => id } },
            },
            b"/Me Do".to_vec(),
        )),
    );
    let c = doc.add_object(stream("/Me Do"));
    let d = doc.get_dictionary_mut(page2).unwrap();
    d.set("Contents", c);
    d.set("Resources", dictionary! { "XObject" => dictionary! { "Me" => id } });
    let rects = page_rects_user(&doc, page2, &[area(2, 0.0, 0.0, 5.0, 5.0)]);
    let err = redact_page(&mut doc, page2, &rects, Fill::Black, &mut Budget::page(64 << 20)).unwrap_err();
    assert!(err.0.contains("cycle") || err.0.contains("deep"), "{err:?}");
}

#[test]
fn names_used_by_resource_less_forms_are_not_pruned() {
    let mut doc = fixture();
    let page1 = page_ids(&doc)[0];
    let image = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Image", "Width" => 1, "Height" => 1,
            "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8,
        },
        vec![100],
    ));
    // The form has no /Resources: it draws /Im from the page's, far away.
    let form = doc.add_object(Stream::new(
        dictionary! { "Type" => "XObject", "Subtype" => "Form", "BBox" => rect_array([0, 0, 612, 792]) },
        b"q 10 0 0 10 300 300 cm /Im Do Q".to_vec(),
    ));
    let c = doc.add_object(stream("q 10 0 0 10 100 700 cm /Im Do Q /Fm Do"));
    let d = doc.get_dictionary_mut(page1).unwrap();
    d.set("Contents", c);
    d.set("Resources", dictionary! { "XObject" => dictionary! { "Im" => image, "Fm" => form } });
    let rects = page_rects_user(&doc, page1, &[area(1, 95.0, 695.0, 20.0, 20.0)]);
    let report = redact_page(&mut doc, page1, &rects, Fill::Black, &mut Budget::page(64 << 20)).unwrap();
    assert_eq!((report.images_redacted, report.forms_redacted), (1, 0));
    let res = doc.get_dictionary(page1).unwrap().get(b"Resources").unwrap().as_dict().unwrap().clone();
    let xobjects = super::interp::page_resources_dict(&doc, &res, b"XObject");
    assert_eq!(xobjects.get(b"Im").unwrap(), &Object::Reference(image), "the unchanged form still draws /Im");
}

fn one_page(content: &str, extra: impl FnOnce(&mut Document, ObjectId)) -> Document {
    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();
    let c = doc.add_object(stream(content));
    let page = doc.add_object(dictionary! { "Type" => "Page", "Parent" => pages_id, "Contents" => c });
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1, "MediaBox" => rect_array([0, 0, 612, 792]),
        }),
    );
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog);
    extra(&mut doc, page);
    doc
}

/// A page whose soft mask group draws (SECRETMASK) at (100, 700), its form
/// /BBox `bbox`; the visible text is at (100, 600).
fn soft_mask_page(bbox: [i64; 4]) -> Document {
    one_page("q /GS1 gs 0 g 0 0 612 792 re f Q BT /H 10 Tf 100 600 Td (Visible) Tj ET", |doc, page| {
        let font = doc.add_object(helvetica());
        let group = doc.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Form", "BBox" => rect_array(bbox),
                "Group" => dictionary! { "S" => "Transparency", "CS" => "DeviceGray" },
                "Resources" => dictionary! { "Font" => dictionary! { "H" => font } },
            },
            b"BT /H 10 Tf 100 700 Td (SECRETMASK) Tj ET".to_vec(),
        ));
        let gs = dictionary! { "Type" => "ExtGState", "SMask" => dictionary! { "Type" => "Mask", "S" => "Luminosity", "G" => group } };
        doc.get_dictionary_mut(page)
            .unwrap()
            .set("Resources", dictionary! { "ExtGState" => dictionary! { "GS1" => gs }, "Font" => dictionary! { "H" => font } });
    })
}

/// A page painting with tiling pattern /P1, whose cell shows (SECRETTILE).
fn pattern_page(content: &str) -> Document {
    one_page(content, |doc, page| {
        let font = doc.add_object(helvetica());
        let pattern = doc.add_object(Stream::new(
            dictionary! {
                "Type" => "Pattern", "PatternType" => 1, "PaintType" => 1, "TilingType" => 1,
                "BBox" => rect_array([0, 0, 200, 50]), "XStep" => 200, "YStep" => 50,
                "Resources" => dictionary! { "Font" => dictionary! { "H" => font } },
            },
            b"BT /H 10 Tf 5 20 Td (SECRETTILE) Tj ET".to_vec(),
        ));
        doc.get_dictionary_mut(page)
            .unwrap()
            .set("Resources", dictionary! { "Pattern" => dictionary! { "P1" => pattern }, "Font" => dictionary! { "H" => font } });
    })
}

fn raster_needed(doc: Document, rects: Vec<RedactRect>) -> bool {
    matches!(redact(&bytes(doc), job(rects)), Err(e) if e.starts_with("Invalid redact settings: raster"))
}

#[test]
fn soft_mask_groups_under_an_area_need_a_raster() {
    assert!(raster_needed(soft_mask_page([0, 0, 612, 792]), vec![area(1, 95.0, 695.0, 80.0, 15.0)]));
    // A group whose box and content miss every area is fine.
    assert!(!raster_needed(soft_mask_page([0, 0, 50, 50]), vec![area(1, 300.0, 300.0, 10.0, 10.0)]));
}

#[test]
fn pattern_painting_under_an_area_needs_a_raster() {
    assert!(raster_needed(pattern_page("/Pattern cs /P1 scn 0 0 612 792 re f"), vec![area(1, 0.0, 0.0, 612.0, 792.0)]));
    let text = "BT /Pattern cs /P1 scn /H 30 Tf 100 700 Td (BIG) Tj ET";
    assert!(raster_needed(pattern_page(text), vec![area(1, 95.0, 690.0, 100.0, 40.0)]));
    // Painting with it away from the areas is fine; so is painting after
    // switching back to a device colour.
    assert!(!raster_needed(pattern_page("/Pattern cs /P1 scn 0 0 50 50 re f"), vec![area(1, 300.0, 300.0, 10.0, 10.0)]));
    let back = "/Pattern cs /P1 scn 0 g 300 300 20 20 re f";
    assert!(!raster_needed(pattern_page(back), vec![area(1, 300.0, 300.0, 10.0, 10.0)]));
    // A form inherits the pattern colour of its placement.
    let mut doc = pattern_page("/Pattern cs /P1 scn /Fm Do");
    let form = doc.add_object(Stream::new(
        dictionary! { "Type" => "XObject", "Subtype" => "Form", "BBox" => rect_array([0, 0, 612, 792]) },
        b"300 300 20 20 re f".to_vec(),
    ));
    let page = page_ids(&doc)[0];
    let res = doc.get_dictionary_mut(page).unwrap().get_mut(b"Resources").unwrap().as_dict_mut().unwrap();
    res.set("XObject", dictionary! { "Fm" => form });
    assert!(raster_needed(doc, vec![area(1, 300.0, 300.0, 10.0, 10.0)]));
}

#[test]
fn verification_fails_on_soft_masks_and_patterns_under_an_area() {
    let cases = [
        (soft_mask_page([0, 0, 612, 792]), area(1, 95.0, 695.0, 80.0, 15.0)),
        (pattern_page("/Pattern cs /P1 scn 300 300 20 20 re f"), area(1, 300.0, 300.0, 10.0, 10.0)),
    ];
    for (doc, a) in cases {
        plant_leak_for_tests(true);
        let result = redact(&bytes(doc), job(vec![a]));
        plant_leak_for_tests(false);
        assert_eq!(result.unwrap_err(), "Redaction verification failed on page 1");
    }
}

#[test]
fn optional_content_groups_carrying_replacement_text_need_a_raster() {
    let doc = one_page("/OC /L0 BDC BT /H 10 Tf 100 700 Td (Hello World) Tj ET EMC", |doc, page| {
        let font = doc.add_object(helvetica());
        let ocg = doc.add_object(dictionary! { "Type" => "OCG", "Name" => text("Layer"), "Alt" => text("World") });
        doc.get_dictionary_mut(page)
            .unwrap()
            .set("Resources", dictionary! { "Font" => dictionary! { "H" => font }, "Properties" => dictionary! { "L0" => ocg } });
    });
    assert!(raster_needed(doc, vec![area(1, 127.0, 700.0, 30.0, 5.0)]));
}

#[test]
fn verification_fails_on_paths_shadings_and_images_left_under_an_area() {
    let image_page = || {
        one_page("q 20 0 0 20 300 300 cm /Im Do Q", |doc, page| {
            let image = doc.add_object(Stream::new(
                dictionary! {
                    "Type" => "XObject", "Subtype" => "Image", "Width" => 1, "Height" => 1,
                    "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8,
                },
                vec![100],
            ));
            doc.get_dictionary_mut(page).unwrap().set("Resources", dictionary! { "XObject" => dictionary! { "Im" => image } });
        })
    };
    let shading_page = || {
        one_page("/Sh sh", |doc, page| {
            doc.get_dictionary_mut(page).unwrap().set(
                "Resources",
                dictionary! { "Shading" => dictionary! { "Sh" => dictionary! { "ShadingType" => 2, "ColorSpace" => "DeviceGray" } } },
            );
        })
    };
    let a = area(1, 300.0, 300.0, 10.0, 10.0);
    for doc in [one_page("300 300 20 20 re f", |_, _| {}), shading_page(), image_page()] {
        // Without the planted leak each is redacted and verified.
        assert!(redact(&bytes(doc.clone()), job(vec![a.clone()])).is_ok());
        plant_leak_for_tests(true);
        let result = redact(&bytes(doc), job(vec![a.clone()]));
        plant_leak_for_tests(false);
        assert_eq!(result.unwrap_err(), "Redaction verification failed on page 1");
    }
}

#[test]
fn planning_skips_the_pixel_work() {
    let page_doc = || {
        one_page("q 200 0 0 200 100 100 cm /Im Do Q", |doc, page| {
            let image = doc.add_object(Stream::new(
                dictionary! {
                    "Type" => "XObject", "Subtype" => "Image", "Width" => 100, "Height" => 100,
                    "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8,
                },
                vec![100; 10_000],
            ));
            doc.get_dictionary_mut(page).unwrap().set("Resources", dictionary! { "XObject" => dictionary! { "Im" => image } });
        })
    };
    let a = [area(1, 150.0, 150.0, 10.0, 10.0)];
    let mut doc = page_doc();
    let page = page_ids(&doc)[0];
    let rects = page_rects_user(&doc, page, &a);
    let mut budget = Budget::page(64 << 20);
    plan_page(&mut doc, page, &rects, &mut budget).unwrap();
    assert!(budget.decoded > (64 << 20) - 1000, "planning decoded the image");
    let mut budget = Budget::page(64 << 20);
    redact_page(&mut page_doc(), page, &rects, Fill::Black, &mut budget).unwrap();
    assert!(budget.decoded <= (64 << 20) - 80_000, "redacting charges the pixels");
    let plan = redact_plan(&bytes(page_doc()), &a).unwrap();
    assert_eq!(plan, vec![PageStatus { page: 1, reason: None }]);
}

#[test]
fn each_area_is_covered_by_a_box_of_the_fill_colour() {
    // The page leaves a q open and a scaled CTM: the boxes must not inherit it.
    let doc = one_page("q 2 0 0 2 0 0 cm 0 0 1 rg 10 10 5 5 re f", |_, _| {});
    let mut j = job(vec![area(1, 300.0, 300.0, 10.0, 20.0), area(1, 100.0, 100.0, 5.0, 5.0)]);
    j.fill = Fill::White;
    let (out, _) = redact(&bytes(doc), j).unwrap();
    let out = load_pdf(&out).unwrap();
    let page = page_ids(&out)[0];
    let boxes: Vec<Rect> = super::verify::page_events(&out, page)
        .unwrap()
        .into_iter()
        .filter_map(|e| match e {
            super::interp::Event::Path(p) if p.painted => p.bbox_user,
            _ => None,
        })
        .collect();
    assert!(boxes.contains(&Rect { x0: 300.0, y0: 300.0, x1: 310.0, y1: 320.0 }), "{boxes:?}");
    assert!(boxes.contains(&Rect { x0: 100.0, y0: 100.0, x1: 105.0, y1: 105.0 }), "{boxes:?}");
    let content = String::from_utf8_lossy(&out.get_page_content(page).unwrap()).into_owned();
    assert!(content.contains("1 1 1 rg"), "{content}");
}

/// An all-white raster of `width` x `height` at `dpi` for 1-based `page`.
fn white_raster(page: u32, width: u32, height: u32, dpi: f64) -> PageRaster {
    PageRaster { page, width, height, dpi, rgba: vec![255; width as usize * height as usize * 4] }
}

fn image_of(doc: &Document, page: ObjectId) -> (usize, usize, Vec<u8>) {
    let res = super::interp::page_resources(doc, page);
    let xobjects = super::interp::page_resources_dict(doc, &res, b"XObject");
    assert_eq!(xobjects.len(), 1);
    let (_, image) = xobjects.iter().next().unwrap();
    let stream = doc.dereference(image).unwrap().1.as_stream().unwrap();
    crate::images::extract::ImageDecoder::new(doc, 1 << 30).rgba(stream, &res).unwrap()
}

#[test]
fn unsupported_pages_are_replaced_by_their_raster() {
    let mut j = job(vec![world(), area(3, 0.0, 0.0, 10.0, 20.0)]);
    j.rasters = vec![white_raster(3, 612, 792, 72.0)];
    let (out, summary) = redact(&bytes(fixture_with_type3()), j).unwrap();
    assert_eq!(summary.pages_rasterized, vec![3]);
    let out = load_pdf(&out).unwrap();
    let pages = page_ids(&out);
    assert_eq!(text_of(&out, pages[0]), "Hello ");
    assert_eq!(text_of(&out, pages[1]), "SECRET DATA");
    assert_eq!(text_of(&out, pages[2]), "", "no text at all on a rasterized page");
    let (w, h, rgba) = image_of(&out, pages[2]);
    assert_eq!((w, h), (612, 792));
    // The engine paints the areas itself: bottom-left 10 x 20 px black.
    let px = |x: usize, y: usize| &rgba[4 * (y * w + x)..4 * (y * w + x) + 3];
    assert_eq!(px(0, h - 1), [0, 0, 0]);
    assert_eq!(px(9, h - 20), [0, 0, 0]);
    assert_eq!(px(10, h - 1), [255, 255, 255]);
    assert_eq!(px(0, h - 21), [255, 255, 255]);
    let page = out.get_dictionary(pages[2]).unwrap();
    for key in [&b"Annots"[..], b"Group", b"StructParents", b"Thumb", b"PieceInfo", b"Metadata", b"AA"] {
        assert!(!page.has(key), "{}", String::from_utf8_lossy(key));
    }
}

#[test]
fn rasterized_pages_keep_their_geometry() {
    let mut doc = fixture_with_type3();
    let page3 = page_ids(&doc)[2];
    let d = doc.get_dictionary_mut(page3).unwrap();
    d.set("Rotate", 90);
    d.set("CropBox", rect_array([12, 0, 612, 792]));
    let mut j = job(vec![area(3, 0.0, 0.0, 10.0, 20.0)]);
    // Visible size 792 x 600 points at 144 dpi.
    j.rasters = vec![white_raster(3, 1584, 1200, 144.0)];
    let (out, _) = redact(&bytes(doc), j).unwrap();
    let out = load_pdf(&out).unwrap();
    let page = page_ids(&out)[2];
    let vb = crate::stamp::geometry::VisibleBox::of_page(&out, page);
    assert_eq!((vb.x0, vb.y0, vb.x1, vb.y1, vb.rotate), (12.0, 0.0, 612.0, 792.0, 90));
    let (w, h, rgba) = image_of(&out, page);
    assert_eq!((w, h), (1584, 1200));
    // 10 x 20 points at 144 dpi: 20 x 40 px from the visible bottom-left.
    assert_eq!(&rgba[4 * ((h - 1) * w)..4 * ((h - 1) * w) + 3], [0, 0, 0]);
    assert_eq!(&rgba[4 * ((h - 40) * w + 19)..4 * ((h - 40) * w + 19) + 3], [0, 0, 0]);
    assert_eq!(&rgba[4 * ((h - 41) * w)..4 * ((h - 41) * w) + 3], [255, 255, 255]);
}

#[test]
fn rasters_are_validated() {
    let pdf = bytes(fixture_with_type3());
    let with = |raster: Option<PageRaster>| {
        let mut j = job(vec![area(3, 0.0, 0.0, 10.0, 10.0)]);
        j.rasters = raster.into_iter().collect();
        redact(&pdf, j).map(|_| ()).unwrap_err()
    };
    assert!(with(None).starts_with("Invalid redact settings: raster (page 3: font T: Type3"));
    assert_eq!(with(Some(white_raster(3, 600, 792, 72.0))), "Invalid redact settings: raster");
    assert_eq!(with(Some(white_raster(3, 612, 792, 0.0))), "Invalid redact settings: raster");
    let mut short = white_raster(3, 612, 792, 72.0);
    short.rgba.pop();
    assert_eq!(with(Some(short)), "Invalid redact settings: raster");
    // Within 2 px is accepted.
    let mut j = job(vec![area(3, 0.0, 0.0, 10.0, 10.0)]);
    j.rasters = vec![white_raster(3, 614, 790, 72.0)];
    assert!(redact(&pdf, j).is_ok());
}

#[test]
fn boxes_keep_the_page_space_when_the_content_pops_too_far() {
    // An extra Q, then a scaled CTM: the boxes must still land on the areas.
    let doc = one_page("Q 2 0 0 2 0 0 cm 0 0 1 rg 400 400 5 5 re f", |_, _| {});
    let (out, _) = redact(&bytes(doc), job(vec![area(1, 100.0, 100.0, 10.0, 10.0)])).unwrap();
    let out = load_pdf(&out).unwrap();
    let page = page_ids(&out)[0];
    let boxes: Vec<Rect> = super::verify::page_events(&out, page)
        .unwrap()
        .into_iter()
        .filter_map(|e| match e {
            super::interp::Event::Path(p) => p.bbox_user,
            _ => None,
        })
        .collect();
    assert!(boxes.contains(&Rect { x0: 100.0, y0: 100.0, x1: 110.0, y1: 110.0 }), "{boxes:?}");
}

fn planted(doc: Document, a: RedactRect) -> Result<(), String> {
    plant_leak_for_tests(true);
    let result = redact(&bytes(doc), job(vec![a])).map(|_| ());
    plant_leak_for_tests(false);
    result
}

#[test]
fn verification_exempts_only_what_this_job_drew() {
    // A path shaped exactly like the area, with an "L" cut out inside it.
    let shaped = "300 300 m 310 300 l 310 320 l 300 320 l h 302 302 m 303 302 l 303 318 l 302 318 l h \
        302 302 m 308 302 l 308 303 l 302 303 l h f*";
    let failed = Err("Redaction verification failed on page 1".to_string());
    assert_eq!(planted(one_page(shaped, |_, _| {}), area(1, 300.0, 300.0, 10.0, 20.0)), failed);
    // A source image named like the engine's copies.
    let named = one_page("q 20 0 0 20 300 300 cm /RedactedIm7 Do Q", |doc, page| {
        let image = doc.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Image", "Width" => 1, "Height" => 1,
                "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8,
            },
            vec![100],
        ));
        doc.get_dictionary_mut(page).unwrap().set("Resources", dictionary! { "XObject" => dictionary! { "RedactedIm7" => image } });
    });
    assert_eq!(planted(named.clone(), area(1, 300.0, 300.0, 10.0, 10.0)), failed);
    // Without the leak both are redacted and pass verification; the tag
    // that identified the new image is not delivered.
    let (out, summary) = redact(&bytes(named), job(vec![area(1, 300.0, 300.0, 10.0, 10.0)])).unwrap();
    assert_eq!(summary.images_redacted, 1);
    let out = load_pdf(&out).unwrap();
    assert!(!out.objects.values().any(|o| matches!(o, Object::Stream(s) if s.dict.has(super::verify::TAG_KEY.as_bytes()))));
}

#[test]
fn a_rasterized_page_shows_exactly_one_tagged_image() {
    let tag = b"0123456789abcdef".to_vec();
    let page_with = |content: &str, tagged: bool| {
        let doc = one_page(content, |doc, page| {
            let mut dict = dictionary! {
                "Type" => "XObject", "Subtype" => "Image", "Width" => 1, "Height" => 1,
                "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8,
            };
            if tagged {
                dict.set(super::verify::TAG_KEY, Object::String(b"0123456789abcdef".to_vec(), StringFormat::Hexadecimal));
            }
            let image = doc.add_object(Stream::new(dict, vec![100]));
            let font = doc.add_object(helvetica());
            doc.get_dictionary_mut(page)
                .unwrap()
                .set("Resources", dictionary! { "XObject" => dictionary! { "P" => image }, "Font" => dictionary! { "H" => font } });
        });
        let page = page_ids(&doc)[0];
        super::verify::verify_raster_page(&doc, page, &tag)
    };
    assert!(page_with("q 612 0 0 792 0 0 cm /P Do Q", true));
    assert!(!page_with("q 612 0 0 792 0 0 cm /P Do Q", false), "not this job's image");
    assert!(!page_with("q 612 0 0 792 0 0 cm /P Do Q /P Do", true), "two images");
    assert!(!page_with("q 612 0 0 792 0 0 cm /P Do Q 0 0 5 5 re f", true), "a path");
    assert!(!page_with("q 612 0 0 792 0 0 cm /P Do Q BT /H 1 Tf 3 Tr (x) Tj ET", true), "invisible text");
}

#[test]
fn soft_mask_group_content_under_an_area_needs_a_raster_whatever_its_box() {
    // The group's /BBox is small and far away, but its content draws text
    // under the area.
    let doc = one_page("q /GS1 gs 0 g 0 0 50 50 re f Q", |doc, page| {
        let font = doc.add_object(helvetica());
        let group = doc.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Form", "BBox" => rect_array([0, 0, 50, 50]),
                "Group" => dictionary! { "S" => "Transparency" },
                "Resources" => dictionary! { "Font" => dictionary! { "H" => font } },
            },
            b"BT /H 10 Tf 100 700 Td (SECRETOUTSIDE) Tj ET".to_vec(),
        ));
        let gs = dictionary! { "Type" => "ExtGState", "SMask" => dictionary! { "S" => "Luminosity", "G" => group } };
        doc.get_dictionary_mut(page).unwrap().set("Resources", dictionary! { "ExtGState" => dictionary! { "GS1" => gs } });
    });
    assert!(raster_needed(doc.clone(), vec![area(1, 95.0, 695.0, 100.0, 15.0)]));
    // Areas missing both its box and its content: fine.
    assert!(!raster_needed(doc, vec![area(1, 300.0, 300.0, 10.0, 10.0)]));
}

#[test]
fn rasters_of_pages_with_a_user_unit_may_be_sized_either_way() {
    let mut doc = fixture_with_type3();
    let page3 = page_ids(&doc)[2];
    doc.get_dictionary_mut(page3).unwrap().set("UserUnit", 2);
    let pdf = bytes(doc);
    let with = |w: u32, h: u32| {
        let mut j = job(vec![area(3, 0.0, 0.0, 10.0, 10.0)]);
        j.rasters = vec![white_raster(3, w, h, 72.0)];
        redact(&pdf, j).map(|_| ())
    };
    // In points (as pdf.js 4 renders it), or in UserUnit-scaled points.
    assert_eq!(with(612, 792), Ok(()));
    assert_eq!(with(1224, 1584), Ok(()));
    assert_eq!(with(900, 1100), Err("Invalid redact settings: raster".to_string()));
}

/// A soft-mask ExtGState whose group (small box, far away) has `content` and
/// `resources` (none when None).
fn soft_mask_gs(doc: &mut Document, content: &str, resources: Option<Dictionary>) -> Dictionary {
    let mut dict = dictionary! {
        "Type" => "XObject", "Subtype" => "Form", "BBox" => rect_array([0, 0, 10, 10]),
        "Group" => dictionary! { "S" => "Transparency" },
    };
    if let Some(res) = resources {
        dict.set("Resources", res);
    }
    let group = doc.add_object(Stream::new(dict, content.as_bytes().to_vec()));
    dictionary! { "Type" => "ExtGState", "SMask" => dictionary! { "S" => "Luminosity", "G" => group } }
}

/// A form drawing (SECRET) at (100, 700).
fn secret_form(doc: &mut Document) -> ObjectId {
    let font = doc.add_object(helvetica());
    doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Form", "BBox" => rect_array([0, 0, 612, 792]),
            "Resources" => dictionary! { "Font" => dictionary! { "H" => font } },
        },
        b"BT /H 10 Tf 100 700 Td (SECRET) Tj ET".to_vec(),
    ))
}

#[test]
fn soft_masks_nested_in_soft_mask_groups_are_checked() {
    let doc = one_page("q /GS1 gs 0 0 5 5 re f Q", |doc, page| {
        let secret = secret_form(doc);
        let inner = soft_mask_gs(doc, "/S Do", Some(dictionary! { "XObject" => dictionary! { "S" => secret } }));
        let outer = soft_mask_gs(doc, "/GS2 gs 0 0 5 5 re f", Some(dictionary! { "ExtGState" => dictionary! { "GS2" => inner } }));
        doc.get_dictionary_mut(page).unwrap().set("Resources", dictionary! { "ExtGState" => dictionary! { "GS1" => outer } });
    });
    let a = area(1, 95.0, 695.0, 60.0, 15.0);
    assert!(raster_needed(doc.clone(), vec![a.clone()]));
    assert_eq!(planted(doc, a), Err("Redaction verification failed on page 1".to_string()));
}

#[test]
fn soft_mask_groups_are_read_with_the_resources_where_they_are_set() {
    // The form sets the soft mask; its group has no /Resources, so /X is the
    // form's (text under the area), not the page's (empty).
    // The page draws its own (empty) /X too, so the name survives the rebuild.
    let doc = one_page("/Fm Do /X Do", |doc, page| {
        let secret = secret_form(doc);
        let empty = doc.add_object(Stream::new(
            dictionary! { "Type" => "XObject", "Subtype" => "Form", "BBox" => rect_array([0, 0, 1, 1]) },
            Vec::new(),
        ));
        let gs = soft_mask_gs(doc, "/X Do", None);
        let form = doc.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Form", "BBox" => rect_array([0, 0, 612, 792]),
                "Resources" => dictionary! { "ExtGState" => dictionary! { "GS1" => gs }, "XObject" => dictionary! { "X" => secret } },
            },
            b"q /GS1 gs 0 0 5 5 re f Q".to_vec(),
        ));
        doc.get_dictionary_mut(page)
            .unwrap()
            .set("Resources", dictionary! { "XObject" => dictionary! { "Fm" => form, "X" => empty } });
    });
    let a = area(1, 95.0, 695.0, 60.0, 15.0);
    assert!(raster_needed(doc.clone(), vec![a.clone()]));
    assert_eq!(planted(doc, a), Err("Redaction verification failed on page 1".to_string()));
}
