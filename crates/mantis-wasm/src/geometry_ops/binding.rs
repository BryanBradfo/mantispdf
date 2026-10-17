//! Thin js_sys::Reflect layer: copies JS geometry job objects into the raw
//! structs of `job`. All range checks happen in `job::validate_*`.

use super::invalid;
use super::job::{RawCrop, RawNup, RawPages, RawResize, RawSheet};
use js_sys::{Array, Reflect};
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

fn boolean(obj: &JsValue, key: &str, path: &str) -> Result<bool, String> {
    get(obj, key, path)?.as_bool().ok_or_else(|| invalid(&format!("{path}.{key}")))
}

/// `obj[key]`, or `None` when it is absent (undefined or null).
fn optional(obj: &JsValue, key: &str, path: &str) -> Result<Option<JsValue>, String> {
    if !obj.is_object() {
        return Err(invalid(path));
    }
    let v = Reflect::get(obj, &JsValue::from_str(key)).map_err(|_| invalid(&format!("{path}.{key}")))?;
    Ok(if v.is_undefined() || v.is_null() { None } else { Some(v) })
}

/// An array of exactly `N` numbers.
fn numbers<const N: usize>(v: &JsValue, field: &str) -> Result<[f64; N], String> {
    if !Array::is_array(v) {
        return Err(invalid(field));
    }
    let a: Array = v.clone().unchecked_into();
    if a.length() as usize != N {
        return Err(invalid(field));
    }
    let mut out = [0.0; N];
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = a.get(i as u32).as_f64().ok_or_else(|| invalid(field))?;
    }
    Ok(out)
}

fn read_pages(job: &JsValue) -> Result<RawPages, String> {
    let v = get(job, "pages", "job")?;
    if v.as_string().as_deref() == Some("all") {
        return Ok(RawPages::All);
    }
    if !Array::is_array(&v) {
        return Err(invalid("pages"));
    }
    let arr: Array = v.unchecked_into();
    let mut out = Vec::with_capacity(arr.length() as usize);
    for i in 0..arr.length() {
        out.push(arr.get(i).as_f64().ok_or_else(|| invalid(&format!("pages[{i}]")))?);
    }
    Ok(RawPages::List(out))
}

pub(crate) fn read_crop(job: &JsValue) -> Result<RawCrop, String> {
    let pages = read_pages(job)?;
    let rect = match optional(job, "rect", "job")? {
        None => None,
        Some(r) => Some(numbers::<4>(&r, "rect")?),
    };
    let per_page = match optional(job, "perPage", "job")? {
        None => Vec::new(),
        Some(v) => {
            if !Array::is_array(&v) {
                return Err(invalid("perPage"));
            }
            let arr: Array = v.unchecked_into();
            // Re-checked in `validate_crop`; checking here keeps a huge array
            // from being copied first.
            if arr.length() as usize > super::crop::MAX_PER_PAGE {
                return Err(invalid("perPage"));
            }
            let mut out = Vec::with_capacity(arr.length() as usize);
            for i in 0..arr.length() {
                let e = arr.get(i);
                let path = format!("perPage[{i}]");
                let page = num(&e, "page", &path)?;
                let rect = numbers::<4>(&get(&e, "rect", &path)?, &format!("{path}.rect"))?;
                out.push((page, rect));
            }
            out
        }
    };
    let permanent = match optional(job, "permanent", "job")? {
        None => false,
        Some(p) => p.as_bool().ok_or_else(|| invalid("permanent"))?,
    };
    Ok(RawCrop { pages, rect, per_page, permanent })
}

pub(crate) fn read_resize(job: &JsValue) -> Result<RawResize, String> {
    Ok(RawResize {
        pages: read_pages(job)?,
        size: numbers::<2>(&get(job, "size", "job")?, "size")?,
        orientation: string(job, "orientation", "job")?,
        mode: string(job, "mode", "job")?,
        margin: num(job, "margin", "job")?,
    })
}

pub(crate) fn read_nup(job: &JsValue) -> Result<RawNup, String> {
    let sheet_val = get(job, "sheet", "job")?;
    let sheet = if sheet_val.as_string().as_deref() == Some("same") {
        RawSheet::Same
    } else {
        RawSheet::Size(numbers::<2>(&sheet_val, "sheet")?)
    };
    Ok(RawNup {
        per_sheet: num(job, "perSheet", "job")?,
        sheet,
        orientation: string(job, "orientation", "job")?,
        order: string(job, "order", "job")?,
        margin: num(job, "margin", "job")?,
        gap: num(job, "gap", "job")?,
        border: boolean(job, "border", "job")?,
    })
}
