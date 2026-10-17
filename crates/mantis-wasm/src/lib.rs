mod annotations;
mod compress;
mod doc_tools;
mod edit;
mod encrypt;
#[cfg(test)]
mod leak_probes;
mod merge;
mod page_plan;
mod pdf_util;
mod rebuild;
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

impl WasmPdf {
    pub(crate) fn from_bytes(bytes: &[u8]) -> Result<WasmPdf, String> {
        let doc = pdf_util::load_pdf(bytes)?;
        let total_pages = doc.get_pages().len() as u32;
        Ok(WasmPdf { doc, total_pages })
    }
}

#[wasm_bindgen]
impl WasmPdf {
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8]) -> Result<WasmPdf, JsValue> {
        WasmPdf::from_bytes(bytes).map_err(|e| JsValue::from_str(&e))
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

#[wasm_bindgen]
pub fn apply_page_plan(pdf_list: js_sys::Array, plan: &[i32]) -> Result<Vec<u8>, JsValue> {
    let buffers: Vec<Vec<u8>> = pdf_list.iter().map(|v| js_sys::Uint8Array::new(&v).to_vec()).collect();
    let slices: Vec<&[u8]> = buffers.iter().map(|b| b.as_slice()).collect();
    let entries = page_plan::decode_plan(plan).map_err(|e| JsValue::from_str(&e))?;
    page_plan::apply_plan(&slices, &entries).map_err(|e| JsValue::from_str(&e))
}

/// Result of `sanitize_pdf`: the cleaned bytes and what was kept or dropped.
#[wasm_bindgen]
pub struct SanitizeOutput {
    bytes: Vec<u8>,
    report: Vec<u32>,
}

#[wasm_bindgen]
impl SanitizeOutput {
    pub fn bytes(&self) -> Vec<u8> {
        self.bytes.clone()
    }

    /// [links_kept, links_dropped, comments_kept, comments_dropped, fields_flattened, warnings]
    pub fn report(&self) -> Vec<u32> {
        self.report.clone()
    }
}

#[wasm_bindgen]
pub fn sanitize_pdf(pdf_bytes: &[u8], keep_comments: bool) -> Result<SanitizeOutput, JsValue> {
    let (bytes, r) = doc_tools::sanitize(pdf_bytes, keep_comments).map_err(|e| JsValue::from_str(&e))?;
    Ok(SanitizeOutput {
        bytes,
        report: vec![
            r.links_kept,
            r.links_dropped,
            r.comments_kept,
            r.comments_dropped,
            r.fields_flattened,
            r.warnings.len() as u32,
        ],
    })
}

#[wasm_bindgen]
pub fn remove_metadata(pdf_bytes: &[u8]) -> Result<Vec<u8>, JsValue> {
    doc_tools::remove_metadata(pdf_bytes).map_err(|e| JsValue::from_str(&e))
}

/// [title, author, subject, keywords]
#[wasm_bindgen]
pub fn read_metadata(pdf_bytes: &[u8]) -> Result<Vec<String>, JsValue> {
    let m = doc_tools::read_metadata(pdf_bytes).map_err(|e| JsValue::from_str(&e))?;
    Ok(vec![m.title, m.author, m.subject, m.keywords])
}

#[wasm_bindgen]
pub fn set_metadata(
    pdf_bytes: &[u8],
    title: &str,
    author: &str,
    subject: &str,
    keywords: &str,
) -> Result<Vec<u8>, JsValue> {
    let m = doc_tools::Metadata {
        title: title.into(),
        author: author.into(),
        subject: subject.into(),
        keywords: keywords.into(),
    };
    doc_tools::set_metadata(pdf_bytes, &m).map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen]
pub fn unlock_pdf(pdf_bytes: &[u8], password: &str) -> Result<Vec<u8>, JsValue> {
    doc_tools::unlock(pdf_bytes, password).map_err(|e| JsValue::from_str(&e))
}
