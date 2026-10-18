//! Fill form fields: set /V (and /I, /AS), give every changed text and
//! choice widget a new appearance stream, set /NeedAppearances false (our
//! appearances are authoritative) and drop /XFA. Unchanged text and choice
//! fields whose appearances are stale (the source asked viewers to rebuild
//! them) or missing get new ones too. All values are validated before the
//! document is touched.

use super::appearance::{
    Frame, Layout, check_appearance, font_resource, frame_content, list_appearance, radio_appearance, text_appearance,
};
use super::tree::{DefaultAppearance, FF_RADIOS_IN_UNISON, FieldRef, acroform, inherited, integer, read_form};
use super::{Field, FieldKind, MAX_OPTIONS, MAX_VALUE_CHARS, Value, invalid};
use crate::annotations::parse_numbers;
use crate::doc_tools::pdfdoc_char;
use crate::pdf_util::{load_pdf, save_pdf};
use crate::rebuild::{add_rotation, deref};
use crate::stamp::engine::MAX_COORD;
use crate::stamp::fonts::{StdFont, encode_winansi};
use crate::stamp::page_writer::font_object;
use lopdf::{Dictionary, Document, Object, ObjectId, Stream, StringFormat, dictionary};
use std::collections::{HashMap, HashSet};

/// Fill `values` (field id from `list_form`, new value) and return the saved
/// PDF, with the fields baked into the pages when `flatten` is set.
pub fn fill_form(pdf: &[u8], values: &[(u32, Value)], flatten: bool) -> Result<Vec<u8>, String> {
    let mut doc = load_pdf(pdf)?;
    fill_document(&mut doc, values)?;
    if flatten {
        super::flatten::flatten_document(&mut doc)?;
    }
    save_pdf(&mut doc)
}

/// A validated change to one field.
#[derive(Debug)]
enum Change {
    /// Text field or combo box: the value and the text its widgets show.
    Text { value: String, shown: String, combo: bool },
    /// List box: selected /Opt indices, ascending.
    List { selected: Vec<usize>, multi: bool },
    /// Checkbox or radio group: raw "on" state name, or None for /Off.
    /// `check_default`: the checkbox has no on appearance and is set to /Yes.
    Button { state: Option<Vec<u8>>, check_default: bool },
}

/// What a text or choice field's widgets show.
enum Shown {
    Text(String),
    /// Selected /Opt indices of a list box.
    List(Vec<usize>),
}

/// On state name used for a checkbox whose widgets have no "on" appearance.
const DEFAULT_ON: &str = "Yes";

pub(crate) fn fill_document(doc: &mut Document, values: &[(u32, Value)]) -> Result<(), String> {
    let tree = read_form(doc)?;
    let mut seen = HashSet::new();
    let mut changes = Vec::new();
    for (id, value) in values {
        let index = *id as usize;
        let (Some(field), Some(field_ref)) = (tree.info.fields.get(index), tree.refs.get(index)) else {
            return Err(invalid("field"));
        };
        if !seen.insert(*id) {
            return Err(invalid("field"));
        }
        if let Some(change) = validate(field, field_ref, value)? {
            changes.push((index, change));
        }
    }

    let rebuild_all = acroform(doc)
        .and_then(|f| f.get(b"NeedAppearances").ok())
        .is_some_and(|v| matches!(v, Object::Boolean(true)));
    let changed: HashSet<usize> = changes.iter().map(|(i, _)| *i).collect();
    let mut fonts: HashMap<StdFont, ObjectId> = HashMap::new();
    for (index, change) in changes {
        apply(doc, &tree.info.fields[index], &tree.refs[index], change, &mut fonts);
    }
    // We own every appearance (/NeedAppearances false): refresh unchanged
    // text and choice fields that have a value when the source asked for a
    // rebuild or a visible widget has no normal appearance. Buttons keep
    // theirs; /AS already picks the state.
    for (index, (field, field_ref)) in tree.info.fields.iter().zip(&tree.refs).enumerate() {
        if changed.contains(&index) || field.value == Value::None {
            continue;
        }
        let Some(shown) = current_shown(field) else {
            continue;
        };
        let visible = || field.widgets.iter().zip(&field_ref.widgets).filter(|(w, _)| !w.hidden);
        if rebuild_all || visible().any(|(_, r)| !has_normal_appearance(doc, r.obj)) {
            let only: Vec<usize> = (0..field.widgets.len()).filter(|&i| !field.widgets[i].hidden).collect();
            draw_field(doc, field, field_ref, &shown, &only, &mut fonts);
        }
    }
    mark_form(doc);
    Ok(())
}

fn has_normal_appearance(doc: &Document, widget: ObjectId) -> bool {
    doc.get_dictionary(widget)
        .ok()
        .and_then(|w| deref(doc, w.get(b"AP").ok()?))
        .and_then(|ap| ap.as_dict().ok())
        .is_some_and(|ap| ap.get(b"N").ok().and_then(|n| deref(doc, n)).is_some())
}

/// What a text or choice field shows for its current value (None for other
/// kinds).
fn current_shown(field: &Field) -> Option<Shown> {
    match (&field.kind, &field.value) {
        (FieldKind::Text { password, .. }, Value::Text(t)) => {
            Some(Shown::Text(if *password { "*".repeat(t.chars().count()) } else { t.clone() }))
        }
        (FieldKind::Combo { .. }, Value::Text(t)) => Some(Shown::Text(
            field.options.iter().find(|(e, _)| e == t).map_or_else(|| t.clone(), |(_, d)| d.clone()),
        )),
        (FieldKind::List { .. }, Value::Names(names)) => {
            let wanted: HashSet<&str> = names.iter().map(String::as_str).collect();
            let selected = (0..field.options.len()).filter(|&i| wanted.contains(field.options[i].0.as_str())).collect();
            Some(Shown::List(selected))
        }
        _ => None,
    }
}

fn text_of(value: &Value) -> Result<String, String> {
    match value {
        Value::Text(s) => Ok(s.clone()),
        Value::None => Ok(String::new()),
        Value::Names(_) => Err(invalid("value")),
    }
}

fn names_of(value: &Value) -> Result<Vec<String>, String> {
    match value {
        Value::Names(n) => Ok(n.clone()),
        Value::None => Ok(Vec::new()),
        Value::Text(_) => Err(invalid("value")),
    }
}

/// The same value as the field has now (an empty text or selection equals
/// no value).
fn same_value(a: &Value, b: &Value) -> bool {
    let norm = |v: &Value| match v {
        Value::Text(s) if s.is_empty() => Value::None,
        Value::Names(n) if n.is_empty() => Value::None,
        other => other.clone(),
    };
    norm(a) == norm(b)
}

/// Text the standard fonts can show (line breaks allowed in multiline).
fn check_text(text: &str, multiline: bool) -> Result<(), String> {
    if text.chars().count() > MAX_VALUE_CHARS {
        return Err(invalid("value"));
    }
    if !multiline && text.contains(['\r', '\n']) {
        return Err(invalid("value"));
    }
    encode_winansi(&text.replace(['\r', '\n'], " ")).map(|_| ())
}

fn validate(field: &Field, field_ref: &FieldRef, value: &Value) -> Result<Option<Change>, String> {
    if field.read_only {
        return if same_value(value, &field.value) { Ok(None) } else { Err(invalid("read-only")) };
    }
    let change = match &field.kind {
        FieldKind::Signature | FieldKind::Button => return Err(invalid("value")),
        FieldKind::Text { multiline, max_len, password, .. } => {
            let text = text_of(value)?;
            check_text(&text, *multiline)?;
            if max_len.is_some_and(|m| text.chars().count() > m as usize) {
                return Err(invalid("max-length"));
            }
            let shown = if *password { "*".repeat(text.chars().count()) } else { text.clone() };
            Change::Text { value: text, shown, combo: false }
        }
        FieldKind::Combo { editable } => {
            let text = text_of(value)?;
            if text.chars().count() > MAX_VALUE_CHARS {
                return Err(invalid("value"));
            }
            let shown = match field.options.iter().find(|(export, _)| *export == text) {
                Some((_, display)) => display.clone(),
                None if text.is_empty() || *editable => {
                    check_text(&text, false)?;
                    text.clone()
                }
                None => return Err(invalid("value")),
            };
            Change::Text { value: text, shown, combo: true }
        }
        FieldKind::List { multi } => {
            let names = names_of(value)?;
            if names.len() > MAX_OPTIONS {
                return Err(invalid("value"));
            }
            let positions: HashMap<&str, usize> =
                field.options.iter().enumerate().rev().map(|(i, (export, _))| (export.as_str(), i)).collect();
            let mut taken = HashSet::new();
            let mut selected = Vec::new();
            for name in &names {
                let index = *positions.get(name.as_str()).ok_or_else(|| invalid("value"))?;
                if taken.insert(index) {
                    selected.push(index);
                }
            }
            if !multi && selected.len() > 1 {
                return Err(invalid("value"));
            }
            selected.sort_unstable();
            Change::List { selected, multi: *multi }
        }
        FieldKind::Checkbox | FieldKind::Radio => {
            let names = names_of(value)?;
            match names.as_slice() {
                [] => Change::Button { state: None, check_default: false },
                [name] => {
                    let found = field
                        .widgets
                        .iter()
                        .zip(&field_ref.widgets)
                        .find(|(w, _)| w.on_state.as_deref() == Some(name.as_str()))
                        .map(|(_, r)| r);
                    match found {
                        Some(r) if r.on_state.is_some() => Change::Button { state: r.on_state.clone(), check_default: false },
                        Some(r) if r.generated_state.is_some() => {
                            Change::Button { state: Some(name.as_bytes().to_vec()), check_default: false }
                        }
                        None if field.kind == FieldKind::Checkbox
                            && field.on_states.is_empty()
                            && name == DEFAULT_ON
                            && !field.widgets.is_empty() =>
                        {
                            Change::Button { state: Some(DEFAULT_ON.as_bytes().to_vec()), check_default: true }
                        }
                        _ => return Err(invalid("value")),
                    }
                }
                _ => return Err(invalid("value")),
            }
        }
    };
    Ok(Some(change))
}

/// A PDF text string: PDFDocEncoding when every character has a code there,
/// else UTF-16BE with a byte order mark.
pub(crate) fn text_string(text: &str) -> Object {
    let pdfdoc = |c: char| -> Option<u8> {
        match u32::from(c) {
            0x09 | 0x0A | 0x0D | 0x20..=0x7E => Some(c as u8),
            _ => (0x18..=0xFFu8).find(|&b| b != 0x7F && b != 0x9F && pdfdoc_char(b) == c),
        }
    };
    let bytes: Option<Vec<u8>> = text.chars().map(pdfdoc).collect();
    let bytes = bytes.unwrap_or_else(|| {
        let mut out = vec![0xFE, 0xFF];
        for unit in text.encode_utf16() {
            out.extend_from_slice(&unit.to_be_bytes());
        }
        out
    });
    Object::String(bytes, StringFormat::Literal)
}

fn apply(doc: &mut Document, field: &Field, field_ref: &FieldRef, change: Change, fonts: &mut HashMap<StdFont, ObjectId>) {
    let all: Vec<usize> = (0..field_ref.widgets.len()).collect();
    match change {
        Change::Text { value, shown, combo } => {
            if let Ok(dict) = doc.get_dictionary_mut(field_ref.obj) {
                dict.set("V", text_string(&value));
                dict.remove(b"RV");
                if combo {
                    dict.remove(b"I");
                }
            }
            draw_field(doc, field, field_ref, &Shown::Text(shown), &all, fonts);
        }
        Change::List { selected, multi } => {
            if let Ok(dict) = doc.get_dictionary_mut(field_ref.obj) {
                let exports: Vec<Object> = selected.iter().map(|&i| text_string(&field.options[i].0)).collect();
                match exports.len() {
                    0 => {
                        dict.remove(b"V");
                        dict.remove(b"I");
                    }
                    n => {
                        if multi && n > 1 {
                            dict.set("V", exports);
                        } else {
                            dict.set("V", exports.into_iter().next().unwrap_or(Object::Null));
                        }
                        let indices: Vec<Object> = selected.iter().map(|&i| Object::Integer(i as i64)).collect();
                        dict.set("I", indices);
                    }
                }
            }
            draw_field(doc, field, field_ref, &Shown::List(selected), &all, fonts);
        }
        Change::Button { state, check_default } => {
            let off = b"Off".to_vec();
            if let Ok(dict) = doc.get_dictionary_mut(field_ref.obj) {
                dict.set("V", Object::Name(state.clone().unwrap_or_else(|| off.clone())));
            }
            let flags = integer(inherited(doc, field_ref.obj, b"Ff")).unwrap_or(0);
            let unison = field.kind == FieldKind::Checkbox || flags & FF_RADIOS_IN_UNISON != 0;
            let mut turned_on = false;
            for wref in &field_ref.widgets {
                let matches = if let Some(generated) = &wref.generated_state {
                    // Every bare radio widget gets its own states, on or off.
                    add_button_states(doc, wref.obj, &wref.da, generated.as_bytes(), true);
                    state.as_deref() == Some(generated.as_bytes())
                } else if check_default && wref.on_state.is_none() {
                    add_button_states(doc, wref.obj, &wref.da, DEFAULT_ON.as_bytes(), false);
                    true
                } else {
                    state.is_some() && wref.on_state == state
                };
                let on = matches && (unison || !turned_on);
                turned_on |= on;
                if let Ok(dict) = doc.get_dictionary_mut(wref.obj) {
                    let as_name = if on { state.clone().unwrap_or_else(|| off.clone()) } else { off.clone() };
                    dict.set("AS", Object::Name(as_name));
                }
            }
        }
    }
}

/// New appearances for the widgets `only` (indices) of a text or choice
/// field showing `shown`.
fn draw_field(
    doc: &mut Document,
    field: &Field,
    field_ref: &FieldRef,
    shown: &Shown,
    only: &[usize],
    fonts: &mut HashMap<StdFont, ObjectId>,
) {
    let layout = match field.kind {
        FieldKind::Text { multiline: true, .. } => Layout::Multiline,
        FieldKind::Text { comb: true, max_len: Some(n), .. } => Layout::Comb(n),
        _ => Layout::Single,
    };
    let displays: Vec<String> = match shown {
        Shown::List(_) => field.options.iter().map(|(_, d)| d.clone()).collect(),
        Shown::Text(_) => Vec::new(),
    };
    for &i in only {
        let (Some(widget), Some(wref)) = (field.widgets.get(i), field_ref.widgets.get(i)) else {
            continue;
        };
        set_appearance(doc, wref.obj, Some(wref.da.font), fonts, |frame| match shown {
            Shown::Text(text) => text_appearance(frame, &wref.da, widget.align, layout, text),
            Shown::List(selected) => list_appearance(frame, &wref.da, &displays, selected),
        });
    }
}

/// The widget box in its own form space: /Rect size, swapped for a quarter
/// turn of /MK /R, with /MK /BG and /BC. Also the /Matrix that turns it.
fn widget_frame(doc: &Document, widget: &Dictionary) -> Option<(Frame, Option<[f64; 6]>)> {
    let [x0, y0, x1, y1] = parse_numbers::<4>(doc, widget.get(b"Rect").ok()?)?;
    let (w, h) = ((x1 - x0).abs(), (y1 - y0).abs());
    // Larger boxes are nonsense (and would not fit the f32 a PDF real is
    // written from).
    if !(w > 0.0 && h > 0.0 && w <= MAX_COORD && h <= MAX_COORD) {
        return None;
    }
    let mk = widget.get(b"MK").ok().and_then(|m| deref(doc, m)).and_then(|m| m.as_dict().ok());
    let colour = |key: &[u8]| -> Option<Vec<f64>> {
        let items = deref(doc, mk?.get(key).ok()?)?.as_array().ok()?;
        let values: Option<Vec<f64>> = items
            .iter()
            .map(|i| deref(doc, i)?.as_float().ok().map(f64::from).filter(|v| v.is_finite()).map(|v| v.clamp(0.0, 1.0)))
            .collect();
        values.filter(|v| matches!(v.len(), 1 | 3 | 4))
    };
    let rotation = add_rotation(mk.and_then(|m| m.get(b"R").ok()).and_then(|r| deref(doc, r)), 0);
    let (fw, fh, matrix) = match rotation {
        90 => (h, w, Some([0.0, 1.0, -1.0, 0.0, w, 0.0])),
        180 => (w, h, Some([-1.0, 0.0, 0.0, -1.0, w, h])),
        270 => (h, w, Some([0.0, -1.0, 1.0, 0.0, 0.0, h])),
        _ => (w, h, None),
    };
    Some((Frame { width: fw, height: fh, background: colour(b"BG"), border: colour(b"BC") }, matrix))
}

fn real(v: f64) -> Object {
    Object::Real(v as f32)
}

/// A new form XObject for `content` sized to `frame`, with `font` (if any)
/// in its own resources.
fn form_xobject(
    doc: &mut Document,
    frame: &Frame,
    matrix: Option<[f64; 6]>,
    font: Option<StdFont>,
    fonts: &mut HashMap<StdFont, ObjectId>,
    content: Vec<u8>,
) -> ObjectId {
    let mut dict = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Form",
        "BBox" => vec![0.into(), 0.into(), real(frame.width), real(frame.height)],
    };
    if let Some(m) = matrix {
        dict.set("Matrix", m.iter().map(|&v| real(v)).collect::<Vec<_>>());
    }
    let mut resources = Dictionary::new();
    if let Some(font) = font {
        let id = *fonts.entry(font).or_insert_with(|| doc.add_object(font_object(font)));
        resources.set("Font", dictionary! { font_resource(font) => id });
    }
    dict.set("Resources", resources);
    doc.add_object(Stream::new(dict, content))
}

/// Give `widget` a new /AP holding only a new normal appearance (an old /AP
/// dictionary or stream, possibly shared, is left as it is). A widget without
/// a usable /Rect loses its (stale) /AP.
fn set_appearance(
    doc: &mut Document,
    widget: ObjectId,
    font: Option<StdFont>,
    fonts: &mut HashMap<StdFont, ObjectId>,
    content: impl FnOnce(&Frame) -> Vec<u8>,
) {
    let Some((frame, matrix)) = doc.get_dictionary(widget).ok().and_then(|w| widget_frame(doc, w)) else {
        if let Ok(dict) = doc.get_dictionary_mut(widget) {
            dict.remove(b"AP");
        }
        return;
    };
    let body = content(&frame);
    let stream = form_xobject(doc, &frame, matrix, font, fonts, body);
    if let Ok(dict) = doc.get_dictionary_mut(widget) {
        dict.set("AP", dictionary! { "N" => stream });
    }
}

/// New /AP for a button widget without an "on" appearance: the frame
/// (/MK /BG and /BC) in both states, plus a check mark (checkbox) or a
/// filled dot (radio) for `on_name`.
fn add_button_states(doc: &mut Document, widget: ObjectId, da: &DefaultAppearance, on_name: &[u8], radio: bool) {
    let Some((frame, matrix)) = doc.get_dictionary(widget).ok().and_then(|w| widget_frame(doc, w)) else {
        return;
    };
    let mut no_fonts = HashMap::new();
    let on_content = if radio {
        let mut c = frame_content(&frame);
        c.extend(radio_appearance(&frame, da));
        c
    } else {
        check_appearance(&frame, da)
    };
    let off_content = frame_content(&frame);
    let on = form_xobject(doc, &frame, matrix, None, &mut no_fonts, on_content);
    let off = form_xobject(doc, &frame, matrix, None, &mut no_fonts, off_content);
    let mut states = Dictionary::new();
    states.set(on_name.to_vec(), on);
    states.set("Off", off);
    if let Ok(dict) = doc.get_dictionary_mut(widget) {
        dict.set("AP", dictionary! { "N" => states });
    }
}

/// /NeedAppearances false (every changed widget has our appearance, the
/// others keep theirs) and no /XFA on the AcroForm.
fn mark_form(doc: &mut Document) {
    let Some(root) = doc.trailer.get(b"Root").ok().and_then(|r| r.as_reference().ok()) else {
        return;
    };
    let form_ref = doc
        .get_dictionary(root)
        .ok()
        .and_then(|c| c.get(b"AcroForm").ok())
        .and_then(|f| f.as_reference().ok());
    let form = match form_ref {
        Some(id) => doc.get_dictionary_mut(id).ok(),
        None => doc
            .get_dictionary_mut(root)
            .ok()
            .and_then(|c| c.get_mut(b"AcroForm").ok())
            .and_then(|f| f.as_dict_mut().ok()),
    };
    if let Some(form) = form {
        form.set("NeedAppearances", false);
        form.remove(b"XFA");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forms::list_form;
    use crate::forms::tree::tests::{base, finish, rect, states, widget, with};
    use crate::forms::tree::{FF_COMBO, FF_EDIT, FF_MULTISELECT, FF_RADIO, FF_READ_ONLY};
    use lopdf::content::Content;

    fn text_field(doc: &mut Document, page: ObjectId, name: &str, extra: Vec<(&str, Object)>) -> ObjectId {
        let mut entries = vec![
            ("FT", "Tx".into()),
            ("T", Object::string_literal(name)),
            ("DA", Object::string_literal("/Helv 12 Tf 0 g")),
        ];
        entries.extend(extra);
        doc.add_object(with(widget(page, [100, 700, 300, 720]), entries))
    }

    fn dict(doc: &Document, id: ObjectId) -> &Dictionary {
        doc.get_dictionary(id).unwrap()
    }

    fn normal_ap(doc: &Document, widget: ObjectId) -> (ObjectId, &Stream) {
        let ap = deref(doc, dict(doc, widget).get(b"AP").unwrap()).unwrap().as_dict().unwrap();
        let id = ap.get(b"N").unwrap().as_reference().unwrap();
        (id, doc.get_object(id).unwrap().as_stream().unwrap())
    }

    fn acroform(doc: &Document) -> &Dictionary {
        let root = doc.trailer.get(b"Root").unwrap().as_reference().unwrap();
        let form = dict(doc, root).get(b"AcroForm").unwrap().as_reference().unwrap();
        dict(doc, form)
    }

    #[test]
    fn text_value_appearance_and_need_appearances() {
        let (mut doc, page) = base(0);
        let f = text_field(&mut doc, page, "name", vec![]);
        finish(&mut doc, page, &[f], &[f], vec![]);
        fill_document(&mut doc, &[(0, Value::Text("Hi".into()))]).unwrap();
        assert_eq!(dict(&doc, f).get(b"V").unwrap(), &Object::string_literal("Hi"));
        let (_, ap) = normal_ap(&doc, f);
        assert_eq!(
            String::from_utf8(ap.content.clone()).unwrap(),
            "/Tx BMC\nq\n1 1 198 18 re W n\nBT\n/Helv 12 Tf\n0 g\n2 6.934 Td\n(Hi) Tj\nET\nQ\nEMC\n"
        );
        assert_eq!(ap.dict.get(b"BBox").unwrap(), &Object::Array(vec![0.into(), 0.into(), real(200.0), real(20.0)]));
        let font = ap.dict.get(b"Resources").unwrap().as_dict().unwrap().get(b"Font").unwrap().as_dict().unwrap();
        let font = dict(&doc, font.get(b"Helv").unwrap().as_reference().unwrap());
        assert_eq!(font.get(b"BaseFont").unwrap(), &Object::Name(b"Helvetica".to_vec()));
        assert_eq!(font.get(b"Encoding").unwrap(), &Object::Name(b"WinAnsiEncoding".to_vec()));
        assert!(Content::decode(&ap.content).is_ok());
        assert_eq!(acroform(&doc).get(b"NeedAppearances").unwrap(), &Object::Boolean(false));
    }

    #[test]
    fn comb_and_multiline_layouts_selected_from_the_kind() {
        let (mut doc, page) = base(0);
        let comb = text_field(&mut doc, page, "pin", vec![("Ff", (1i64 << 24).into()), ("MaxLen", 5.into())]);
        let multi = text_field(&mut doc, page, "notes", vec![("Ff", (1i64 << 12).into())]);
        let password = text_field(&mut doc, page, "pw", vec![("Ff", (1i64 << 13).into())]);
        finish(&mut doc, page, &[comb, multi, password], &[comb, multi, password], vec![]);
        fill_document(&mut doc, &[
            (0, Value::Text("ABC".into())),
            (1, Value::Text("one\ntwo".into())),
            (2, Value::Text("secret".into())),
        ])
        .unwrap();
        let content = |w| String::from_utf8(normal_ap(&doc, w).1.content.clone()).unwrap();
        assert_eq!(content(comb).matches(" Tm\n(").count(), 3);
        assert!(content(multi).contains("(one) Tj") && content(multi).contains("(two) Tj"));
        assert!(content(password).contains("(******) Tj"));
        assert_eq!(dict(&doc, password).get(b"V").unwrap(), &Object::string_literal("secret"));
    }

    #[test]
    fn checkbox_on_and_off_with_on_name() {
        let (mut doc, page) = base(0);
        let ap = states(&mut doc, &["On", "Off"]);
        let f = doc.add_object(with(widget(page, [0, 0, 10, 10]), vec![
            ("FT", "Btn".into()), ("T", Object::string_literal("agree")), ("AP", ap), ("AS", "Off".into()),
        ]));
        finish(&mut doc, page, &[f], &[f], vec![]);
        let ap_before = dict(&doc, f).get(b"AP").unwrap().clone();
        fill_document(&mut doc, &[(0, Value::Names(vec!["On".into()]))]).unwrap();
        assert_eq!(dict(&doc, f).get(b"V").unwrap(), &Object::Name(b"On".to_vec()));
        assert_eq!(dict(&doc, f).get(b"AS").unwrap(), &Object::Name(b"On".to_vec()));
        assert_eq!(dict(&doc, f).get(b"AP").unwrap(), &ap_before);
        fill_document(&mut doc, &[(0, Value::None)]).unwrap();
        assert_eq!(dict(&doc, f).get(b"V").unwrap(), &Object::Name(b"Off".to_vec()));
        assert_eq!(dict(&doc, f).get(b"AS").unwrap(), &Object::Name(b"Off".to_vec()));
        assert_eq!(fill_document(&mut doc, &[(0, Value::Names(vec!["Yes".into()]))]).unwrap_err(), "Invalid form settings: value");
    }

    #[test]
    fn checkbox_without_on_appearance_gets_a_check_mark() {
        let (mut doc, page) = base(0);
        let f = doc.add_object(with(widget(page, [0, 0, 20, 20]), vec![
            ("FT", "Btn".into()), ("T", Object::string_literal("c")),
        ]));
        finish(&mut doc, page, &[f], &[f], vec![]);
        fill_document(&mut doc, &[(0, Value::Names(vec!["Yes".into()]))]).unwrap();
        assert_eq!(dict(&doc, f).get(b"AS").unwrap(), &Object::Name(b"Yes".to_vec()));
        let n = dict(&doc, f).get(b"AP").unwrap().as_dict().unwrap().get(b"N").unwrap().as_dict().unwrap();
        let on = doc.get_object(n.get(b"Yes").unwrap().as_reference().unwrap()).unwrap().as_stream().unwrap();
        assert!(String::from_utf8_lossy(&on.content).contains(" l\nS\n"));
        assert!(n.has(b"Off"));
        assert_eq!(list_form(&crate::pdf_util::save_pdf(&mut doc).unwrap()).unwrap().fields[0].on_states, vec!["Yes"]);
    }

    fn radio(unison: bool) -> (Document, Vec<ObjectId>) {
        let (mut doc, page) = base(0);
        let field = doc.new_object_id();
        let mut kids = Vec::new();
        for (i, state) in ["a", "b", "a"].into_iter().enumerate() {
            let ap = states(&mut doc, &["Off", state]);
            let x = 20 * i as i64;
            kids.push(doc.add_object(with(widget(page, [x, 0, x + 10, 10]), vec![
                ("Parent", field.into()), ("AP", ap), ("AS", "Off".into()),
            ])));
        }
        let flags = FF_RADIO | if unison { FF_RADIOS_IN_UNISON } else { 0 };
        doc.objects.insert(field, Object::Dictionary(dictionary! {
            "FT" => "Btn", "Ff" => flags, "T" => Object::string_literal("r"),
            "Kids" => kids.iter().map(|&k| Object::from(k)).collect::<Vec<_>>(),
        }));
        finish(&mut doc, page, &[field], &kids, vec![]);
        kids.insert(0, field);
        (doc, kids)
    }

    fn as_states(doc: &Document, ids: &[ObjectId]) -> Vec<String> {
        ids.iter().map(|&k| String::from_utf8_lossy(dict(doc, k).get(b"AS").unwrap().as_name().unwrap()).into_owned()).collect()
    }

    #[test]
    fn radio_group_and_unison() {
        let (mut doc, ids) = radio(false);
        fill_document(&mut doc, &[(0, Value::Names(vec!["a".into()]))]).unwrap();
        assert_eq!(dict(&doc, ids[0]).get(b"V").unwrap(), &Object::Name(b"a".to_vec()));
        assert_eq!(as_states(&doc, &ids[1..]), vec!["a", "Off", "Off"]);
        fill_document(&mut doc, &[(0, Value::Names(vec!["b".into()]))]).unwrap();
        assert_eq!(as_states(&doc, &ids[1..]), vec!["Off", "b", "Off"]);

        let (mut doc, ids) = radio(true);
        fill_document(&mut doc, &[(0, Value::Names(vec!["a".into()]))]).unwrap();
        assert_eq!(as_states(&doc, &ids[1..]), vec!["a", "Off", "a"]);
        assert_eq!(fill_document(&mut doc, &[(0, Value::Names(vec!["z".into()]))]).unwrap_err(), "Invalid form settings: value");
    }

    #[test]
    fn raw_non_utf8_state_written_back_unchanged() {
        let (mut doc, page) = base(0);
        let raw = vec![b'J', 0xE9];
        let mut n = Dictionary::new();
        n.set(raw.clone(), doc.add_object(Stream::new(dictionary! {}, vec![])));
        n.set("Off", doc.add_object(Stream::new(dictionary! {}, vec![])));
        let f = doc.add_object(with(widget(page, [0, 0, 10, 10]), vec![
            ("FT", "Btn".into()), ("T", Object::string_literal("x")), ("AP", dictionary! { "N" => n }.into()),
        ]));
        finish(&mut doc, page, &[f], &[f], vec![]);
        fill_document(&mut doc, &[(0, Value::Names(vec!["J\u{FFFD}".into()]))]).unwrap();
        assert_eq!(dict(&doc, f).get(b"V").unwrap(), &Object::Name(raw.clone()));
        assert_eq!(dict(&doc, f).get(b"AS").unwrap(), &Object::Name(raw));
    }

    fn choice(doc: &mut Document, page: ObjectId, name: &str, flags: i64) -> ObjectId {
        let opt = Object::Array(vec![
            Object::Array(vec![Object::string_literal("a"), Object::string_literal("Apple")]),
            Object::string_literal("b"),
            Object::string_literal("c"),
        ]);
        doc.add_object(with(widget(page, [0, 0, 100, 60]), vec![
            ("FT", "Ch".into()), ("T", Object::string_literal(name)), ("Ff", flags.into()), ("Opt", opt),
            ("DA", Object::string_literal("/Helv 0 Tf 0 g")),
        ]))
    }

    #[test]
    fn list_multi_select_sets_v_array_and_sorted_i() {
        let (mut doc, page) = base(0);
        let list = choice(&mut doc, page, "l", FF_MULTISELECT);
        let single = choice(&mut doc, page, "s", 0);
        finish(&mut doc, page, &[list, single], &[list, single], vec![]);
        fill_document(&mut doc, &[
            (0, Value::Names(vec!["c".into(), "a".into()])),
            (1, Value::Names(vec!["b".into()])),
        ])
        .unwrap();
        let d = dict(&doc, list);
        assert_eq!(d.get(b"V").unwrap(), &Object::Array(vec![Object::string_literal("a"), Object::string_literal("c")]));
        assert_eq!(d.get(b"I").unwrap(), &Object::Array(vec![0.into(), 2.into()]));
        let content = String::from_utf8(normal_ap(&doc, list).1.content.clone()).unwrap();
        assert_eq!(content.matches("0.6 0.75 0.95 rg").count(), 2);
        assert!(content.contains("(Apple) Tj"));
        let d = dict(&doc, single);
        assert_eq!(d.get(b"V").unwrap(), &Object::string_literal("b"));
        assert_eq!(d.get(b"I").unwrap(), &Object::Array(vec![1.into()]));
        let err = fill_document(&mut doc, &[(1, Value::Names(vec!["a".into(), "b".into()]))]).unwrap_err();
        assert_eq!(err, "Invalid form settings: value");
        assert_eq!(fill_document(&mut doc, &[(0, Value::Names(vec!["zz".into()]))]).unwrap_err(), "Invalid form settings: value");
        fill_document(&mut doc, &[(0, Value::None)]).unwrap();
        assert!(!dict(&doc, list).has(b"V") && !dict(&doc, list).has(b"I"));
    }

    #[test]
    fn combo_editable_custom_value_and_display_text() {
        let (mut doc, page) = base(0);
        let editable = choice(&mut doc, page, "e", FF_COMBO | FF_EDIT);
        let fixed = choice(&mut doc, page, "f", FF_COMBO);
        finish(&mut doc, page, &[editable, fixed], &[editable, fixed], vec![]);
        fill_document(&mut doc, &[(0, Value::Text("zzz".into())), (1, Value::Text("a".into()))]).unwrap();
        assert_eq!(dict(&doc, editable).get(b"V").unwrap(), &Object::string_literal("zzz"));
        assert!(String::from_utf8_lossy(&normal_ap(&doc, editable).1.content).contains("(zzz) Tj"));
        assert_eq!(dict(&doc, fixed).get(b"V").unwrap(), &Object::string_literal("a"));
        assert!(String::from_utf8_lossy(&normal_ap(&doc, fixed).1.content).contains("(Apple) Tj"));
        assert_eq!(fill_document(&mut doc, &[(1, Value::Text("zzz".into()))]).unwrap_err(), "Invalid form settings: value");
    }

    #[test]
    fn shared_appearance_is_not_mutated_and_no_longer_shared() {
        let (mut doc, page) = base(0);
        let shared_stream = doc.add_object(Stream::new(dictionary! { "BBox" => rect([0, 0, 200, 20]) }, b"old".to_vec()));
        let shared_ap = doc.add_object(dictionary! { "N" => shared_stream });
        let a = text_field(&mut doc, page, "a", vec![("AP", shared_ap.into())]);
        let b = text_field(&mut doc, page, "b", vec![("AP", shared_ap.into())]);
        finish(&mut doc, page, &[a, b], &[a, b], vec![]);
        let before_ap = doc.get_object(shared_ap).unwrap().clone();
        let before_stream = doc.get_object(shared_stream).unwrap().clone();
        fill_document(&mut doc, &[(0, Value::Text("new".into()))]).unwrap();
        let (new_id, _) = normal_ap(&doc, a);
        assert_ne!(new_id, shared_stream);
        assert_eq!(dict(&doc, b).get(b"AP").unwrap(), &Object::Reference(shared_ap));
        assert_eq!(doc.get_object(shared_ap).unwrap(), &before_ap);
        assert_eq!(doc.get_object(shared_stream).unwrap(), &before_stream);
    }

    #[test]
    fn untouched_fields_are_identical_and_xfa_removed() {
        let (mut doc, page) = base(0);
        let a = text_field(&mut doc, page, "a", vec![]);
        let ap = doc.add_object(Stream::new(dictionary! { "BBox" => rect([0, 0, 200, 20]) }, b"(keep) Tj".to_vec()));
        let b = text_field(&mut doc, page, "b", vec![("V", Object::string_literal("keep")), ("AP", dictionary! { "N" => ap }.into())]);
        let xfa = doc.add_object(Stream::new(dictionary! {}, b"<xdp/>".to_vec()));
        finish(&mut doc, page, &[a, b], &[a, b], vec![("XFA", xfa.into())]);
        let before = dict(&doc, b).clone();
        fill_document(&mut doc, &[(0, Value::Text("x".into()))]).unwrap();
        assert_eq!(dict(&doc, b), &before);
        assert!(!acroform(&doc).has(b"XFA"));
        assert_eq!(acroform(&doc).get(b"NeedAppearances").unwrap(), &Object::Boolean(false));
    }

    #[test]
    fn radio_widget_without_on_appearance_gets_a_dot() {
        let (mut doc, page) = base(0);
        let field = doc.new_object_id();
        let ap = states(&mut doc, &["Off", "On"]);
        let with_ap = doc.add_object(with(widget(page, [0, 0, 10, 10]), vec![("Parent", field.into()), ("AP", ap)]));
        let bare = doc.add_object(with(widget(page, [20, 0, 40, 10]), vec![("Parent", field.into())]));
        let framed = doc.add_object(with(widget(page, [50, 0, 70, 10]), vec![
            ("Parent", field.into()), ("MK", dictionary! { "BC" => vec![Object::Integer(0)] }.into()),
        ]));
        doc.objects.insert(field, Object::Dictionary(dictionary! {
            "FT" => "Btn", "Ff" => FF_RADIO, "T" => Object::string_literal("r"),
            "DA" => Object::string_literal("/Helv 0 Tf 0 0 1 rg"),
            "Kids" => vec![with_ap.into(), bare.into(), framed.into()],
        }));
        finish(&mut doc, page, &[field], &[with_ap, bare, framed], vec![]);
        // Each bare widget has its own generated state.
        let listed = list_form(&crate::pdf_util::save_pdf(&mut doc.clone()).unwrap()).unwrap();
        assert_eq!(listed.fields[0].on_states, vec!["On", "On2", "On3"]);
        fill_document(&mut doc, &[(0, Value::Names(vec!["On2".into()]))]).unwrap();
        assert_eq!(dict(&doc, field).get(b"V").unwrap(), &Object::Name(b"On2".to_vec()));
        assert_eq!(as_states(&doc, &[with_ap, bare, framed]), vec!["Off", "On2", "Off"]);
        let n = dict(&doc, bare).get(b"AP").unwrap().as_dict().unwrap().get(b"N").unwrap().as_dict().unwrap();
        let stream = |key: &[u8]| doc.get_object(n.get(key).unwrap().as_reference().unwrap()).unwrap().as_stream().unwrap();
        let on = String::from_utf8(stream(b"On2").content.clone()).unwrap();
        assert!(on.starts_with("q\n0 0 1 rg\n12.5 5 m\n") && on.ends_with("f\nQ\n"), "{on}");
        assert!(stream(b"Off").content.is_empty());
        // The framed one (not chosen) draws its border in both states.
        let n = dict(&doc, framed).get(b"AP").unwrap().as_dict().unwrap().get(b"N").unwrap().as_dict().unwrap();
        let content = |key: &[u8]| {
            let id = n.get(key).unwrap().as_reference().unwrap();
            String::from_utf8(doc.get_object(id).unwrap().as_stream().unwrap().content.clone()).unwrap()
        };
        assert_eq!(content(b"Off"), "0 G\n1 w\n0.5 0.5 19 9 re S\n");
        assert!(content(b"On3").starts_with("0 G\n1 w\n0.5 0.5 19 9 re S\nq\n0 0 1 rg\n"));
        fill_document(&mut doc, &[(0, Value::Names(vec!["On3".into()]))]).unwrap();
        assert_eq!(as_states(&doc, &[with_ap, bare, framed]), vec!["Off", "Off", "On3"]);
        // The widget that has its own appearance keeps it.
        assert!(dict(&doc, with_ap).get(b"AP").unwrap().as_dict().unwrap().get(b"N").unwrap().as_dict().unwrap().has(b"On"));
        assert_eq!(fill_document(&mut doc, &[(0, Value::Names(vec!["On4".into()]))]).unwrap_err(), "Invalid form settings: value");
    }

    #[test]
    fn stale_appearances_rebuilt_when_the_source_needs_appearances() {
        let (mut doc, page) = base(0);
        let stale = doc.add_object(Stream::new(dictionary! { "BBox" => rect([0, 0, 200, 20]) }, b"(old) Tj".to_vec()));
        let shared_ap = doc.add_object(dictionary! { "N" => stale });
        let kept = text_field(&mut doc, page, "kept", vec![("V", Object::string_literal("keep")), ("AP", shared_ap.into())]);
        let empty = text_field(&mut doc, page, "empty", vec![("AP", shared_ap.into())]);
        let hidden = text_field(&mut doc, page, "hidden", vec![("V", Object::string_literal("h")), ("F", 2.into()), ("AP", shared_ap.into())]);
        let cb_ap = states(&mut doc, &["On", "Off"]);
        let cb = doc.add_object(with(widget(page, [0, 0, 10, 10]), vec![
            ("FT", "Btn".into()), ("T", Object::string_literal("cb")), ("V", "On".into()), ("AS", "On".into()), ("AP", cb_ap),
        ]));
        let changed = text_field(&mut doc, page, "changed", vec![]);
        finish(&mut doc, page, &[kept, empty, hidden, cb, changed], &[kept, empty, hidden, cb, changed], vec![
            ("NeedAppearances", true.into()),
        ]);
        let cb_before = dict(&doc, cb).clone();
        let stale_before = doc.get_object(stale).unwrap().clone();
        fill_document(&mut doc, &[(4, Value::Text("new".into()))]).unwrap();
        let (id, ap) = normal_ap(&doc, kept);
        assert_ne!(id, stale);
        assert!(String::from_utf8_lossy(&ap.content).contains("(keep) Tj"));
        // No value, hidden widget and buttons: left as they were.
        assert_eq!(dict(&doc, empty).get(b"AP").unwrap(), &Object::Reference(shared_ap));
        assert_eq!(dict(&doc, hidden).get(b"AP").unwrap(), &Object::Reference(shared_ap));
        assert_eq!(dict(&doc, cb), &cb_before);
        assert_eq!(doc.get_object(stale).unwrap(), &stale_before);
        assert_eq!(acroform(&doc).get(b"NeedAppearances").unwrap(), &Object::Boolean(false));
    }

    #[test]
    fn unchanged_value_without_appearance_gets_one() {
        let (mut doc, page) = base(0);
        let bare = text_field(&mut doc, page, "bare", vec![("V", Object::string_literal("shown"))]);
        let list = choice(&mut doc, page, "l", FF_MULTISELECT);
        doc.get_dictionary_mut(list).unwrap().set("V", vec![Object::string_literal("c"), Object::string_literal("b")]);
        let with_ap = doc.add_object(Stream::new(dictionary! { "BBox" => rect([0, 0, 200, 20]) }, b"(ok) Tj".to_vec()));
        let fine = text_field(&mut doc, page, "fine", vec![("V", Object::string_literal("x")), ("AP", dictionary! { "N" => with_ap }.into())]);
        finish(&mut doc, page, &[bare, list, fine], &[bare, list, fine], vec![]);
        fill_document(&mut doc, &[]).unwrap();
        assert!(String::from_utf8_lossy(&normal_ap(&doc, bare).1.content).contains("(shown) Tj"));
        let list_ap = String::from_utf8(normal_ap(&doc, list).1.content.clone()).unwrap();
        assert_eq!(list_ap.matches("0.6 0.75 0.95 rg").count(), 2);
        assert_eq!(normal_ap(&doc, fine).0, with_ap);
    }

    #[test]
    fn changed_widget_without_usable_rect_loses_its_appearance() {
        let (mut doc, page) = base(0);
        let old = doc.add_object(Stream::new(dictionary! {}, b"(old) Tj".to_vec()));
        let flat = text_field(&mut doc, page, "flat", vec![("Rect", rect([10, 10, 10, 30])), ("AP", dictionary! { "N" => old }.into())]);
        let huge = text_field(&mut doc, page, "huge", vec![
            ("Rect", Object::Array(vec![real(0.0), real(0.0), real(3.0e38), real(20.0)])), ("AP", dictionary! { "N" => old }.into()),
        ]);
        finish(&mut doc, page, &[flat, huge], &[flat, huge], vec![]);
        fill_document(&mut doc, &[(0, Value::Text("a".into())), (1, Value::Text("b".into()))]).unwrap();
        assert!(!dict(&doc, flat).has(b"AP") && !dict(&doc, huge).has(b"AP"));
        assert_eq!(dict(&doc, huge).get(b"V").unwrap(), &Object::string_literal("b"));
        assert!(doc.get_object(old).is_ok());
    }

    #[test]
    fn list_values_capped_and_deduplicated() {
        let (mut doc, page) = base(0);
        let list = choice(&mut doc, page, "l", FF_MULTISELECT);
        finish(&mut doc, page, &[list], &[list], vec![]);
        let too_many = Value::Names(vec!["a".to_string(); MAX_OPTIONS + 1]);
        assert_eq!(fill_document(&mut doc, &[(0, too_many)]).unwrap_err(), "Invalid form settings: value");
        fill_document(&mut doc, &[(0, Value::Names(vec!["b".into(), "b".into(), "a".into()]))]).unwrap();
        assert_eq!(dict(&doc, list).get(b"I").unwrap(), &Object::Array(vec![0.into(), 1.into()]));
    }

    #[test]
    fn saved_pdf_reloads_with_the_values() {
        let (mut doc, page) = base(0);
        let a = text_field(&mut doc, page, "a", vec![]);
        let l = choice(&mut doc, page, "l", FF_MULTISELECT);
        finish(&mut doc, page, &[a, l], &[a, l], vec![]);
        let pdf = crate::pdf_util::save_pdf(&mut doc).unwrap();
        let out = fill_form(&pdf, &[(0, Value::Text("Grüße €".into())), (1, Value::Names(vec!["b".into()]))], false).unwrap();
        let reloaded = load_pdf(&out).unwrap();
        let info = read_form(&reloaded).unwrap().info;
        assert_eq!(info.fields[0].value, Value::Text("Grüße €".into()));
        assert_eq!(info.fields[1].value, Value::Names(vec!["b".into()]));
        let (_, ap) = normal_ap(&reloaded, read_form(&reloaded).unwrap().refs[0].widgets[0].obj);
        assert!(ap.decompressed_content().unwrap_or_else(|_| ap.content.clone()).windows(2).any(|w| w == b"\xFC\xDF"));
    }

    #[test]
    fn text_string_uses_pdfdoc_then_utf16() {
        assert_eq!(text_string("a€"), Object::String(vec![b'a', 0xA0], StringFormat::Literal));
        assert_eq!(text_string("\u{2022}\n"), Object::String(vec![0x80, b'\n'], StringFormat::Literal));
        // U+00A0 is WinAnsi but not PDFDocEncoding (0xA0 is the euro sign there).
        assert_eq!(text_string("x\u{A0}"), Object::String(vec![0xFE, 0xFF, 0, b'x', 0, 0xA0], StringFormat::Literal));
    }

    #[test]
    fn invalid_values_are_refused_before_any_change() {
        let (mut doc, page) = base(0);
        let ro = text_field(&mut doc, page, "ro", vec![("Ff", FF_READ_ONLY.into()), ("V", Object::string_literal("same"))]);
        let max = text_field(&mut doc, page, "max", vec![("MaxLen", 3.into())]);
        let sig = doc.add_object(with(widget(page, [0, 0, 10, 10]), vec![("FT", "Sig".into()), ("T", Object::string_literal("s"))]));
        let push = doc.add_object(with(widget(page, [0, 0, 10, 10]), vec![
            ("FT", "Btn".into()), ("T", Object::string_literal("p")), ("Ff", (1i64 << 16).into()),
        ]));
        let plain = text_field(&mut doc, page, "plain", vec![]);
        finish(&mut doc, page, &[ro, max, sig, push, plain], &[ro, max, sig, push, plain], vec![]);
        let snapshot = doc.objects.clone();
        let err = |values: &[(u32, Value)], doc: &mut Document| fill_document(doc, values).unwrap_err();
        let t = |s: &str| Value::Text(s.into());
        assert_eq!(err(&[(4, t("ok")), (0, t("other"))], &mut doc), "Invalid form settings: read-only");
        assert_eq!(err(&[(1, t("abcd"))], &mut doc), "Invalid form settings: max-length");
        assert_eq!(err(&[(2, t("x"))], &mut doc), "Invalid form settings: value");
        assert_eq!(err(&[(3, Value::Names(vec!["x".into()]))], &mut doc), "Invalid form settings: value");
        assert_eq!(err(&[(9, t("x"))], &mut doc), "Invalid form settings: field");
        assert_eq!(err(&[(4, t("x")), (4, t("y"))], &mut doc), "Invalid form settings: field");
        assert_eq!(err(&[(4, t("日本"))], &mut doc), "Characters not supported by the standard PDF fonts: 日本");
        assert_eq!(err(&[(4, t("a\nb"))], &mut doc), "Invalid form settings: value");
        assert_eq!(err(&[(4, t(&"x".repeat(MAX_VALUE_CHARS + 1)))], &mut doc), "Invalid form settings: value");
        assert_eq!(err(&[(4, Value::Names(vec![]))], &mut doc), "Invalid form settings: value");
        assert_eq!(doc.objects, snapshot);
        // The read-only field's own value is accepted as a no-op (its missing
        // appearance is generated, as for any unchanged field with a value).
        fill_document(&mut doc, &[(0, t("same"))]).unwrap();
        assert_eq!(dict(&doc, ro).get(b"V").unwrap(), &Object::string_literal("same"));
        assert!(String::from_utf8_lossy(&normal_ap(&doc, ro).1.content).contains("(same) Tj"));
    }

    #[test]
    fn rotated_widget_and_orphan_widget() {
        let (mut doc, page) = base(0);
        let rotated = text_field(&mut doc, page, "r", vec![("MK", dictionary! { "R" => 90, "BG" => vec![real(2.0)] }.into())]);
        let mut orphan = widget(page, [0, 0, 50, 20]);
        orphan.remove(b"P");
        let orphan = doc.add_object(with(orphan, vec![("FT", "Tx".into()), ("T", Object::string_literal("o"))]));
        finish(&mut doc, page, &[rotated, orphan], &[rotated], vec![]);
        fill_document(&mut doc, &[(0, Value::Text("x".into())), (1, Value::Text("y".into()))]).unwrap();
        let (_, ap) = normal_ap(&doc, rotated);
        assert_eq!(ap.dict.get(b"BBox").unwrap(), &Object::Array(vec![0.into(), 0.into(), real(20.0), real(200.0)]));
        let m: Vec<f32> = ap.dict.get(b"Matrix").unwrap().as_array().unwrap().iter().map(|v| v.as_float().unwrap()).collect();
        assert_eq!(m, vec![0.0, 1.0, -1.0, 0.0, 200.0, 0.0]);
        assert!(String::from_utf8_lossy(&ap.content).starts_with("1 g\n0 0 20 200 re f\n"));
        assert_eq!(dict(&doc, orphan).get(b"V").unwrap(), &Object::string_literal("y"));
        assert!(String::from_utf8_lossy(&normal_ap(&doc, orphan).1.content).contains("(y) Tj"));
    }
}
