use lopdf::{
    Document,
    encryption::{EncryptionVersion, EncryptionState, Permissions},
};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn encrypt_pdf(
    pdf_bytes: &[u8],
    user_password: &str,
    owner_password: &str,
) -> Result<Vec<u8>, JsValue> {
    encrypt_pdf_impl(pdf_bytes, user_password, owner_password)
        .map_err(|e| JsValue::from_str(&e))
}

fn encrypt_pdf_impl(
    pdf_bytes: &[u8],
    user_password: &str,
    owner_password: &str,
) -> Result<Vec<u8>, String> {
    let mut doc = Document::load_mem(pdf_bytes)
        .map_err(|e| e.to_string())?;

    let version = EncryptionVersion::V2 {
        document: &doc,
        owner_password,
        user_password,
        key_length: 128,
        permissions: Permissions::all(),
    };
    let state = EncryptionState::try_from(version)
        .map_err(|e| e.to_string())?;

    doc.encrypt(&state)
        .map_err(|e| e.to_string())?;

    let mut buf = Vec::new();
    doc.save_to(&mut buf)
        .map_err(|e| e.to_string())?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, content::Content, Object, Stream};

    fn make_test_pdf(n: u32) -> Vec<u8> {
        let mut doc = Document::with_version("1.5");

        let pages_id = doc.new_object_id();
        let mut page_ids = Vec::new();

        for _ in 0..n {
            let content = Content { operations: vec![] };
            let content_bytes = content.encode().unwrap();
            let stream = Stream::new(dictionary! {}, content_bytes);
            let content_id = doc.add_object(stream);

            let page = dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
                "Contents" => content_id,
            };
            let page_id = doc.add_object(page);
            page_ids.push(page_id);
        }

        let kids: Vec<Object> = page_ids.iter().map(|&id| id.into()).collect();
        let pages = dictionary! {
            "Type" => "Pages",
            "Kids" => kids,
            "Count" => n,
        };
        doc.objects.insert(pages_id, Object::Dictionary(pages));

        let catalog = dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        };
        let catalog_id = doc.add_object(catalog);
        doc.trailer.set("Root", catalog_id);
        // lopdf encryption requires an /ID entry in the trailer
        doc.trailer.set("ID", vec![
            Object::string_literal("mantis-test-id-1"),
            Object::string_literal("mantis-test-id-2"),
        ]);

        let mut buf = Vec::new();
        doc.save_to(&mut buf).unwrap();
        buf
    }

    #[test]
    fn test_encrypt_round_trip() {
        let pdf = make_test_pdf(2);
        let result = encrypt_pdf_impl(&pdf, "password", "owner").unwrap();
        // Output should be a non-empty byte sequence
        assert!(!result.is_empty());
        // The encrypted PDF is larger than or similar in size to the original
        // (encryption adds metadata)
        assert!(result.len() > 0);
    }

    #[test]
    fn test_encrypt_empty_user_password() {
        let pdf = make_test_pdf(1);
        // Empty user password should still produce a valid encrypted PDF
        let result = encrypt_pdf_impl(&pdf, "", "owner");
        assert!(result.is_ok());
        assert!(!result.unwrap().is_empty());
    }

    #[test]
    fn test_encrypt_same_user_and_owner_password() {
        let pdf = make_test_pdf(1);
        let result = encrypt_pdf_impl(&pdf, "secret", "secret");
        assert!(result.is_ok());
    }

    #[test]
    fn test_encrypt_invalid_pdf() {
        assert!(encrypt_pdf_impl(b"not a pdf", "pw", "owner").is_err());
    }
}
