use lopdf::{
    Document,
    encryption::{
        EncryptionVersion, EncryptionState, Permissions,
        crypt_filters::{Aes256CryptFilter, CryptFilter},
    },
};
use std::collections::BTreeMap;
use std::sync::Arc;
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

pub(crate) fn encrypt_pdf_impl(
    pdf_bytes: &[u8],
    user_password: &str,
    owner_password: &str,
) -> Result<Vec<u8>, String> {
    let mut doc = Document::load_mem(pdf_bytes)
        .map_err(|e| e.to_string())?;

    // AES-256 (PDF 2.0 security handler V5/R6) instead of the legacy, broken
    // RC4. Generate a random 32-byte file encryption key.
    let mut file_encryption_key = [0u8; 32];
    getrandom::fill(&mut file_encryption_key)
        .map_err(|e| format!("Failed to generate encryption key: {e}"))?;

    let crypt_filter: Arc<dyn CryptFilter> = Arc::new(Aes256CryptFilter);
    let version = EncryptionVersion::V5 {
        encrypt_metadata: true,
        crypt_filters: BTreeMap::from([(b"StdCF".to_vec(), crypt_filter)]),
        file_encryption_key: &file_encryption_key,
        stream_filter: b"StdCF".to_vec(),
        string_filter: b"StdCF".to_vec(),
        owner_password,
        user_password,
        permissions: Permissions::all(),
    };
    let state = EncryptionState::try_from(version)
        .map_err(|e| e.to_string())?;

    doc.encrypt(&state)
        .map_err(|e| e.to_string())?;

    // lopdf's Aes256CryptFilter omits /Length from the crypt filter dictionary.
    // Poppler-based viewers (Evince, Okular, and most Linux/GNOME readers) read
    // it to size the AES key; without it they derive a shorter, wrong key. The
    // document then authenticates and opens, but every stream and string
    // decrypts to garbage - the file renders blank. Acrobat writes the key
    // length in BYTES here, so /Length 32 for AES-256.
    set_crypt_filter_length(&mut doc)?;

    let mut buf = Vec::new();
    doc.save_to(&mut buf)
        .map_err(|e| e.to_string())?;
    Ok(buf)
}

/// Add `/Length 32` to the `/StdCF` crypt filter written by lopdf.
///
/// See the call site for why this matters. Kept separate so the fix is one
/// named step rather than a block of dereferencing inside the main flow.
fn set_crypt_filter_length(doc: &mut Document) -> Result<(), String> {
    let encrypt_id = doc
        .trailer
        .get(b"Encrypt")
        .map_err(|e| format!("no /Encrypt after encrypting: {e}"))?
        .as_reference()
        .map_err(|e| format!("/Encrypt is not a reference: {e}"))?;

    let dict = doc
        .get_object_mut(encrypt_id)
        .map_err(|e| format!("resolve /Encrypt: {e}"))?
        .as_dict_mut()
        .map_err(|e| format!("/Encrypt is not a dictionary: {e}"))?;

    let std_cf = dict
        .get_mut(b"CF")
        .and_then(|o| o.as_dict_mut())
        .and_then(|cf| cf.get_mut(b"StdCF"))
        .and_then(|o| o.as_dict_mut())
        .map_err(|e| format!("/CF /StdCF crypt filter missing: {e}"))?;

    std_cf.set("Length", 32i64);
    Ok(())
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
        // The output must actually decrypt with the user password and recover
        // the original content (page count). This is what proves the encryption
        // is correct, not merely that bytes were produced.
        let reopened = Document::load_mem_with_password(&result, "password")
            .expect("encrypted PDF must open with the correct user password");
        assert_eq!(reopened.get_pages().len(), 2);
    }

    #[test]
    fn test_encrypt_wrong_password_rejected() {
        let pdf = make_test_pdf(1);
        let result = encrypt_pdf_impl(&pdf, "secret", "owner").unwrap();
        // A wrong password (neither user nor owner) must fail to open.
        assert!(Document::load_mem_with_password(&result, "definitely-wrong").is_err());
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


    /// The crypt filter dictionary MUST declare the key length.
    ///
    /// Poppler (Evince, Okular, and most Linux/GNOME viewers) reads `/Length`
    /// from the crypt filter to size the AES key. Without it, it derives a
    /// shorter key, so every stream and string decrypts to garbage while
    /// *authentication still succeeds* - the document opens, then renders
    /// nothing. Verified on a real paper: 114 "Unknown compression method in
    /// flate stream" errors and 7 characters of extractable text; adding
    /// `/Length 32` makes the same file render perfectly.
    ///
    /// lopdf's `Aes256CryptFilter` does not emit it, so `encrypt_pdf_impl`
    /// adds it. The other tests here cannot catch this: they read the output
    /// back with lopdf, which ignores `/Length` and so agrees with itself.
    #[test]
    fn test_crypt_filter_declares_key_length() {
        let pdf = make_test_pdf(1);
        let out = encrypt_pdf_impl(&pdf, "pw", "owner").expect("encrypt");
        // Assert on the SERIALIZED bytes: lopdf drops /Encrypt from the
        // trailer once it has decrypted on load, and the bytes are what a
        // viewer actually parses. Work on bytes, not str - the neighbouring
        // /OE and /UE entries are binary and split UTF-8 boundaries.
        let needle = b"/CF";
        let cf_start = out
            .windows(needle.len())
            .position(|w| w == needle)
            .expect("/CF crypt filter dictionary");
        let cf = &out[cf_start..(cf_start + 80).min(out.len())];
        let contains = |hay: &[u8], pat: &[u8]| hay.windows(pat.len()).any(|w| w == pat);

        assert!(
            contains(cf, b"/AESV3"),
            "expected an AES-256 crypt filter, got: {}",
            String::from_utf8_lossy(cf)
        );
        assert!(
            contains(cf, b"/Length 32"),
            "crypt filter must declare /Length 32 (bytes) or poppler-based \
             viewers derive the wrong key and render an empty document; got: {}",
            String::from_utf8_lossy(cf)
        );
    }

    #[test]
    fn test_encrypt_invalid_pdf() {
        assert!(encrypt_pdf_impl(b"not a pdf", "pw", "owner").is_err());
    }
}
