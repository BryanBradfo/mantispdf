//! Thin js_sys::Reflect layer: copies a JS `EditJobSpec` (see
//! `src/lib/editor/toJob.ts`) into the raw structs of `job`. It never
//! panics; shape errors come back as `Invalid edit settings: <path>`. Range
//! checks happen in `job::validate_job` and `edit_pdf`.

use super::job::{RawImageData, RawItem, RawJob, RawPaint, RawUnicode};
use super::{MAX_FREEHAND_POINTS, MAX_IMAGE_BYTES, MAX_IMAGES, MAX_ITEMS, invalid};
use crate::unifont::{MAX_FONT_BYTES, MAX_FONTS};
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

fn string(obj: &JsValue, key: &str, path: &str) -> Result<String, String> {
    get(obj, key, path)?.as_string().ok_or_else(|| invalid(&format!("{path}.{key}")))
}

/// `obj[key]`, None when it is absent (undefined or null).
fn optional(obj: &JsValue, key: &str, path: &str) -> Result<Option<JsValue>, String> {
    let v = Reflect::get(obj, &JsValue::from_str(key)).map_err(|_| invalid(&format!("{path}.{key}")))?;
    Ok((!v.is_undefined() && !v.is_null()).then_some(v))
}

/// A JS array of strings.
fn strings(v: &JsValue, field: &str) -> Result<Vec<String>, String> {
    if !Array::is_array(v) {
        return Err(invalid(field));
    }
    let a: Array = v.clone().unchecked_into();
    if a.length() as usize > MAX_FONTS {
        return Err(invalid(field));
    }
    a.iter().map(|s| s.as_string().ok_or_else(|| invalid(field))).collect()
}

/// The embedded fonts of a text item (`family: "noto"`), None for a standard font.
fn unicode(v: &JsValue, path: &str) -> Result<Option<RawUnicode>, String> {
    let Some(family) = optional(v, "family", path)? else {
        return Ok(None);
    };
    match family.as_string().as_deref() {
        Some("standard") => Ok(None),
        Some("noto") => Ok(Some(RawUnicode {
            faces: strings(&get(v, "faces", path)?, &format!("{path}.faces"))?,
            fake_bold: match optional(v, "fakeBold", path)? {
                Some(list) => strings(&list, &format!("{path}.fakeBold"))?,
                None => Vec::new(),
            },
        })),
        _ => Err(invalid(&format!("{path}.family"))),
    }
}

/// The job's font files (`fonts: [{ id, bytes }]`): count and total size
/// are checked on the JS lengths before anything is copied.
fn fonts(job: &JsValue) -> Result<Vec<(String, Vec<u8>)>, String> {
    let Some(list) = optional(job, "fonts", "job")? else {
        return Ok(Vec::new());
    };
    if !Array::is_array(&list) {
        return Err(invalid("font"));
    }
    let list: Array = list.unchecked_into();
    if list.length() as usize > MAX_FONTS {
        return Err(invalid("font"));
    }
    let mut entries = Vec::with_capacity(list.length() as usize);
    let mut total = 0usize;
    for (i, entry) in list.iter().enumerate() {
        let path = format!("fonts[{i}]");
        let id = string(&entry, "id", &path)?;
        let bytes = data(&entry, "bytes", &path)?;
        total = total.saturating_add(bytes.length() as usize);
        if total > MAX_FONT_BYTES {
            return Err(invalid("font"));
        }
        entries.push((id, bytes));
    }
    Ok(entries.into_iter().map(|(id, bytes)| (id, bytes.to_vec())).collect())
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

/// Running totals of the job read so far: image placements and data (to recognise a buffer
/// placed again) and freehand points.
struct JobTotals {
    placements: usize,
    /// What the job may still carry, counted once per distinct buffer.
    budget: u64,
    /// Data buffers already read and the index of the item that read them.
    seen: Vec<(JsValue, usize)>,
    /// Freehand points of the strokes read so far.
    points: usize,
}

/// The `Uint8Array` at `obj[key]`, not copied yet.
fn data(obj: &JsValue, key: &str, path: &str) -> Result<Uint8Array, String> {
    let v = get(obj, key, path)?;
    if !v.is_instance_of::<Uint8Array>() {
        return Err(invalid(&format!("{path}.{key}")));
    }
    Ok(v.unchecked_into())
}

/// Copies `arr` once the budget allows it (checked on the JS length before copying).
fn copy(arr: &Uint8Array, budget: &mut u64) -> Result<Vec<u8>, String> {
    let len = u64::from(arr.length());
    if len > *budget {
        return Err(invalid("images"));
    }
    *budget -= len;
    Ok(arr.to_vec())
}

/// The image of item `index`. A data buffer already read by an earlier item (the same picked
/// image placed again: `buildEditJob` shares it) is neither copied nor charged again; the engine
/// then embeds it once.
fn image(v: &JsValue, index: usize, path: &str, reader: &mut JobTotals) -> Result<RawImageData, String> {
    let img = get(v, "image", path)?;
    let ipath = format!("{path}.image");
    let kind = string(&img, "kind", &ipath)?;
    let key = match kind.as_str() {
        "jpeg" => "bytes",
        "rgba" => "pixels",
        _ => return Err(invalid(&format!("{ipath}.kind"))),
    };
    let arr = data(&img, key, &ipath)?;
    if let Some(&(_, j)) = reader.seen.iter().find(|(prev, _)| Object::is(prev, &arr)) {
        return Ok(RawImageData::Same(j));
    }
    let out = if kind == "jpeg" {
        RawImageData::Jpeg(copy(&arr, &mut reader.budget)?)
    } else {
        RawImageData::Rgba {
            width: num(&img, "width", &ipath)?,
            height: num(&img, "height", &ipath)?,
            pixels: copy(&arr, &mut reader.budget)?,
        }
    };
    reader.seen.push((arr.into(), index));
    Ok(out)
}

fn item(v: &JsValue, index: usize, path: &str, reader: &mut JobTotals) -> Result<RawItem, String> {
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
            unicode: unicode(v, path)?,
        },
        "image" => {
            reader.placements += 1;
            if reader.placements > MAX_IMAGES {
                return Err(invalid("images"));
            }
            RawItem::Image {
                page,
                rect: nums(v, "rect", path)?,
                image: image(v, index, path, reader)?,
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
            // Re-checked by the engine; checking the running total here keeps the job from
            // copying more points than all strokes together may have.
            reader.points = reader.points.saturating_add(pts.length() as usize);
            if reader.points > MAX_FREEHAND_POINTS {
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
    let mut reader = JobTotals { placements: 0, budget: MAX_IMAGE_BYTES, seen: Vec::new(), points: 0 };
    let mut items = Vec::with_capacity(list.length() as usize);
    for i in 0..list.length() {
        items.push(item(&list.get(i), i as usize, &format!("items[{i}]"), &mut reader)?);
    }
    Ok(RawJob { items, fonts: fonts(job)? })
}

/// A `PreviewLayout` as `{ lines: [{ baselineY, runs: [{ face, rtl, x, width, text }] }], missing }`.
pub(crate) fn preview_to_js(layout: &super::unitext::PreviewLayout) -> JsValue {
    let set = |obj: &Object, key: &str, value: JsValue| {
        let _ = Reflect::set(obj, &JsValue::from_str(key), &value);
    };
    let lines = Array::new();
    for line in &layout.lines {
        let l = Object::new();
        set(&l, "baselineY", line.baseline_y.into());
        let runs = Array::new();
        for run in &line.runs {
            let r = Object::new();
            set(&r, "face", (run.face as u32).into());
            set(&r, "rtl", run.rtl.into());
            set(&r, "x", run.x.into());
            set(&r, "width", run.width.into());
            set(&r, "text", JsValue::from_str(&run.text));
            runs.push(&r);
        }
        set(&l, "runs", runs.into());
        lines.push(&l);
    }
    let out = Object::new();
    set(&out, "lines", lines.into());
    set(&out, "missing", JsValue::from_str(&layout.missing));
    set(&out, "height", layout.height.into());
    out.into()
}
