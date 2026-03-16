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
    let mut doc = Document::load_mem(pdf_bytes)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    let version = EncryptionVersion::V2 {
        document: &doc,
        owner_password,
        user_password,
        key_length: 128,
        permissions: Permissions::all(),
    };
    let state = EncryptionState::try_from(version)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    doc.encrypt(&state)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    let mut buf = Vec::new();
    doc.save_to(&mut buf)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    Ok(buf)
}
