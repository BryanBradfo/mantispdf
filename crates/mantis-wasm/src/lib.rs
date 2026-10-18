mod annotations;
mod compress;
mod doc_tools;
mod edit;
mod edit_ops;
mod encrypt;
// Until the wasm bindings (forms task 4) use it.
#[allow(dead_code, unused_imports)]
mod forms;
mod geometry_ops;
mod images;
#[cfg(test)]
mod leak_probes;
mod merge;
mod page_content;
mod page_plan;
mod pdf_util;
mod rebuild;
mod rotate;
mod split;
mod stamp;
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

    /// [links_kept, links_dropped, comments_kept, comments_dropped, fields_flattened, warnings,
    /// too_deep_pages, images_cleaned]; `warnings` counts every page warning, `too_deep_pages`
    /// those where deeply nested content was dropped, `images_cleaned` the
    /// JPEG images whose metadata was removed.
    pub fn report(&self) -> Vec<u32> {
        self.report.clone()
    }
}

#[wasm_bindgen]
pub fn sanitize_pdf(pdf_bytes: &[u8], keep_comments: bool) -> Result<SanitizeOutput, JsValue> {
    let (bytes, r) = doc_tools::sanitize(pdf_bytes, keep_comments).map_err(|e| JsValue::from_str(&e))?;
    Ok(SanitizeOutput {
        bytes,
        report: report_counts(&r),
    })
}

/// Result of `stamp_pdf`: the stamped bytes and how many pages received any
/// stamp (text or image).
#[wasm_bindgen]
pub struct StampOutput {
    bytes: Vec<u8>,
    stamped_pages: u32,
}

#[wasm_bindgen]
impl StampOutput {
    pub fn bytes(&self) -> Vec<u8> {
        self.bytes.clone()
    }

    pub fn stamped_pages(&self) -> u32 {
        self.stamped_pages
    }
}

#[wasm_bindgen]
pub fn stamp_pdf(pdf_bytes: &[u8], job: JsValue) -> Result<StampOutput, JsValue> {
    let raw = stamp::binding::read_job(&job).map_err(|e| JsValue::from_str(&e))?;
    let job = stamp::job::validate_job(raw).map_err(|e| JsValue::from_str(&e))?;
    let r = stamp::engine::apply_stamps(pdf_bytes, &job).map_err(|e| JsValue::from_str(&e))?;
    Ok(StampOutput { bytes: r.bytes, stamped_pages: r.stamped_pages })
}

/// Bakes the items of an edit job (text, images, shapes, lines, highlights,
/// freehand, whiteout) into the pages. See `src/lib/editor/toJob.ts` for the shape.
#[wasm_bindgen]
pub fn edit_pdf(pdf_bytes: &[u8], job: JsValue) -> Result<Vec<u8>, JsValue> {
    let raw = edit_ops::binding::read_job(&job).map_err(|e| JsValue::from_str(&e))?;
    let job = edit_ops::job::validate_job(raw).map_err(|e| JsValue::from_str(&e))?;
    edit_ops::edit_pdf(pdf_bytes, &job).map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen]
pub fn crop_pdf(pdf_bytes: &[u8], job: JsValue) -> Result<Vec<u8>, JsValue> {
    let raw = geometry_ops::binding::read_crop(&job).map_err(|e| JsValue::from_str(&e))?;
    let job = geometry_ops::job::validate_crop(raw).map_err(|e| JsValue::from_str(&e))?;
    geometry_ops::crop::crop_pages(pdf_bytes, &job).map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen]
pub fn resize_pdf(pdf_bytes: &[u8], job: JsValue) -> Result<Vec<u8>, JsValue> {
    let raw = geometry_ops::binding::read_resize(&job).map_err(|e| JsValue::from_str(&e))?;
    let job = geometry_ops::job::validate_resize(raw).map_err(|e| JsValue::from_str(&e))?;
    geometry_ops::resize::resize_pages(pdf_bytes, &job).map_err(|e| JsValue::from_str(&e))
}

/// Result of `nup_pdf`: the sheets, how many there are, and the source pages
/// (1-based) whose content could not be decoded (their cells are empty).
#[wasm_bindgen]
pub struct NupOutput {
    bytes: Vec<u8>,
    sheets: u32,
    undecodable: Vec<u32>,
}

#[wasm_bindgen]
impl NupOutput {
    pub fn bytes(&self) -> Vec<u8> {
        self.bytes.clone()
    }

    pub fn sheets(&self) -> u32 {
        self.sheets
    }

    pub fn undecodable(&self) -> Vec<u32> {
        self.undecodable.clone()
    }
}

#[wasm_bindgen]
pub fn nup_pdf(pdf_bytes: &[u8], job: JsValue) -> Result<NupOutput, JsValue> {
    let raw = geometry_ops::binding::read_nup(&job).map_err(|e| JsValue::from_str(&e))?;
    let job = geometry_ops::job::validate_nup(raw).map_err(|e| JsValue::from_str(&e))?;
    let r = geometry_ops::nup::nup(pdf_bytes, &job).map_err(|e| JsValue::from_str(&e))?;
    Ok(NupOutput { bytes: r.bytes, sheets: r.sheets, undecodable: r.undecodable_pages })
}

/// Result of `extract_images`: images in page order. `bytes(i)` is the
/// original JPEG for a JPEG image, `pixels(i)` is RGBA8 for the others.
#[wasm_bindgen]
pub struct ExtractOutput {
    images: Vec<images::extract::Extracted>,
    skipped: Vec<(String, u32)>,
}

#[wasm_bindgen]
impl ExtractOutput {
    pub fn count(&self) -> u32 {
        self.images.len() as u32
    }

    /// 1-based page of image `i` (0 when out of range).
    pub fn page(&self, i: u32) -> u32 {
        self.images.get(i as usize).map_or(0, |e| e.page)
    }

    /// 1-based order of image `i` within its page.
    pub fn index(&self, i: u32) -> u32 {
        self.images.get(i as usize).map_or(0, |e| e.index)
    }

    pub fn is_jpeg(&self, i: u32) -> bool {
        matches!(self.images.get(i as usize).map(|e| &e.kind), Some(images::extract::ExtractedKind::Jpeg(_)))
    }

    /// JPEG bytes; empty for an RGBA image.
    pub fn bytes(&self, i: u32) -> Vec<u8> {
        match self.images.get(i as usize).map(|e| &e.kind) {
            Some(images::extract::ExtractedKind::Jpeg(b)) => b.clone(),
            _ => Vec::new(),
        }
    }

    pub fn width(&self, i: u32) -> u32 {
        match self.images.get(i as usize).map(|e| &e.kind) {
            Some(images::extract::ExtractedKind::Rgba { width, .. }) => *width,
            _ => 0,
        }
    }

    pub fn height(&self, i: u32) -> u32 {
        match self.images.get(i as usize).map(|e| &e.kind) {
            Some(images::extract::ExtractedKind::Rgba { height, .. }) => *height,
            _ => 0,
        }
    }

    /// RGBA8 pixels; empty for a JPEG image.
    pub fn pixels(&self, i: u32) -> Vec<u8> {
        match self.images.get(i as usize).map(|e| &e.kind) {
            Some(images::extract::ExtractedKind::Rgba { pixels, .. }) => pixels.clone(),
            _ => Vec::new(),
        }
    }

    /// Why images were skipped; parallel to `skipped_counts`.
    pub fn skipped_reasons(&self) -> Vec<String> {
        self.skipped.iter().map(|(r, _)| r.clone()).collect()
    }

    pub fn skipped_counts(&self) -> Vec<u32> {
        self.skipped.iter().map(|(_, c)| *c).collect()
    }
}

#[wasm_bindgen]
pub fn extract_images(pdf_bytes: &[u8]) -> Result<ExtractOutput, JsValue> {
    let r = images::extract::extract_images(pdf_bytes).map_err(|e| JsValue::from_str(&e))?;
    Ok(ExtractOutput { images: r.images, skipped: r.skipped })
}

/// `images`: `{kind:"jpeg", bytes} | {kind:"rgba", width, height, pixels}`
/// plus `rotate` and `flipX`; `layout`: `{page: "fit" | [w, h], orientation, margin}`.
#[wasm_bindgen]
pub fn images_to_pdf(images: js_sys::Array, layout: JsValue) -> Result<Vec<u8>, JsValue> {
    let run = || -> Result<Vec<u8>, String> {
        let layout = images::job::validate_layout(images::binding::read_layout(&layout)?)?;
        let list = images::job::validate_images(images::binding::read_images(&images)?)?;
        images::to_pdf::images_to_pdf(list, &layout)
    };
    run().map_err(|e| JsValue::from_str(&e))
}

/// Visible `[w, h]` of every page, flattened: `[w1, h1, w2, h2, ...]`.
#[wasm_bindgen]
pub fn visible_page_sizes(pdf_bytes: &[u8]) -> Result<Vec<f64>, JsValue> {
    stamp::engine::visible_page_sizes(pdf_bytes).map_err(|e| JsValue::from_str(&e))
}

/// The wire form of a report; indexes are stable, new counters are appended.
fn report_counts(r: &rebuild::RebuildReport) -> Vec<u32> {
    vec![
        r.links_kept,
        r.links_dropped,
        r.comments_kept,
        r.comments_dropped,
        r.fields_flattened,
        r.warnings.len() as u32,
        r.too_deep_pages,
        r.images_cleaned,
    ]
}

#[cfg(test)]
mod tests {
    #[test]
    fn report_counts_keep_indexes_and_append_new_counters() {
        let r = crate::rebuild::RebuildReport {
            links_kept: 1,
            links_dropped: 2,
            comments_kept: 3,
            comments_dropped: 4,
            fields_flattened: 5,
            warnings: vec!["a".into(), "b".into()],
            too_deep_pages: 1,
            images_cleaned: 6,
        };
        assert_eq!(super::report_counts(&r), [1, 2, 3, 4, 5, 2, 1, 6]);
    }
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
