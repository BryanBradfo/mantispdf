//! Whole-document tools: sanitize, metadata read/write/removal and unlock.

use crate::rebuild::{OutPage, Policy, RebuildReport, rebuild_document};
use lopdf::{Dictionary, Document, Object, ObjectId};

fn load(bytes: &[u8]) -> Result<Document, String> {
    Document::load_mem(bytes).map_err(|e| format!("Failed to parse PDF: {e}"))
}

fn save(doc: &mut Document) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    doc.save_to(&mut buf)
        .map_err(|e| format!("Failed to save PDF: {e}"))?;
    Ok(buf)
}

/// Rebuild every page from the allowlist: no metadata, scripts, attachments,
/// outlines or form data survive; links stay, comments by choice, form
/// fields are flattened.
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

/// PDF text string: UTF-16BE with a BOM, otherwise PDFDocEncoding (treated
/// as Latin-1).
fn decode_text(bytes: &[u8]) -> String {
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        let units: Vec<u16> = rest
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        bytes.iter().map(|&b| b as char).collect()
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
        doc.objects.insert(
            page_id,
            Object::Dictionary(dictionary! {
                "Type" => "Page", "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
                "Contents" => content,
                "Annots" => vec![widget.into(), link.into(), note.into()],
                "PieceInfo" => dictionary! { "App" => Object::string_literal("SECRETPIECE") },
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

    #[test]
    fn remove_metadata_keeps_forms() {
        let src = hidden_pdf();
        let out = remove_metadata(&src).unwrap();
        for s in ["SECRETINFO", "SECRETXMP", "SECRETCREATOR", "SECRETPIECE"] {
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
        assert!(unlock(&owner_only, "").is_ok());

        assert_eq!(
            unlock(&plain, "").unwrap_err(),
            "This PDF is not password-protected"
        );
    }
}
