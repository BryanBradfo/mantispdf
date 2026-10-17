//! Leak probes (sub-project 2c): page 1 of one source is kept, and it holds
//! references into pages 2-3 through every path known to have leaked. Each
//! path leads to a unique `SECRET_*` value reachable only from pages 2-3, so
//! any secret in the output means a dropped page left something behind.

use crate::pdf_util::get_inherited_attr;
use crate::{page_plan, split};
use lopdf::{Dictionary, Document, Object, ObjectId, Stream, dictionary};

/// Every secret planted by `probe_pdf`, one per leak path.
const SECRETS: [&str; 11] = [
    "SECRET_DEST",
    "SECRET_FIELDV",
    "SECRET_FIELDAP",
    "SECRET_IRT",
    "SECRET_RESET",
    "SECRET_HIDE",
    "SECRET_NEXT",
    "SECRET_PAGEAA",
    "SECRET_IMG",
    "SECRET_FONTREF",
    "SECRET_FLATE",
];

fn rect() -> Object {
    vec![0.into(), 0.into(), 10.into(), 10.into()].into()
}

fn str_obj(s: &str) -> Object {
    Object::string_literal(s)
}

fn image(doc: &mut Document, payload: &[u8]) -> ObjectId {
    doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Image",
            "Width" => payload.len() as i64, "Height" => 1,
            "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8,
        },
        payload.to_vec(),
    ))
}

/// Normal appearance dictionary whose form draws `text`.
fn appearance(doc: &mut Document, text: &str) -> Dictionary {
    let form = doc.add_object(Stream::new(
        dictionary! { "Type" => "XObject", "Subtype" => "Form", "BBox" => rect() },
        format!("BT ({text}) Tj ET").into_bytes(),
    ));
    dictionary! { "N" => form }
}

/// Three pages; page 1 (kept) reaches pages 2-3 through every known path.
fn probe_pdf() -> Vec<u8> {
    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();
    let [p1, p2, p3] = [(); 3].map(|_| doc.new_object_id());

    // SECRET_IMG: one shared /Resources on /Pages; Im_secret is drawn by p2 only.
    // SECRET_FONTREF: p1's font carries a stray reference to p3.
    let im_used = image(&mut doc, b"USEDIMG");
    let im_secret = image(&mut doc, b"SECRET_IMG");
    let font = doc.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica", "Evil" => p3,
    });
    let resources = dictionary! {
        "Font" => dictionary! { "F1" => font },
        "XObject" => dictionary! { "Im_used" => im_used, "Im_secret" => im_secret },
    };

    // SECRET_DEST: a link on p1 whose /Dest is p2.
    let link_dest = doc.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Link", "Rect" => rect(),
        "Dest" => vec![p2.into(), "Fit".into()],
    });

    // SECRET_FIELDV / SECRET_FIELDAP: p1's widget belongs to a field whose
    // sibling field has a value and a widget on p2 with an appearance.
    let field = doc.new_object_id();
    let sibling = doc.new_object_id();
    let keep_ap = appearance(&mut doc, "KEEPAP");
    let widget_p1 = doc.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Widget", "Rect" => rect(), "Parent" => field,
        "AP" => keep_ap,
    });
    let secret_ap = appearance(&mut doc, "SECRET_FIELDAP");
    let widget_p2 = doc.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Widget", "Rect" => rect(), "Parent" => sibling,
        "AP" => secret_ap,
    });
    doc.objects.insert(
        sibling,
        Object::Dictionary(dictionary! {
            "T" => str_obj("sibling"), "Parent" => field, "V" => str_obj("SECRET_FIELDV"),
            "Kids" => vec![widget_p2.into()],
        }),
    );
    doc.objects.insert(
        field,
        Object::Dictionary(dictionary! {
            "FT" => "Tx", "T" => str_obj("field"),
            "Kids" => vec![widget_p1.into(), sibling.into()],
        }),
    );

    // SECRET_IRT: a reply on p1 to a note on p2.
    let note_p2 = doc.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Text", "Rect" => rect(),
        "Contents" => str_obj("SECRET_IRT"),
    });
    let reply_p1 = doc.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Text", "Rect" => rect(),
        "IRT" => note_p2, "Contents" => str_obj("reply"),
    });

    // SECRET_RESET: ResetForm naming a field (with a value) on p3.
    let field_p3 = doc.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Widget", "FT" => "Tx", "T" => str_obj("f3"),
        "Rect" => rect(), "V" => str_obj("SECRET_RESET"),
    });
    let link_reset = doc.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Link", "Rect" => rect(),
        "A" => dictionary! { "S" => "ResetForm", "Fields" => vec![field_p3.into()] },
    });

    // SECRET_HIDE: Hide action targeting a widget on p3.
    let hide_ap = appearance(&mut doc, "SECRET_HIDE");
    let widget_hide = doc.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Widget", "FT" => "Tx", "T" => str_obj("hide"),
        "Rect" => rect(), "AP" => hide_ap,
    });
    let link_hide = doc.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Link", "Rect" => rect(),
        "A" => dictionary! { "S" => "Hide", "T" => widget_hide },
    });

    // SECRET_NEXT: GoTo p1, chained /Next Hide on an annotation of p3.
    let annot_next = doc.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Text", "Rect" => rect(),
        "Contents" => str_obj("SECRET_NEXT"),
    });
    let link_next = doc.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Link", "Rect" => rect(),
        "A" => dictionary! {
            "S" => "GoTo", "D" => vec![p1.into(), "Fit".into()],
            "Next" => dictionary! { "S" => "Hide", "T" => annot_next },
        },
    });

    let content = |doc: &mut Document, text: &str| {
        doc.add_object(Stream::new(dictionary! {}, text.as_bytes().to_vec()))
    };
    let c1 = content(
        &mut doc,
        "q 7 0 0 1 0 0 cm /Im_used Do Q BT /F1 12 Tf (KEEPME) Tj ET",
    );
    let c2 = content(
        &mut doc,
        "q 10 0 0 1 0 0 cm /Im_secret Do Q BT /F1 12 Tf (SECRET_DEST) Tj ET",
    );
    // SECRET_FONTREF lives in p3, reached from p1 only through the font's /Evil.
    let c3 = content(&mut doc, "BT /F1 12 Tf (SECRET_FONTREF) Tj ET");
    // SECRET_FLATE: a Flate-compressed second content stream of p2, so the
    // secret is invisible to a raw byte search and only the decompressed-stream
    // check of `leaked` can see it.
    let mut flate = Stream::new(
        dictionary! {},
        format!("BT (SECRET_FLATE) Tj ET {}", "0 0 m 1 1 l S ".repeat(40)).into_bytes(),
    );
    flate.compress().unwrap();
    let c2_flate = doc.add_object(flate);
    let media = || -> Object { vec![0.into(), 0.into(), 612.into(), 792.into()].into() };
    let refs = |ids: &[ObjectId]| -> Vec<Object> { ids.iter().map(|&id| id.into()).collect() };

    doc.objects.insert(
        p1,
        Object::Dictionary(dictionary! {
            "Type" => "Page", "Parent" => pages_id, "MediaBox" => media(), "Contents" => c1,
            "Annots" => refs(&[link_dest, widget_p1, reply_p1, link_reset, link_hide, link_next]),
            // SECRET_PAGEAA: page-open JavaScript.
            "AA" => dictionary! {
                "O" => dictionary! { "S" => "JavaScript", "JS" => str_obj("SECRET_PAGEAA") },
            },
        }),
    );
    doc.objects.insert(
        p2,
        Object::Dictionary(dictionary! {
            "Type" => "Page", "Parent" => pages_id, "MediaBox" => media(), "Contents" => refs(&[c2, c2_flate]),
            "Annots" => refs(&[widget_p2, note_p2]),
        }),
    );
    doc.objects.insert(
        p3,
        Object::Dictionary(dictionary! {
            "Type" => "Page", "Parent" => pages_id, "MediaBox" => media(), "Contents" => c3,
            "Annots" => refs(&[field_p3, widget_hide, annot_next]),
        }),
    );
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages", "Kids" => refs(&[p1, p2, p3]), "Count" => 3,
            "Resources" => resources,
        }),
    );
    let catalog = doc.add_object(dictionary! {
        "Type" => "Catalog", "Pages" => pages_id,
        "AcroForm" => dictionary! { "Fields" => refs(&[field, field_p3, widget_hide]) },
    });
    doc.trailer.set("Root", catalog);
    let mut buf = Vec::new();
    doc.save_to(&mut buf).unwrap();
    buf
}

fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack
        .windows(needle.len())
        .any(|w| w == needle.as_bytes())
}

/// Every byte string an object exposes: strings, names, dictionary keys and
/// stream content (decoded when possible, raw otherwise).
fn collect_bytes(obj: &Object, into: &mut Vec<Vec<u8>>) {
    match obj {
        Object::String(bytes, _) | Object::Name(bytes) => into.push(bytes.clone()),
        Object::Array(items) => items.iter().for_each(|o| collect_bytes(o, into)),
        Object::Dictionary(dict) => collect_dict(dict, into),
        Object::Stream(stream) => {
            collect_dict(&stream.dict, into);
            into.push(
                stream
                    .decompressed_content()
                    .unwrap_or_else(|_| stream.content.clone()),
            );
        }
        _ => {}
    }
}

fn collect_dict(dict: &Dictionary, into: &mut Vec<Vec<u8>>) {
    for (key, value) in dict.iter() {
        into.push(key.clone());
        collect_bytes(value, into);
    }
}

/// The secrets found in `out`, in raw bytes or in any parsed object.
fn leaked(out: &[u8]) -> Vec<&'static str> {
    let doc = Document::load_mem(out).expect("output parses");
    let mut chunks = vec![out.to_vec()];
    for obj in doc.objects.values() {
        collect_bytes(obj, &mut chunks);
    }
    collect_dict(&doc.trailer, &mut chunks);
    let mut found: Vec<&str> = SECRETS
        .iter()
        .copied()
        .filter(|s| chunks.iter().any(|c| contains(c, s)))
        .collect();
    if found.is_empty() && chunks.iter().any(|c| contains(c, "SECRET_")) {
        found.push("SECRET_ (unlisted)");
    }
    found
}

/// The single output page still shows its own text and its own image.
fn assert_page_one_intact(out: &[u8]) {
    let doc = Document::load_mem(out).unwrap();
    let pages = doc.get_pages();
    assert_eq!(pages.len(), 1);
    let id = pages[&1];
    let content = doc.get_page_content(id).unwrap();
    assert!(contains(&content, "KEEPME"), "page 1 content lost");
    let res = match get_inherited_attr(&doc, id, b"Resources").expect("page resources") {
        Object::Reference(r) => doc.get_dictionary(r).unwrap().clone(),
        Object::Dictionary(d) => d,
        other => panic!("unexpected /Resources {other:?}"),
    };
    let xobjects = res.get(b"XObject").unwrap().as_dict().unwrap();
    let image = xobjects.get(b"Im_used").unwrap().as_reference().unwrap();
    let image = doc.get_object(image).unwrap().as_stream().unwrap();
    assert_eq!(image.content, b"USEDIMG", "page 1 image lost");
}

fn assert_clean(tool: &str, out: &[u8]) {
    let found = leaked(out);
    assert!(found.is_empty(), "{tool} leaked: {found:?}");
    // Fresh catalog: no /AcroForm, /Names, /OpenAction... and no /Info.
    let doc = Document::load_mem(out).unwrap();
    let mut keys: Vec<&[u8]> = doc
        .catalog()
        .unwrap()
        .iter()
        .map(|(k, _)| k.as_slice())
        .collect();
    keys.sort();
    assert_eq!(keys, [&b"Pages"[..], b"Type"], "{tool}: catalog keys");
    assert!(!doc.trailer.has(b"Info"), "{tool}: /Info in trailer");
}

#[test]
fn apply_plan_leaves_nothing_of_dropped_pages() {
    let src = probe_pdf();
    let plan = [page_plan::PlanEntry::Page {
        src: 0,
        page: 1,
        rotate: 0,
    }];
    let out = page_plan::apply_plan(&[&src], &plan).unwrap();
    assert_clean("apply_plan", &out);
}

#[test]
fn apply_plan_keeps_page_one() {
    let src = probe_pdf();
    let plan = [page_plan::PlanEntry::Page {
        src: 0,
        page: 1,
        rotate: 0,
    }];
    assert_page_one_intact(&page_plan::apply_plan(&[&src], &plan).unwrap());
}

#[test]
fn split_leaves_nothing_of_dropped_pages() {
    let src = probe_pdf();
    assert_clean(
        "extract_page_range",
        &split::extract_page_range(&src, 1, 1).unwrap(),
    );
}

#[test]
fn split_from_parsed_doc_leaves_nothing_of_dropped_pages() {
    let src = probe_pdf();
    let doc = Document::load_mem(&src).unwrap();
    let out = split::extract_range_from_doc(&doc, 3, 1, 1).unwrap();
    assert_clean("extract_range_from_doc", &out);
}

#[test]
fn split_keeps_page_one() {
    let src = probe_pdf();
    assert_page_one_intact(&split::extract_page_range(&src, 1, 1).unwrap());
    let doc = Document::load_mem(&src).unwrap();
    assert_page_one_intact(&split::extract_range_from_doc(&doc, 3, 1, 1).unwrap());
}

#[test]
fn source_really_holds_every_secret() {
    // Guards the probe itself: a typo in the fixture must not pass silently.
    // `leaked` also looks inside compressed streams.
    let src = probe_pdf();
    let found = leaked(&src);
    for secret in SECRETS {
        assert!(found.contains(&secret), "{secret} not planted");
    }
}

#[test]
fn detector_sees_inside_flate_streams() {
    let src = probe_pdf();
    assert!(
        !contains(&src, "SECRET_FLATE"),
        "must be hidden from raw bytes"
    );
    assert!(leaked(&src).contains(&"SECRET_FLATE"));
}

#[test]
fn sanitize_leaves_nothing_of_dropped_pages() {
    // Keeping every page, nothing reachable only through forms, actions or
    // JavaScript may survive. Text drawn on kept pages (DEST, FONTREF, IMG,
    // FLATE, and HIDE/FIELDAP via flattened widgets) is legitimately kept.
    let src = probe_pdf();
    let (out, _) = crate::doc_tools::sanitize(&src, true).unwrap();
    let found = leaked(&out);
    for gone in ["SECRET_RESET", "SECRET_PAGEAA", "SECRET_FIELDV"] {
        assert!(!found.contains(&gone), "sanitize leaked {gone}");
    }
    // Comments are only kept on request.
    let (no_comments, _) = crate::doc_tools::sanitize(&src, false).unwrap();
    let found = leaked(&no_comments);
    for gone in ["SECRET_NEXT", "SECRET_IRT"] {
        assert!(!found.contains(&gone), "sanitize leaked {gone}");
    }
    let doc = Document::load_mem(&out).unwrap();
    assert_eq!(doc.get_pages().len(), 3);
    let page1 = doc.get_pages()[&1];
    assert!(contains(&doc.get_page_content(page1).unwrap(), "KEEPME"));
    assert!(!doc.trailer.has(b"Info"));
}
