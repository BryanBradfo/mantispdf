mod compress;
mod edit;
mod encrypt;
mod merge;
mod rotate;
mod split;
mod watermark;

pub use compress::compress_pdf;
pub use edit::reorder_pages;
pub use encrypt::encrypt_pdf;
pub use rotate::rotate_pdf;
pub use watermark::add_watermark;
use lopdf::Document;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn get_page_count(pdf_bytes: &[u8]) -> Result<u32, JsValue> {
    split::page_count(pdf_bytes).map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen]
pub fn extract_pages(pdf_bytes: &[u8], page_start: u32, page_end: u32) -> Result<Vec<u8>, JsValue> {
    split::extract_page_range(pdf_bytes, page_start, page_end).map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen]
pub struct WasmPdf {
    doc: Document,
    total_pages: u32,
}

#[wasm_bindgen]
impl WasmPdf {
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8]) -> Result<WasmPdf, JsValue> {
        let doc = Document::load_mem(bytes)
            .map_err(|e| JsValue::from_str(&format!("Failed to parse PDF: {e}")))?;
        let total_pages = doc.get_pages().len() as u32;
        Ok(WasmPdf { doc, total_pages })
    }

    pub fn page_count(&self) -> u32 {
        self.total_pages
    }

    pub fn extract_range(&self, start: u32, end: u32) -> Result<Vec<u8>, JsValue> {
        split::extract_range_from_doc(&self.doc, self.total_pages, start, end)
            .map_err(|e| JsValue::from_str(&e))
    }
}

#[wasm_bindgen]
pub fn merge_pdfs(pdf_list: js_sys::Array) -> Result<Vec<u8>, JsValue> {
    let buffers: Vec<Vec<u8>> = pdf_list
        .iter()
        .map(|val| {
            let arr = js_sys::Uint8Array::new(&val);
            arr.to_vec()
        })
        .collect();

    let slices: Vec<&[u8]> = buffers.iter().map(|b| b.as_slice()).collect();
    merge::merge_documents(&slices).map_err(|e| JsValue::from_str(&e))
}
