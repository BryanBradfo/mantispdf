mod split;

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn get_page_count(pdf_bytes: &[u8]) -> Result<u32, JsValue> {
    split::page_count(pdf_bytes).map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen]
pub fn extract_pages(pdf_bytes: &[u8], page_start: u32, page_end: u32) -> Result<Vec<u8>, JsValue> {
    split::extract_page_range(pdf_bytes, page_start, page_end).map_err(|e| JsValue::from_str(&e))
}
