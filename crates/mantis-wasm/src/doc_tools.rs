//! Whole-document tools: sanitize, metadata read/write/removal and unlock.

use crate::rebuild::{OutPage, Policy, RebuildReport, rebuild_document};
use lopdf::{Dictionary, Document, Object, ObjectId};

/// Parse a PDF, refusing one that still needs a user password: lopdf then
/// returns Ok with an empty page tree and /Encrypt left in the trailer.
pub(crate) fn load(bytes: &[u8]) -> Result<Document, String> {
    crate::pdf_util::load_pdf(bytes)
}

fn save(doc: &mut Document) -> Result<Vec<u8>, String> {
    crate::pdf_util::save_pdf(doc)
}

/// Rebuild every page from the allowlist: no metadata, scripts, attachments,
/// outlines or form data survive; links stay, comments by choice, form
/// fields are flattened. JPEG images lose their Exif/GPS, XMP, MPF and
/// trailing data (`Policy::strip_image_metadata`).
pub fn sanitize(bytes: &[u8], keep_comments: bool) -> Result<(Vec<u8>, RebuildReport), String> {
    let doc = load(bytes)?;
    let pages: Vec<OutPage> = doc
        .get_pages()
        .values()
        .map(|&page| OutPage::Page {
            src: 0,
            page,
            rotate: 0,
        })
        .collect();
    let policy = Policy {
        keep_links: true,
        keep_comments,
        strip_image_metadata: true,
    };
    let (mut out, report) = rebuild_document(std::slice::from_ref(&doc), &pages, &policy)?;
    Ok((save(&mut out)?, report))
}

fn catalog_id(doc: &Document) -> Result<ObjectId, String> {
    doc.trailer
        .get(b"Root")
        .and_then(|o| o.as_reference())
        .map_err(|_| "PDF has no catalog".to_string())
}

fn strip_catalog_metadata(doc: &mut Document) -> Result<(), String> {
    let id = catalog_id(doc)?;
    if let Ok(cat) = doc.get_dictionary_mut(id) {
        cat.remove(b"Metadata");
    }
    Ok(())
}

/// Drop the document information dictionary, XMP and every /Metadata and
/// /PieceInfo entry. Pages, forms and outlines are kept as they are.
pub fn remove_metadata(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut doc = load(bytes)?;
    if let Some(Object::Reference(id)) = doc.trailer.get(b"Info").ok().cloned() {
        doc.objects.remove(&id);
    }
    doc.trailer.remove(b"Info");
    for obj in doc.objects.values_mut() {
        let dict = match obj {
            Object::Dictionary(d) => d,
            Object::Stream(s) => &mut s.dict,
            _ => continue,
        };
        dict.remove(b"Metadata");
        dict.remove(b"PieceInfo");
    }
    doc.prune_objects();
    save(&mut doc)
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Metadata {
    pub title: String,
    pub author: String,
    pub subject: String,
    pub keywords: String,
}

/// PDFDocEncoding for 0x18-0x1F and 0x80-0xA0 (ISO 32000 Annex D); the rest
/// matches Latin-1. 0x9F is undefined and maps to U+FFFD.
pub(crate) fn pdfdoc_char(b: u8) -> char {
    const LOW: [char; 8] = [
        '\u{2D8}', '\u{2C7}', '\u{2C6}', '\u{2D9}', '\u{2DD}', '\u{2DB}', '\u{2DA}', '\u{2DC}',
    ];
    const HIGH: [char; 33] = [
        '\u{2022}', '\u{2020}', '\u{2021}', '\u{2026}', '\u{2014}', '\u{2013}', '\u{192}',
        '\u{2044}', '\u{2039}', '\u{203A}', '\u{2212}', '\u{2030}', '\u{201E}', '\u{201C}',
        '\u{201D}', '\u{2018}', '\u{2019}', '\u{201A}', '\u{2122}', '\u{FB01}', '\u{FB02}',
        '\u{141}', '\u{152}', '\u{160}', '\u{178}', '\u{17D}', '\u{131}', '\u{142}', '\u{153}',
        '\u{161}', '\u{17E}', '\u{FFFD}', '\u{20AC}',
    ];
    match b {
        0x18..=0x1F => LOW[(b - 0x18) as usize],
        0x80..=0xA0 => HIGH[(b - 0x80) as usize],
        _ => b as char,
    }
}

/// PDF text string: UTF-16BE with a BOM, UTF-8 with a BOM (PDF 2.0),
/// otherwise PDFDocEncoding.
pub(crate) fn decode_text(bytes: &[u8]) -> String {
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        let units: Vec<u16> = rest
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        String::from_utf8_lossy(rest).into_owned()
    } else {
        bytes.iter().map(|&b| pdfdoc_char(b)).collect()
    }
}

fn encode_text(text: &str) -> Object {
    if text.is_ascii() {
        Object::string_literal(text)
    } else {
        let mut bytes = vec![0xFE, 0xFF];
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_be_bytes());
        }
        Object::string_literal(bytes)
    }
}

fn info_dict(doc: &Document) -> Option<&Dictionary> {
    match doc.trailer.get(b"Info").ok()? {
        Object::Reference(id) => doc.get_dictionary(*id).ok(),
        Object::Dictionary(d) => Some(d),
        _ => None,
    }
}

fn info_text(doc: &Document, info: &Dictionary, key: &[u8]) -> String {
    match info.get(key).ok().and_then(|o| doc.dereference(o).ok()) {
        Some((_, Object::String(bytes, _))) => decode_text(bytes),
        _ => String::new(),
    }
}

pub fn read_metadata(bytes: &[u8]) -> Result<Metadata, String> {
    let doc = load(bytes)?;
    let Some(info) = info_dict(&doc) else {
        return Ok(Metadata::default());
    };
    Ok(Metadata {
        title: info_text(&doc, info, b"Title"),
        author: info_text(&doc, info, b"Author"),
        subject: info_text(&doc, info, b"Subject"),
        keywords: info_text(&doc, info, b"Keywords"),
    })
}

/// Set the four fields (an empty value removes its key) and drop the XMP
/// packet so it cannot contradict the new values.
pub fn set_metadata(bytes: &[u8], m: &Metadata) -> Result<Vec<u8>, String> {
    let mut doc = load(bytes)?;
    let mut info = info_dict(&doc).cloned().unwrap_or_default();
    for (key, value) in [
        ("Title", &m.title),
        ("Author", &m.author),
        ("Subject", &m.subject),
        ("Keywords", &m.keywords),
    ] {
        if value.is_empty() {
            info.remove(key.as_bytes());
        } else {
            info.set(key, encode_text(value));
        }
    }
    match doc.trailer.get(b"Info").ok().cloned() {
        Some(Object::Reference(id)) => {
            doc.objects.insert(id, Object::Dictionary(info));
        }
        _ => {
            let id = doc.add_object(info);
            doc.trailer.set("Info", id);
        }
    }
    strip_catalog_metadata(&mut doc)?;
    doc.prune_objects();
    save(&mut doc)
}

/// Re-save without encryption. Authenticates with `password` (user or owner).
pub fn unlock(bytes: &[u8], password: &str) -> Result<Vec<u8>, String> {
    let mut doc = match Document::load_mem_with_password(bytes, password) {
        Ok(doc) => doc,
        Err(lopdf::Error::InvalidPassword)
        | Err(lopdf::Error::Decryption(lopdf::encryption::DecryptionError::IncorrectPassword)) => {
            return Err("Wrong password".to_string());
        }
        Err(e) => return Err(format!("Failed to parse PDF: {e}")),
    };
    if !doc.was_encrypted() {
        return Err("This PDF is not password-protected".to_string());
    }
    doc.trailer.remove(b"Encrypt");
    doc.encryption_state = None;
    save(&mut doc)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encrypt::encrypt_pdf_impl;
    use lopdf::{Stream, dictionary};

    fn contains(hay: &[u8], needle: &str) -> bool {
        hay.windows(needle.len()).any(|w| w == needle.as_bytes())
    }

    fn rect() -> Object {
        vec![0.into(), 0.into(), 100.into(), 20.into()].into()
    }

    /// One page carrying every kind of hidden content plus visible text.
    fn hidden_pdf() -> Vec<u8> {
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let page_id = doc.new_object_id();
        let ap = doc.add_object(Stream::new(
            dictionary! { "Type" => "XObject", "Subtype" => "Form", "BBox" => rect() },
            b"BT (FIELDLOOK) Tj ET".to_vec(),
        ));
        let widget = doc.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Widget", "FT" => "Tx", "T" => Object::string_literal("f"),
            "Rect" => rect(), "AP" => dictionary! { "N" => ap },
        });
        let link = doc.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Link", "Rect" => rect(),
            "A" => dictionary! { "S" => "URI", "URI" => Object::string_literal("https://example.com") },
        });
        let note = doc.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Text", "Rect" => rect(),
            "Contents" => Object::string_literal("SECRETNOTE"),
        });
        let content = doc.add_object(Stream::new(dictionary! {}, b"BT (VISIBLE) Tj ET".to_vec()));
        let page_xmp = doc.add_object(Stream::new(
            dictionary! { "Type" => "Metadata", "Subtype" => "XML" },
            b"<x>SECRETPAGEXMP</x>".to_vec(),
        ));
        let image_xmp = doc.add_object(Stream::new(
            dictionary! { "Type" => "Metadata", "Subtype" => "XML" },
            b"<x>SECRETIMGXMP</x>".to_vec(),
        ));
        let image = doc.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Image", "Width" => 1, "Height" => 1,
                "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8, "Metadata" => image_xmp,
            },
            vec![0u8],
        ));
        doc.objects.insert(
            page_id,
            Object::Dictionary(dictionary! {
                "Type" => "Page", "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
                "Contents" => content,
                "Annots" => vec![widget.into(), link.into(), note.into()],
                "PieceInfo" => dictionary! { "App" => Object::string_literal("SECRETPIECE") },
                "Metadata" => page_xmp,
                "Resources" => dictionary! { "XObject" => dictionary! { "Im1" => image } },
            }),
        );
        doc.objects.insert(
            pages_id,
            Object::Dictionary(
                dictionary! { "Type" => "Pages", "Kids" => vec![page_id.into()], "Count" => 1 },
            ),
        );
        let info = doc.add_object(dictionary! {
            "Title" => Object::string_literal("SECRETINFO"),
            "Author" => Object::string_literal("Old Author"),
            "Creator" => Object::string_literal("SECRETCREATOR"),
        });
        doc.trailer.set("Info", info);
        let xmp = doc.add_object(Stream::new(
            dictionary! { "Type" => "Metadata", "Subtype" => "XML" },
            b"<x>SECRETXMP</x>".to_vec(),
        ));
        let outline_item = doc.new_object_id();
        let outlines = doc.add_object(dictionary! {
            "Type" => "Outlines", "First" => outline_item, "Last" => outline_item, "Count" => 1,
        });
        doc.objects.insert(
            outline_item,
            Object::Dictionary(dictionary! {
                "Title" => Object::string_literal("SECRETOUTLINE"), "Parent" => outlines,
                "Dest" => vec![page_id.into(), "Fit".into()],
            }),
        );
        let file_stream = doc.add_object(Stream::new(
            dictionary! { "Type" => "EmbeddedFile" },
            b"SECRETFILE".to_vec(),
        ));
        let filespec = doc.add_object(dictionary! {
            "Type" => "Filespec", "F" => Object::string_literal("a.txt"),
            "EF" => dictionary! { "F" => file_stream },
        });
        let catalog = doc.add_object(dictionary! {
            "Type" => "Catalog", "Pages" => pages_id, "Metadata" => xmp,
            "Outlines" => outlines,
            "OpenAction" => dictionary! { "S" => "JavaScript", "JS" => Object::string_literal("SECRETJS") },
            "Names" => dictionary! { "EmbeddedFiles" => dictionary! {
                "Names" => vec![Object::string_literal("a.txt"), filespec.into()],
            } },
            "AcroForm" => dictionary! { "Fields" => vec![widget.into()] },
        });
        doc.trailer.set("Root", catalog);
        let mut buf = Vec::new();
        doc.save_to(&mut buf).unwrap();
        buf
    }

    const ALL_SECRETS: [&str; 7] = [
        "SECRETINFO",
        "SECRETXMP",
        "SECRETJS",
        "SECRETFILE",
        "SECRETOUTLINE",
        "SECRETCREATOR",
        "SECRETPIECE",
    ];

    #[test]
    fn sanitize_removes_everything_hidden() {
        let src = hidden_pdf();
        for s in ALL_SECRETS.iter().chain(&["SECRETNOTE"]) {
            assert!(contains(&src, s), "{s} not planted");
        }
        let (out, report) = sanitize(&src, false).unwrap();
        for s in ALL_SECRETS.iter().chain(&["SECRETNOTE"]) {
            assert!(!contains(&out, s), "{s} survived");
        }
        assert!(contains(&out, "https://example.com"), "URI link kept");
        assert_eq!(report.fields_flattened, 1);
        assert_eq!(report.comments_dropped, 1);
        assert_eq!(report.links_kept, 1);
        let doc = Document::load_mem(&out).unwrap();
        assert!(!doc.trailer.has(b"Info"));
        assert_eq!(doc.get_pages().len(), 1);

        let (kept, report) = sanitize(&src, true).unwrap();
        assert!(contains(&kept, "SECRETNOTE"));
        assert_eq!(report.comments_kept, 1);
        assert!(!contains(&kept, "SECRETJS"));
    }

    /// A JPEG carrying Exif GPS, an MPF index and a trailing secondary JPEG.
    fn leaky_jpeg() -> Vec<u8> {
        let seg = |m: u8, body: &[u8]| {
            let mut v = vec![0xFF, m, 0, (body.len() + 2) as u8];
            v.extend_from_slice(body);
            v
        };
        let mut v = vec![0xFF, 0xD8];
        v.extend(seg(0xE0, b"JFIF\0"));
        v.extend(seg(0xE1, b"Exif\0\0SECRETGPS"));
        v.extend(seg(0xE2, b"MPF\0SECRETMPF"));
        v.extend(seg(0xC0, &[8, 0, 1, 0, 1, 1, 1, 0x11, 0]));
        v.extend_from_slice(&[0xFF, 0xDA, 0, 4, 1, 0, 0x12, 0xFF, 0xD9]);
        v.extend_from_slice(b"\xFF\xD8SECRETTRAILER\xFF\xD9");
        v
    }

    fn image_stream(width: i64, filter: Object, content: Vec<u8>) -> Stream {
        let dict = dictionary! {
            "Type" => "XObject", "Subtype" => "Image", "Width" => width, "Height" => 1,
            "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8, "Filter" => filter,
        };
        Stream::new(dict, content).with_compression(false)
    }

    /// Two pages drawing a shared DCT image (/Filter name), plus a 1-element
    /// filter array, a DCT behind Flate and an indirect /Filter on page 1.
    fn jpeg_images_pdf() -> Vec<u8> {
        use std::io::Write;
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let jpeg = leaky_jpeg();
        let shared = doc.add_object(image_stream(1, "DCTDecode".into(), jpeg.clone()));
        let array = doc.add_object(image_stream(2, vec![Object::Name(b"DCTDecode".to_vec())].into(), jpeg.clone()));
        let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        z.write_all(&jpeg).unwrap();
        let chained = doc.add_object(image_stream(
            3,
            vec![Object::Name(b"FlateDecode".to_vec()), Object::Name(b"DCTDecode".to_vec())].into(),
            z.finish().unwrap(),
        ));
        let filter_ref = doc.add_object(Object::Name(b"DCTDecode".to_vec()));
        let indirect = doc.add_object(image_stream(4, filter_ref.into(), jpeg.clone()));
        let mut kids = vec![];
        for names in [&["A", "B", "C", "D"][..], &["A"][..]] {
            let mut xobjects = Dictionary::new();
            let mut ops = String::new();
            for n in names {
                let id = match *n { "A" => shared, "B" => array, "C" => chained, _ => indirect };
                xobjects.set(*n, id);
                ops.push_str(&format!("q 10 0 0 10 0 0 cm /{n} Do Q "));
            }
            let contents = doc.add_object(Stream::new(dictionary! {}, ops.into_bytes()));
            kids.push(Object::Reference(doc.add_object(dictionary! {
                "Type" => "Page", "Parent" => pages_id, "MediaBox" => rect(),
                "Resources" => dictionary! { "XObject" => xobjects }, "Contents" => contents,
            })));
        }
        doc.objects.insert(pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => 2 }));
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", catalog);
        crate::pdf_util::save_pdf(&mut doc).unwrap()
    }

    /// Raw content of every image XObject in `doc`, by /Width.
    fn images_by_width(doc: &Document) -> std::collections::BTreeMap<i64, Vec<Vec<u8>>> {
        let mut out = std::collections::BTreeMap::<i64, Vec<Vec<u8>>>::new();
        for obj in doc.objects.values() {
            if let Ok(s) = obj.as_stream() {
                if s.dict.get(b"Subtype").and_then(Object::as_name).ok() == Some(b"Image") {
                    let w = s.dict.get(b"Width").and_then(Object::as_i64).unwrap();
                    out.entry(w).or_default().push(s.content.clone());
                }
            }
        }
        out
    }

    #[test]
    fn sanitize_strips_metadata_from_dct_only_images_once() {
        let src = jpeg_images_pdf();
        let (out, report) = sanitize(&src, false).unwrap();
        assert_eq!(report.images_cleaned, 2, "the shared image counts once");
        let doc = Document::load_mem(&out).unwrap();
        let images = images_by_width(&doc);
        assert_eq!(images[&1].len(), 1, "the shared image is copied once");
        let clean = crate::stamp::image::strip_jpeg_metadata(&leaky_jpeg());
        for w in [1, 2] {
            let content = &images[&w][0];
            assert_eq!(content, &clean);
            for secret in ["SECRETGPS", "SECRETMPF", "SECRETTRAILER"] {
                assert!(!contains(content, secret), "{secret} survived in image {w}");
            }
        }
        let (src_doc, out_doc) = (Document::load_mem(&src).unwrap(), &doc);
        let src_images = images_by_width(&src_doc);
        // Behind another filter or an indirect /Filter: copied byte-exact.
        assert_eq!(images_by_width(out_doc)[&3], src_images[&3]);
        assert_eq!(images_by_width(out_doc)[&4], src_images[&4]);
        // /Length follows the new content.
        for obj in doc.objects.values() {
            if let Ok(s) = obj.as_stream() {
                if let Ok(len) = s.dict.get(b"Length").and_then(Object::as_i64) {
                    assert_eq!(len as usize, s.content.len());
                }
            }
        }
    }

    #[test]
    fn page_tools_copy_jpeg_images_byte_exact() {
        let src = Document::load_mem(&jpeg_images_pdf()).unwrap();
        let pages: Vec<OutPage> =
            src.get_pages().values().map(|&page| OutPage::Page { src: 0, page, rotate: 0 }).collect();
        let (out, report) =
            rebuild_document(std::slice::from_ref(&src), &pages, &crate::rebuild::PAGE_TOOLS).unwrap();
        assert_eq!(report.images_cleaned, 0);
        assert_eq!(images_by_width(&out), images_by_width(&src));
        assert!(contains(&images_by_width(&out)[&1][0], "SECRETGPS"));
    }

    #[test]
    fn remove_metadata_keeps_forms() {
        let src = hidden_pdf();
        let out = remove_metadata(&src).unwrap();
        for s in [
            "SECRETINFO",
            "SECRETXMP",
            "SECRETCREATOR",
            "SECRETPIECE",
            "SECRETPAGEXMP",
            "SECRETIMGXMP",
        ] {
            assert!(!contains(&out, s), "{s} survived");
        }
        let doc = Document::load_mem(&out).unwrap();
        assert!(!doc.trailer.has(b"Info"));
        let cat = doc.catalog().unwrap();
        assert!(!cat.has(b"Metadata"));
        assert!(cat.has(b"AcroForm"), "AcroForm kept");
        assert!(cat.has(b"Outlines"), "outlines kept");
        let page = doc.get_pages()[&1];
        let annots = doc.get_dictionary(page).unwrap().get(b"Annots").unwrap();
        assert_eq!(annots.as_array().unwrap().len(), 3, "widget kept");
    }

    #[test]
    fn metadata_round_trip_unicode() {
        let src = hidden_pdf();
        let m = Metadata {
            title: "Rapport été 2026 – v2".into(),
            author: String::new(),
            subject: "Plain".into(),
            keywords: "a, b".into(),
        };
        let out = set_metadata(&src, &m).unwrap();
        assert_eq!(read_metadata(&out).unwrap(), m);
        assert!(!contains(&out, "SECRETXMP"));
        assert!(!contains(&out, "Old Author"));
        let doc = Document::load_mem(&out).unwrap();
        assert!(!doc.catalog().unwrap().has(b"Metadata"));
        assert!(!info_dict(&doc).unwrap().has(b"Author"));
    }

    #[test]
    fn read_metadata_latin1_and_missing() {
        let mut doc = Document::load_mem(&hidden_pdf()).unwrap();
        let info = match doc.trailer.get(b"Info").unwrap() {
            Object::Reference(id) => *id,
            _ => unreachable!(),
        };
        doc.get_dictionary_mut(info).unwrap().set(
            "Title",
            Object::string_literal(vec![b'c', b'a', b'f', 0xE9]),
        );
        let mut buf = Vec::new();
        doc.save_to(&mut buf).unwrap();
        assert_eq!(read_metadata(&buf).unwrap().title, "café");
        let bare = remove_metadata(&buf).unwrap();
        assert_eq!(read_metadata(&bare).unwrap(), Metadata::default());
    }

    fn plain_with_id() -> Vec<u8> {
        let mut doc = Document::load_mem(&hidden_pdf()).unwrap();
        doc.trailer.set(
            "ID",
            vec![
                Object::string_literal("mantis-test-id-1"),
                Object::string_literal("mantis-test-id-2"),
            ],
        );
        let mut buf = Vec::new();
        doc.save_to(&mut buf).unwrap();
        buf
    }

    #[test]
    fn password_protected_input_is_refused() {
        let locked = encrypt_pdf_impl(&plain_with_id(), "u", "o").unwrap();
        let want = "This PDF is password-protected. Unlock it first.";
        let m = Metadata::default();
        assert_eq!(sanitize(&locked, false).unwrap_err(), want);
        assert_eq!(remove_metadata(&locked).unwrap_err(), want);
        assert_eq!(read_metadata(&locked).unwrap_err(), want);
        assert_eq!(set_metadata(&locked, &m).unwrap_err(), want);
        assert_eq!(crate::split::page_count(&locked).unwrap_err(), want);
        // Owner-only (empty user password) opens normally.
        let owner_only = encrypt_pdf_impl(&plain_with_id(), "", "o").unwrap();
        assert_eq!(crate::split::page_count(&owner_only).unwrap(), 1);
        assert!(sanitize(&owner_only, false).is_ok());
        assert_eq!(read_metadata(&owner_only).unwrap().author, "Old Author");
    }

    #[test]
    fn decode_pdfdoc_and_utf8() {
        assert_eq!(decode_text(&[0x84]), "\u{2014}");
        assert_eq!(decode_text(&[0x93]), "\u{FB01}");
        assert_eq!(decode_text(&[0xA0]), "\u{20AC}");
        assert_eq!(decode_text(&[0x18]), "\u{02D8}");
        assert_eq!(decode_text(&[0xE9]), "\u{E9}");
        assert_eq!(
            decode_text(&[0xEF, 0xBB, 0xBF, b'a', 0xC3, 0xA9]),
            "a\u{E9}"
        );
    }

    #[test]
    fn metadata_round_trip_special_chars() {
        let m = Metadata {
            title: r"Plan (v2) \ draft".into(),
            author: "Zoë (ÿ)".into(),
            subject: String::new(),
            keywords: String::new(),
        };
        let out = set_metadata(&hidden_pdf(), &m).unwrap();
        assert_eq!(read_metadata(&out).unwrap().title, m.title);
        assert_eq!(read_metadata(&out).unwrap().author, m.author);
    }

    #[test]
    fn unlock_round_trips() {
        let plain = plain_with_id();
        let locked = encrypt_pdf_impl(&plain, "u", "o").unwrap();
        assert!(!contains(&locked, "VISIBLE"));

        let out = unlock(&locked, "u").unwrap();
        let doc = Document::load_mem(&out).expect("opens without a password");
        assert_eq!(doc.get_pages().len(), 1);
        assert!(!doc.is_encrypted());
        assert!(contains(&out, "VISIBLE"), "content decrypted");
        assert!(!contains(&out, "/Encrypt"));

        assert_eq!(unlock(&locked, "x").unwrap_err(), "Wrong password");
        assert!(unlock(&locked, "o").is_ok(), "owner password works");

        let owner_only = encrypt_pdf_impl(&plain, "", "o").unwrap();
        let out = unlock(&owner_only, "").unwrap();
        let doc = Document::load_mem(&out).unwrap();
        assert!(!doc.is_encrypted());
        assert_eq!(doc.get_pages().len(), 1);

        assert_eq!(
            unlock(&plain, "").unwrap_err(),
            "This PDF is not password-protected"
        );
    }
}
