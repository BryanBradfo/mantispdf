//! Thin js_sys::Reflect layer: copies a JS `EditJobSpec` (see
//! `src/lib/editor/toJob.ts`) into the raw structs of `job`. It never
//! panics; shape errors come back as `Invalid edit settings: <path>`. Range
//! checks happen in `job::validate_job` and `edit_pdf`.

use super::job::{RawImageData, RawItem, RawJob, RawPaint};
use super::{MAX_FREEHAND_POINTS, MAX_IMAGE_BYTES, MAX_IMAGES, MAX_ITEMS, invalid};
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

fn boolean(obj: &JsValue, key: &str, path: &str) -> Result<bool, String> {
    get(obj, key, path)?.as_bool().ok_or_else(|| invalid(&format!("{path}.{key}")))
}

fn array(obj: &JsValue, key: &str, path: &str) -> Result<Array, String> {
    let v = get(obj, key, path)?;
    if Array::is_array(&v) { Ok(v.unchecked_into()) } else { Err(invalid(&format!("{path}.{key}"))) }
}

/// A JS array of exactly `N` numbers.
fn fixed<const N: usize>(v: &JsValue, field: &str) -> Result<[f64; N], String> {
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

fn nums<const N: usize>(obj: &JsValue, key: &str, path: &str) -> Result<[f64; N], String> {
    fixed(&get(obj, key, path)?, &format!("{path}.{key}"))
}

fn paint(obj: &JsValue, key: &str, path: &str) -> Result<RawPaint, String> {
    let v = get(obj, key, path)?;
    let p = format!("{path}.{key}");
    match string(&v, "kind", &p)?.as_str() {
        "none" => Ok(RawPaint::None),
        "rgb" => Ok(RawPaint::Rgb(nums::<3>(&v, "color", &p)?)),
        _ => Err(invalid(&format!("{p}.kind"))),
    }
}

/// Image bytes; `budget` is what the job may still carry (checked on the
/// JS length before anything is copied).
fn bytes(obj: &JsValue, key: &str, path: &str, budget: &mut u64) -> Result<Vec<u8>, String> {
    let v = get(obj, key, path)?;
    if !v.is_instance_of::<Uint8Array>() {
        return Err(invalid(&format!("{path}.{key}")));
    }
    let arr: Uint8Array = v.unchecked_into();
    let len = u64::from(arr.length());
    if len > *budget {
        return Err(invalid("images"));
    }
    *budget -= len;
    Ok(arr.to_vec())
}

fn image(v: &JsValue, path: &str, budget: &mut u64) -> Result<RawImageData, String> {
    let img = get(v, "image", path)?;
    let ipath = format!("{path}.image");
    match string(&img, "kind", &ipath)?.as_str() {
        "jpeg" => Ok(RawImageData::Jpeg(bytes(&img, "bytes", &ipath, budget)?)),
        "rgba" => Ok(RawImageData::Rgba {
            width: num(&img, "width", &ipath)?,
            height: num(&img, "height", &ipath)?,
            pixels: bytes(&img, "pixels", &ipath, budget)?,
        }),
        _ => Err(invalid(&format!("{ipath}.kind"))),
    }
}

fn item(v: &JsValue, path: &str, images: &mut usize, budget: &mut u64) -> Result<RawItem, String> {
    let page = num(v, "page", path)?;
    Ok(match string(v, "kind", path)?.as_str() {
        "text" => RawItem::Text {
            page,
            rect: nums(v, "rect", path)?,
            text: string(v, "text", path)?,
            font: string(v, "font", path)?,
            size: num(v, "size", path)?,
            color: nums(v, "color", path)?,
            opacity: num(v, "opacity", path)?,
            align: string(v, "align", path)?,
            line_height: num(v, "lineHeight", path)?,
        },
        "image" => {
            *images += 1;
            if *images > MAX_IMAGES {
                return Err(invalid("images"));
            }
            RawItem::Image {
                page,
                rect: nums(v, "rect", path)?,
                image: image(v, path, budget)?,
                opacity: num(v, "opacity", path)?,
                rotation: num(v, "rotation", path)?,
            }
        }
        "rect" => RawItem::Rect {
            page,
            rect: nums(v, "rect", path)?,
            stroke: paint(v, "stroke", path)?,
            width: num(v, "width", path)?,
            fill: paint(v, "fill", path)?,
            opacity: num(v, "opacity", path)?,
        },
        "ellipse" => RawItem::Ellipse {
            page,
            rect: nums(v, "rect", path)?,
            stroke: paint(v, "stroke", path)?,
            width: num(v, "width", path)?,
            fill: paint(v, "fill", path)?,
            opacity: num(v, "opacity", path)?,
        },
        "line" => RawItem::Line {
            page,
            from: nums(v, "from", path)?,
            to: nums(v, "to", path)?,
            color: nums(v, "color", path)?,
            width: num(v, "width", path)?,
            opacity: num(v, "opacity", path)?,
            arrow_start: boolean(v, "arrowStart", path)?,
            arrow_end: boolean(v, "arrowEnd", path)?,
        },
        "highlight" => RawItem::Highlight {
            page,
            rect: nums(v, "rect", path)?,
            color: nums(v, "color", path)?,
            opacity: num(v, "opacity", path)?,
        },
        "freehand" => {
            let pts = array(v, "points", path)?;
            // Re-checked by the engine; checking here keeps a huge array from being copied.
            if pts.length() as usize > MAX_FREEHAND_POINTS {
                return Err(invalid("points"));
            }
            let mut points = Vec::with_capacity(pts.length() as usize);
            for i in 0..pts.length() {
                points.push(fixed::<2>(&pts.get(i), &format!("{path}.points[{i}]"))?);
            }
            RawItem::Freehand {
                page,
                points,
                color: nums(v, "color", path)?,
                width: num(v, "width", path)?,
                opacity: num(v, "opacity", path)?,
            }
        }
        "whiteout" => RawItem::Whiteout { page, rect: nums(v, "rect", path)? },
        _ => return Err(invalid(&format!("{path}.kind"))),
    })
}

pub(crate) fn read_job(job: &JsValue) -> Result<RawJob, String> {
    let list = array(job, "items", "job")?;
    if list.length() as usize > MAX_ITEMS {
        return Err(invalid("items"));
    }
    let (mut images, mut budget) = (0usize, MAX_IMAGE_BYTES);
    let mut items = Vec::with_capacity(list.length() as usize);
    for i in 0..list.length() {
        items.push(item(&list.get(i), &format!("items[{i}]"), &mut images, &mut budget)?);
    }
    Ok(RawJob { items })
}
