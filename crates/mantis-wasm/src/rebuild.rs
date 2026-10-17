//! Allowlist rebuild core (sub-project 2c).
//!
//! Output pages are built by copying only what a kept page displays, instead of
//! importing whole documents and deleting what was dropped. Every previous
//! delete-then-prune pass leaked through some reachability path (link dests,
//! form trees, actions, shared resources), so here nothing is reachable unless
//! it was copied on purpose:
//!
//! - `scan_content` finds which resource names a content stream really uses,
//!   so a shared `/Resources` dictionary does not drag in images or fonts that
//!   only dropped pages drew.
//! - `SafeCopier` deep-copies objects but refuses to follow references into
//!   pages, annotations, actions, form fields and other document-level
//!   structures; any such edge becomes `null`.
//! - `copy_page` builds a fresh page dictionary from an allowlist of keys.
//!
//! Annotations (Task 2) and document assembly (Task 3) build on these pieces.

use crate::pdf_util::get_inherited_attr;
use lopdf::content::{Content, Operation};
use lopdf::{Dictionary, Document, Object, ObjectId};
use std::collections::{HashMap, HashSet};

/// Which annotation kinds survive a rebuild.
// Consumed by Task 2 (annotation rebuild) and Task 3 (tool entry points).
#[allow(dead_code)]
pub struct Policy {
    pub keep_links: bool,
    pub keep_comments: bool,
}

/// Organize/Remove/Extract/Split keep links and comments; only what belongs to
/// dropped pages disappears.
// Consumed by Task 3 (page tools rebuilt on the engine).
#[allow(dead_code)]
pub const PAGE_TOOLS: Policy = Policy {
    keep_links: true,
    keep_comments: true,
};

// Resource categories, used both as `/Resources` keys and as `UsedNames` keys.
const XOBJECT: &[u8] = b"XObject";
const FONT: &[u8] = b"Font";
const EXT_G_STATE: &[u8] = b"ExtGState";
const COLOR_SPACE: &[u8] = b"ColorSpace";
const PATTERN: &[u8] = b"Pattern";
const SHADING: &[u8] = b"Shading";
const PROPERTIES: &[u8] = b"Properties";
const CATEGORIES: [&[u8]; 7] = [
    XOBJECT,
    FONT,
    EXT_G_STATE,
    COLOR_SPACE,
    PATTERN,
    SHADING,
    PROPERTIES,
];

/// Objects with these `/Type`s are document structure, never page content.
/// Following a reference into one is exactly how dropped pages used to leak.
const BLOCKED_TYPES: [&[u8]; 9] = [
    b"Page",
    b"Pages",
    b"Catalog",
    b"Annot",
    b"Action",
    b"Outlines",
    b"EmbeddedFile",
    b"Filespec",
    b"Sig",
];

/// Annotation subtypes. Annotations often omit `/Type /Annot`, so the subtype
/// is the reliable marker. None of these names is used by content resources.
const ANNOT_SUBTYPES: [&[u8]; 28] = [
    b"Text",
    b"Link",
    b"FreeText",
    b"Line",
    b"Square",
    b"Circle",
    b"Polygon",
    b"PolyLine",
    b"Highlight",
    b"Underline",
    b"Squiggly",
    b"StrikeOut",
    b"Caret",
    b"Stamp",
    b"Ink",
    b"Popup",
    b"FileAttachment",
    b"Sound",
    b"Movie",
    b"Screen",
    b"Widget",
    b"PrinterMark",
    b"TrapNet",
    b"Watermark",
    b"3D",
    b"Redact",
    b"Projection",
    b"RichMedia",
];

/// Keys dropped from every copied dictionary: tree back-links (/Parent, /P),
/// privacy payloads (/Metadata, /PieceInfo), scripts and actions, and
/// structure-tree hooks that would point at a structure tree we do not copy.
const NEVER_COPIED: [&[u8]; 10] = [
    b"Parent",
    b"Metadata",
    b"PieceInfo",
    b"AA",
    b"A",
    b"JS",
    b"OpenAction",
    b"P",
    b"StructParent",
    b"StructParents",
];

/// `/Type` is optional almost everywhere, so structure is also recognized by
/// shape. A page or page-tree node: one of these keys...
const PAGE_MARKERS: [&[u8]; 3] = [b"Contents", b"Kids", b"Annots"];
/// ...together with one of these.
const PAGE_CONTEXT: [&[u8]; 3] = [b"MediaBox", b"Parent", b"Resources"];
/// An action: a Name `/S` plus one of the payload keys actions carry. Content
/// dictionaries with a Name `/S` (transparency groups, soft masks) use none.
const ACTION_PAYLOADS: [&[u8]; 14] = [
    b"URI",
    b"Sound",
    b"State",
    b"Trans",
    b"JS",
    b"D",
    b"N",
    b"F",
    b"Fields",
    b"T",
    b"Next",
    b"AN",
    b"Annotation",
    b"TA",
];

/// ISO 32000 action types. A dictionary whose Name `/S` is one of these is an
/// action even without any payload key. Content dictionaries use other `/S`
/// names (`/Transparency` groups, `/Luminosity` and `/Alpha` soft masks).
const ACTION_TYPES: [&[u8]; 20] = [
    b"GoTo",
    b"GoToR",
    b"GoToE",
    b"GoToDp",
    b"Launch",
    b"Thread",
    b"URI",
    b"Sound",
    b"Movie",
    b"Hide",
    b"Named",
    b"SubmitForm",
    b"ResetForm",
    b"ImportData",
    b"JavaScript",
    b"SetOCGState",
    b"Rendition",
    b"Trans",
    b"GoTo3DView",
    b"RichMediaExecute",
];

/// Guard against stack exhaustion on adversarial reference chains (WASM has a
/// small stack). Real resource graphs are a handful of levels deep.
const MAX_REF_DEPTH: usize = 256;

/// Maximum `[` / `<<` nesting accepted in content. lopdf's content parser
/// recurses per level and overflows the stack on a few hundred, so deeper
/// content is rejected (keep-all fallback) before lopdf ever sees it. Real
/// content nests two or three levels.
const MAX_CONTENT_NESTING: usize = 64;

/// Resource names a content stream refers to, per resource category.
#[derive(Default, Debug)]
pub struct UsedNames {
    pub by_category: HashMap<&'static [u8], HashSet<Vec<u8>>>,
}

impl UsedNames {
    fn insert(&mut self, category: &'static [u8], name: &[u8]) {
        self.by_category
            .entry(category)
            .or_default()
            .insert(name.to_vec());
    }

    pub fn contains(&self, category: &[u8], name: &[u8]) -> bool {
        self.by_category
            .get(category)
            .is_some_and(|s| s.contains(name))
    }

    fn merge(&mut self, other: UsedNames) {
        for (category, names) in other.by_category {
            self.by_category.entry(category).or_default().extend(names);
        }
    }
}

/// Find the resource names used by a (decoded, unfiltered) content stream.
/// None when the content cannot be decoded: the caller must then keep every
/// resource, because guessing "uses nothing" would blank the page.
pub fn scan_content(content: &[u8]) -> Option<UsedNames> {
    // lopdf gives up on inline images whose /CS is a named resource (it only
    // knows device spaces), which is exactly the case we must see. So inline
    // images are cut out first and their dictionaries parsed on their own.
    let (rest, inline_dicts) = split_inline_images(content)?;
    let mut used = UsedNames::default();

    for op in decode_complete(&rest)? {
        let name_at = |i: usize| op.operands.get(i).and_then(|o| o.as_name().ok());
        let (category, name) = match op.operator.as_str() {
            "Do" => (XOBJECT, name_at(0)),
            "Tf" => (FONT, name_at(0)),
            "gs" => (EXT_G_STATE, name_at(0)),
            "cs" | "CS" => (COLOR_SPACE, name_at(0)),
            "scn" | "SCN" => (PATTERN, op.operands.last().and_then(|o| o.as_name().ok())),
            "sh" => (SHADING, name_at(0)),
            // op[0] is the marked-content tag; op[1] names a /Properties entry
            // (it can also be an inline dictionary, which needs no resource).
            "BDC" | "DP" => (PROPERTIES, name_at(1)),
            _ => continue,
        };
        if let Some(name) = name {
            used.insert(category, name);
        }
    }

    for dict_bytes in inline_dicts {
        let dict = decode_inline_dict(&dict_bytes)?;
        if let Ok(name) = dict
            .get(b"CS")
            .or_else(|_| dict.get(b"ColorSpace"))
            .and_then(Object::as_name)
        {
            used.insert(COLOR_SPACE, name);
        }
    }
    Some(used)
}

/// Operator appended after the real content to detect partial parses.
const END_SENTINEL: &str = "MantisScanEnd";

/// Decode content and insist that ALL of it parsed. lopdf's content parser
/// silently stops at the first bad token and returns the operations before
/// it, which would make later resource uses invisible. A sentinel operator at
/// the very end only comes back (with no stray operands) when every byte
/// before it was consumed.
fn decode_complete(bytes: &[u8]) -> Option<Vec<Operation>> {
    let mut buf = Vec::with_capacity(bytes.len() + END_SENTINEL.len() + 2);
    buf.extend_from_slice(bytes);
    buf.push(b'\n');
    buf.extend_from_slice(END_SENTINEL.as_bytes());
    buf.push(b'\n');
    let mut ops = Content::decode(&buf).ok()?.operations;
    match ops.pop() {
        Some(op) if op.operator == END_SENTINEL && op.operands.is_empty() => Some(ops),
        _ => None,
    }
}

/// Parse the key/value tokens between `BI` and `ID` as a dictionary.
fn decode_inline_dict(tokens: &[u8]) -> Option<Dictionary> {
    let mut buf = Vec::with_capacity(tokens.len() + 8);
    buf.extend_from_slice(b"<<");
    buf.extend_from_slice(tokens);
    buf.extend_from_slice(b">> BI");
    let mut ops = decode_complete(&buf)?;
    match ops.pop()?.operands.pop()? {
        Object::Dictionary(d) => Some(d),
        _ => None,
    }
}

fn is_pdf_whitespace(c: u8) -> bool {
    b" \t\n\r\0\x0C".contains(&c)
}

fn is_pdf_delimiter(c: u8) -> bool {
    b"()<>[]{}/%".contains(&c)
}

fn is_pdf_regular(c: u8) -> bool {
    !is_pdf_whitespace(c) && !is_pdf_delimiter(c)
}

/// Tracks `[` and `<<` depth; `enter` fails past `MAX_CONTENT_NESTING`.
#[derive(Default)]
struct Nesting(usize);

impl Nesting {
    fn enter(&mut self) -> Option<()> {
        self.0 += 1;
        (self.0 <= MAX_CONTENT_NESTING).then_some(())
    }

    fn leave(&mut self) {
        self.0 = self.0.saturating_sub(1);
    }
}

/// Remove every `BI ... ID <data> EI` from `content`. Returns the remaining
/// content and, per inline image, the raw dictionary tokens between BI and ID.
/// A minimal lexer skips strings, names and comments so that `(BI)` or `/BI`
/// are not mistaken for operators. None (caller keeps all resources) when an
/// inline image is unterminated, when its end is ambiguous (see
/// `inline_image_extent`), or when `[`/`<<` nest deeper than
/// `MAX_CONTENT_NESTING`.
fn split_inline_images(c: &[u8]) -> Option<(Vec<u8>, Vec<Vec<u8>>)> {
    let mut rest = Vec::with_capacity(c.len());
    let mut dicts = Vec::new();
    let mut copied_upto = 0;
    let mut nesting = Nesting::default();
    let mut i = 0;
    while i < c.len() {
        match c[i] {
            b'[' => {
                nesting.enter()?;
                i += 1;
            }
            b']' => {
                nesting.leave();
                i += 1;
            }
            b'>' if c.get(i + 1) == Some(&b'>') => {
                nesting.leave();
                i += 2;
            }
            b'%' => {
                while i < c.len() && c[i] != b'\n' && c[i] != b'\r' {
                    i += 1;
                }
            }
            b'(' => i = skip_literal_string(c, i),
            b'<' if c.get(i + 1) == Some(&b'<') => {
                nesting.enter()?;
                i += 2;
            }
            b'<' => {
                while i < c.len() && c[i] != b'>' {
                    i += 1;
                }
                i += 1;
            }
            b'/' => {
                i += 1;
                while i < c.len() && is_pdf_regular(c[i]) {
                    i += 1;
                }
            }
            b if is_pdf_regular(b) => {
                let start = i;
                while i < c.len() && is_pdf_regular(c[i]) {
                    i += 1;
                }
                // Type3 glyph operators d0/d1 contain a digit, which lopdf's
                // operator grammar (letters only) splits into `d` + a number
                // operand that then sticks to the next operator (`0 /Im Do`),
                // hiding its resource name. Rename them to a letters-only
                // operator of the same length; the scan ignores it anyway.
                if matches!(&c[start..i], b"d0" | b"d1") {
                    rest.extend_from_slice(&c[copied_upto..start]);
                    rest.extend_from_slice(b"dZ");
                    copied_upto = i;
                } else if &c[start..i] == b"BI" {
                    let (dict, end) = inline_image_extent(c, i)?;
                    rest.extend_from_slice(&c[copied_upto..start]);
                    rest.push(b' ');
                    copied_upto = end;
                    dicts.push(dict.to_vec());
                    i = end;
                }
            }
            _ => i += 1,
        }
    }
    rest.extend_from_slice(&c[copied_upto..]);
    Some((rest, dicts))
}

/// From just after a `BI` token: return the dictionary tokens and the index
/// just past the closing `EI`.
///
/// The data end is the first whitespace + `EI` + whitespace/delimiter/EOF.
/// Binary data can contain that pattern. Usually the bytes left over then fail
/// `decode_complete` (keep-all fallback), but a `%` after the false `EI` would
/// turn the real remainder of the line into a "comment" and hide operators
/// that use resources. So a `%` anywhere on the rest of that line makes the
/// end ambiguous and the whole scan gives up (None).
fn inline_image_extent(c: &[u8], mut i: usize) -> Option<(&[u8], usize)> {
    let dict_start = i;
    let mut nesting = Nesting::default();
    // Find the ID token, skipping strings and names inside the dictionary.
    let dict_end = loop {
        if i >= c.len() {
            return None;
        }
        match c[i] {
            b'[' | b'<' => {
                nesting.enter()?;
                i += 1;
            }
            b']' | b'>' => {
                nesting.leave();
                i += 1;
            }
            b'(' => i = skip_literal_string(c, i),
            b'/' => {
                i += 1;
                while i < c.len() && is_pdf_regular(c[i]) {
                    i += 1;
                }
            }
            b if is_pdf_regular(b) => {
                let start = i;
                while i < c.len() && is_pdf_regular(c[i]) {
                    i += 1;
                }
                if &c[start..i] == b"ID" {
                    break start;
                }
            }
            _ => i += 1,
        }
    };
    // Exactly one whitespace byte separates ID from the binary data.
    let data_start = i + 1;
    let mut j = data_start;
    while j + 2 <= c.len() {
        if c[j..].starts_with(b"EI")
            && j > data_start
            && is_pdf_whitespace(c[j - 1])
            && c.get(j + 2)
                .is_none_or(|&b| is_pdf_whitespace(b) || is_pdf_delimiter(b))
        {
            let end = j + 2;
            let line_end = c[end..]
                .iter()
                .position(|&b| b == b'\n' || b == b'\r')
                .map_or(c.len(), |p| end + p);
            if c[end..line_end].contains(&b'%') {
                return None;
            }
            return Some((&c[dict_start..dict_end], end));
        }
        j += 1;
    }
    None
}

/// Index just past the literal string starting at `c[i] == b'('` (nested
/// parentheses and backslash escapes honored).
fn skip_literal_string(c: &[u8], mut i: usize) -> usize {
    let mut depth = 0usize;
    while i < c.len() {
        match c[i] {
            b'\\' => i += 1,
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return i + 1;
                }
            }
            _ => {}
        }
        i += 1;
    }
    i
}

/// Follow references (bounded) to the underlying object.
pub(crate) fn deref<'a>(doc: &'a Document, mut obj: &'a Object) -> Option<&'a Object> {
    for _ in 0..32 {
        match obj {
            Object::Reference(id) => obj = doc.get_object(*id).ok()?,
            other => return Some(other),
        }
    }
    None
}

pub(crate) fn name_of<'a>(dict: &'a Dictionary, key: &[u8]) -> Option<&'a [u8]> {
    dict.get(key).and_then(Object::as_name).ok()
}

/// True when following into this object would copy document structure rather
/// than page content.
fn is_blocked(obj: &Object) -> bool {
    let dict = match obj {
        Object::Dictionary(d) => d,
        Object::Stream(s) => &s.dict,
        _ => return false,
    };
    let has_any = |keys: &[&[u8]]| keys.iter().any(|k| dict.has(k));
    name_of(dict, b"Type").is_some_and(|t| BLOCKED_TYPES.contains(&t))
        || dict.has(b"FT")
        || name_of(dict, b"Subtype").is_some_and(|s| ANNOT_SUBTYPES.contains(&s))
        || (has_any(&PAGE_MARKERS) && has_any(&PAGE_CONTEXT))
        || name_of(dict, b"S").is_some_and(|s| ACTION_TYPES.contains(&s))
        || (name_of(dict, b"S").is_some() && has_any(&ACTION_PAYLOADS))
        || (matches!(obj, Object::Stream(_)) && is_embedded_file_like(dict))
}

/// Embedded file streams carry `/Params` (size, dates, checksum) and a MIME
/// type as `/Subtype` (e.g. `/application#2Fpdf`). Content streams never
/// have `/Params`, and their subtypes (Image, Form, Type1C, CIDFontType0C,
/// OpenType, ...) never contain a slash, so font programs stay copyable.
fn is_embedded_file_like(dict: &Dictionary) -> bool {
    dict.has(b"Params") || name_of(dict, b"Subtype").is_some_and(|s| s.contains(&b'/'))
}

/// Whether `key` (holding `value`) is left out of a copied dictionary.
fn is_never_copied(dict: &Dictionary, key: &[u8], value: &Object) -> bool {
    if !NEVER_COPIED.contains(&key) {
        return false;
    }
    // On an optional-content membership dictionary /P is the visibility
    // policy (/AllOn, /AnyOff, ...), not a parent link; dropping it would
    // change what is shown.
    let is_policy = key == b"P"
        && (matches!(value, Object::Name(_)) || name_of(dict, b"Type") == Some(b"OCMD"));
    !is_policy
}

/// Content of a stream after its filters, or the raw bytes when lopdf cannot
/// undo them (the scan then most likely fails and keeps all resources).
fn stream_content(stream: &lopdf::Stream) -> Vec<u8> {
    stream
        .decompressed_content()
        .unwrap_or_else(|_| stream.content.clone())
}

/// Streams that carry their own content and `/Resources`: Form XObjects and
/// tiling patterns. Their resources are trimmed against their own content.
fn has_own_content(dict: &Dictionary) -> bool {
    name_of(dict, b"Subtype") == Some(b"Form")
        || dict.get(b"PatternType").and_then(Object::as_i64).ok() == Some(1)
}

/// Deep copier from source documents into one output document.
pub struct SafeCopier<'s> {
    sources: &'s [Document],
    /// (source index, source id) -> output id. Shared objects (a font used by
    /// many pages, a form drawn twice) are copied once, and cycles terminate
    /// because the entry is inserted before recursing.
    memo: HashMap<(usize, ObjectId), ObjectId>,
    depth: usize,
    /// Edges replaced by null because `MAX_REF_DEPTH` was reached. `copy` has
    /// no report to write to, so `copy_page` turns increments into warnings.
    too_deep: u32,
    /// Per source: page id -> 1-based page number, built on the first warning.
    page_numbers: HashMap<usize, HashMap<ObjectId, u32>>,
}

impl<'s> SafeCopier<'s> {
    // Consumed by Task 3 (tool entry points create one copier per output).
    #[allow(dead_code)]
    pub fn new(sources: &'s [Document]) -> Self {
        SafeCopier {
            sources,
            memo: HashMap::new(),
            depth: 0,
            too_deep: 0,
            page_numbers: HashMap::new(),
        }
    }

    /// 1-based number of `page_id` in source `src` (0 if not in its page
    /// tree). The page-tree walk happens once per source, not per warning.
    fn page_number(&mut self, src: usize, page_id: ObjectId) -> u32 {
        let doc = self.source(src);
        let numbers = self
            .page_numbers
            .entry(src)
            .or_insert_with(|| doc.get_pages().into_iter().map(|(n, id)| (id, n)).collect());
        numbers.get(&page_id).copied().unwrap_or(0)
    }

    pub(crate) fn source(&self, src: usize) -> &'s Document {
        &self.sources[src]
    }

    /// Deep-copy `obj` (from source `src`) into `out` under the blocking rules.
    pub fn copy(&mut self, out: &mut Document, src: usize, obj: &Object) -> Object {
        match obj {
            Object::Reference(id) => self.copy_reference(out, src, *id),
            Object::Array(items) => {
                Object::Array(items.iter().map(|o| self.copy(out, src, o)).collect())
            }
            Object::Dictionary(_) | Object::Stream(_) if is_blocked(obj) => Object::Null,
            Object::Dictionary(d) => Object::Dictionary(self.copy_dict(out, src, d)),
            Object::Stream(s) => Object::Stream(self.copy_stream(out, src, s)),
            other => other.clone(),
        }
    }

    fn copy_reference(&mut self, out: &mut Document, src: usize, id: ObjectId) -> Object {
        if let Some(&new_id) = self.memo.get(&(src, id)) {
            return Object::Reference(new_id);
        }
        let Ok(target) = self.source(src).get_object(id) else {
            return Object::Null;
        };
        if is_blocked(target) {
            return Object::Null;
        }
        if self.depth >= MAX_REF_DEPTH {
            self.too_deep += 1;
            return Object::Null;
        }
        let new_id = out.new_object_id();
        self.memo.insert((src, id), new_id);
        self.depth += 1;
        let value = self.copy(out, src, target);
        self.depth -= 1;
        out.objects.insert(new_id, value);
        Object::Reference(new_id)
    }

    fn copy_dict(&mut self, out: &mut Document, src: usize, dict: &Dictionary) -> Dictionary {
        let mut copy = Dictionary::new();
        for (key, value) in dict.iter() {
            if !is_never_copied(dict, key, value) {
                copy.set(key.clone(), self.copy(out, src, value));
            }
        }
        copy
    }

    fn copy_stream(
        &mut self,
        out: &mut Document,
        src: usize,
        stream: &lopdf::Stream,
    ) -> lopdf::Stream {
        let doc = self.source(src);
        let own_resources = has_own_content(&stream.dict)
            .then(|| {
                stream
                    .dict
                    .get(b"Resources")
                    .ok()
                    .and_then(|r| deref(doc, r))
            })
            .flatten()
            .and_then(|r| r.as_dict().ok());

        let mut dict = Dictionary::new();
        for (key, value) in stream.dict.iter() {
            if is_never_copied(&stream.dict, key, value) {
                continue;
            }
            let copied = match own_resources {
                Some(res) if key == b"Resources" => {
                    let used = scan_content(&stream_content(stream));
                    Object::Dictionary(self.copy_resources(out, src, res, used.as_ref()))
                }
                _ => self.copy(out, src, value),
            };
            dict.set(key.clone(), copied);
        }
        // Clone keeps the content bytes and filters untouched (byte-exact).
        let mut copy = stream.clone();
        copy.dict = dict;
        copy
    }

    /// Copy a resources dictionary keeping only `used` names (all names if
    /// `used` is None). Only the known categories and /ProcSet are copied.
    pub fn copy_resources(
        &mut self,
        out: &mut Document,
        src: usize,
        res: &Dictionary,
        used: Option<&UsedNames>,
    ) -> Dictionary {
        let doc = self.source(src);
        // A form without its own /Resources draws from the enclosing ones, so
        // its names count as used here. If one of those cannot be decoded,
        // fall back to keeping everything.
        let expanded = used.and_then(|u| expand_usage(doc, res, u));
        let used = expanded.as_ref();

        let mut copy = Dictionary::new();
        for category in CATEGORIES {
            let Some(entries) = res
                .get(category)
                .ok()
                .and_then(|o| deref(doc, o))
                .and_then(|o| o.as_dict().ok())
            else {
                continue;
            };
            let mut kept = Dictionary::new();
            for (name, value) in entries.iter() {
                if used.is_none_or(|u| u.contains(category, name)) {
                    kept.set(name.clone(), self.copy(out, src, value));
                }
            }
            if !kept.is_empty() {
                copy.set(category, kept);
            }
        }
        if let Ok(proc_set) = res.get(b"ProcSet") {
            copy.set("ProcSet", self.copy(out, src, proc_set));
        }
        copy
    }
}

/// Add to `used`, transitively, the names drawn by streams that have no
/// `/Resources` of their own and so use the enclosing ones: Form XObjects and
/// tiling patterns, Type3 glyph procedures, and soft-mask group forms reached
/// through an ExtGState. None when one of those streams cannot be scanned.
fn expand_usage(doc: &Document, res: &Dictionary, used: &UsedNames) -> Option<UsedNames> {
    let lookup = |category: &[u8], name: &[u8]| {
        let entries = deref(doc, res.get(category).ok()?)?.as_dict().ok()?;
        deref(doc, entries.get(name).ok()?)
    };
    let mut result = UsedNames::default();
    for (&category, names) in &used.by_category {
        for name in names {
            result.insert(category, name);
        }
    }
    let mut visited: HashSet<(&'static [u8], Vec<u8>)> = HashSet::new();
    loop {
        let pending: Vec<(&'static [u8], Vec<u8>)> = [XOBJECT, PATTERN, FONT, EXT_G_STATE]
            .into_iter()
            .flat_map(|cat| {
                result
                    .by_category
                    .get(cat)
                    .into_iter()
                    .flatten()
                    .map(move |n| (cat, n.clone()))
            })
            .filter(|key| !visited.contains(key))
            .collect();
        if pending.is_empty() {
            return Some(result);
        }
        for (category, name) in pending {
            if let Some(entry) = lookup(category, &name) {
                for stream in inheriting_streams(doc, category, entry) {
                    result.merge(scan_content(&stream_content(stream))?);
                }
            }
            visited.insert((category, name));
        }
    }
}

/// The content streams reached from resource `entry` (of `category`) that
/// draw with the enclosing resources because they lack their own.
fn inheriting_streams<'a>(
    doc: &'a Document,
    category: &[u8],
    entry: &'a Object,
) -> Vec<&'a lopdf::Stream> {
    let resource_less_form = |obj: &'a Object| {
        obj.as_stream()
            .ok()
            .filter(|s| has_own_content(&s.dict) && !s.dict.has(b"Resources"))
    };
    match category {
        XOBJECT | PATTERN => resource_less_form(entry).into_iter().collect(),
        FONT => {
            let Ok(font) = entry.as_dict() else {
                return vec![];
            };
            if name_of(font, b"Subtype") != Some(b"Type3") || font.has(b"Resources") {
                return vec![];
            }
            font.get(b"CharProcs")
                .ok()
                .and_then(|p| deref(doc, p))
                .and_then(|p| p.as_dict().ok())
                .into_iter()
                .flat_map(|procs| procs.iter())
                .filter_map(|(_, glyph)| deref(doc, glyph)?.as_stream().ok())
                .collect()
        }
        EXT_G_STATE => entry
            .as_dict()
            .ok()
            .and_then(|gs| deref(doc, gs.get(b"SMask").ok()?))
            .and_then(|mask| mask.as_dict().ok())
            .and_then(|mask| deref(doc, mask.get(b"G").ok()?))
            .and_then(resource_less_form)
            .into_iter()
            .collect(),
        _ => vec![],
    }
}

/// Counters and messages for the "what was removed" summary.
#[derive(Default, Debug, Clone, PartialEq)]
pub struct RebuildReport {
    // Annotation counters are filled by Task 2 and read by Task 3.
    #[allow(dead_code)]
    pub links_kept: u32,
    #[allow(dead_code)]
    pub links_dropped: u32,
    #[allow(dead_code)]
    pub comments_kept: u32,
    #[allow(dead_code)]
    pub comments_dropped: u32,
    #[allow(dead_code)]
    pub fields_flattened: u32,
    pub warnings: Vec<String>,
}

/// Copy page `page_id` of source `src` into `out` WITHOUT annotations (Task 2
/// adds them). Returns the new page id. Rotation is the inherited /Rotate plus
/// `rotate_delta`, normalized. The page has no /Parent: assembly sets it.
// Consumed by Task 2 (annotations) and Task 3 (page tools, split, sanitize).
#[allow(dead_code)]
pub fn copy_page(
    out: &mut Document,
    copier: &mut SafeCopier,
    src: usize,
    page_id: ObjectId,
    rotate_delta: i64,
    report: &mut RebuildReport,
) -> Result<ObjectId, String> {
    let doc = copier.source(src);
    let leaf = doc
        .get_dictionary(page_id)
        .map_err(|e| format!("Page {page_id:?} not found: {e}"))?;
    let mut page = Dictionary::new();
    page.set("Type", "Page");

    let media_box = get_inherited_attr(doc, page_id, b"MediaBox")
        .map(|mb| copier.copy(out, src, &mb))
        .filter(|mb| !matches!(mb, Object::Null))
        .unwrap_or_else(|| vec![0.into(), 0.into(), 612.into(), 792.into()].into());
    page.set("MediaBox", media_box);
    if let Some(crop_box) = get_inherited_attr(doc, page_id, b"CropBox") {
        page.set("CropBox", copier.copy(out, src, &crop_box));
    }
    let rotate = get_inherited_attr(doc, page_id, b"Rotate")
        .and_then(|r| deref(doc, &r).and_then(|r| r.as_i64().ok()))
        .unwrap_or(0);
    let rotate = (rotate + rotate_delta).rem_euclid(360);
    if rotate != 0 {
        page.set("Rotate", rotate);
    }
    // Not inheritable: only the leaf's own values count.
    for key in [
        &b"BleedBox"[..],
        b"TrimBox",
        b"ArtBox",
        b"UserUnit",
        b"Group",
    ] {
        if let Ok(value) = leaf.get(key) {
            page.set(key, copier.copy(out, src, value));
        }
    }

    // Contents are copied stream by stream so their bytes and filters stay
    // exactly as they were. Usage is scanned on the concatenation; a newline
    // between streams keeps tokens at stream boundaries apart (lopdf's
    // get_page_content concatenates without a separator).
    let too_deep_before = copier.too_deep;
    let content_ids = doc.get_page_contents(page_id);
    let mut joined = Vec::new();
    let mut contents = Vec::with_capacity(content_ids.len());
    for id in &content_ids {
        if let Ok(stream) = doc.get_object(*id).and_then(Object::as_stream) {
            joined.extend_from_slice(&stream_content(stream));
            joined.push(b'\n');
        }
        contents.push(copier.copy(out, src, &Object::Reference(*id)));
    }
    match contents.len() {
        0 => {}
        1 => page.set("Contents", contents.pop().unwrap()),
        _ => page.set("Contents", contents),
    }

    let resources = get_inherited_attr(doc, page_id, b"Resources");
    let resources = resources
        .as_ref()
        .and_then(|r| deref(doc, r))
        .and_then(|r| r.as_dict().ok());
    let mut problems = Vec::new();
    if let Some(res) = resources {
        let used = scan_content(&joined);
        if used.is_none() {
            problems.push("content not decodable, kept all resources");
        }
        page.set(
            "Resources",
            copier.copy_resources(out, src, res, used.as_ref()),
        );
    }
    if copier.too_deep > too_deep_before {
        problems.push("object graph too deep, some content dropped");
    }
    if !problems.is_empty() {
        let number = copier.page_number(src, page_id);
        for problem in problems {
            report.warnings.push(format!("Page {number}: {problem}"));
        }
    }

    Ok(out.add_object(page))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pdf_util::make_inherited_test_pdf_sized;
    use lopdf::{Stream, dictionary};

    // ---- fixtures -------------------------------------------------------

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack.windows(needle.len()).any(|w| w == needle)
    }

    fn image(payload: &[u8]) -> Stream {
        Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => 1,
                "Height" => 1,
                "ColorSpace" => "DeviceGray",
                "BitsPerComponent" => 8,
            },
            payload.to_vec(),
        )
    }

    fn form(content: &[u8], resources: Dictionary) -> Stream {
        Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Form",
                "BBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
                "Resources" => resources,
            },
            content.to_vec(),
        )
    }

    /// Source document under construction: a flat /Pages node plus helpers to
    /// add leaves. `finish` saves and reloads so tests run on parsed objects.
    struct Src {
        doc: Document,
        pages_id: ObjectId,
        kids: Vec<ObjectId>,
    }

    impl Src {
        fn new() -> Self {
            let mut doc = Document::with_version("1.7");
            let pages_id = doc.new_object_id();
            Src {
                doc,
                pages_id,
                kids: vec![],
            }
        }

        fn add_page(&mut self, resources: Dictionary, content: &[u8]) -> ObjectId {
            let content_id = self
                .doc
                .add_object(Stream::new(dictionary! {}, content.to_vec()));
            let page = dictionary! {
                "Type" => "Page",
                "Parent" => self.pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
                "Resources" => resources,
                "Contents" => content_id,
            };
            let id = self.doc.add_object(page);
            self.kids.push(id);
            id
        }

        fn finish(mut self) -> Document {
            let kids: Vec<Object> = self.kids.iter().map(|&id| id.into()).collect();
            let count = kids.len() as i64;
            self.doc.objects.insert(
                self.pages_id,
                Object::Dictionary(
                    dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => count },
                ),
            );
            let catalog = self
                .doc
                .add_object(dictionary! { "Type" => "Catalog", "Pages" => self.pages_id });
            self.doc.trailer.set("Root", catalog);
            let mut buf = Vec::new();
            self.doc.save_to(&mut buf).unwrap();
            Document::load_mem(&buf).unwrap()
        }
    }

    /// Wire copied pages into a minimal output document and serialize it.
    fn assemble(mut out: Document, pages: &[ObjectId]) -> Vec<u8> {
        let pages_id = out.new_object_id();
        for &p in pages {
            out.get_object_mut(p)
                .unwrap()
                .as_dict_mut()
                .unwrap()
                .set("Parent", pages_id);
        }
        let kids: Vec<Object> = pages.iter().map(|&id| id.into()).collect();
        out.objects.insert(
            pages_id,
            Object::Dictionary(
                dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => pages.len() as i64 },
            ),
        );
        let catalog = out.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        out.trailer.set("Root", catalog);
        let mut buf = Vec::new();
        out.save_to(&mut buf).unwrap();
        buf
    }

    /// Copy the given source pages (1-based numbers) into a fresh document.
    fn rebuild(src: Document, numbers: &[u32]) -> (Vec<u8>, Document, RebuildReport) {
        let pages = src.get_pages();
        let sources = [src];
        let mut copier = SafeCopier::new(&sources);
        let mut out = Document::with_version("1.7");
        let mut report = RebuildReport::default();
        let mut new_ids = vec![];
        for n in numbers {
            new_ids.push(copy_page(&mut out, &mut copier, 0, pages[n], 0, &mut report).unwrap());
        }
        let bytes = assemble(out.clone(), &new_ids);
        (bytes, out, report)
    }

    fn page_dict(doc: &Document, id: ObjectId) -> &Dictionary {
        doc.get_dictionary(id).unwrap()
    }

    // ---- scanner --------------------------------------------------------

    #[test]
    fn scan_finds_all_categories() {
        let used = scan_content(
            b"q /GS1 gs /CS0 cs /P0 scn /Sh0 sh BT /F1 12 Tf ET /Im1 Do /OC /MC0 BDC EMC Q",
        )
        .expect("decodable");
        assert!(used.contains(b"ExtGState", b"GS1"));
        assert!(used.contains(b"ColorSpace", b"CS0"));
        assert!(used.contains(b"Pattern", b"P0"));
        assert!(used.contains(b"Shading", b"Sh0"));
        assert!(used.contains(b"Font", b"F1"));
        assert!(used.contains(b"XObject", b"Im1"));
        assert!(used.contains(b"Properties", b"MC0"));
        // Names in the wrong position are not mistaken for resources.
        assert!(!used.contains(b"Properties", b"OC"));
    }

    #[test]
    fn scan_inline_image_colorspace() {
        let used = scan_content(b"q BI /W 1 /H 1 /CS /CSI /BPC 8 ID \x00 EI Q /Im1 Do")
            .expect("decodable");
        assert!(used.contains(b"ColorSpace", b"CSI"));
        // Operators after the inline image are still seen.
        assert!(used.contains(b"XObject", b"Im1"));
    }

    #[test]
    fn scan_returns_none_on_garbage() {
        // lopdf stops at the first bad token and returns what it parsed so far;
        // the scanner must treat that as undecodable, not as "uses nothing".
        assert!(scan_content(b"BT ( unterminated").is_none());
        assert!(scan_content(b"/Im1 Do ] /Im2 Do").is_none());
    }

    #[test]
    fn scan_type3_glyph_operators() {
        for op in ["d0", "d1"] {
            let operands = if op == "d0" { "1 0" } else { "1 0 0 0 1 1" };
            let content = format!("{operands} {op} /ImG Do");
            let used = scan_content(content.as_bytes()).expect("decodable");
            assert!(used.contains(b"XObject", b"ImG"), "{op}");
        }
    }

    // ---- page copier ----------------------------------------------------

    #[test]
    fn unused_image_is_not_copied() {
        let mut src = Src::new();
        let im1 = src.doc.add_object(image(b"SECRETUSED"));
        let im2 = src.doc.add_object(image(b"SECRETUNUSED"));
        src.add_page(
            dictionary! { "XObject" => dictionary! { "Im1" => im1, "Im2" => im2 } },
            b"q /Im1 Do Q",
        );
        let (bytes, _, _) = rebuild(src.finish(), &[1]);
        assert!(contains(&bytes, b"SECRETUSED"));
        assert!(!contains(&bytes, b"SECRETUNUSED"));
    }

    #[test]
    fn nested_form_resources_are_trimmed() {
        let mut src = Src::new();
        let im1 = src.doc.add_object(image(b"SECRETINNER"));
        let im2 = src.doc.add_object(image(b"SECRETNESTED"));
        let fm1 = src.doc.add_object(form(
            b"/Im1 Do",
            dictionary! { "XObject" => dictionary! { "Im1" => im1, "Im2" => im2 } },
        ));
        src.add_page(
            dictionary! { "XObject" => dictionary! { "Fm1" => fm1 } },
            b"/Fm1 Do",
        );
        let (bytes, _, _) = rebuild(src.finish(), &[1]);
        assert!(contains(&bytes, b"SECRETINNER"));
        assert!(!contains(&bytes, b"SECRETNESTED"));
    }

    #[test]
    fn stray_reference_to_page_is_blocked() {
        let mut src = Src::new();
        let font = src.doc.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica",
        });
        src.add_page(
            dictionary! { "Font" => dictionary! { "F1" => font } },
            b"BT /F1 12 Tf ET",
        );
        let other = src.add_page(dictionary! {}, b"BT (SECRETPAGE) Tj ET");
        src.doc
            .get_object_mut(font)
            .unwrap()
            .as_dict_mut()
            .unwrap()
            .set("Evil", other);
        let (bytes, _, _) = rebuild(src.finish(), &[1]);
        assert!(contains(&bytes, b"Helvetica"), "the font itself is kept");
        assert!(!contains(&bytes, b"SECRETPAGE"));
    }

    #[test]
    fn shared_form_copied_once() {
        let mut src = Src::new();
        let fm1 = src.doc.add_object(form(b"0 0 m 1 1 l S", dictionary! {}));
        let res = || dictionary! { "XObject" => dictionary! { "Fm1" => fm1 } };
        src.add_page(res(), b"/Fm1 Do");
        src.add_page(res(), b"/Fm1 Do");
        let (_, out, _) = rebuild(src.finish(), &[1, 2]);
        let forms = out
            .objects
            .values()
            .filter(|o| {
                o.as_stream().is_ok_and(|s| {
                    s.dict
                        .get(b"Subtype")
                        .and_then(Object::as_name)
                        .is_ok_and(|n| n == b"Form")
                })
            })
            .count();
        assert_eq!(forms, 1);
    }

    #[test]
    fn undecodable_content_keeps_resources() {
        let mut src = Src::new();
        let im1 = src.doc.add_object(image(b"SECRETKEPT"));
        src.add_page(
            dictionary! { "XObject" => dictionary! { "Im1" => im1 } },
            b"/Im1 Do BT ( unterminated",
        );
        let (bytes, _, report) = rebuild(src.finish(), &[1]);
        assert!(contains(&bytes, b"SECRETKEPT"));
        assert_eq!(report.warnings.len(), 1, "{:?}", report.warnings);
        assert!(
            report.warnings[0].starts_with("Page 1:"),
            "{:?}",
            report.warnings
        );
    }

    #[test]
    fn inherited_attributes_resolved_and_rotation_added() {
        let mut src = Document::load_mem(&make_inherited_test_pdf_sized(1, 595, 842)).unwrap();
        let page_id = src.get_pages()[&1];
        let pages_id = page_dict(&src, page_id)
            .get(b"Parent")
            .unwrap()
            .as_reference()
            .unwrap();
        src.get_object_mut(pages_id)
            .unwrap()
            .as_dict_mut()
            .unwrap()
            .set("Rotate", 90);
        // The fixture's content is empty; draw with the inherited font so the
        // trimmed resources must still carry it.
        let content_id = src.get_page_contents(page_id)[0];
        src.get_object_mut(content_id)
            .unwrap()
            .as_stream_mut()
            .unwrap()
            .set_plain_content(b"BT /F1 12 Tf ET".to_vec());

        let sources = [src];
        let mut copier = SafeCopier::new(&sources);
        let mut out = Document::with_version("1.7");
        let mut report = RebuildReport::default();
        let new_id = copy_page(&mut out, &mut copier, 0, page_id, 90, &mut report).unwrap();

        let page = page_dict(&out, new_id);
        let mb: Vec<i64> = page
            .get(b"MediaBox")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|o| o.as_i64().unwrap())
            .collect();
        assert_eq!(mb, vec![0, 0, 595, 842]);
        assert_eq!(page.get(b"Rotate").unwrap().as_i64().unwrap(), 180);
        let fonts = page
            .get(b"Resources")
            .unwrap()
            .as_dict()
            .unwrap()
            .get(b"Font")
            .unwrap()
            .as_dict()
            .unwrap();
        let f1 = out
            .get_dictionary(fonts.get(b"F1").unwrap().as_reference().unwrap())
            .unwrap();
        assert_eq!(
            f1.get(b"BaseFont").unwrap().as_name().unwrap(),
            b"Helvetica"
        );
        assert!(page.get(b"Parent").is_err(), "assembly sets /Parent");
        assert!(page.get(b"Annots").is_err(), "annotations are Task 2");
    }

    #[test]
    fn never_copied_keys_dropped() {
        let mut src = Src::new();
        let xmp = src.doc.add_object(Stream::new(
            dictionary! { "Type" => "Metadata", "Subtype" => "XML" },
            b"<x:xmpmeta>SECRETXMP</x:xmpmeta>".to_vec(),
        ));
        let mut img = image(b"PIXELS");
        img.dict.set("Metadata", xmp);
        let im1 = src.doc.add_object(img);
        let mut fm = form(b"0 0 m S", dictionary! {});
        fm.dict.set(
            "PieceInfo",
            dictionary! { "App" => dictionary! { "Private" => Object::string_literal("SECRETPIECE") } },
        );
        let fm1 = src.doc.add_object(fm);
        src.add_page(
            dictionary! { "XObject" => dictionary! { "Im1" => im1, "Fm1" => fm1 } },
            b"/Im1 Do /Fm1 Do",
        );
        let (bytes, _, _) = rebuild(src.finish(), &[1]);
        assert!(contains(&bytes, b"PIXELS"));
        assert!(!contains(&bytes, b"SECRETXMP"));
        assert!(!contains(&bytes, b"SECRETPIECE"));
    }

    // ---- fix round 1 ----------------------------------------------------

    /// Form XObject with no /Resources of its own (draws from the caller's).
    fn bare_form(content: &[u8]) -> Stream {
        let mut f = form(content, dictionary! {});
        f.dict.remove(b"Resources");
        f
    }

    /// One page drawing `/F1` from a font whose stray `/Evil` key points at `evil`.
    fn page_with_evil_font(src: &mut Src, evil: Object) {
        let font = src.doc.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica", "Evil" => evil,
        });
        src.add_page(
            dictionary! { "Font" => dictionary! { "F1" => font } },
            b"BT /F1 12 Tf ET",
        );
    }

    #[test]
    fn untyped_page_dict_is_blocked() {
        let mut src = Src::new();
        let content = src.doc.add_object(Stream::new(
            dictionary! {},
            b"(SECRET_UNTYPEDPAGE) Tj".to_vec(),
        ));
        let untyped = src.doc.add_object(dictionary! {
            "MediaBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
            "Contents" => content,
        });
        page_with_evil_font(&mut src, untyped.into());
        let (bytes, _, _) = rebuild(src.finish(), &[1]);
        assert!(contains(&bytes, b"Helvetica"));
        assert!(!contains(&bytes, b"SECRET_UNTYPEDPAGE"));
    }

    #[test]
    fn untyped_action_dicts_are_blocked() {
        let mut src = Src::new();
        let js = src.doc.add_object(dictionary! {
            "S" => "JavaScript", "JS" => Object::string_literal("SECRET_JS"),
        });
        let uri = src.doc.add_object(dictionary! {
            "S" => "URI", "URI" => Object::string_literal("SECRET_URI"),
        });
        let gs = src
            .doc
            .add_object(dictionary! { "CA" => 0.5, "Foo" => js, "Bar" => uri });
        src.add_page(
            dictionary! { "ExtGState" => dictionary! { "GS1" => gs } },
            b"/GS1 gs",
        );
        let (bytes, _, _) = rebuild(src.finish(), &[1]);
        assert!(contains(&bytes, b"/CA"), "the ExtGState itself is kept");
        assert!(!contains(&bytes, b"SECRET_JS"));
        assert!(!contains(&bytes, b"SECRET_URI"));
    }

    #[test]
    fn action_dicts_blocked_by_s_type_name() {
        let mut src = Src::new();
        let sound = src.doc.add_object(Stream::new(
            dictionary! { "R" => 8000 },
            b"SECRET_SOUND".to_vec(),
        ));
        let action = src
            .doc
            .add_object(dictionary! { "S" => "Sound", "Sound" => sound });
        let named = src.doc.add_object(
            dictionary! { "S" => "Named", "Foo" => Object::string_literal("SECRET_NAMED") },
        );
        let gs = src.doc.add_object(dictionary! {
            "CA" => 0.5, "Foo" => action, "Bar" => named,
            "SMask" => dictionary! { "S" => "Alpha", "BC" => vec![0.into()] },
        });
        let page = src.add_page(
            dictionary! { "ExtGState" => dictionary! { "GS1" => gs } },
            b"/GS1 gs",
        );
        src.doc
            .get_object_mut(page)
            .unwrap()
            .as_dict_mut()
            .unwrap()
            .set(
                "Group",
                dictionary! { "S" => "Transparency", "CS" => "DeviceRGB" },
            );
        let (bytes, _, _) = rebuild(src.finish(), &[1]);
        assert!(!contains(&bytes, b"SECRET_SOUND"));
        assert!(!contains(&bytes, b"SECRET_NAMED"));
        assert!(
            contains(&bytes, b"/Transparency"),
            "transparency group kept"
        );
        assert!(contains(&bytes, b"/Alpha"), "soft mask kept");
    }

    #[test]
    fn embedded_file_like_stream_is_blocked_font_file_kept() {
        let mut src = Src::new();
        let embedded = src.doc.add_object(Stream::new(
            dictionary! { "Params" => dictionary! { "Size" => 13 } },
            b"SECRET_EMBED".to_vec(),
        ));
        let font_file = src.doc.add_object(Stream::new(
            dictionary! { "Subtype" => "Type1C" },
            b"CFFDATA".to_vec(),
        ));
        let descriptor = src
            .doc
            .add_object(dictionary! { "Type" => "FontDescriptor", "FontFile3" => font_file });
        page_with_evil_font(&mut src, embedded.into());
        let font = src
            .doc
            .objects
            .iter()
            .find(|(_, o)| o.as_dict().is_ok_and(|d| d.get(b"BaseFont").is_ok()))
            .map(|(id, _)| *id)
            .unwrap();
        src.doc
            .get_object_mut(font)
            .unwrap()
            .as_dict_mut()
            .unwrap()
            .set("FontDescriptor", descriptor);
        let (bytes, _, _) = rebuild(src.finish(), &[1]);
        assert!(
            contains(&bytes, b"CFFDATA"),
            "font programs are page content"
        );
        assert!(!contains(&bytes, b"SECRET_EMBED"));
    }

    #[test]
    fn inline_image_comment_after_ei_falls_back() {
        // 4 data bytes are " EI%": the first EI is inside the data, the real
        // one follows. Trusting the first would hide /Im2 behind a comment.
        let used = scan_content(b"q BI /W 4 /H 1 /CS /DeviceGray /BPC 8 ID  EI% EI /Im2 Do Q");
        assert!(used.is_none_or(|u| u.contains(b"XObject", b"Im2")));
    }

    #[test]
    fn deep_nesting_is_rejected_without_decoding() {
        let mut content = Vec::new();
        content.extend(std::iter::repeat_n(b'[', 600));
        content.extend(std::iter::repeat_n(b']', 600));
        content.extend_from_slice(b" TJ");
        assert!(scan_content(&content).is_none());
        let mut dicts = Vec::new();
        for _ in 0..600 {
            dicts.extend_from_slice(b"<< /A ");
        }
        dicts.extend(std::iter::repeat_n(b'>', 1200));
        dicts.extend_from_slice(b" /Tag BDC EMC");
        assert!(scan_content(&dicts).is_none());
    }

    #[test]
    fn type3_glyph_resources_are_kept() {
        let mut src = Src::new();
        let img = src.doc.add_object(image(b"SECRET_GLYPHIMG"));
        let glyph = src
            .doc
            .add_object(Stream::new(dictionary! {}, b"0 0 d0 /ImG Do".to_vec()));
        let t3 = src.doc.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type3",
            "FontBBox" => vec![0.into(), 0.into(), 1.into(), 1.into()],
            "FontMatrix" => vec![1.into(), 0.into(), 0.into(), 1.into(), 0.into(), 0.into()],
            "CharProcs" => dictionary! { "g0" => glyph },
            "Encoding" => dictionary! { "Differences" => vec![97.into(), Object::Name(b"g0".to_vec())] },
            "FirstChar" => 97, "LastChar" => 97, "Widths" => vec![1.into()],
        });
        src.add_page(
            dictionary! { "Font" => dictionary! { "T3" => t3 }, "XObject" => dictionary! { "ImG" => img } },
            b"BT /T3 12 Tf (a) Tj ET",
        );
        let (bytes, _, _) = rebuild(src.finish(), &[1]);
        assert!(contains(&bytes, b"SECRET_GLYPHIMG"));
    }

    #[test]
    fn smask_group_resources_are_kept() {
        let mut src = Src::new();
        let img = src.doc.add_object(image(b"SECRET_MASKIMG"));
        let group = src.doc.add_object(bare_form(b"/ImM Do"));
        let gs = src.doc.add_object(dictionary! {
            "SMask" => dictionary! { "S" => "Luminosity", "G" => group },
        });
        src.add_page(
            dictionary! { "ExtGState" => dictionary! { "GS1" => gs }, "XObject" => dictionary! { "ImM" => img } },
            b"/GS1 gs 0 0 m S",
        );
        let (bytes, _, _) = rebuild(src.finish(), &[1]);
        assert!(contains(&bytes, b"SECRET_MASKIMG"));
    }

    #[test]
    fn ocmd_visibility_policy_is_kept() {
        let mut src = Src::new();
        let ocg = src
            .doc
            .add_object(dictionary! { "Type" => "OCG", "Name" => Object::string_literal("Layer") });
        let ocmd = src
            .doc
            .add_object(dictionary! { "Type" => "OCMD", "OCGs" => ocg, "P" => "AllOff" });
        src.add_page(
            dictionary! { "Properties" => dictionary! { "MC0" => ocmd } },
            b"/OC /MC0 BDC EMC",
        );
        let (_, out, _) = rebuild(src.finish(), &[1]);
        let copied = out.objects.values().find_map(|o| {
            o.as_dict().ok().filter(|d| {
                d.get(b"Type")
                    .and_then(Object::as_name)
                    .is_ok_and(|t| t == b"OCMD")
            })
        });
        let p = copied.expect("OCMD copied").get(b"P").expect("/P kept");
        assert_eq!(p.as_name().unwrap(), b"AllOff");
    }

    #[test]
    fn too_deep_object_graph_is_reported() {
        let mut src = Src::new();
        let mut inner = src.doc.add_object(bare_form(b"0 0 m S"));
        for _ in 0..300 {
            inner = src.doc.add_object(form(
                b"/F Do",
                dictionary! { "XObject" => dictionary! { "F" => inner } },
            ));
        }
        src.add_page(
            dictionary! { "XObject" => dictionary! { "F" => inner } },
            b"/F Do",
        );
        let (_, _, report) = rebuild(src.finish(), &[1]);
        assert!(
            report
                .warnings
                .iter()
                .any(|w| w.starts_with("Page 1:") && w.contains("too deep")),
            "{:?}",
            report.warnings
        );
    }

    #[test]
    fn resource_less_form_keeps_parent_resource() {
        let mut src = Src::new();
        let img = src.doc.add_object(image(b"SECRET_PARENTIMG"));
        let unused = src.doc.add_object(image(b"SECRET_UNUSEDIMG"));
        let fm = src.doc.add_object(bare_form(b"/ImP Do"));
        src.add_page(
            dictionary! { "XObject" => dictionary! { "Fm1" => fm, "ImP" => img, "ImX" => unused } },
            b"/Fm1 Do",
        );
        let (bytes, _, _) = rebuild(src.finish(), &[1]);
        assert!(contains(&bytes, b"SECRET_PARENTIMG"));
        assert!(!contains(&bytes, b"SECRET_UNUSEDIMG"));
    }
}
