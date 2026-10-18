//! AcroForm field tree: deterministic depth-first traversal of
//! `/Root /AcroForm /Fields`, attribute inheritance through /Parent, widget
//! placement in visible page space.

use super::{
    Field, FieldKind, FormInfo, MAX_DEPTH, MAX_FIELDS, MAX_OPTIONS, MAX_WIDGETS, Value, Widget, Xfa,
    invalid,
};
use crate::annotations::parse_numbers;
use crate::doc_tools::decode_text;
use crate::pdf_util::load_pdf;
use crate::rebuild::{add_rotation, deref, name_of};
use crate::stamp::fonts::StdFont;
use crate::stamp::geometry::VisibleBox;
use lopdf::{Dictionary, Document, Object, ObjectId};
use std::collections::{HashMap, HashSet};

// Field flags (/Ff), ISO 32000 tables 221, 226, 228, 230.
pub(crate) const FF_READ_ONLY: i64 = 1;
pub(crate) const FF_REQUIRED: i64 = 1 << 1;
pub(crate) const FF_MULTILINE: i64 = 1 << 12;
pub(crate) const FF_PASSWORD: i64 = 1 << 13;
pub(crate) const FF_RADIO: i64 = 1 << 15;
pub(crate) const FF_PUSHBUTTON: i64 = 1 << 16;
pub(crate) const FF_COMBO: i64 = 1 << 17;
pub(crate) const FF_EDIT: i64 = 1 << 18;
pub(crate) const FF_MULTISELECT: i64 = 1 << 21;
pub(crate) const FF_COMB: i64 = 1 << 24;
pub(crate) const FF_RADIOS_IN_UNISON: i64 = 1 << 25;

/// Annotation flags that keep a widget off the page: Hidden and NoView.
const INVISIBLE_FLAGS: i64 = 2 | 32;

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum DaColor {
    Gray(f64),
    Rgb([f64; 3]),
    Cmyk([f64; 4]),
}

/// A parsed /DA string: font, size (0 = auto) and fill colour.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct DefaultAppearance {
    pub font: StdFont,
    pub size: f64,
    pub color: DaColor,
}

impl Default for DefaultAppearance {
    fn default() -> Self {
        DefaultAppearance { font: StdFont::Helvetica, size: 0.0, color: DaColor::Gray(0.0) }
    }
}

/// Document objects behind one listed widget.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct WidgetRef {
    pub obj: ObjectId,
    /// /DA with the size clamped (0 = auto, else 0 < size <= 1000).
    pub da: DefaultAppearance,
    /// Raw /AP /N key of the "on" state (checkbox and radio widgets).
    pub on_state: Option<Vec<u8>>,
}

/// Document objects behind one listed field; `widgets[i]` is
/// `Field::widgets[i]`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct FieldRef {
    pub obj: ObjectId,
    pub widgets: Vec<WidgetRef>,
    /// Raw name bytes of a /V name (checkbox and radio state).
    pub value_name: Option<Vec<u8>>,
    /// On state listed for the radio widgets that have no "on" appearance
    /// (`generated_radio_state`); a fill generates their appearance.
    pub generated_state: Option<String>,
}

/// `info.fields[i]` is backed by `refs[i]`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct FormTree {
    pub info: FormInfo,
    pub refs: Vec<FieldRef>,
}

/// List the fields of a PDF form.
pub fn list_form(pdf: &[u8]) -> Result<FormInfo, String> {
    let doc = load_pdf(pdf)?;
    Ok(read_form(&doc)?.info)
}

fn acroform(doc: &Document) -> Option<&Dictionary> {
    let root = deref(doc, doc.trailer.get(b"Root").ok()?)?.as_dict().ok()?;
    deref(doc, root.get(b"AcroForm").ok()?)?.as_dict().ok()
}

/// A terminal field found by the traversal.
struct Terminal {
    obj: ObjectId,
    name: String,
    partial: String,
    widgets: Vec<ObjectId>,
}

struct Walker<'a> {
    doc: &'a Document,
    visited: HashSet<ObjectId>,
    terminals: Vec<Terminal>,
    widget_count: usize,
}

impl Walker<'_> {
    /// Visit field node `id` at `depth` (1 for /Fields entries).
    fn visit(&mut self, id: ObjectId, parent_name: &str, depth: usize) -> Result<(), String> {
        if depth > MAX_DEPTH || !self.visited.insert(id) {
            return Ok(());
        }
        let Ok(node) = self.doc.get_dictionary(id) else {
            return Ok(());
        };
        let partial = text_of(self.doc, node, b"T").unwrap_or_default();
        let name = match (parent_name.is_empty(), partial.is_empty()) {
            (true, _) => partial.clone(),
            (false, true) => parent_name.to_string(),
            (false, false) => format!("{parent_name}.{partial}"),
        };
        let mut field_kids = Vec::new();
        let mut widget_kids = Vec::new();
        for kid in references(self.doc, node.get(b"Kids").ok()) {
            match self.doc.get_dictionary(kid) {
                Ok(d) if is_field_node(d) => field_kids.push(kid),
                Ok(d) if is_widget(d) => widget_kids.push(kid),
                _ => {}
            }
        }

        // Widgets of this node: itself (merged field and widget) and its
        // widget kids, also those next to field kids (malformed but seen).
        let mut widgets = Vec::new();
        if is_widget(node) {
            widgets.push(id);
        }
        for kid in widget_kids {
            if self.visited.insert(kid) {
                widgets.push(kid);
            }
        }
        // A node with field kids is a field itself only when it has widgets.
        if field_kids.is_empty() || !widgets.is_empty() {
            self.widget_count += widgets.len();
            if self.widget_count > MAX_WIDGETS {
                return Err(invalid("widgets"));
            }
            self.terminals.push(Terminal { obj: id, name: name.clone(), partial, widgets });
            if self.terminals.len() > MAX_FIELDS {
                return Err(invalid("fields"));
            }
        }
        for kid in field_kids {
            self.visit(kid, &name, depth + 1)?;
        }
        Ok(())
    }
}

/// A field (not only a widget): titled, or an untitled node with kids that
/// is not a widget itself (an intermediate node).
fn is_field_node(dict: &Dictionary) -> bool {
    dict.has(b"T") || (dict.has(b"Kids") && !is_widget(dict))
}

/// An untitled node whose /Parent is a dictionary: its parent claims it, so
/// a /Fields entry like that is only visited after all others.
fn claimed_by_parent(doc: &Document, id: ObjectId) -> bool {
    doc.get_dictionary(id).is_ok_and(|d| {
        !d.has(b"T")
            && d.get(b"Parent").ok().and_then(|p| deref(doc, p)).is_some_and(|p| p.as_dict().is_ok())
    })
}

fn is_widget(dict: &Dictionary) -> bool {
    name_of(dict, b"Subtype") == Some(b"Widget")
}

/// The indirect references of an array (direct entries are skipped).
fn references(doc: &Document, obj: Option<&Object>) -> Vec<ObjectId> {
    obj.and_then(|o| deref(doc, o))
        .and_then(|o| o.as_array().ok())
        .map(|items| items.iter().filter_map(|i| i.as_reference().ok()).collect())
        .unwrap_or_default()
}

fn decode_object_text(obj: &Object) -> Option<String> {
    match obj {
        Object::String(bytes, _) => Some(decode_text(bytes)),
        Object::Name(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
        _ => None,
    }
}

fn text_of(doc: &Document, dict: &Dictionary, key: &[u8]) -> Option<String> {
    decode_object_text(deref(doc, dict.get(key).ok()?)?)
}

/// `key` on field `id` or the nearest ancestor that has it (bounded /Parent
/// chain, so a cycle ends).
pub(crate) fn inherited<'a>(doc: &'a Document, id: ObjectId, key: &[u8]) -> Option<&'a Object> {
    deref(doc, inherited_entry(doc, id, key)?)
}

/// `inherited`, without following a reference held by the entry.
fn inherited_entry<'a>(doc: &'a Document, id: ObjectId, key: &[u8]) -> Option<&'a Object> {
    let mut current = id;
    for _ in 0..=MAX_DEPTH {
        let dict = doc.get_dictionary(current).ok()?;
        if let Ok(value) = dict.get(key) {
            return Some(value);
        }
        current = dict.get(b"Parent").ok()?.as_reference().ok()?;
    }
    None
}

pub(crate) fn integer(obj: Option<&Object>) -> Option<i64> {
    match obj? {
        Object::Integer(i) => Some(*i),
        Object::Real(f) if f.is_finite() => Some(*f as i64),
        _ => None,
    }
}

fn kind_of(doc: &Document, id: ObjectId, flags: i64) -> Option<FieldKind> {
    let has = |bit: i64| flags & bit != 0;
    let kind = match inherited(doc, id, b"FT")?.as_name().ok()? {
        b"Tx" => {
            let max_len = integer(inherited(doc, id, b"MaxLen"))
                .filter(|&n| n >= 0)
                .map(|n| u32::try_from(n).unwrap_or(u32::MAX));
            let (multiline, password) = (has(FF_MULTILINE), has(FF_PASSWORD));
            let comb = has(FF_COMB) && max_len.is_some() && !multiline && !password;
            FieldKind::Text { multiline, comb, max_len, password }
        }
        b"Btn" if has(FF_PUSHBUTTON) => FieldKind::Button,
        b"Btn" if has(FF_RADIO) => FieldKind::Radio,
        b"Btn" => FieldKind::Checkbox,
        b"Ch" if has(FF_COMBO) => FieldKind::Combo { editable: has(FF_EDIT) },
        b"Ch" => FieldKind::List { multi: has(FF_MULTISELECT) },
        b"Sig" => FieldKind::Signature,
        _ => return None,
    };
    Some(kind)
}

fn non_empty_text(s: String) -> Value {
    if s.is_empty() { Value::None } else { Value::Text(s) }
}

/// Text values held in a stream (allowed for text fields) are read up to
/// this many decoded bytes; a longer one reads as no value.
const MAX_STREAM_VALUE: usize = 64 * 1024;
/// Decoded bytes all stream values of one document may take together; once
/// spent, further stream values read as no value.
const MAX_STREAM_VALUES_TOTAL: usize = 8 << 20;

/// Stream /V values of one traversal: one decode budget for the document
/// and each stream decoded once (fields may share a /V stream).
pub(crate) struct StreamValues {
    spent: usize,
    decodes: usize,
    cache: HashMap<ObjectId, Option<String>>,
}

impl StreamValues {
    pub(crate) fn new() -> StreamValues {
        StreamValues { spent: 0, decodes: 0, cache: HashMap::new() }
    }

    fn text(&mut self, id: ObjectId, stream: &lopdf::Stream) -> Option<String> {
        if let Some(cached) = self.cache.get(&id) {
            return cached.clone();
        }
        let left = MAX_STREAM_VALUES_TOTAL.saturating_sub(self.spent);
        let text = if left == 0 {
            None
        } else {
            self.decodes += 1;
            crate::rebuild::bounded_content(stream, MAX_STREAM_VALUE.min(left), &mut self.spent)
                .map(|b| decode_text(&b))
        };
        self.cache.insert(id, text.clone());
        text
    }
}

/// `value` is the raw /V entry (a stream value is always indirect).
fn read_value(doc: &Document, value: Option<&Object>, kind: &FieldKind, streams: &mut StreamValues) -> Value {
    let Some(raw) = value else {
        return Value::None;
    };
    let Some(value) = deref(doc, raw) else {
        return Value::None;
    };
    if let (Object::Stream(stream), FieldKind::Text { .. } | FieldKind::Combo { .. }) = (value, kind) {
        let text = match raw {
            Object::Reference(id) => streams.text(*id, stream),
            _ => None,
        };
        return non_empty_text(text.unwrap_or_default());
    }
    let strings = |o: &Object| -> Vec<String> {
        match o {
            Object::Array(items) => items
                .iter()
                .filter_map(|i| deref(doc, i).and_then(decode_object_text))
                .collect(),
            other => decode_object_text(other).into_iter().collect(),
        }
    };
    match kind {
        FieldKind::Checkbox | FieldKind::Radio | FieldKind::Button => match decode_object_text(value) {
            Some(state) if !state.is_empty() && state != "Off" => Value::Names(vec![state]),
            _ => Value::None,
        },
        FieldKind::List { .. } => {
            let names = strings(value);
            if names.is_empty() { Value::None } else { Value::Names(names) }
        }
        FieldKind::Text { .. } | FieldKind::Combo { .. } => {
            non_empty_text(strings(value).into_iter().next().unwrap_or_default())
        }
        FieldKind::Signature => Value::None,
    }
}

/// /Opt as (export, display) pairs. A malformed entry stays as an empty pair
/// so indices (/I) keep matching /Opt.
fn read_options(doc: &Document, opt: Option<&Object>) -> Result<Vec<(String, String)>, String> {
    let Some(items) = opt.and_then(|o| o.as_array().ok()) else {
        return Ok(Vec::new());
    };
    if items.len() > MAX_OPTIONS {
        return Err(invalid("options"));
    }
    let text = |o: &Object| deref(doc, o).and_then(decode_object_text);
    Ok(items
        .iter()
        .map(|item| match deref(doc, item) {
            Some(Object::Array(pair)) => {
                let export = pair.first().and_then(text).unwrap_or_default();
                let display = pair.get(1).and_then(text).unwrap_or_else(|| export.clone());
                (export, display)
            }
            Some(other) => {
                let s = decode_object_text(other).unwrap_or_default();
                (s.clone(), s)
            }
            None => (String::new(), String::new()),
        })
        .collect())
}

/// The first /AP /N state other than /Off, as raw name bytes.
fn on_state(doc: &Document, widget: &Dictionary) -> Option<Vec<u8>> {
    let ap = deref(doc, widget.get(b"AP").ok()?)?.as_dict().ok()?;
    let states = deref(doc, ap.get(b"N").ok()?)?.as_dict().ok()?;
    states.iter().map(|(k, _)| k).find(|k| k.as_slice() != b"Off").cloned()
}

fn std_font_named(name: &[u8]) -> Option<StdFont> {
    // Drop a subset tag such as "ABCDEF+".
    let name = match name.iter().position(|&b| b == b'+') {
        Some(6) => &name[7..],
        _ => name,
    };
    match name {
        b"Helvetica" | b"Helv" => Some(StdFont::Helvetica),
        b"Helvetica-Bold" | b"HeBo" => Some(StdFont::HelveticaBold),
        b"Times-Roman" | b"TiRo" => Some(StdFont::TimesRoman),
        b"Courier" | b"Cour" => Some(StdFont::Courier),
        _ => None,
    }
}

/// Largest /DA font size taken as is; larger (or non-positive, non-finite)
/// sizes mean auto size.
pub(crate) const MAX_DA_SIZE: f64 = 1000.0;

fn da_size(size: Option<f64>) -> f64 {
    size.filter(|s| s.is_finite() && *s > 0.0 && *s <= MAX_DA_SIZE).unwrap_or(0.0)
}

fn da_font(doc: &Document, name: &[u8], dr: Option<&Dictionary>) -> StdFont {
    let base = dr
        .and_then(|dr| deref(doc, dr.get(b"Font").ok()?)?.as_dict().ok())
        .and_then(|fonts| deref(doc, fonts.get(name).ok()?)?.as_dict().ok())
        .and_then(|font| name_of(font, b"BaseFont"));
    base.or(Some(name)).and_then(std_font_named).unwrap_or(StdFont::Helvetica)
}

/// `/Name size Tf` found by splitting on whitespace, for a /DA lopdf cannot
/// tokenize (it stops silently at the first bad token). The last one wins.
fn scan_tf(da: &[u8]) -> Option<(Vec<u8>, Option<f64>)> {
    let tokens: Vec<&[u8]> = da.split(|b| b.is_ascii_whitespace()).filter(|t| !t.is_empty()).collect();
    tokens.windows(3).rev().find_map(|w| {
        let name = w[0].strip_prefix(b"/")?;
        (w[2] == b"Tf").then(|| (name.to_vec(), std::str::from_utf8(w[1]).ok().and_then(|s| s.parse().ok())))
    })
}

/// Parse a /DA string. The font resource name is looked up in /DR /Font for
/// its /BaseFont; anything but the four supported standard fonts becomes
/// Helvetica. Sizes are clamped (`MAX_DA_SIZE`, 0 = auto); colour
/// components to 0..1.
pub(crate) fn parse_da(doc: &Document, da: &[u8], dr: Option<&Dictionary>) -> DefaultAppearance {
    let mut out = DefaultAppearance::default();
    let operations = lopdf::content::Content::decode(da).map(|c| c.operations).unwrap_or_default();
    let has_tf = operations
        .iter()
        .any(|op| op.operator == "Tf" && matches!(op.operands.as_slice(), [Object::Name(_), _]));
    if !has_tf && let Some((name, size)) = scan_tf(da) {
        out.font = da_font(doc, &name, dr);
        out.size = da_size(size);
    }
    let number = |o: &Object| o.as_float().ok().map(f64::from).filter(|n| n.is_finite());
    let numbers = |ops: &[Object]| -> Option<Vec<f64>> {
        ops.iter().map(|o| number(o).map(|n| n.clamp(0.0, 1.0))).collect()
    };
    for op in operations {
        match (op.operator.as_str(), op.operands.as_slice()) {
            ("Tf", [Object::Name(name), size]) => {
                out.font = da_font(doc, name, dr);
                out.size = da_size(number(size));
            }
            ("g", ops) => {
                if let Some([g]) = numbers(ops).as_deref() {
                    out.color = DaColor::Gray(*g);
                }
            }
            ("rg", ops) => {
                if let Some([r, g, b]) = numbers(ops).as_deref() {
                    out.color = DaColor::Rgb([*r, *g, *b]);
                }
            }
            ("k", ops) => {
                if let Some([c, m, y, k]) = numbers(ops).as_deref() {
                    out.color = DaColor::Cmyk([*c, *m, *y, *k]);
                }
            }
            _ => {}
        }
    }
    out
}

/// Visible-space rectangle of a user-space `rect` (inverse of
/// `VisibleBox::matrix`).
pub(crate) fn to_visible(vb: &VisibleBox, [x0, y0, x1, y1]: [f64; 4]) -> [f64; 4] {
    let map = |x: f64, y: f64| match vb.rotate {
        90 => (y - vb.y0, vb.x1 - x),
        180 => (vb.x1 - x, vb.y1 - y),
        270 => (vb.y1 - y, x - vb.x0),
        _ => (x - vb.x0, y - vb.y0),
    };
    let (ax, ay) = map(x0, y0);
    let (bx, by) = map(x1, y1);
    [ax.min(bx), ay.min(by), ax.max(bx), ay.max(by)]
}

/// Where widgets sit: page number per annotation (from page /Annots, first
/// page wins) and per page object.
struct Pages {
    by_annot: HashMap<ObjectId, u32>,
    by_page: HashMap<ObjectId, u32>,
    boxes: HashMap<u32, VisibleBox>,
}

impl Pages {
    fn new(doc: &Document) -> Pages {
        let mut by_annot = HashMap::new();
        let mut by_page = HashMap::new();
        let mut boxes = HashMap::new();
        for (number, page) in doc.get_pages() {
            by_page.insert(page, number);
            boxes.insert(number, VisibleBox::of_page(doc, page));
            let Ok(dict) = doc.get_dictionary(page) else {
                continue;
            };
            for annot in references(doc, dict.get(b"Annots").ok()) {
                by_annot.entry(annot).or_insert(number);
            }
        }
        Pages { by_annot, by_page, boxes }
    }

    fn page_of(&self, id: ObjectId, widget: &Dictionary) -> u32 {
        self.by_annot
            .get(&id)
            .or_else(|| widget.get(b"P").ok()?.as_reference().ok().and_then(|p| self.by_page.get(&p)))
            .copied()
            .unwrap_or(0)
    }
}

struct Context<'a> {
    doc: &'a Document,
    form: &'a Dictionary,
    dr: Option<&'a Dictionary>,
    pages: Pages,
}

impl<'a> Context<'a> {
    /// `key` on the widget itself, else inherited by the field, else the
    /// AcroForm default.
    fn widget_attr(&self, widget: &'a Dictionary, field: ObjectId, key: &[u8]) -> Option<&'a Object> {
        widget
            .get(key)
            .ok()
            .and_then(|v| deref(self.doc, v))
            .or_else(|| inherited(self.doc, field, key))
            .or_else(|| self.form.get(key).ok().and_then(|v| deref(self.doc, v)))
    }

    /// None only when `id` is not a dictionary (the traversal never yields one).
    fn widget(&self, id: ObjectId, field: ObjectId, kind: &FieldKind) -> Option<(Widget, WidgetRef)> {
        let doc = self.doc;
        let dict = doc.get_dictionary(id).ok()?;
        let page = self.pages.page_of(id, dict);
        let rect = dict
            .get(b"Rect")
            .ok()
            .and_then(|r| parse_numbers::<4>(doc, r))
            .map(|[a, b, c, d]| [a.min(c), b.min(d), a.max(c), b.max(d)])
            .unwrap_or([0.0; 4]);
        let page_box = self.pages.boxes.get(&page);
        let mk_rotation = dict
            .get(b"MK")
            .ok()
            .and_then(|mk| deref(doc, mk)?.as_dict().ok())
            .and_then(|mk| deref(doc, mk.get(b"R").ok()?));
        let rotation = add_rotation(mk_rotation, page_box.map_or(0, |vb| vb.rotate));
        let flags = integer(dict.get(b"F").ok().and_then(|f| deref(doc, f))).unwrap_or(0);
        let da = match self.widget_attr(dict, field, b"DA") {
            Some(Object::String(bytes, _)) => parse_da(doc, bytes, self.dr),
            _ => DefaultAppearance::default(),
        };
        let align = match integer(self.widget_attr(dict, field, b"Q")) {
            Some(q @ 0..=2) => q as u8,
            _ => 0,
        };
        let on_state = match kind {
            FieldKind::Checkbox | FieldKind::Radio => on_state(doc, dict),
            _ => None,
        };
        let on_state_text = on_state.as_ref().map(|s| String::from_utf8_lossy(s).into_owned());
        let widget = Widget {
            page,
            rect: page_box.map_or(rect, |vb| to_visible(vb, rect)),
            rotation: rotation as u16,
            on_state: on_state_text,
            hidden: flags & INVISIBLE_FLAGS != 0,
            font_size: da.size,
            align,
        };
        Some((widget, WidgetRef { obj: id, da, on_state }))
    }

    fn field(&self, index: usize, t: &Terminal, streams: &mut StreamValues) -> Result<Option<(Field, FieldRef)>, String> {
        let doc = self.doc;
        let flags = integer(inherited(doc, t.obj, b"Ff")).unwrap_or(0);
        let Some(kind) = kind_of(doc, t.obj, flags) else {
            return Ok(None);
        };
        let dict = doc.get_dictionary(t.obj).map_err(|e| e.to_string())?;
        let label = text_of(doc, dict, b"TU")
            .filter(|s| !s.is_empty())
            .or_else(|| (!t.partial.is_empty()).then(|| t.partial.clone()))
            .unwrap_or_else(|| t.name.clone());
        let (mut widgets, widget_refs): (Vec<Widget>, Vec<WidgetRef>) =
            t.widgets.iter().filter_map(|&w| self.widget(w, t.obj, &kind)).unzip();
        let mut on_states: Vec<String> = Vec::new();
        let mut seen: HashSet<&str> = HashSet::new();
        for state in widgets.iter().filter_map(|w| w.on_state.as_deref()) {
            if seen.insert(state) {
                on_states.push(state.to_string());
            }
        }
        let mut generated_state = None;
        if kind == FieldKind::Radio && widgets.iter().any(|w| w.on_state.is_none()) {
            let name = generated_radio_state(&on_states);
            for w in widgets.iter_mut().filter(|w| w.on_state.is_none()) {
                w.on_state = Some(name.clone());
            }
            on_states.push(name.clone());
            generated_state = Some(name);
        }
        let value = inherited_entry(doc, t.obj, b"V");
        let value_name = match (&kind, value.and_then(|v| deref(doc, v))) {
            (FieldKind::Checkbox | FieldKind::Radio, Some(Object::Name(n))) => Some(n.clone()),
            _ => None,
        };
        let field = Field {
            id: index as u32,
            name: t.name.clone(),
            label,
            read_only: flags & FF_READ_ONLY != 0,
            required: flags & FF_REQUIRED != 0,
            value: read_value(doc, value, &kind, streams),
            options: read_options(doc, inherited(doc, t.obj, b"Opt"))?,
            kind,
            on_states,
            widgets,
        };
        Ok(Some((field, FieldRef { obj: t.obj, widgets: widget_refs, value_name, generated_state })))
    }
}

/// On state name for radio widgets without an "on" appearance: /On, or
/// /On2, /On3, ... when the group already uses it.
pub(crate) fn generated_radio_state(on_states: &[String]) -> String {
    let taken = |name: &str| on_states.iter().any(|s| s == name);
    (1u32..)
        .map(|k| if k == 1 { "On".to_string() } else { format!("On{k}") })
        .find(|name| !taken(name))
        .unwrap_or_default()
}

/// Read the form of a loaded document. Field ids are indices in this
/// traversal; fields of an unknown type are skipped.
pub(crate) fn read_form(doc: &Document) -> Result<FormTree, String> {
    read_form_with(doc, &mut StreamValues::new())
}

fn read_form_with(doc: &Document, streams: &mut StreamValues) -> Result<FormTree, String> {
    let Some(form) = acroform(doc) else {
        return Ok(FormTree { info: FormInfo { xfa: Xfa::None, fields: Vec::new() }, refs: Vec::new() });
    };
    let mut walker = Walker { doc, visited: HashSet::new(), terminals: Vec::new(), widget_count: 0 };
    let (claimed, top): (Vec<ObjectId>, Vec<ObjectId>) =
        references(doc, form.get(b"Fields").ok()).into_iter().partition(|&id| claimed_by_parent(doc, id));
    // Nodes their parent claims go last: the visited set skips those taken.
    for id in top.into_iter().chain(claimed) {
        walker.visit(id, "", 1)?;
    }
    let ctx = Context {
        doc,
        form,
        dr: form.get(b"DR").ok().and_then(|d| deref(doc, d)?.as_dict().ok()),
        pages: Pages::new(doc),
    };
    let mut fields = Vec::new();
    let mut refs = Vec::new();
    for terminal in &walker.terminals {
        if let Some((field, field_ref)) = ctx.field(fields.len(), terminal, streams)? {
            fields.push(field);
            refs.push(field_ref);
        }
    }
    let has_xfa = form.get(b"XFA").ok().and_then(|x| deref(doc, x)).is_some_and(|x| !matches!(x, Object::Null));
    let xfa = match (has_xfa, fields.is_empty()) {
        (false, _) => Xfa::None,
        (true, true) => Xfa::Pure,
        (true, false) => Xfa::Hybrid,
    };
    Ok(FormTree { info: FormInfo { xfa, fields }, refs })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::pdf_util::save_pdf;
    use lopdf::{Stream, dictionary};

    pub(crate) fn rect(v: [i64; 4]) -> Object {
        Object::Array(v.iter().map(|&n| Object::Integer(n)).collect())
    }

    /// A one-page document (MediaBox 0 0 600 800, given /Rotate) without a
    /// form yet.
    pub(crate) fn base(rotate: i64) -> (Document, ObjectId) {
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let page = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id, "MediaBox" => rect([0, 0, 600, 800]),
            "Rotate" => rotate,
        });
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1 }),
        );
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", catalog);
        (doc, page)
    }

    /// Attach /AcroForm (with `extra` entries) and the page /Annots.
    pub(crate) fn finish(doc: &mut Document, page: ObjectId, fields: &[ObjectId], annots: &[ObjectId], extra: Vec<(&str, Object)>) {
        let helv = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica" });
        let cour = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Courier" });
        let mut form = dictionary! {
            "Fields" => fields.iter().map(|&f| Object::from(f)).collect::<Vec<_>>(),
            "DR" => dictionary! { "Font" => dictionary! { "Helv" => helv, "F2" => cour } },
        };
        for (k, v) in extra {
            form.set(k, v);
        }
        let form = doc.add_object(form);
        let root = doc.trailer.get(b"Root").unwrap().as_reference().unwrap();
        doc.get_dictionary_mut(root).unwrap().set("AcroForm", form);
        let annots: Vec<Object> = annots.iter().map(|&a| a.into()).collect();
        doc.get_dictionary_mut(page).unwrap().set("Annots", annots);
    }

    pub(crate) fn widget(page: ObjectId, r: [i64; 4]) -> Dictionary {
        dictionary! { "Type" => "Annot", "Subtype" => "Widget", "Rect" => rect(r), "P" => page }
    }

    pub(crate) fn with(mut d: Dictionary, entries: Vec<(&str, Object)>) -> Dictionary {
        for (k, v) in entries {
            d.set(k, v);
        }
        d
    }

    pub(crate) fn states(doc: &mut Document, names: &[&str]) -> Object {
        let mut n = Dictionary::new();
        for name in names {
            n.set(*name, doc.add_object(Stream::new(dictionary! {}, b"".to_vec())));
        }
        Object::Dictionary(dictionary! { "N" => n })
    }

    fn tree(doc: &Document) -> FormTree {
        read_form(doc).unwrap()
    }

    #[test]
    fn merged_field_and_widget_through_bytes() {
        let (mut doc, page) = base(0);
        let field = doc.add_object(with(widget(page, [100, 700, 300, 720]), vec![
            ("FT", "Tx".into()),
            ("T", Object::string_literal("name")),
            ("V", Object::string_literal("Ada")),
            ("DA", Object::string_literal("/Helv 12 Tf 0 g")),
            ("Q", 1.into()),
        ]));
        finish(&mut doc, page, &[field], &[field], vec![]);
        let info = list_form(&save_pdf(&mut doc).unwrap()).unwrap();
        assert_eq!(info.xfa, Xfa::None);
        assert_eq!(info.fields.len(), 1);
        let f = &info.fields[0];
        assert_eq!((f.id, f.name.as_str(), f.label.as_str()), (0, "name", "name"));
        assert_eq!(f.kind, FieldKind::Text { multiline: false, comb: false, max_len: None, password: false });
        assert_eq!(f.value, Value::Text("Ada".into()));
        assert!(!f.read_only && !f.required);
        assert_eq!(f.widgets, vec![Widget {
            page: 1, rect: [100.0, 700.0, 300.0, 720.0], rotation: 0, on_state: None,
            hidden: false, font_size: 12.0, align: 1,
        }]);
    }

    #[test]
    fn split_field_with_two_widgets() {
        let (mut doc, page) = base(0);
        let field = doc.new_object_id();
        let w1 = doc.add_object(with(widget(page, [0, 0, 10, 10]), vec![("Parent", field.into())]));
        let w2 = doc.add_object(with(widget(page, [20, 0, 30, 10]), vec![
            ("Parent", field.into()),
            ("DA", Object::string_literal("/F2 8 Tf")),
        ]));
        doc.objects.insert(field, Object::Dictionary(dictionary! {
            "FT" => "Tx", "T" => Object::string_literal("dup"), "Kids" => vec![w1.into(), w2.into()],
            "DA" => Object::string_literal("/Helv 10 Tf"),
        }));
        finish(&mut doc, page, &[field], &[w1, w2], vec![]);
        let t = tree(&doc);
        assert_eq!(t.info.fields.len(), 1);
        let f = &t.info.fields[0];
        assert_eq!(f.name, "dup");
        assert_eq!(f.widgets.len(), 2);
        assert_eq!(f.widgets[1].rect, [20.0, 0.0, 30.0, 10.0]);
        assert_eq!((f.widgets[0].font_size, f.widgets[1].font_size), (10.0, 8.0));
        assert_eq!(t.refs[0].obj, field);
        assert_eq!(t.refs[0].widgets.iter().map(|w| w.obj).collect::<Vec<_>>(), vec![w1, w2]);
        assert_eq!(t.refs[0].widgets[0].da.font, StdFont::Helvetica);
        assert_eq!(t.refs[0].widgets[1].da.font, StdFont::Courier);
    }

    #[test]
    fn three_level_names_and_tooltip_label() {
        let (mut doc, page) = base(0);
        let a = doc.new_object_id();
        let b = doc.new_object_id();
        let c = doc.add_object(with(widget(page, [0, 0, 10, 10]), vec![
            ("FT", "Tx".into()), ("T", Object::string_literal("c")), ("Parent", b.into()),
        ]));
        let d = doc.add_object(with(widget(page, [0, 20, 10, 30]), vec![
            ("FT", "Tx".into()), ("T", Object::string_literal("d")), ("Parent", b.into()),
            ("TU", Object::string_literal("Your city")),
        ]));
        doc.objects.insert(b, Object::Dictionary(dictionary! {
            "T" => Object::string_literal("b"), "Parent" => a, "Kids" => vec![c.into(), d.into()],
        }));
        doc.objects.insert(a, Object::Dictionary(dictionary! {
            "T" => Object::string_literal("a"), "Kids" => vec![b.into()],
        }));
        finish(&mut doc, page, &[a], &[c, d], vec![]);
        let info = tree(&doc).info;
        let names: Vec<(&str, &str)> = info.fields.iter().map(|f| (f.name.as_str(), f.label.as_str())).collect();
        assert_eq!(names, vec![("a.b.c", "c"), ("a.b.d", "Your city")]);
        assert_eq!(info.fields.iter().map(|f| f.id).collect::<Vec<_>>(), vec![0, 1]);
    }

    #[test]
    fn inherited_ft_ff_da_and_acroform_defaults() {
        let (mut doc, page) = base(0);
        let parent = doc.new_object_id();
        let kid = doc.add_object(with(widget(page, [0, 0, 10, 10]), vec![
            ("T", Object::string_literal("q")), ("Parent", parent.into()),
        ]));
        doc.objects.insert(parent, Object::Dictionary(dictionary! {
            "T" => Object::string_literal("p"), "FT" => "Tx", "Ff" => FF_MULTILINE,
            "DA" => Object::string_literal("/Cour 9 Tf 0.5 g"), "Kids" => vec![kid.into()],
        }));
        let bare = doc.add_object(with(widget(page, [0, 20, 10, 30]), vec![
            ("FT", "Tx".into()), ("T", Object::string_literal("bare")),
        ]));
        finish(&mut doc, page, &[parent, bare], &[kid, bare], vec![
            ("DA", Object::string_literal("/TiRo 7 Tf 1 0 0 rg")),
            ("Q", 2.into()),
        ]);
        let t = tree(&doc);
        let f = &t.info.fields[0];
        assert_eq!(f.name, "p.q");
        assert_eq!(f.kind, FieldKind::Text { multiline: true, comb: false, max_len: None, password: false });
        assert_eq!(f.widgets[0].font_size, 9.0);
        assert_eq!(f.widgets[0].align, 2);
        assert_eq!(t.refs[0].widgets[0].da, DefaultAppearance {
            font: StdFont::Courier, size: 9.0, color: DaColor::Gray(0.5),
        });
        assert_eq!(t.refs[1].widgets[0].da, DefaultAppearance {
            font: StdFont::TimesRoman, size: 7.0, color: DaColor::Rgb([1.0, 0.0, 0.0]),
        });
    }

    #[test]
    fn radio_kids_with_numbered_on_states() {
        let (mut doc, page) = base(0);
        let field = doc.new_object_id();
        let mut kids = Vec::new();
        for (i, state) in ["1", "2", "3"].into_iter().enumerate() {
            let ap = states(&mut doc, &["Off", state]);
            let x = 20 * i as i64;
            kids.push(doc.add_object(with(widget(page, [x, 0, x + 10, 10]), vec![
                ("Parent", field.into()), ("AP", ap), ("AS", "Off".into()),
            ])));
        }
        doc.objects.insert(field, Object::Dictionary(dictionary! {
            "FT" => "Btn", "Ff" => FF_RADIO, "T" => Object::string_literal("choice"), "V" => "2",
            "Kids" => kids.iter().map(|&k| Object::from(k)).collect::<Vec<_>>(),
        }));
        finish(&mut doc, page, &[field], &kids, vec![]);
        let f = &tree(&doc).info.fields[0];
        assert_eq!(f.kind, FieldKind::Radio);
        assert_eq!(f.on_states, vec!["1", "2", "3"]);
        let per_widget: Vec<Option<&str>> = f.widgets.iter().map(|w| w.on_state.as_deref()).collect();
        assert_eq!(per_widget, vec![Some("1"), Some("2"), Some("3")]);
        assert_eq!(f.value, Value::Names(vec!["2".into()]));
    }

    #[test]
    fn checkbox_on_state_and_off_value() {
        let (mut doc, page) = base(0);
        let ap = states(&mut doc, &["On", "Off"]);
        let field = doc.add_object(with(widget(page, [0, 0, 10, 10]), vec![
            ("FT", "Btn".into()), ("T", Object::string_literal("agree")), ("V", "Off".into()), ("AP", ap),
            ("Ff", (FF_READ_ONLY | FF_REQUIRED).into()),
        ]));
        finish(&mut doc, page, &[field], &[field], vec![]);
        let f = &tree(&doc).info.fields[0];
        assert_eq!(f.kind, FieldKind::Checkbox);
        assert_eq!(f.on_states, vec!["On"]);
        assert_eq!(f.widgets[0].on_state.as_deref(), Some("On"));
        assert_eq!(f.value, Value::None);
        assert!(f.read_only && f.required);
    }

    #[test]
    fn choice_options_pairs_and_plain_strings() {
        let (mut doc, page) = base(0);
        let opt = Object::Array(vec![
            Object::Array(vec![Object::string_literal("a"), Object::string_literal("Apple")]),
            Object::string_literal("b"),
            Object::Integer(7),
        ]);
        let combo = doc.add_object(with(widget(page, [0, 0, 10, 10]), vec![
            ("FT", "Ch".into()), ("T", Object::string_literal("fruit")), ("Ff", (FF_COMBO | FF_EDIT).into()),
            ("Opt", opt.clone()), ("V", Object::string_literal("a")),
        ]));
        let list = doc.add_object(with(widget(page, [0, 20, 10, 30]), vec![
            ("FT", "Ch".into()), ("T", Object::string_literal("many")), ("Ff", FF_MULTISELECT.into()),
            ("Opt", opt), ("V", vec![Object::string_literal("a"), Object::string_literal("b")].into()),
        ]));
        finish(&mut doc, page, &[combo, list], &[combo, list], vec![]);
        let info = tree(&doc).info;
        let expected = vec![
            ("a".to_string(), "Apple".to_string()),
            ("b".to_string(), "b".to_string()),
            (String::new(), String::new()),
        ];
        assert_eq!(info.fields[0].kind, FieldKind::Combo { editable: true });
        assert_eq!(info.fields[0].options, expected);
        assert_eq!(info.fields[0].value, Value::Text("a".into()));
        assert_eq!(info.fields[1].kind, FieldKind::List { multi: true });
        assert_eq!(info.fields[1].options, expected);
        assert_eq!(info.fields[1].value, Value::Names(vec!["a".into(), "b".into()]));
    }

    #[test]
    fn text_flags_comb_password_maxlen() {
        let (mut doc, page) = base(0);
        let comb = doc.add_object(with(widget(page, [0, 0, 10, 10]), vec![
            ("FT", "Tx".into()), ("T", Object::string_literal("pin")), ("Ff", FF_COMB.into()), ("MaxLen", 6.into()),
        ]));
        let no_len = doc.add_object(with(widget(page, [0, 0, 10, 10]), vec![
            ("FT", "Tx".into()), ("T", Object::string_literal("x")), ("Ff", (FF_COMB | FF_PASSWORD).into()),
            ("MaxLen", (-3).into()),
        ]));
        finish(&mut doc, page, &[comb, no_len], &[comb, no_len], vec![]);
        let info = tree(&doc).info;
        assert_eq!(info.fields[0].kind, FieldKind::Text { multiline: false, comb: true, max_len: Some(6), password: false });
        assert_eq!(info.fields[1].kind, FieldKind::Text { multiline: false, comb: false, max_len: None, password: true });
    }

    #[test]
    fn button_signature_and_unknown_types() {
        let (mut doc, page) = base(0);
        let push = doc.add_object(with(widget(page, [0, 0, 10, 10]), vec![
            ("FT", "Btn".into()), ("T", Object::string_literal("go")), ("Ff", FF_PUSHBUTTON.into()),
        ]));
        let unknown = doc.add_object(with(widget(page, [0, 0, 10, 10]), vec![("T", Object::string_literal("?"))]));
        let sig = doc.add_object(with(widget(page, [0, 0, 10, 10]), vec![
            ("FT", "Sig".into()), ("T", Object::string_literal("sign")), ("V", dictionary! {}.into()),
        ]));
        finish(&mut doc, page, &[push, unknown, sig], &[push, unknown, sig], vec![]);
        let t = tree(&doc);
        let kinds: Vec<(u32, &FieldKind)> = t.info.fields.iter().map(|f| (f.id, &f.kind)).collect();
        assert_eq!(kinds, vec![(0, &FieldKind::Button), (1, &FieldKind::Signature)]);
        assert_eq!(t.info.fields[1].value, Value::None);
        assert_eq!(t.refs.iter().map(|r| r.obj).collect::<Vec<_>>(), vec![push, sig]);
    }

    #[test]
    fn cycles_in_kids_and_parent_terminate() {
        let (mut doc, page) = base(0);
        let a = doc.new_object_id();
        let b = doc.new_object_id();
        // a -> b -> a (and a lists itself).
        doc.objects.insert(a, Object::Dictionary(dictionary! {
            "T" => Object::string_literal("a"), "Kids" => vec![b.into(), a.into()],
        }));
        doc.objects.insert(b, Object::Dictionary(dictionary! {
            "T" => Object::string_literal("b"), "Kids" => vec![a.into()], "Parent" => a,
        }));
        // Terminal c whose /Parent chain loops c -> d -> c; no /FT anywhere.
        let c = doc.new_object_id();
        let d = doc.add_object(dictionary! { "Parent" => c });
        doc.objects.insert(c, Object::Dictionary(with(widget(page, [0, 0, 10, 10]), vec![
            ("T", Object::string_literal("c")), ("Parent", d.into()),
        ])));
        // Terminal e inherits /FT from f through a looping chain e -> f -> e.
        let e = doc.new_object_id();
        let f = doc.add_object(dictionary! { "Parent" => e, "FT" => "Tx" });
        doc.objects.insert(e, Object::Dictionary(with(widget(page, [0, 0, 10, 10]), vec![
            ("T", Object::string_literal("e")), ("Parent", f.into()),
        ])));
        finish(&mut doc, page, &[a, c, e, e], &[c, e], vec![]);
        let info = tree(&doc).info;
        let names: Vec<&str> = info.fields.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["e"]);
    }

    fn chain(depth: usize) -> Document {
        let (mut doc, page) = base(0);
        let leaf = doc.add_object(with(widget(page, [0, 0, 10, 10]), vec![
            ("FT", "Tx".into()), ("T", Object::string_literal("leaf")),
        ]));
        let mut top = leaf;
        for i in 1..depth {
            top = doc.add_object(dictionary! {
                "T" => Object::string_literal(format!("n{i}")), "Kids" => vec![top.into()],
            });
        }
        finish(&mut doc, page, &[top], &[leaf], vec![]);
        doc
    }

    #[test]
    fn depth_32_listed_depth_40_truncated() {
        let info = tree(&chain(MAX_DEPTH)).info;
        assert_eq!(info.fields.len(), 1);
        assert!(info.fields[0].name.ends_with(".n1.leaf"));
        assert_eq!(info.fields[0].name.split('.').count(), MAX_DEPTH);
        assert!(tree(&chain(40)).info.fields.is_empty());
    }

    #[test]
    fn more_than_20000_fields_is_an_error() {
        let (mut doc, page) = base(0);
        let fields: Vec<ObjectId> = (0..=MAX_FIELDS)
            .map(|i| doc.add_object(dictionary! { "FT" => "Tx", "T" => Object::string_literal(format!("f{i}")) }))
            .collect();
        finish(&mut doc, page, &fields, &[], vec![]);
        assert_eq!(read_form(&doc).unwrap_err(), "Invalid form settings: fields");
    }

    #[test]
    fn more_than_50000_widgets_is_an_error() {
        let (mut doc, page) = base(0);
        let kids: Vec<Object> = (0..=MAX_WIDGETS).map(|_| doc.add_object(widget(page, [0, 0, 1, 1])).into()).collect();
        let field = doc.add_object(dictionary! { "FT" => "Tx", "T" => Object::string_literal("x"), "Kids" => kids });
        finish(&mut doc, page, &[field], &[], vec![]);
        assert_eq!(read_form(&doc).unwrap_err(), "Invalid form settings: widgets");
    }

    #[test]
    fn more_than_10000_options_is_an_error() {
        let (mut doc, page) = base(0);
        let opt: Vec<Object> = (0..=MAX_OPTIONS).map(|i| Object::string_literal(format!("{i}"))).collect();
        let field = doc.add_object(dictionary! { "FT" => "Ch", "T" => Object::string_literal("x"), "Opt" => opt });
        finish(&mut doc, page, &[field], &[], vec![]);
        assert_eq!(read_form(&doc).unwrap_err(), "Invalid form settings: options");
    }

    #[test]
    fn xfa_hybrid_and_pure() {
        let (mut doc, page) = base(0);
        let field = doc.add_object(with(widget(page, [0, 0, 10, 10]), vec![
            ("FT", "Tx".into()), ("T", Object::string_literal("x")),
        ]));
        let xfa = doc.add_object(Stream::new(dictionary! {}, b"<xdp/>".to_vec()));
        finish(&mut doc, page, &[field], &[field], vec![("XFA", xfa.into())]);
        assert_eq!(tree(&doc).info.xfa, Xfa::Hybrid);

        let (mut doc, page) = base(0);
        finish(&mut doc, page, &[], &[], vec![("XFA", Object::Array(vec![]))]);
        let info = tree(&doc).info;
        assert_eq!((info.xfa, info.fields.len()), (Xfa::Pure, 0));
    }

    #[test]
    fn rotated_page_rect_in_visible_space() {
        let (mut doc, page) = base(90);
        let field = doc.add_object(with(widget(page, [100, 200, 150, 220]), vec![
            ("FT", "Tx".into()), ("T", Object::string_literal("x")),
            ("MK", dictionary! { "R" => 90 }.into()),
        ]));
        finish(&mut doc, page, &[field], &[field], vec![]);
        let w = &tree(&doc).info.fields[0].widgets[0];
        assert_eq!(w.rect, [200.0, 450.0, 220.0, 500.0]);
        assert_eq!(w.rotation, 180);
        // Mapping back with the page matrix lands on the original corners.
        let vb = VisibleBox::of_page(&doc, page);
        let corners = [vb.to_user(w.rect[0], w.rect[1]), vb.to_user(w.rect[2], w.rect[3])];
        assert!(corners.contains(&(150.0, 200.0)) && corners.contains(&(100.0, 220.0)), "{corners:?}");
    }

    #[test]
    fn to_visible_inverts_every_rotation() {
        for rotate in [0, 90, 180, 270] {
            let vb = VisibleBox { x0: 10.0, y0: 20.0, x1: 610.0, y1: 820.0, rotate };
            let r = to_visible(&vb, [110.0, 220.0, 160.0, 240.0]);
            let (ax, ay) = vb.to_user(r[0], r[1]);
            let (bx, by) = vb.to_user(r[2], r[3]);
            assert_eq!([ax.min(bx), ay.min(by), ax.max(bx), ay.max(by)], [110.0, 220.0, 160.0, 240.0], "{rotate}");
        }
    }

    #[test]
    fn hidden_flags() {
        let (mut doc, page) = base(0);
        let ids: Vec<ObjectId> = [2, 32, 4, 0]
            .iter()
            .enumerate()
            .map(|(i, &flag)| doc.add_object(with(widget(page, [0, 0, 10, 10]), vec![
                ("FT", "Tx".into()), ("T", Object::string_literal(format!("f{i}"))), ("F", flag.into()),
            ])))
            .collect();
        finish(&mut doc, page, &ids, &ids, vec![]);
        let hidden: Vec<bool> = tree(&doc).info.fields.iter().map(|f| f.widgets[0].hidden).collect();
        assert_eq!(hidden, vec![true, true, false, false]);
    }

    #[test]
    fn widget_page_from_p_or_none() {
        let (mut doc, page) = base(0);
        let via_p = doc.add_object(with(widget(page, [0, 0, 10, 10]), vec![
            ("FT", "Tx".into()), ("T", Object::string_literal("p")),
        ]));
        let mut orphan = widget(page, [0, 0, 10, 10]);
        orphan.remove(b"P");
        let orphan = doc.add_object(with(orphan, vec![("FT", "Tx".into()), ("T", Object::string_literal("o"))]));
        finish(&mut doc, page, &[via_p, orphan], &[], vec![]);
        let pages: Vec<u32> = tree(&doc).info.fields.iter().map(|f| f.widgets[0].page).collect();
        assert_eq!(pages, vec![1, 0]);
    }

    #[test]
    fn names_decode_utf16_and_pdfdoc() {
        let (mut doc, page) = base(0);
        let mut utf16 = vec![0xFE, 0xFF];
        for unit in "Nom é日".encode_utf16() {
            utf16.extend_from_slice(&unit.to_be_bytes());
        }
        let a = doc.add_object(with(widget(page, [0, 0, 10, 10]), vec![
            ("FT", "Tx".into()), ("T", Object::string_literal(utf16)),
            ("V", Object::string_literal(vec![0x80, b'x', 0x18, 0x93])),
        ]));
        finish(&mut doc, page, &[a], &[a], vec![]);
        let f = &tree(&doc).info.fields[0];
        assert_eq!(f.name, "Nom é日");
        assert_eq!(f.value, Value::Text("\u{2022}x\u{2D8}\u{FB01}".into()));
    }

    #[test]
    fn da_parsing_variants() {
        let doc = Document::with_version("1.7");
        let da = |s: &str| parse_da(&doc, s.as_bytes(), None);
        assert_eq!(da("/HeBo 0 Tf 0 0 0 1 k"), DefaultAppearance {
            font: StdFont::HelveticaBold, size: 0.0, color: DaColor::Cmyk([0.0, 0.0, 0.0, 1.0]),
        });
        assert_eq!(da("/Arial 11 Tf").font, StdFont::Helvetica);
        assert_eq!(da("/Courier -3 Tf").size, 0.0);
        assert_eq!(da("/Courier 1001 Tf").size, 0.0);
        assert_eq!(da("/Courier 1000 Tf").size, 1000.0);
        assert_eq!(da("/Helv 9 Tf 2 -1 0.5 rg").color, DaColor::Rgb([1.0, 0.0, 0.5]));
        assert_eq!(da("/Helv 9 Tf 7 g").color, DaColor::Gray(1.0));
        // lopdf stops at the bad token before the Tf; the scan still finds it.
        assert!(lopdf::content::Content::decode(b"<zz> /Cour 9 Tf").unwrap().operations.is_empty());
        let broken = da("<zz> /Cour 9 Tf");
        assert_eq!((broken.font, broken.size), (StdFont::Courier, 9.0));
        assert_eq!(da("{ /Cour 5000 Tf").size, 0.0);
        assert_eq!(da("((( garbage"), DefaultAppearance::default());
        assert_eq!(da("/Helv 9 Tf 1 g"), DefaultAppearance {
            font: StdFont::Helvetica, size: 9.0, color: DaColor::Gray(1.0),
        });
        assert_eq!(da("/Helv 9 Tf 1 rg").color, DaColor::Gray(0.0));
        let mut doc = Document::with_version("1.7");
        let font = doc.add_object(dictionary! { "BaseFont" => "ABCDEF+Times-Roman" });
        let dr = dictionary! { "Font" => dictionary! { "F1" => font } };
        assert_eq!(parse_da(&doc, b"/F1 10 Tf", Some(&dr)).font, StdFont::TimesRoman);
    }

    #[test]
    fn malformed_form_never_panics() {
        let (mut doc, page) = base(0);
        let weird = doc.add_object(dictionary! {
            "FT" => "Tx", "T" => 5, "Kids" => 7, "Rect" => "nope", "MK" => 3, "Q" => 9, "DA" => 4,
            "Opt" => Object::Array(vec![Object::Array(vec![])]), "V" => Object::Array(vec![]),
            "Ff" => Object::Real(f32::NAN),
        });
        let missing = (9999, 0);
        finish(&mut doc, page, &[weird, missing], &[weird], vec![]);
        let root = doc.trailer.get(b"Root").unwrap().as_reference().unwrap();
        let form = doc.get_dictionary(root).unwrap().get(b"AcroForm").unwrap().as_reference().unwrap();
        let mut fields = doc.get_dictionary(form).unwrap().get(b"Fields").unwrap().as_array().unwrap().clone();
        fields.push(Object::Integer(1));
        fields.push(Object::Dictionary(dictionary! { "FT" => "Tx" }));
        doc.get_dictionary_mut(form).unwrap().set("Fields", fields);
        let info = tree(&doc).info;
        assert_eq!(info.fields.len(), 1);
        let f = &info.fields[0];
        assert!(f.widgets.is_empty());
        assert_eq!(f.options, vec![(String::new(), String::new())]);
        assert_eq!(f.value, Value::None);

        let (doc, _) = base(0);
        assert_eq!(tree(&doc).info, FormInfo { xfa: Xfa::None, fields: Vec::new() });
    }

    #[test]
    fn widget_listed_before_its_parent_is_claimed_by_the_parent() {
        let (mut doc, page) = base(0);
        let parent = doc.new_object_id();
        let w = doc.add_object(with(widget(page, [0, 0, 10, 10]), vec![("Parent", parent.into())]));
        doc.objects.insert(parent, Object::Dictionary(dictionary! {
            "FT" => "Tx", "T" => Object::string_literal("f"), "Kids" => vec![w.into()],
        }));
        finish(&mut doc, page, &[w, parent], &[w], vec![]);
        let t = tree(&doc);
        assert_eq!(t.info.fields.len(), 1);
        assert_eq!(t.info.fields[0].name, "f");
        assert_eq!(t.refs[0].widgets.iter().map(|w| w.obj).collect::<Vec<_>>(), vec![w]);
    }

    #[test]
    fn untitled_intermediate_node_keeps_descendants() {
        let (mut doc, page) = base(0);
        let a = doc.new_object_id();
        let m = doc.new_object_id();
        let c = doc.add_object(with(widget(page, [0, 0, 10, 10]), vec![
            ("FT", "Tx".into()), ("T", Object::string_literal("c")), ("Parent", m.into()),
        ]));
        doc.objects.insert(m, Object::Dictionary(dictionary! { "Parent" => a, "Kids" => vec![c.into()] }));
        doc.objects.insert(a, Object::Dictionary(dictionary! {
            "T" => Object::string_literal("a"), "Kids" => vec![m.into()],
        }));
        finish(&mut doc, page, &[a], &[c], vec![]);
        let names: Vec<String> = tree(&doc).info.fields.into_iter().map(|f| f.name).collect();
        assert_eq!(names, vec!["a.c"]);
    }

    #[test]
    fn untitled_widget_next_to_titled_kids_belongs_to_the_parent() {
        let (mut doc, page) = base(0);
        let f = doc.new_object_id();
        let w = doc.add_object(with(widget(page, [0, 0, 10, 10]), vec![("Parent", f.into())]));
        let g = doc.add_object(with(widget(page, [0, 20, 10, 30]), vec![
            ("T", Object::string_literal("g")), ("Parent", f.into()),
        ]));
        doc.objects.insert(f, Object::Dictionary(dictionary! {
            "FT" => "Tx", "T" => Object::string_literal("f"), "Kids" => vec![w.into(), g.into()],
        }));
        finish(&mut doc, page, &[f], &[w, g], vec![]);
        let info = tree(&doc).info;
        let got: Vec<(&str, usize)> = info.fields.iter().map(|f| (f.name.as_str(), f.widgets.len())).collect();
        assert_eq!(got, vec![("f", 1), ("f.g", 1)]);
    }

    #[test]
    fn raw_on_state_and_value_names_kept() {
        let (mut doc, page) = base(0);
        let raw = vec![b'J', 0xE9]; // not UTF-8
        let mut n = Dictionary::new();
        n.set(raw.clone(), doc.add_object(Stream::new(dictionary! {}, vec![])));
        n.set("Off", doc.add_object(Stream::new(dictionary! {}, vec![])));
        let n_ref = doc.add_object(n); // indirect /AP /N
        let field = doc.add_object(with(widget(page, [0, 0, 10, 10]), vec![
            ("FT", "Btn".into()), ("T", Object::string_literal("x")), ("V", Object::Name(raw.clone())),
            ("AP", dictionary! { "N" => n_ref }.into()),
        ]));
        finish(&mut doc, page, &[field], &[field], vec![]);
        let t = tree(&doc);
        assert_eq!(t.refs[0].widgets[0].on_state.as_deref(), Some(raw.as_slice()));
        assert_eq!(t.refs[0].value_name.as_deref(), Some(raw.as_slice()));
        assert_eq!(t.info.fields[0].on_states, vec!["J\u{FFFD}"]);
    }

    #[test]
    fn widget_on_two_pages_takes_the_first() {
        let (mut doc, page) = base(0);
        let field = doc.add_object(with(widget(page, [0, 0, 10, 10]), vec![
            ("FT", "Tx".into()), ("T", Object::string_literal("x")),
        ]));
        finish(&mut doc, page, &[field], &[field], vec![]);
        let pages_id = doc.get_dictionary(page).unwrap().get(b"Parent").unwrap().as_reference().unwrap();
        let second = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id, "MediaBox" => rect([0, 0, 600, 800]),
            "Annots" => vec![field.into()],
        });
        let pages = doc.get_dictionary_mut(pages_id).unwrap();
        pages.set("Kids", vec![second.into(), page.into()]);
        pages.set("Count", 2);
        assert_eq!(tree(&doc).info.fields[0].widgets[0].page, 1);
        // Page 1 is now `second`; the field's /P (old page) is page 2.
        let pages = doc.get_pages();
        assert_eq!(pages[&1], second);
    }

    #[test]
    fn cropbox_offsets_the_visible_rect() {
        let (mut doc, page) = base(0);
        doc.get_dictionary_mut(page).unwrap().set("CropBox", rect([50, 60, 550, 760]));
        let field = doc.add_object(with(widget(page, [100, 200, 150, 220]), vec![
            ("FT", "Tx".into()), ("T", Object::string_literal("x")),
        ]));
        finish(&mut doc, page, &[field], &[field], vec![]);
        assert_eq!(tree(&doc).info.fields[0].widgets[0].rect, [50.0, 140.0, 100.0, 160.0]);
    }

    #[test]
    fn text_value_in_a_stream_is_bounded() {
        let (mut doc, page) = base(0);
        let small = doc.add_object(Stream::new(dictionary! {}, b"hello".to_vec()));
        let big = doc.add_object(Stream::new(dictionary! {}, vec![b'x'; MAX_STREAM_VALUE + 1]));
        let a = doc.add_object(with(widget(page, [0, 0, 10, 10]), vec![
            ("FT", "Tx".into()), ("T", Object::string_literal("a")), ("V", small.into()),
        ]));
        let b = doc.add_object(with(widget(page, [0, 0, 10, 10]), vec![
            ("FT", "Tx".into()), ("T", Object::string_literal("b")), ("V", big.into()),
        ]));
        finish(&mut doc, page, &[a, b], &[a, b], vec![]);
        let values: Vec<Value> = tree(&doc).info.fields.into_iter().map(|f| f.value).collect();
        assert_eq!(values, vec![Value::Text("hello".into()), Value::None]);
    }

    #[test]
    fn shared_value_stream_is_decoded_once() {
        let (mut doc, page) = base(0);
        let shared = doc.add_object(Stream::new(dictionary! {}, vec![b'x'; MAX_STREAM_VALUE]));
        let ids: Vec<ObjectId> = (0..2000)
            .map(|i| doc.add_object(with(widget(page, [0, 0, 10, 10]), vec![
                ("FT", "Tx".into()), ("T", Object::string_literal(format!("f{i}"))), ("V", shared.into()),
            ])))
            .collect();
        finish(&mut doc, page, &ids, &[], vec![]);
        let mut streams = StreamValues::new();
        let info = read_form_with(&doc, &mut streams).unwrap().info;
        assert_eq!(streams.decodes, 1);
        assert_eq!(streams.spent, MAX_STREAM_VALUE);
        assert!(info.fields.iter().all(|f| matches!(&f.value, Value::Text(t) if t.len() == MAX_STREAM_VALUE)));
    }

    #[test]
    fn stream_values_share_one_document_budget() {
        let (mut doc, page) = base(0);
        let count = MAX_STREAM_VALUES_TOTAL / MAX_STREAM_VALUE + 2;
        let ids: Vec<ObjectId> = (0..count)
            .map(|i| {
                let v = doc.add_object(Stream::new(dictionary! {}, vec![b'x'; MAX_STREAM_VALUE]));
                doc.add_object(with(widget(page, [0, 0, 10, 10]), vec![
                    ("FT", "Tx".into()), ("T", Object::string_literal(format!("f{i}"))), ("V", v.into()),
                ]))
            })
            .collect();
        finish(&mut doc, page, &ids, &[], vec![]);
        let mut streams = StreamValues::new();
        let info = read_form_with(&doc, &mut streams).unwrap().info;
        assert!(streams.spent <= MAX_STREAM_VALUES_TOTAL, "{}", streams.spent);
        let read = info.fields.iter().filter(|f| f.value != Value::None).count();
        assert_eq!(read, MAX_STREAM_VALUES_TOTAL / MAX_STREAM_VALUE);
        assert_eq!(info.fields.last().unwrap().value, Value::None);
    }

    #[test]
    fn radio_widget_without_on_appearance_lists_the_generated_state() {
        let (mut doc, page) = base(0);
        let field = doc.new_object_id();
        let ap = states(&mut doc, &["Off", "On"]);
        let with_ap = doc.add_object(with(widget(page, [0, 0, 10, 10]), vec![("Parent", field.into()), ("AP", ap)]));
        let bare = doc.add_object(with(widget(page, [20, 0, 30, 10]), vec![("Parent", field.into())]));
        doc.objects.insert(field, Object::Dictionary(dictionary! {
            "FT" => "Btn", "Ff" => FF_RADIO, "T" => Object::string_literal("r"),
            "Kids" => vec![with_ap.into(), bare.into()],
        }));
        finish(&mut doc, page, &[field], &[with_ap, bare], vec![]);
        let t = tree(&doc);
        let f = &t.info.fields[0];
        assert_eq!(f.on_states, vec!["On", "On2"]);
        assert_eq!(f.widgets[1].on_state.as_deref(), Some("On2"));
        assert_eq!(t.refs[0].widgets[1].on_state, None);
        assert_eq!(t.refs[0].generated_state.as_deref(), Some("On2"));
        // Checkbox widgets and radio groups with every appearance are unchanged.
        assert_eq!(generated_radio_state(&[]), "On");
    }
}
