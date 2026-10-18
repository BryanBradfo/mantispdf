//! Fill PDF forms (AcroForm): read the field tree, fill values, flatten.

pub(crate) mod appearance;
pub(crate) mod fill;
pub(crate) mod flatten;
pub(crate) mod tree;

pub use fill::fill_form;
pub use tree::list_form;

/// Fields one form may have.
pub(crate) const MAX_FIELDS: usize = 20_000;
/// Widgets all fields of one form may have together.
pub(crate) const MAX_WIDGETS: usize = 50_000;
/// Options (/Opt entries) one field may have.
pub(crate) const MAX_OPTIONS: usize = 10_000;
/// Characters in one text value.
pub(crate) const MAX_VALUE_CHARS: usize = 20_000;
/// Field tree depth: fields nested deeper are not listed.
pub(crate) const MAX_DEPTH: usize = 32;

pub(crate) fn invalid(field: &str) -> String {
    format!("Invalid form settings: {field}")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Xfa {
    /// No /XFA entry.
    None,
    /// /XFA next to AcroForm fields: filled through AcroForm.
    Hybrid,
    /// /XFA and no AcroForm field: not supported.
    Pure,
}

#[derive(Debug, Clone, PartialEq)]
pub enum FieldKind {
    Text { multiline: bool, comb: bool, max_len: Option<u32>, password: bool },
    Checkbox,
    Radio,
    Combo { editable: bool },
    List { multi: bool },
    Signature,
    /// Push button: listed, never filled.
    Button,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    /// Text field or combo box value.
    Text(String),
    /// Checked button state names, or the selected export values of a list box.
    Names(Vec<String>),
    /// No value (unchecked, empty or absent).
    None,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Widget {
    /// 1-based page number, 0 when the widget is on no page.
    pub page: u32,
    /// `[x0 y0 x1 y1]` in visible page space (bottom-left origin, page
    /// /Rotate applied); user space when `page` is 0.
    pub rect: [f64; 4],
    /// /MK /R plus page /Rotate, in {0, 90, 180, 270}. For display only.
    pub rotation: u16,
    /// The widget's "on" appearance state (buttons only).
    pub on_state: Option<String>,
    /// Hidden or NoView annotation flag set.
    pub hidden: bool,
    /// /DA font size; 0 means auto size.
    pub font_size: f64,
    /// /Q quadding: 0 left, 1 centre, 2 right.
    pub align: u8,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Field {
    /// Index in the `list_form` traversal.
    pub id: u32,
    /// Full name `a.b.c`.
    pub name: String,
    /// /TU tooltip, else the partial name, else the full name.
    pub label: String,
    pub kind: FieldKind,
    pub read_only: bool,
    pub required: bool,
    pub value: Value,
    /// /Opt entries as (export value, display text).
    pub options: Vec<(String, String)>,
    /// "On" states of the field's widgets, deduplicated (buttons).
    pub on_states: Vec<String>,
    pub widgets: Vec<Widget>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FormInfo {
    pub xfa: Xfa,
    pub fields: Vec<Field>,
}
