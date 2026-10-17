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

// ---- final review probes ------------------------------------------------

/// Two pages sharing one /Resources (`shared`): page 2 (dropped) draws
/// `SECRET_IMG` from it. `kept` adds page 1's extra resources and /Annots;
/// it receives (doc, page 2 content, shared resources, secret image).
fn two_page_probe(
    kept: impl FnOnce(&mut Document, ObjectId, ObjectId, ObjectId) -> (Dictionary, Option<Object>),
) -> Vec<u8> {
    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();
    let [p1, p2] = [(); 2].map(|_| doc.new_object_id());
    let secret = image(&mut doc, b"SECRET_IMG");
    let used = image(&mut doc, b"USEDIMG");
    let shared = doc.add_object(dictionary! {
        "XObject" => dictionary! { "Im_used" => used, "Im_secret" => secret },
    });
    let c2 = doc.add_object(Stream::new(
        dictionary! {},
        b"/Im_secret Do (SECRET_P2TEXT) Tj".to_vec(),
    ));
    let (extra, annots) = kept(&mut doc, c2, shared, secret);
    let mut res = dictionary! { "XObject" => dictionary! { "Im_used" => used } };
    for (k, v) in extra.iter() {
        res.set(k.clone(), v.clone());
    }
    let c1 = doc.add_object(Stream::new(
        dictionary! {},
        b"/Im_used Do BT /F3 12 Tf (a) Tj ET".to_vec(),
    ));
    let mut d1 = dictionary! {
        "Type" => "Page", "Parent" => pages_id, "MediaBox" => rect(),
        "Resources" => res, "Contents" => c1,
    };
    if let Some(a) = annots {
        d1.set("Annots", a);
    }
    doc.objects.insert(p1, Object::Dictionary(d1));
    doc.objects.insert(
        p2,
        Object::Dictionary(dictionary! {
            "Type" => "Page", "Parent" => pages_id, "MediaBox" => rect(),
            "Resources" => shared, "Contents" => c2,
        }),
    );
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![Object::from(p1), p2.into()], "Count" => 2 }),
    );
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog);
    let mut buf = Vec::new();
    doc.save_to(&mut buf).unwrap();
    buf
}

/// Keep page 1 only; the secrets of page 2 must not appear.
fn assert_page_two_gone(name: &str, src: &[u8]) {
    let plan = [page_plan::PlanEntry::Page {
        src: 0,
        page: 1,
        rotate: 0,
    }];
    let out = page_plan::apply_plan(&[src], &plan).unwrap();
    let found = leaked(&out);
    assert!(found.is_empty(), "{name} leaked: {found:?}");
}

#[test]
fn type3_font_resources_are_trimmed() {
    let src = two_page_probe(|doc, _c2, shared, _secret| {
        let glyph = doc.add_object(Stream::new(dictionary! {}, b"0 0 d0 /Im_used Do".to_vec()));
        let font = doc.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type3", "FontBBox" => rect(),
            "FontMatrix" => vec![0.001.into(), 0.into(), 0.into(), 0.001.into(), 0.into(), 0.into()],
            "CharProcs" => dictionary! { "a" => glyph },
            "Encoding" => dictionary! { "Differences" => vec![97.into(), Object::Name(b"a".to_vec())] },
            "FirstChar" => 97, "LastChar" => 97, "Widths" => vec![1000.into()],
            "Resources" => shared,
        });
        (dictionary! { "Font" => dictionary! { "F3" => font } }, None)
    });
    assert!(leaked(&src).contains(&"SECRET_IMG"), "probe planted");
    assert_page_two_gone("type3 resources", &src);
}

#[test]
fn annotation_arrays_and_border_styles_carry_no_references() {
    // A link /BS with a stray key to page 2's content, and a comment whose
    // /C, /InkList and /RD hide references among numbers.
    let src = two_page_probe(|doc, c2, _shared, secret| {
        let link = doc.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Link", "Rect" => rect(),
            "BS" => dictionary! { "W" => 1, "S" => "S", "Evil" => c2 },
            "A" => dictionary! { "S" => "URI", "URI" => str_obj("https://x.test") },
        });
        let square = doc.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Square", "Rect" => rect(),
            "C" => vec![1.into(), secret.into(), 0.into()],
            "RD" => vec![0.into(), 0.into(), 0.into(), c2.into()],
        });
        let ink = doc.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Ink", "Rect" => rect(),
            "InkList" => vec![vec![Object::from(1), 2.into(), secret.into(), 4.into()].into()],
        });
        (
            dictionary! {},
            Some(vec![link.into(), square.into(), ink.into()].into()),
        )
    });
    assert_page_two_gone("annotation values", &src);
}

#[test]
fn sanitize_drops_embedded_file_behind_reference_xobject() {
    // A reference XObject (/Ref) points at an untyped file specification
    // whose /EF holds an attachment.
    let src = two_page_probe(|doc, _c2, _shared, _secret| {
        let file = doc.add_object(
            Stream::new(dictionary! {}, b"SECRET_EMB attachment".to_vec()).with_compression(false),
        );
        let form = doc.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Form", "BBox" => rect(),
                "Ref" => dictionary! {
                    "F" => dictionary! { "F" => str_obj("x.pdf"), "EF" => dictionary! { "F" => file } },
                    "Page" => 0,
                },
            },
            b"".to_vec(),
        ));
        (
            dictionary! { "XObject" => dictionary! { "Im_used" => form } },
            None,
        )
    });
    let (out, _) = crate::doc_tools::sanitize(&src, true).unwrap();
    let bytes = {
        let doc = Document::load_mem(&out).unwrap();
        let mut chunks = vec![out.clone()];
        for obj in doc.objects.values() {
            collect_bytes(obj, &mut chunks);
        }
        chunks.concat()
    };
    assert!(!contains(&bytes, "SECRET_EMB"), "attachment kept");
    assert!(!contains(&bytes, "/Ref"), "/Ref kept on the form");
}
