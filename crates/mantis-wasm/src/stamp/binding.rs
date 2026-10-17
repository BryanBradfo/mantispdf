//! Thin js_sys::Reflect layer: copies a JS `StampJobSpec` into the raw
//! structs of `job`. All range checks happen in `job::validate_job`.

use super::job::{
    RawBates, RawImage, RawImageData, RawJob, RawPages, RawText, invalid,
};
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

fn array(obj: &JsValue, key: &str, path: &str) -> Result<Array, String> {
    let v = get(obj, key, path)?;
    if Array::is_array(&v) { Ok(v.unchecked_into()) } else { Err(invalid(&format!("{path}.{key}"))) }
}

fn bytes(obj: &JsValue, key: &str, path: &str) -> Result<Vec<u8>, String> {
    let v = get(obj, key, path)?;
    if v.is_instance_of::<Uint8Array>() {
        Ok(v.unchecked_into::<Uint8Array>().to_vec())
    } else {
        Err(invalid(&format!("{path}.{key}")))
    }
}

fn text(v: &JsValue, path: &str) -> Result<RawText, String> {
    let color = array(v, "color", path)?;
    if color.length() != 3 {
        return Err(invalid(&format!("{path}.color")));
    }
    let mut c = [0.0; 3];
    for (i, slot) in c.iter_mut().enumerate() {
        *slot = color.get(i as u32).as_f64().ok_or_else(|| invalid(&format!("{path}.color")))?;
    }
    Ok(RawText {
        template: string(v, "template", path)?,
        font: string(v, "font", path)?,
        size: num(v, "size", path)?,
        color: c,
        opacity: num(v, "opacity", path)?,
        anchor: string(v, "anchor", path)?,
        margin_x: num(v, "marginX", path)?,
        margin_y: num(v, "marginY", path)?,
    })
}

fn image(v: &JsValue, path: &str) -> Result<RawImage, String> {
    let img = get(v, "image", path)?;
    let ipath = format!("{path}.image");
    let data = match string(&img, "kind", &ipath)?.as_str() {
        "rgba" => RawImageData::Rgba {
            width: num(&img, "width", &ipath)?,
            height: num(&img, "height", &ipath)?,
            pixels: bytes(&img, "pixels", &ipath)?,
        },
        "jpeg" => RawImageData::Jpeg(bytes(&img, "bytes", &ipath)?),
        _ => return Err(invalid(&format!("{ipath}.kind"))),
    };
    let rect = array(v, "rect", path)?;
    if rect.length() != 4 {
        return Err(invalid(&format!("{path}.rect")));
    }
    let mut r = [0.0; 4];
    for (i, slot) in r.iter_mut().enumerate() {
        *slot = rect.get(i as u32).as_f64().ok_or_else(|| invalid(&format!("{path}.rect")))?;
    }
    Ok(RawImage { image: data, page: num(v, "page", path)?, rect: r, opacity: num(v, "opacity", path)? })
}

pub(crate) fn read_job(job: &JsValue) -> Result<RawJob, String> {
    let pages_val = get(job, "pages", "job")?;
    let pages = if pages_val.as_string().as_deref() == Some("all") {
        RawPages::All
    } else if Array::is_array(&pages_val) {
        let arr: Array = pages_val.unchecked_into();
        let mut out = Vec::with_capacity(arr.length() as usize);
        for i in 0..arr.length() {
            out.push(arr.get(i).as_f64().ok_or_else(|| invalid(&format!("pages[{i}]")))?);
        }
        RawPages::List(out)
    } else {
        return Err(invalid("pages"));
    };

    let texts = array(job, "texts", "job")?;
    let mut raw_texts = Vec::new();
    for i in 0..texts.length() {
        raw_texts.push(text(&texts.get(i), &format!("texts[{i}]"))?);
    }
    let images = array(job, "images", "job")?;
    let mut raw_images = Vec::new();
    for i in 0..images.length() {
        raw_images.push(image(&images.get(i), &format!("images[{i}]"))?);
    }

    let bates_val = Reflect::get(job, &JsValue::from_str("bates")).map_err(|_| invalid("bates"))?;
    let bates = if bates_val.is_undefined() || bates_val.is_null() {
        None
    } else {
        Some(RawBates {
            prefix: string(&bates_val, "prefix", "bates")?,
            suffix: string(&bates_val, "suffix", "bates")?,
            start: num(&bates_val, "start", "bates")?,
            digits: num(&bates_val, "digits", "bates")?,
        })
    };

    Ok(RawJob { pages, texts: raw_texts, images: raw_images, number_start: num(job, "numberStart", "job")?, bates })
}
