//! Thin js_sys::Reflect layer: copies the JS image list and layout into the
//! raw structs of `job`. All range checks happen in `job::validate_*`; the
//! only checks here guard against copying more than the job may hold.

use super::job::{RawData, RawImage, RawLayout, RawPage, add_input_bytes, invalid};
use super::to_pdf::MAX_IMAGES;
use js_sys::{Array, Reflect, Uint8Array};
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

fn string(obj: &JsValue, key: &str, path: &str) -> Result<String, String> {
    get(obj, key, path)?.as_string().ok_or_else(|| invalid(&format!("{path}.{key}")))
}

/// Copies a Uint8Array after charging its length to the input budget.
fn bytes(obj: &JsValue, key: &str, path: &str, total: &mut u64) -> Result<Vec<u8>, String> {
    let v = get(obj, key, path)?;
    if !v.is_instance_of::<Uint8Array>() {
        return Err(invalid(&format!("{path}.{key}")));
    }
    let arr: Uint8Array = v.unchecked_into();
    *total = add_input_bytes(*total, u64::from(arr.length()))?;
    Ok(arr.to_vec())
}

pub(crate) fn read_images(images: &Array) -> Result<Vec<RawImage>, String> {
    if images.length() as usize > MAX_IMAGES {
        return Err(invalid("images"));
    }
    let mut total = 0u64;
    let mut out = Vec::with_capacity(images.length() as usize);
    for i in 0..images.length() {
        let v = images.get(i);
        let path = format!("images[{i}]");
        let data = match string(&v, "kind", &path)?.as_str() {
            "jpeg" => RawData::Jpeg(bytes(&v, "bytes", &path, &mut total)?),
            "rgba" => RawData::Rgba {
                width: num(&v, "width", &path)?,
                height: num(&v, "height", &path)?,
                pixels: bytes(&v, "pixels", &path, &mut total)?,
            },
            _ => return Err(invalid(&format!("{path}.kind"))),
        };
        let flip_x = get(&v, "flipX", &path)?.as_bool().ok_or_else(|| invalid(&format!("{path}.flipX")))?;
        out.push(RawImage { data, rotate: num(&v, "rotate", &path)?, flip_x });
    }
    Ok(out)
}

pub(crate) fn read_layout(layout: &JsValue) -> Result<RawLayout, String> {
    let page_val = get(layout, "page", "layout")?;
    let page = if page_val.as_string().as_deref() == Some("fit") {
        RawPage::Fit
    } else if Array::is_array(&page_val) {
        let a: Array = page_val.unchecked_into();
        if a.length() != 2 {
            return Err(invalid("page"));
        }
        let side = |i: u32| a.get(i).as_f64().ok_or_else(|| invalid("page"));
        RawPage::Paper([side(0)?, side(1)?])
    } else {
        return Err(invalid("page"));
    };
    Ok(RawLayout {
        page,
        orientation: string(layout, "orientation", "layout")?,
        margin: num(layout, "margin", "layout")?,
    })
}
