//! Page plumbing shared by the stamp and edit engines: draws new operators on
//! top of a page without mutating anything other pages may share.
//!
//! The page gets owned copies of its resource dictionaries, page-unique
//! resource names, and a content list `q` (+ one more `q` per stray `Q` of
//! the original, so it cannot pop the wrapper), original..., `Q` + one `Q`
//! per `q` the original leaves open, then the new operators. New objects (fonts,
//! graphics states, the `q` stream) are shared between pages of one job:
//! none of them pre-exists, so sharing mutates nothing of the original.

use super::fonts::StdFont;
use crate::page_content::{BalanceScanner, flate_stream, original_contents, owned_dict, plain_stream};
use crate::pdf_util::get_inherited_attr;
use lopdf::{Dictionary, Document, Object, ObjectId, Stream, dictionary};
use std::collections::HashMap;

/// Blend mode of a graphics state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum Blend {
    Normal,
    Multiply,
}

/// Objects one job creates once and shares between pages.
pub(crate) struct DocWriter {
    fonts: HashMap<&'static str, ObjectId>,
    states: HashMap<(u64, Blend), ObjectId>,
    /// The head stream per count of stray `Q` in the original: `q` that many + 1 times.
    open_q: HashMap<usize, ObjectId>,
    scanner: BalanceScanner,
}

/// One page being drawn on; `ops` receives the new operators.
pub(crate) struct PageWriter {
    page_id: ObjectId,
    resources: Dictionary,
    font_dict: Dictionary,
    gs_dict: Dictionary,
    xobject_dict: Dictionary,
    properties_dict: Dictionary,
    original: Vec<Object>,
    /// Stray `Q` in the original.
    excess: usize,
    font_names: HashMap<&'static str, Vec<u8>>,
    gs_names: HashMap<(u64, Blend), Vec<u8>>,
    /// New operators; they may contain raw (WinAnsi) bytes.
    pub(crate) ops: Vec<u8>,
}

impl DocWriter {
    pub(crate) fn new() -> Self {
        DocWriter { fonts: HashMap::new(), states: HashMap::new(), open_q: HashMap::new(), scanner: BalanceScanner::new() }
    }

    /// Starts drawing on `page_id`: `ops` already closes the original
    /// content's graphics state.
    pub(crate) fn page(&mut self, doc: &Document, page_id: ObjectId) -> Result<PageWriter, String> {
        let page = doc.get_dictionary(page_id).map_err(|e| format!("Page {page_id:?} not found: {e}"))?;
        let resources = owned_dict(doc, get_inherited_attr(doc, page_id, b"Resources").as_ref());
        let font_dict = owned_dict(doc, resources.get(b"Font").ok());
        let gs_dict = owned_dict(doc, resources.get(b"ExtGState").ok());
        let xobject_dict = owned_dict(doc, resources.get(b"XObject").ok());
        let properties_dict = owned_dict(doc, resources.get(b"Properties").ok());
        let original = original_contents(doc, page.get(b"Contents").ok());
        let (open, excess) = self.scanner.balance(doc, &original);
        let mut ops = Vec::new();
        if !original.is_empty() {
            ops.extend_from_slice(b"\nQ\n");
            ops.extend_from_slice("Q\n".repeat(open).as_bytes());
        }
        Ok(PageWriter {
            page_id,
            resources,
            font_dict,
            gs_dict,
            xobject_dict,
            properties_dict,
            original,
            excess,
            font_names: HashMap::new(),
            gs_names: HashMap::new(),
            ops,
        })
    }
}

impl PageWriter {
    /// Page-local name of `font`, creating the document font on first use.
    pub(crate) fn font(&mut self, doc: &mut Document, w: &mut DocWriter, font: StdFont) -> Vec<u8> {
        if let Some(n) = self.font_names.get(font.base_font()) {
            return n.clone();
        }
        let id = *w.fonts.entry(font.base_font()).or_insert_with(|| doc.add_object(font_object(font)));
        let name = free_name(&self.font_dict, "MStF");
        self.font_dict.set(name.clone(), Object::Reference(id));
        self.font_names.insert(font.base_font(), name.clone());
        name
    }

    /// Page-local name of the ExtGState for `opacity` (clamped to 0..1) and
    /// `blend`, creating the document object on first use.
    pub(crate) fn gs(&mut self, doc: &mut Document, w: &mut DocWriter, opacity: f64, blend: Blend) -> Vec<u8> {
        let opacity = opacity.clamp(0.0, 1.0);
        let key = (opacity.to_bits(), blend);
        if let Some(n) = self.gs_names.get(&key) {
            return n.clone();
        }
        let id = *w.states.entry(key).or_insert_with(|| {
            let mut d = dictionary! {
                "Type" => "ExtGState",
                "ca" => Object::Real(opacity as f32),
                "CA" => Object::Real(opacity as f32),
            };
            if blend == Blend::Multiply {
                d.set("BM", "Multiply");
            }
            doc.add_object(d)
        });
        let name = free_name(&self.gs_dict, "MStGs");
        self.gs_dict.set(name.clone(), Object::Reference(id));
        self.gs_names.insert(key, name.clone());
        name
    }

    /// Page-local name `<prefix><k>` of the font object `id` (one the job
    /// created: it is shared between pages as is).
    pub(crate) fn font_object(&mut self, id: ObjectId, prefix: &str) -> Vec<u8> {
        let name = free_name(&self.font_dict, prefix);
        self.font_dict.set(name.clone(), Object::Reference(id));
        name
    }

    /// A fresh page-local name for the XObject `id`.
    pub(crate) fn xobject(&mut self, id: ObjectId) -> Vec<u8> {
        self.xobject_with_prefix(id, "MStIm")
    }

    /// Page-local name `<prefix><k>` of XObject `id`.
    pub(crate) fn xobject_with_prefix(&mut self, id: ObjectId, prefix: &str) -> Vec<u8> {
        let name = free_name(&self.xobject_dict, prefix);
        self.xobject_dict.set(name.clone(), Object::Reference(id));
        name
    }

    /// A fresh page-local /Properties name for `properties` (an optional
    /// content group or membership dictionary, kept as given: a reference
    /// stays a reference).
    pub(crate) fn properties(&mut self, properties: Object) -> Vec<u8> {
        let name = free_name(&self.properties_dict, "MStOC");
        self.properties_dict.set(name.clone(), properties);
        name
    }

    /// Writes the page's new resources and content list.
    pub(crate) fn finish(self, doc: &mut Document, w: &mut DocWriter) -> Result<(), String> {
        self.finish_with(doc, w, plain_stream)
    }

    /// `finish` with the new operators Flate-compressed (for large layers).
    pub(crate) fn finish_compressed(self, doc: &mut Document, w: &mut DocWriter) -> Result<(), String> {
        self.finish_with(doc, w, |ops| flate_stream(Dictionary::new(), &ops))
    }

    fn finish_with(self, doc: &mut Document, w: &mut DocWriter, tail: impl FnOnce(Vec<u8>) -> Stream) -> Result<(), String> {
        let PageWriter { page_id, mut resources, font_dict, gs_dict, xobject_dict, properties_dict, original, excess, ops, .. } = self;
        if !properties_dict.is_empty() || resources.has(b"Properties") {
            resources.set("Properties", properties_dict);
        }
        if !font_dict.is_empty() || resources.has(b"Font") {
            resources.set("Font", font_dict);
        }
        if !gs_dict.is_empty() || resources.has(b"ExtGState") {
            resources.set("ExtGState", gs_dict);
        }
        if !xobject_dict.is_empty() || resources.has(b"XObject") {
            resources.set("XObject", xobject_dict);
        }
        let mut contents = Vec::with_capacity(original.len() + 2);
        if !original.is_empty() {
            let q = *w.open_q.entry(excess).or_insert_with(|| doc.add_object(plain_stream(b"q\n".repeat(excess + 1))));
            contents.push(Object::Reference(q));
        }
        contents.extend(original);
        let tail = doc.add_object(tail(ops));
        contents.push(Object::Reference(tail));
        let page = doc.get_dictionary_mut(page_id).map_err(|e| format!("Page {page_id:?} not found: {e}"))?;
        page.set("Resources", resources);
        page.set("Contents", contents);
        Ok(())
    }
}

pub(crate) fn font_object(font: StdFont) -> Dictionary {
    dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => Object::Name(font.base_font().as_bytes().to_vec()),
        "Encoding" => "WinAnsiEncoding",
    }
}

/// First `<prefix><k>` (k = 1, 2, ...) not already in `dict`.
fn free_name(dict: &Dictionary, prefix: &str) -> Vec<u8> {
    (1u32..)
        .map(|k| format!("{prefix}{k}").into_bytes())
        .find(|n| !dict.has(n))
        .expect("a free name exists")
}

/// Append `bytes` as the body of a PDF literal string.
pub(crate) fn escape_literal(bytes: &[u8], out: &mut Vec<u8>) {
    for &b in bytes {
        if matches!(b, b'\\' | b'(' | b')') {
            out.push(b'\\');
        }
        out.push(b);
    }
}

/// A resource name as text for `format!` (names are ASCII).
pub(crate) fn lossy(name: &[u8]) -> std::borrow::Cow<'_, str> {
    String::from_utf8_lossy(name)
}
