//! Thin js_sys::Reflect layer between the worker and `add_text_layer`
//! (shapes in `src/lib/ocr/textLayerWire.ts`, keys in
//! `src/lib/ocr/wireKeys.ts`). Counts (pages, words per page, words in all)
//! and string lengths are checked on the JS lengths before anything is
//! copied. It never panics; shape errors come back as
//! `Invalid OCR settings: <path>`.

use super::job::{RawPage, check_counts};
use super::{MAX_WORD_UNITS, OcrWord, invalid};
use js_sys::{Array, JsString, Reflect};
use wasm_bindgen::{JsCast, JsValue};

/// `obj[key]`, which may be null or undefined.
fn get_any(obj: &JsValue, key: &str, path: &str) -> Result<JsValue, String> {
    if !obj.is_object() {
        return Err(invalid(path));
    }
    Reflect::get(obj, &JsValue::from_str(key)).map_err(|_| invalid(&format!("{path}.{key}")))
}

fn get(obj: &JsValue, key: &str, path: &str) -> Result<JsValue, String> {
    let v = get_any(obj, key, path)?;
    if v.is_undefined() || v.is_null() {
        return Err(invalid(&format!("{path}.{key}")));
    }
    Ok(v)
}

fn num(obj: &JsValue, key: &str, path: &str) -> Result<f64, String> {
    get(obj, key, path)?.as_f64().ok_or_else(|| invalid(&format!("{path}.{key}")))
}

fn array(v: &JsValue, path: &str) -> Result<Array, String> {
    if Array::is_array(v) { Ok(v.clone().unchecked_into()) } else { Err(invalid(path)) }
}

/// A word's text: a JS string of at most `MAX_WORD_UNITS` UTF-16 units,
/// checked before it is copied.
fn text(word: &JsValue, path: &str) -> Result<String, String> {
    match get(word, "text", path)?.dyn_ref::<JsString>() {
        Some(s) if s.length() as usize > MAX_WORD_UNITS => Err(invalid("text")),
        Some(s) => s.as_string().ok_or_else(|| invalid(&format!("{path}.text"))),
        None => Err(invalid(&format!("{path}.text"))),
    }
}

/// `{ text, x, y, w, h, baseline: number | null, spaceAfter, angle?: number | null }`.
fn word(v: &JsValue, path: &str) -> Result<OcrWord, String> {
    let baseline = match get_any(v, "baseline", path)? {
        b if b.is_null() => None,
        b => Some(b.as_f64().ok_or_else(|| invalid(&format!("{path}.baseline")))?),
    };
    let angle = match get_any(v, "angle", path)? {
        a if a.is_null() || a.is_undefined() => None,
        a => Some(a.as_f64().ok_or_else(|| invalid(&format!("{path}.angle")))?),
    };
    Ok(OcrWord {
        text: text(v, path)?,
        x: num(v, "x", path)?,
        y: num(v, "y", path)?,
        w: num(v, "w", path)?,
        h: num(v, "h", path)?,
        baseline,
        space_after: get(v, "spaceAfter", path)?.as_bool().ok_or_else(|| invalid(&format!("{path}.spaceAfter")))?,
        angle,
    })
}

/// `pages`: `[{ page, words: [word] }]`, words in visible-space points.
pub(crate) fn read_pages(pages: &JsValue) -> Result<Vec<RawPage>, String> {
    let list = array(pages, "pages")?;
    let mut word_lists = Vec::new();
    // The counts first, from the JS lengths alone.
    check_counts(list.length() as usize, std::iter::empty())?;
    for i in 0..list.length() {
        let path = format!("pages[{i}]");
        word_lists.push(array(&get(&list.get(i), "words", &path)?, &format!("{path}.words"))?);
    }
    check_counts(list.length() as usize, word_lists.iter().map(|w| w.length() as usize))?;
    let mut out = Vec::with_capacity(word_lists.len());
    for (i, words) in word_lists.iter().enumerate() {
        let path = format!("pages[{i}]");
        let page = num(&list.get(i as u32), "page", &path)?;
        let mut read = Vec::with_capacity(words.length() as usize);
        for k in 0..words.length() {
            read.push(word(&words.get(k), &format!("{path}.words[{k}]"))?);
        }
        out.push(RawPage { page, words: read });
    }
    Ok(out)
}
