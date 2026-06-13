use lopdf::{Document, Object, ObjectId};
use std::collections::HashSet;

/// Resolve an inheritable page attribute (`/MediaBox`, `/Resources`, `/Rotate`,
/// `/CropBox`) by walking the `/Parent` chain starting at `page_id`. Returns the
/// first value found (the leaf's own value if present, else an ancestor's),
/// cloned so it can be written onto the leaf. Cycle-guarded like lopdf's own
/// `get_page_resources`, so a malformed `/Parent` loop returns `None` instead of
/// hanging the WASM module.
pub fn get_inherited_attr(doc: &Document, page_id: ObjectId, key: &[u8]) -> Option<Object> {
    let mut current = page_id;
    let mut seen = HashSet::new();
    loop {
        if !seen.insert(current) {
            return None; // /Parent cycle
        }
        let dict = doc.get_dictionary(current).ok()?;
        if let Ok(value) = dict.get(key) {
            return Some(value.clone());
        }
        match dict.get(b"Parent").and_then(Object::as_reference) {
            Ok(parent) => current = parent,
            Err(_) => return None,
        }
    }
}

/// Build a PDF whose `n` pages do NOT carry `/MediaBox` or `/Resources` on the
/// leaf — they inherit both from the intermediate `/Pages` node. This reproduces
/// the real-world inheritance that the older `make_test_pdf` helpers (which set
/// `/MediaBox` on every leaf) cannot. Defined at module level (not inside the
/// `tests` submodule) so other modules' `#[cfg(test)]` code can import it via
/// `crate::pdf_util::make_inherited_test_pdf`.
#[cfg(test)]
pub fn make_inherited_test_pdf(n: u32) -> Vec<u8> {
    use lopdf::{content::Content, dictionary, Stream};

    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();

    // A shared resource dictionary lives on the /Pages node.
    let font_id = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Helvetica",
    });
    let shared_resources = dictionary! {
        "Font" => dictionary! { "F1" => font_id },
    };

    let mut page_ids = Vec::new();
    for _ in 0..n {
        let content = Content { operations: vec![] };
        let content_id = doc.add_object(Stream::new(dictionary! {}, content.encode().unwrap()));
        // Leaf page: NO MediaBox, NO Resources — inherited from /Pages.
        let page = dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "Contents" => content_id,
        };
        page_ids.push(doc.add_object(page));
    }

    let kids: Vec<Object> = page_ids.iter().map(|&id| id.into()).collect();
    let pages = dictionary! {
        "Type" => "Pages",
        "Kids" => kids,
        "Count" => n,
        "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        "Resources" => shared_resources,
    };
    doc.objects.insert(pages_id, Object::Dictionary(pages));

    let catalog_id = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog_id);

    let mut buf = Vec::new();
    doc.save_to(&mut buf).unwrap();
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inherited_mediabox_resolves_from_parent() {
        let pdf = make_inherited_test_pdf(2);
        let doc = Document::load_mem(&pdf).unwrap();
        let first_page = *doc.get_pages().get(&1).unwrap();
        // The leaf has no MediaBox; the helper must find it on /Pages.
        let mb = get_inherited_attr(&doc, first_page, b"MediaBox");
        assert!(mb.is_some(), "MediaBox should be resolved from the parent");
        let arr = mb.unwrap();
        let arr = arr.as_array().unwrap();
        assert_eq!(arr.len(), 4);
        // 612.into() is stored as an Integer in this fixture.
        assert_eq!(arr[2].as_i64().unwrap(), 612);
    }

    #[test]
    fn missing_attr_returns_none() {
        let pdf = make_inherited_test_pdf(1);
        let doc = Document::load_mem(&pdf).unwrap();
        let first_page = *doc.get_pages().get(&1).unwrap();
        assert!(get_inherited_attr(&doc, first_page, b"CropBox").is_none());
    }
}
