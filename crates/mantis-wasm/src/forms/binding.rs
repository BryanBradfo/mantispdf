//! Thin js_sys::Reflect layer. `read_values` copies the JS fill values (see
//! `src/lib/forms/toWire.ts`) into the raw structs of `job`; `form_to_js`
//! builds the plain object `list_form` returns (see
//! `src/lib/forms/model.ts`). It never panics; shape errors come back as
//! `Invalid form settings: <path>`.

use super::job::{RawEntry, RawValue};
use super::{Field, FieldKind, FormInfo, MAX_FIELDS, MAX_OPTIONS, MAX_VALUE_CHARS, Value, Widget, Xfa, invalid};
use js_sys::{Array, JsString, Object, Reflect};
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

fn string(obj: &JsValue, key: &str, path: &str) -> Result<String, String> {
    get(obj, key, path)?.as_string().ok_or_else(|| invalid(&format!("{path}.{key}")))
}

fn num(obj: &JsValue, key: &str, path: &str) -> Result<f64, String> {
    get(obj, key, path)?.as_f64().ok_or_else(|| invalid(&format!("{path}.{key}")))
}

fn array(obj: &JsValue, key: &str, path: &str) -> Result<Array, String> {
    let v = get(obj, key, path)?;
    if Array::is_array(&v) { Ok(v.unchecked_into()) } else { Err(invalid(&format!("{path}.{key}"))) }
}

/// UTF-16 units a value string may have (two per character at most): checked
/// on the JS length before the string is copied.
const MAX_STRING_UNITS: u32 = 2 * MAX_VALUE_CHARS as u32;

/// A JS string of at most `MAX_STRING_UNITS` units.
fn bounded(v: &JsValue, path: &str) -> Result<String, String> {
    match v.dyn_ref::<JsString>() {
        Some(s) if s.length() <= MAX_STRING_UNITS => s.as_string().ok_or_else(|| invalid(path)),
        _ => Err(invalid(path)),
    }
}

fn value(entry: &JsValue, path: &str) -> Result<RawValue, String> {
    let v = get(entry, "value", path)?;
    let p = format!("{path}.value");
    match string(&v, "kind", &p)?.as_str() {
        "text" => Ok(RawValue::Text(bounded(&get(&v, "text", &p)?, &format!("{p}.text"))?)),
        "names" => {
            let list = array(&v, "names", &p)?;
            // Checked before copying; `fill_form` re-checks against the field.
            if list.length() as usize > MAX_OPTIONS {
                return Err(invalid(&format!("{p}.names")));
            }
            let mut names = Vec::with_capacity(list.length() as usize);
            for i in 0..list.length() {
                names.push(bounded(&list.get(i), &format!("{p}.names[{i}]"))?);
            }
            Ok(RawValue::Names(names))
        }
        "none" => Ok(RawValue::None),
        _ => Err(invalid(&format!("{p}.kind"))),
    }
}

/// `values`: `[{ id, value: { kind: "text", text } | { kind: "names", names } | { kind: "none" } }]`.
pub(crate) fn read_values(values: &JsValue) -> Result<Vec<RawEntry>, String> {
    if !Array::is_array(values) {
        return Err(invalid("values"));
    }
    let list: Array = values.clone().unchecked_into();
    if list.length() as usize > MAX_FIELDS {
        return Err(invalid("values"));
    }
    let mut out = Vec::with_capacity(list.length() as usize);
    for i in 0..list.length() {
        let entry = list.get(i);
        let path = format!("values[{i}]");
        out.push(RawEntry { id: num(&entry, "id", &path)?, value: value(&entry, &path)? });
    }
    Ok(out)
}

fn set(obj: &Object, key: &str, v: impl Into<JsValue>) {
    // Setting a plain data property on a fresh plain object cannot fail.
    let _ = Reflect::set(obj, &JsValue::from_str(key), &v.into());
}

fn strings(items: &[String]) -> Array {
    items.iter().map(|s| JsValue::from_str(s)).collect()
}

fn value_to_js(value: &Value) -> Object {
    let o = Object::new();
    match value {
        Value::Text(t) => {
            set(&o, "kind", "text");
            set(&o, "text", t.as_str());
        }
        Value::Names(n) => {
            set(&o, "kind", "names");
            set(&o, "names", strings(n));
        }
        Value::None => set(&o, "kind", "none"),
    }
    o
}

fn kind_to_js(kind: &FieldKind) -> Object {
    let o = Object::new();
    match kind {
        FieldKind::Text { multiline, comb, max_len, password } => {
            set(&o, "kind", "text");
            set(&o, "multiline", *multiline);
            set(&o, "comb", *comb);
            set(&o, "maxLen", max_len.map_or(JsValue::NULL, |n| JsValue::from_f64(f64::from(n))));
            set(&o, "password", *password);
        }
        FieldKind::Checkbox => set(&o, "kind", "checkbox"),
        FieldKind::Radio => set(&o, "kind", "radio"),
        FieldKind::Combo { editable } => {
            set(&o, "kind", "combo");
            set(&o, "editable", *editable);
        }
        FieldKind::List { multi } => {
            set(&o, "kind", "list");
            set(&o, "multi", *multi);
        }
        FieldKind::Signature => set(&o, "kind", "signature"),
        FieldKind::Button => set(&o, "kind", "button"),
    }
    o
}

fn widget_to_js(w: &Widget) -> Object {
    let o = Object::new();
    set(&o, "page", w.page);
    set(&o, "rect", w.rect.iter().map(|&n| JsValue::from_f64(n)).collect::<Array>());
    set(&o, "rotation", w.rotation);
    set(&o, "onState", w.on_state.as_deref().map_or(JsValue::NULL, JsValue::from_str));
    set(&o, "hidden", w.hidden);
    set(&o, "font", w.font.base_font());
    set(&o, "fontSize", w.font_size);
    set(&o, "align", w.align);
    set(&o, "annotIndex", w.annot_index.map_or(JsValue::NULL, |i| JsValue::from_f64(f64::from(i))));
    set(&o, "tabs", w.tabs.as_deref().map_or(JsValue::NULL, JsValue::from_str));
    o
}

fn field_to_js(f: &Field) -> Object {
    let o = Object::new();
    set(&o, "id", f.id);
    set(&o, "name", f.name.as_str());
    set(&o, "label", f.label.as_str());
    set(&o, "kind", kind_to_js(&f.kind));
    set(&o, "readOnly", f.read_only);
    set(&o, "required", f.required);
    set(&o, "value", value_to_js(&f.value));
    let options: Array = f
        .options
        .iter()
        .map(|(export, display)| {
            let opt = Object::new();
            set(&opt, "exportValue", export.as_str());
            set(&opt, "display", display.as_str());
            JsValue::from(opt)
        })
        .collect();
    set(&o, "options", options);
    set(&o, "onStates", strings(&f.on_states));
    set(&o, "widgets", f.widgets.iter().map(|w| JsValue::from(widget_to_js(w))).collect::<Array>());
    o
}

/// `{ xfa: "none" | "hybrid" | "pure", fields: Field[], signed: boolean }`.
pub(crate) fn form_to_js(info: &FormInfo) -> JsValue {
    let o = Object::new();
    let xfa = match info.xfa {
        Xfa::None => "none",
        Xfa::Hybrid => "hybrid",
        Xfa::Pure => "pure",
    };
    set(&o, "xfa", xfa);
    set(&o, "fields", info.fields.iter().map(|f| JsValue::from(field_to_js(f))).collect::<Array>());
    set(&o, "signed", info.signed);
    o.into()
}
