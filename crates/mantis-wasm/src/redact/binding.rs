//! Thin js_sys::Reflect layer between the worker and `redact_plan` /
//! `redact` (shapes in `src/lib/redact/toJob.ts`, keys in
//! `src/lib/redact/wireKeys.ts`). It never panics; shape errors come back as
//! `Invalid redact settings: <path>`.

use super::raster::MAX_RASTER_PIXELS;
use super::search::{SearchOptions, SearchResult};
use super::{Fill, MAX_RECTS, PageRaster, PageStatus, RedactJob, RedactRect, RedactSummary, invalid};
use js_sys::{Array, Object, Reflect, Uint8Array};
use wasm_bindgen::{JsCast, JsValue};

fn get(obj: &JsValue, key: &str, path: &str) -> Result<JsValue, String> {
    if !obj.is_object() {
        return Err(invalid(path));
    }
    let v = Reflect::get(obj, &JsValue::from_str(key)).map_err(|_| invalid(&format!("{path}.{key}")))?;
    if v.is_undefined() || v.is_null() {
        return Err(invalid(&format!("{path}.{key}")));
    }
    Ok(v)
}

fn num(obj: &JsValue, key: &str, path: &str) -> Result<f64, String> {
    get(obj, key, path)?.as_f64().ok_or_else(|| invalid(&format!("{path}.{key}")))
}

/// A whole number in 0..=u32::MAX.
fn count(obj: &JsValue, key: &str, path: &str) -> Result<u32, String> {
    let v = num(obj, key, path)?;
    if v.fract() == 0.0 && (0.0..=f64::from(u32::MAX)).contains(&v) {
        Ok(v as u32)
    } else {
        Err(invalid(&format!("{path}.{key}")))
    }
}

/// An array of at most `max` entries.
fn array(v: &JsValue, max: usize, path: &str) -> Result<Array, String> {
    if !Array::is_array(v) {
        return Err(invalid(path));
    }
    let list: Array = v.clone().unchecked_into();
    if list.length() as usize > max {
        return Err(invalid(path));
    }
    Ok(list)
}

/// `rects`: `[{ page, rect: [x, y, width, height] }]` (visible space).
pub(crate) fn read_rects(rects: &JsValue) -> Result<Vec<RedactRect>, String> {
    let list = array(rects, MAX_RECTS, "rects")?;
    let mut out = Vec::with_capacity(list.length() as usize);
    for i in 0..list.length() {
        let path = format!("rects[{i}]");
        let item = list.get(i);
        let page = count(&item, "page", &path)?;
        let values = array(&get(&item, "rect", &path)?, 4, &format!("{path}.rect"))?;
        if values.length() != 4 {
            return Err(invalid(&format!("{path}.rect")));
        }
        let mut rect = [0.0; 4];
        for (k, slot) in rect.iter_mut().enumerate() {
            *slot = values.get(k as u32).as_f64().ok_or_else(|| invalid(&format!("{path}.rect")))?;
        }
        out.push(RedactRect { page, rect });
    }
    Ok(out)
}

/// Raster pixel bytes one job may send in all (the UI lowers the dpi to fit).
const MAX_RASTER_BYTES: u64 = 512 << 20;

/// `rasters`: `[{ page, width, height, dpi, rgba: Uint8Array }]`. The pixel
/// count of each, the total size of all and each buffer's length are
/// checked before any pixel is copied in.
fn read_rasters(rasters: &JsValue) -> Result<Vec<PageRaster>, String> {
    let list = array(rasters, MAX_RECTS, "rasters")?;
    let mut total = 0u64;
    for i in 0..list.length() {
        let path = format!("rasters[{i}]");
        let item = list.get(i);
        let pixels = u64::from(count(&item, "width", &path)?) * u64::from(count(&item, "height", &path)?);
        total = total.saturating_add(pixels.saturating_mul(4));
        if total > MAX_RASTER_BYTES {
            return Err(invalid("raster size"));
        }
    }
    let mut out = Vec::with_capacity(list.length() as usize);
    for i in 0..list.length() {
        let path = format!("rasters[{i}]");
        let item = list.get(i);
        let page = count(&item, "page", &path)?;
        let width = count(&item, "width", &path)?;
        let height = count(&item, "height", &path)?;
        let dpi = num(&item, "dpi", &path)?;
        let rgba = get(&item, "rgba", &path)?;
        let rgba = rgba.dyn_ref::<Uint8Array>().ok_or_else(|| invalid(&format!("{path}.rgba")))?;
        let pixels = u64::from(width) * u64::from(height);
        if pixels > MAX_RASTER_PIXELS || u64::from(rgba.length()) != pixels * 4 {
            return Err(invalid("raster"));
        }
        out.push(PageRaster { page, width, height, dpi, rgba: rgba.to_vec() });
    }
    Ok(out)
}

/// `job`: `{ rects, fill: "black" | "white", removeMetadata, rasters }`.
pub(crate) fn read_job(job: &JsValue) -> Result<RedactJob, String> {
    let rects = read_rects(&get(job, "rects", "job")?)?;
    let fill = match get(job, "fill", "job")?.as_string().as_deref() {
        Some("black") => Fill::Black,
        Some("white") => Fill::White,
        _ => return Err(invalid("fill")),
    };
    let remove_metadata = get(job, "removeMetadata", "job")?.as_bool().ok_or_else(|| invalid("removeMetadata"))?;
    let rasters = read_rasters(&get(job, "rasters", "job")?)?;
    Ok(RedactJob { rects, fill, remove_metadata, rasters })
}

fn set(obj: &Object, key: &str, value: &JsValue) {
    // Setting a property on a plain object cannot fail.
    let _ = Reflect::set(obj, &JsValue::from_str(key), value);
}

fn numbers(values: &[u32]) -> JsValue {
    values.iter().map(|v| JsValue::from_f64(f64::from(*v))).collect::<Array>().into()
}

/// `[{ page, reason: string | null }]`.
pub(crate) fn plan_to_js(plan: &[PageStatus]) -> JsValue {
    plan.iter()
        .map(|status| {
            let obj = Object::new();
            set(&obj, "page", &JsValue::from_f64(f64::from(status.page)));
            set(&obj, "reason", &status.reason.as_deref().map_or(JsValue::NULL, JsValue::from_str));
            JsValue::from(obj)
        })
        .collect::<Array>()
        .into()
}

/// `{ bytes, pagesRedacted, pagesRasterized, widenedPages, glyphsRemoved, ... }`.
pub(crate) fn result_to_js(bytes: &[u8], summary: &RedactSummary) -> JsValue {
    let obj = Object::new();
    set(&obj, "bytes", &Uint8Array::from(bytes).into());
    set(&obj, "pagesRedacted", &numbers(&summary.pages_redacted));
    set(&obj, "pagesRasterized", &numbers(&summary.pages_rasterized));
    set(&obj, "widenedPages", &numbers(&summary.pages_widened));
    let count = |n: usize| JsValue::from_f64(n as f64);
    set(&obj, "glyphsRemoved", &count(summary.glyphs_removed));
    set(&obj, "pathsRemoved", &count(summary.paths_removed));
    set(&obj, "imagesRedacted", &count(summary.images_redacted));
    set(&obj, "imagesRemoved", &count(summary.images_removed));
    set(&obj, "formsRedacted", &count(summary.forms_redacted));
    set(&obj, "annotationsRemoved", &count(summary.annotations_removed));
    obj.into()
}

/// `options`: `{ wholeWord, caseSensitive }` (both booleans).
pub(crate) fn read_search_options(options: &JsValue) -> Result<SearchOptions, String> {
    let flag = |key: &str| get(options, key, "options")?.as_bool().ok_or_else(|| invalid(&format!("options.{key}")));
    Ok(SearchOptions { whole_word: flag("wholeWord")?, case_sensitive: flag("caseSensitive")? })
}

/// `{ pages: [{ page, quads: [[x, y, w, h]] }], undecodablePages, truncated, unsearchedPages }`.
pub(crate) fn search_to_js(result: &SearchResult) -> JsValue {
    let pages: Array = result
        .pages
        .iter()
        .map(|hits| {
            let obj = Object::new();
            set(&obj, "page", &JsValue::from_f64(f64::from(hits.page)));
            let quads: Array = hits
                .rects
                .iter()
                .map(|r| JsValue::from(r.iter().map(|v| JsValue::from_f64(*v)).collect::<Array>()))
                .collect();
            set(&obj, "quads", &quads.into());
            JsValue::from(obj)
        })
        .collect();
    let obj = Object::new();
    set(&obj, "pages", &pages.into());
    set(&obj, "undecodablePages", &numbers(&result.undecodable_pages));
    set(&obj, "truncated", &JsValue::from_bool(result.truncated));
    set(&obj, "unsearchedPages", &numbers(&result.unsearched_pages));
    obj.into()
}
