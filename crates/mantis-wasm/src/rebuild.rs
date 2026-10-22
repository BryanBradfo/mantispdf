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
//! `rebuild_document` assembles a fresh document from these pieces and the
//! annotation rebuild in `annotations.rs`.

use crate::annotations::{PendingLinks, PendingReplies, finish_links, rebuild_annotations};
use crate::pdf_util::get_inherited_attr;
use crate::stamp::image::strip_jpeg_metadata;
use lopdf::content::{Content, Operation};
use lopdf::{Dictionary, Document, Object, ObjectId, dictionary};
use std::collections::{HashMap, HashSet};

/// Which annotation kinds survive a rebuild.
pub struct Policy {
    pub keep_links: bool,
    pub keep_comments: bool,
    /// Remove Exif, XMP, MPF and other metadata (and trailing data) from
    /// images whose only filter is `/DCTDecode` (see `SafeCopier::copy_stream`).
    pub strip_image_metadata: bool,
}

/// Organize/Remove/Extract/Split keep links and comments; only what belongs to
/// dropped pages disappears. Images are copied byte-exact.
pub const PAGE_TOOLS: Policy = Policy {
    keep_links: true,
    keep_comments: true,
    strip_image_metadata: false,
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

/// Keys whose dictionary value maps arbitrary names (glyph names, colorant
/// names) to values. Its keys are data, not PDF structure, so `NEVER_COPIED`
/// must not filter them: a glyph named /A or /P is still a glyph. /Solidities
/// and /DotGain are the colorant maps of a DeviceN /MixingHints.
const NAME_MAP_KEYS: [&[u8]; 4] = [b"CharProcs", b"Colorants", b"Solidities", b"DotGain"];

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

/// Border style names. A border-style dictionary (`<< /W 1 /S /D /D [3 2] >>`)
/// has a Name `/S` and a `/D` payload key too, but it is not an action.
const BORDER_STYLES: [&[u8]; 5] = [b"S", b"D", b"B", b"I", b"U"];

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
#[derive(Default, Debug, Clone)]
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

    pub(crate) fn merge(&mut self, other: UsedNames) {
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

/// Number of `q` still open at the end of `content`. None when the content
/// cannot be decoded completely.
pub(crate) fn unbalanced_saves(content: &[u8]) -> Option<usize> {
    save_balance(content).map(|(open, _)| open)
}

/// `(open, excess)`: the `q` still open at the end of `content` (a `Q`
/// with nothing to restore counts as nothing), and the most `Q` it runs
/// below its starting depth. None when it cannot be decoded completely.
pub(crate) fn save_balance(content: &[u8]) -> Option<(usize, usize)> {
    let (rest, _) = split_inline_images(content)?;
    let mut depth = 0i64;
    let mut lowest = 0i64;
    for op in decode_complete(&rest)? {
        match op.operator.as_str() {
            "q" => depth += 1,
            "Q" => {
                depth -= 1;
                lowest = lowest.min(depth);
            }
            _ => {}
        }
    }
    // A saturating counter ends at depth - lowest.
    Some(((depth - lowest) as usize, (-lowest) as usize))
}

/// Operator appended after the real content to detect partial parses.
const END_SENTINEL: &str = "MantisScanEnd";

/// Decode content and insist that ALL of it parsed. lopdf's content parser
/// silently stops at the first bad token and returns the operations before
/// it, which would make later resource uses invisible. A sentinel operator at
/// the very end only comes back (with no stray operands) when every byte
/// before it was consumed.
pub(crate) fn decode_complete(bytes: &[u8]) -> Option<Vec<Operation>> {
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
pub(crate) fn decode_inline_dict(tokens: &[u8]) -> Option<Dictionary> {
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

pub(crate) fn is_pdf_regular(c: u8) -> bool {
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

/// Number of inline images (`BI ... ID <data> EI`) in `content`, None when
/// the content cannot be split reliably (see `split_inline_images`).
pub(crate) fn count_inline_images(content: &[u8]) -> Option<usize> {
    split_inline_images(content).map(|(_, dicts)| dicts.len())
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
pub(crate) fn inline_image_extent(c: &[u8], mut i: usize) -> Option<(&[u8], usize)> {
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
pub(crate) fn skip_literal_string(c: &[u8], mut i: usize) -> usize {
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
        // A file specification (typed or not) carrying embedded files.
        || dict.has(b"EF")
        || name_of(dict, b"Subtype").is_some_and(|s| ANNOT_SUBTYPES.contains(&s))
        || (has_any(&PAGE_MARKERS) && has_any(&PAGE_CONTEXT))
        || name_of(dict, b"S").is_some_and(|s| ACTION_TYPES.contains(&s))
        || (name_of(dict, b"S").is_some_and(|s| !BORDER_STYLES.contains(&s))
            && !dict.has(b"W")
            && name_of(dict, b"Type") != Some(b"Border")
            && has_any(&ACTION_PAYLOADS))
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

/// Decoded bytes one stream may expand to for a content scan; a larger one
/// counts as undecodable (its resources are all kept).
pub(crate) const MAX_STREAM_DECODED: usize = 64 << 20;
/// Decoded bytes all content scans of one rebuild may produce together.
const MAX_TOTAL_DECODED: usize = 512 << 20;

/// Outcome of one decoding step of `bounded_content`.
enum Step {
    Done(Vec<u8>),
    /// The output would exceed the cap.
    TooLarge,
    /// lopdf cannot undo the filter: the raw bytes are scanned instead.
    Failed,
}

/// `io::Write` sink that refuses to hold more than `cap` bytes, growing its
/// buffer geometrically but never past the cap.
struct Capped {
    buf: Vec<u8>,
    cap: usize,
    over: bool,
}

impl std::io::Write for Capped {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        let len = self.buf.len() + data.len();
        if len > self.cap {
            self.over = true;
            return Err(std::io::Error::other("decoded content over the cap"));
        }
        if len > self.buf.capacity() {
            let target = (self.buf.capacity() * 2)
                .max(len)
                .max(64 << 10)
                .min(self.cap);
            self.buf.reserve_exact(target - self.buf.len());
        }
        self.buf.extend_from_slice(data);
        Ok(data.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// One filter run by lopdf on its own, once its output is known to fit.
fn lopdf_step(filter: &[u8], input: &[u8], params: Option<&Dictionary>) -> Step {
    let mut dict = dictionary! { "Filter" => Object::Name(filter.to_vec()) };
    if let Some(params) = params {
        dict.set("DecodeParms", params.clone());
    }
    match lopdf::Stream::new(dict, input.to_vec()).decompressed_content() {
        Ok(out) => Step::Done(out),
        Err(_) => Step::Failed,
    }
}

/// Row size of the PNG predictor lopdf applies after Flate/LZW with these
/// parameters (saturating), None when there is no such predictor.
fn predictor_row(params: Option<&Dictionary>) -> Option<usize> {
    let params = params?;
    let int =
        |key: &[u8], default: i64| params.get(key).and_then(Object::as_i64).unwrap_or(default);
    if !(10..=15).contains(&int(b"Predictor", 1)) {
        return None;
    }
    let columns = int(b"Columns", 1).max(1) as usize;
    let colors = int(b"Colors", 1).max(1) as usize;
    let bits = int(b"BitsPerComponent", 8).max(8) as usize;
    Some(colors.saturating_mul(bits) / 8 * columns)
}

/// FlateDecode or LZWDecode as lopdf does it (partial output on a corrupt
/// stream, then the PNG predictor), stopping at `cap` bytes.
/// `corrupt` is set when the decoder fails before producing any byte.
fn inflate_step(
    filter: &[u8],
    input: &[u8],
    params: Option<&Dictionary>,
    cap: usize,
    corrupt: &mut bool,
) -> Step {
    let mut sink = Capped {
        buf: Vec::new(),
        cap,
        over: false,
    };
    let failed = if filter == b"FlateDecode" {
        !input.is_empty()
            && std::io::copy(&mut flate2::read::ZlibDecoder::new(input), &mut sink).is_err()
    } else {
        use weezl::{BitOrder, decode::Decoder};
        let early_change = params
            .and_then(|p| p.get(b"EarlyChange").ok())
            .and_then(|v| v.as_i64().ok())
            .is_none_or(|v| v != 0);
        let mut decoder = if early_change {
            Decoder::with_tiff_size_switch(BitOrder::Msb, 8)
        } else {
            Decoder::new(BitOrder::Msb, 8)
        };
        decoder.into_stream(&mut sink).decode_all(input).status.is_err()
    };
    if sink.over {
        return Step::TooLarge;
    }
    *corrupt = failed && sink.buf.is_empty();
    match predictor_row(params) {
        None => Step::Done(sink.buf),
        // The predictor never grows the data, but allocates two rows first.
        Some(row) if row <= cap => {
            drop(sink);
            lopdf_step(filter, input, params)
        }
        Some(_) => Step::TooLarge,
    }
}

/// ASCII85Decode as lopdf does it, refused up front when its output could
/// exceed `cap` (4 bytes per `z`, 4 per group of 5 digits).
fn ascii85_step(input: &[u8], cap: usize) -> Step {
    let (mut zs, mut digits) = (0usize, 0usize);
    for &c in input {
        match c {
            b'z' => zs += 1,
            b'!'..=b'u' => digits += 1,
            c if c.is_ascii_whitespace() => {}
            _ => break,
        }
    }
    if zs.saturating_mul(4).saturating_add(digits.div_ceil(5) * 4) > cap {
        return Step::TooLarge;
    }
    lopdf_step(b"ASCII85Decode", input, None)
}

/// Outcome of `strict_content`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Decoded {
    Content(Vec<u8>),
    /// More than the cap.
    TooLarge,
    /// A filter that cannot be undone, or a decoder failing before it
    /// produced anything (an empty but valid stream is `Content`).
    Failed,
}

/// Content of a stream after its filters as lopdf decodes it, or the raw
/// bytes when lopdf cannot undo them (the scan then most likely fails and
/// keeps all resources). None when that takes more than `cap` bytes: each
/// step is bounded before it allocates. `charged` grows by the bytes decoded.
pub(crate) fn bounded_content(stream: &lopdf::Stream, cap: usize, charged: &mut usize) -> Option<Vec<u8>> {
    match decode_filters(None, stream, cap, charged, false) {
        Decoded::Content(out) => Some(out),
        Decoded::TooLarge => None,
        Decoded::Failed => {
            let len = stream.content.len();
            *charged += len.min(cap);
            (len <= cap).then(|| stream.content.clone())
        }
    }
}

/// Like `bounded_content`, but undecodable content is `Failed` instead of
/// coming back raw (for callers that draw the content, not scan it).
pub(crate) fn strict_content(stream: &lopdf::Stream, cap: usize, charged: &mut usize) -> Decoded {
    decode_filters(None, stream, cap, charged, true)
}

/// `strict_content` resolving references in /DecodeParms through `doc`.
pub(crate) fn strict_content_in(doc: Option<&Document>, stream: &lopdf::Stream, cap: usize, charged: &mut usize) -> Decoded {
    decode_filters(doc, stream, cap, charged, true)
}

/// The /DecodeParms of each of `count` filters: a dictionary applies to
/// every filter (as lopdf does), an array gives filter i its i-th entry
/// (null or missing: none). References are followed through `doc`; without
/// one they count as no parameters.
pub(crate) fn filter_params<'a>(doc: Option<&'a Document>, stream: &'a lopdf::Stream, count: usize) -> Vec<Option<&'a Dictionary>> {
    let resolve = |obj: &'a Object| -> Option<&'a Object> {
        match (obj, doc) {
            (Object::Reference(_), Some(doc)) => deref(doc, obj),
            (Object::Reference(_), None) => None,
            _ => Some(obj),
        }
    };
    match stream.dict.get(b"DecodeParms").ok().and_then(resolve) {
        Some(Object::Dictionary(params)) => vec![Some(params); count],
        Some(Object::Array(items)) => (0..count)
            .map(|i| items.get(i).and_then(resolve).and_then(|o| o.as_dict().ok()))
            .collect(),
        _ => vec![None; count],
    }
}

/// The filter pipeline of `bounded_content` and `strict_content`. A stream
/// without /Filter is its own content; `strict` turns a decoder failure
/// that produced nothing into `Failed`.
fn decode_filters(
    doc: Option<&Document>,
    stream: &lopdf::Stream,
    cap: usize,
    charged: &mut usize,
    strict: bool,
) -> Decoded {
    if stream.dict.get(b"Filter").is_err() {
        let len = stream.content.len();
        *charged += len.min(cap);
        return if len <= cap { Decoded::Content(stream.content.clone()) } else { Decoded::TooLarge };
    }
    let Ok(filters) = stream.filters() else {
        return Decoded::Failed;
    };
    let params = filter_params(doc, stream, filters.len());
    let mut data = std::borrow::Cow::Borrowed(stream.content.as_slice());
    for (filter, params) in filters.into_iter().zip(params) {
        let mut corrupt = false;
        let step = match filter {
            b"FlateDecode" | b"LZWDecode" => inflate_step(filter, &data, params, cap, &mut corrupt),
            b"ASCII85Decode" => ascii85_step(&data, cap),
            _ => Step::Failed,
        };
        match step {
            Step::Done(_) if strict && corrupt => return Decoded::Failed,
            Step::Done(out) => {
                *charged += out.len();
                data = std::borrow::Cow::Owned(out);
            }
            Step::TooLarge => {
                *charged += cap;
                return Decoded::TooLarge;
            }
            Step::Failed => return Decoded::Failed,
        }
    }
    Decoded::Content(data.into_owned())
}

/// Streams that carry their own content and `/Resources`: Form XObjects and
/// tiling patterns. Their resources are trimmed against their own content.
fn has_own_content(dict: &Dictionary) -> bool {
    name_of(dict, b"Subtype") == Some(b"Form")
        || dict.get(b"PatternType").and_then(Object::as_i64).ok() == Some(1)
}

/// An image XObject whose only filter is `/DCTDecode` (a name or a
/// one-element array, both direct): its content is a plain JPEG file. DCT
/// behind other filters, and an indirect `/Filter`, are left byte-exact.
fn is_dct_only_image(dict: &Dictionary) -> bool {
    if name_of(dict, b"Subtype") != Some(b"Image") {
        return false;
    }
    match dict.get(b"Filter") {
        Ok(Object::Name(n)) => n == b"DCTDecode",
        Ok(Object::Array(a)) => matches!(a.as_slice(), [Object::Name(n)] if n == b"DCTDecode"),
        _ => false,
    }
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
    /// Like `memo`, for objects copied trimmed to a set of resource names:
    /// one output object per source object, role (a `/Resources`, None, or
    /// the category dictionary it is used as) and trimming.
    trimmed: HashMap<TrimmedKey, ObjectId>,
    /// Scan result per (source, stream object id): a stream drawn from many
    /// places (one glyph procedure shared by thousands of Type3 fonts) is
    /// decoded and scanned once.
    scans: HashMap<(usize, ObjectId), Option<UsedNames>>,
    /// Decoded bytes content scans may still produce in this rebuild.
    decode_budget: usize,
    /// `Policy::strip_image_metadata`.
    strip_image_metadata: bool,
    /// DCT images whose metadata was removed. A shared image is copied, and
    /// so stripped and counted, once (`memo`).
    images_cleaned: u32,
}

/// The resource names a trimmed copy keeps, per category, in a canonical
/// order (None: every name).
type Trim = Option<Vec<(&'static [u8], Vec<Vec<u8>>)>>;

fn trim_of(used: Option<&UsedNames>) -> Trim {
    let used = used?;
    let mut trim: Vec<_> = used
        .by_category
        .iter()
        .map(|(&category, names)| {
            let mut names: Vec<Vec<u8>> = names.iter().cloned().collect();
            names.sort();
            (category, names)
        })
        .collect();
    trim.sort();
    Some(trim)
}

type TrimmedKey = (usize, ObjectId, Option<&'static [u8]>, Trim);

/// The object a reference chain starting at `id` ends on (lopdf's
/// `get_object` follows chains, so aliases of one object share its id here).
fn terminal(doc: &Document, id: ObjectId) -> ObjectId {
    doc.dereference(&Object::Reference(id))
        .ok()
        .and_then(|(last, _)| last)
        .unwrap_or(id)
}

/// Which memo an object copied through `SafeCopier::copy_once` is kept in.
enum MemoKey {
    Plain(usize, ObjectId),
    Trimmed(TrimmedKey),
}

impl<'s> SafeCopier<'s> {
    pub fn new(sources: &'s [Document], strip_image_metadata: bool) -> Self {
        SafeCopier {
            strip_image_metadata,
            images_cleaned: 0,
            sources,
            memo: HashMap::new(),
            depth: 0,
            too_deep: 0,
            page_numbers: HashMap::new(),
            trimmed: HashMap::new(),
            scans: HashMap::new(),
            decode_budget: MAX_TOTAL_DECODED,
        }
    }

    /// Decoded content of `stream` for a scan, within `MAX_STREAM_DECODED`
    /// and what is left of the rebuild's budget. None: over either limit.
    fn decode_for_scan(&mut self, stream: &lopdf::Stream) -> Option<Vec<u8>> {
        let cap = MAX_STREAM_DECODED.min(self.decode_budget);
        let mut charged = 0;
        let content = bounded_content(stream, cap, &mut charged);
        self.decode_budget = self.decode_budget.saturating_sub(charged);
        content
    }

    /// `scan_content` of `stream`, memoized on its object when it is
    /// indirect (`id`, in source `src`). None: undecodable or over a limit.
    fn scan_stream(
        &mut self,
        src: usize,
        id: Option<ObjectId>,
        stream: &lopdf::Stream,
    ) -> Option<UsedNames> {
        let key = id.map(|id| (src, terminal(self.source(src), id)));
        if let Some(known) = key.and_then(|key| self.scans.get(&key)) {
            return known.clone();
        }
        let used = self
            .decode_for_scan(stream)
            .and_then(|content| scan_content(&content));
        if let Some(key) = key {
            self.scans.insert(key, used.clone());
        }
        used
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

    /// The guard on every edge that follows a reference: a source object is
    /// copied once per `key` (later edges, and cycles back into it, get the
    /// output id registered before recursing), and at most `MAX_REF_DEPTH`
    /// references deep. `build` makes the copied value.
    fn copy_once(
        &mut self,
        out: &mut Document,
        key: MemoKey,
        build: impl FnOnce(&mut Self, &mut Document) -> Object,
    ) -> Object {
        // Memoize on the object a chain of aliases ends on.
        let key = match key {
            MemoKey::Plain(src, id) => MemoKey::Plain(src, terminal(self.source(src), id)),
            MemoKey::Trimmed((src, id, role, trim)) => {
                MemoKey::Trimmed((src, terminal(self.source(src), id), role, trim))
            }
        };
        let known = match &key {
            MemoKey::Plain(src, id) => self.memo.get(&(*src, *id)),
            MemoKey::Trimmed(key) => self.trimmed.get(key),
        };
        if let Some(&new_id) = known {
            return Object::Reference(new_id);
        }
        if self.depth >= MAX_REF_DEPTH {
            self.too_deep += 1;
            return Object::Null;
        }
        let new_id = out.new_object_id();
        match key {
            MemoKey::Plain(src, id) => self.memo.insert((src, id), new_id),
            MemoKey::Trimmed(key) => self.trimmed.insert(key, new_id),
        };
        self.depth += 1;
        let value = build(self, out);
        self.depth -= 1;
        out.objects.insert(new_id, value);
        Object::Reference(new_id)
    }

    /// Output id of source object `id` (or of the object its alias chain
    /// ends on), when it was copied.
    pub(crate) fn copied(&self, src: usize, id: ObjectId) -> Option<ObjectId> {
        self.memo
            .get(&(src, terminal(self.source(src), id)))
            .copied()
    }

    fn copy_reference(&mut self, out: &mut Document, src: usize, id: ObjectId) -> Object {
        if let Some(new_id) = self.copied(src, id) {
            return Object::Reference(new_id);
        }
        let Ok(target) = self.source(src).get_object(id) else {
            return Object::Null;
        };
        if is_blocked(target) {
            return Object::Null;
        }
        self.copy_once(out, MemoKey::Plain(src, id), |this, out| {
            this.copy(out, src, target)
        })
    }

    fn copy_dict(&mut self, out: &mut Document, src: usize, dict: &Dictionary) -> Dictionary {
        let mut copy = Dictionary::new();
        for (key, value) in dict.iter() {
            if is_never_copied(dict, key, value) {
                continue;
            }
            let copied = if NAME_MAP_KEYS.contains(&key.as_slice()) {
                self.copy_name_map(out, src, value)
            } else if key == b"Resources" {
                let used = if name_of(dict, b"Subtype") == Some(b"Type3") {
                    type3_usage(self, src, dict)
                } else {
                    None
                };
                self.copy_any_resources(out, src, value, used.as_ref())
            } else {
                self.copy(out, src, value)
            };
            copy.set(key.clone(), copied);
        }
        copy
    }

    /// Copy a name-keyed map (see `NAME_MAP_KEYS`): every key is kept, every
    /// value goes through the blocking rules. A reference to it is memoized
    /// like any other object.
    fn copy_name_map(&mut self, out: &mut Document, src: usize, value: &Object) -> Object {
        let copy_entries = |this: &mut Self, out: &mut Document, map: &Dictionary| {
            let mut copy = Dictionary::new();
            for (name, entry) in map.iter() {
                copy.set(name.clone(), this.copy(out, src, entry));
            }
            Object::Dictionary(copy)
        };
        match value {
            Object::Dictionary(map) if !is_blocked(value) => copy_entries(self, out, map),
            Object::Reference(id) => {
                if let Some(new_id) = self.copied(src, *id) {
                    return Object::Reference(new_id);
                }
                let Ok(target @ Object::Dictionary(map)) = self.source(src).get_object(*id) else {
                    return self.copy(out, src, value);
                };
                if is_blocked(target) {
                    return Object::Null;
                }
                self.copy_once(out, MemoKey::Plain(src, *id), |this, out| {
                    copy_entries(this, out, map)
                })
            }
            _ => self.copy(out, src, value),
        }
    }

    /// A `/Resources` value met outside a page or form: its category
    /// dictionaries are name-keyed, so it is copied with `copy_resources`
    /// (trimmed to `used`, or every name when None) rather than as a
    /// structural dictionary. A referenced one is copied once per trimming.
    fn copy_any_resources(
        &mut self,
        out: &mut Document,
        src: usize,
        value: &Object,
        used: Option<&UsedNames>,
    ) -> Object {
        let doc = self.source(src);
        let Some(res @ Object::Dictionary(dict)) = deref(doc, value) else {
            return self.copy(out, src, value);
        };
        if is_blocked(res) {
            return Object::Null;
        }
        if let Ok(id) = value.as_reference() {
            let key = MemoKey::Trimmed((src, id, None, trim_of(used)));
            return self.copy_once(out, key, |this, out| {
                Object::Dictionary(this.copy_resources(out, src, dict, used))
            });
        }
        if self.depth >= MAX_REF_DEPTH {
            self.too_deep += 1;
            return Object::Null;
        }
        self.depth += 1;
        let copied = self.copy_resources(out, src, dict, used);
        self.depth -= 1;
        Object::Dictionary(copied)
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
        let is_form = name_of(&stream.dict, b"Subtype") == Some(b"Form");
        for (key, value) in stream.dict.iter() {
            // A reference XObject's /Ref points at another PDF file, often
            // embedded: never part of what the page shows.
            if is_never_copied(&stream.dict, key, value) || (is_form && key == b"Ref") {
                continue;
            }
            let copied = match own_resources {
                Some(res) if key == b"Resources" => {
                    let used = self.scan_stream(src, None, stream);
                    Object::Dictionary(self.copy_resources(out, src, res, used.as_ref()))
                }
                _ => self.copy(out, src, value),
            };
            dict.set(key.clone(), copied);
        }
        // Clone keeps the content bytes and filters untouched (byte-exact).
        let mut copy = stream.clone();
        copy.dict = dict;
        if self.strip_image_metadata && is_dct_only_image(&stream.dict) {
            let stripped = strip_jpeg_metadata(&stream.content);
            // Whitespace or NUL padding after the end of the image carries
            // nothing: such a stream stays byte-exact and is not counted.
            let padding_only = stream.content.starts_with(&stripped)
                && stream.content[stripped.len()..].iter().all(|&b| b == 0 || b.is_ascii_whitespace());
            if !padding_only {
                copy.set_content(stripped); // also rewrites /Length
                self.images_cleaned += 1;
            }
        }
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
        let expanded = used.and_then(|u| expand_usage(self, src, res, u));
        let used = expanded.as_ref();

        let mut copy = Dictionary::new();
        for category in CATEGORIES {
            let Some(value) = res.get(category).ok() else {
                continue;
            };
            let Some(entries) = deref(doc, value).and_then(|o| o.as_dict().ok()) else {
                continue;
            };
            let keep = |name: &[u8]| used.is_none_or(|u| u.contains(category, name));
            if !entries.iter().any(|(name, _)| keep(name)) {
                continue;
            }
            let copy_kept = |this: &mut Self, out: &mut Document| {
                let mut kept = Dictionary::new();
                for (name, value) in entries.iter() {
                    if keep(name) {
                        kept.set(name.clone(), this.copy(out, src, value));
                    }
                }
                Object::Dictionary(kept)
            };
            // A shared category dictionary is copied once per trimming.
            let kept = match value.as_reference() {
                Ok(id) => {
                    let trim = used.map(|u| {
                        let mut names: Vec<Vec<u8>> = entries
                            .iter()
                            .filter(|(name, _)| u.contains(category, name))
                            .map(|(name, _)| name.clone())
                            .collect();
                        names.sort();
                        vec![(category, names)]
                    });
                    let key = MemoKey::Trimmed((src, id, Some(category), trim));
                    self.copy_once(out, key, copy_kept)
                }
                Err(_) => copy_kept(self, out),
            };
            copy.set(category, kept);
        }
        if let Ok(proc_set) = res.get(b"ProcSet") {
            copy.set("ProcSet", self.copy(out, src, proc_set));
        }
        copy
    }
}

/// Resource names drawn by all glyph procedures of Type3 font `font`, whose
/// `/Resources` they share. None (keep every resource) when the font has no
/// readable /CharProcs or one glyph cannot be scanned.
fn type3_usage(copier: &mut SafeCopier, src: usize, font: &Dictionary) -> Option<UsedNames> {
    let doc = copier.source(src);
    let procs = deref(doc, font.get(b"CharProcs").ok()?)?.as_dict().ok()?;
    let mut used = UsedNames::default();
    for (_, glyph) in procs.iter() {
        let stream = deref(doc, glyph)?.as_stream().ok()?;
        used.merge(copier.scan_stream(src, glyph.as_reference().ok(), stream)?);
    }
    Some(used)
}

/// Add to `used`, transitively, the names drawn by streams that have no
/// `/Resources` of their own and so use the enclosing ones: Form XObjects and
/// tiling patterns, Type3 glyph procedures, and soft-mask group forms reached
/// through an ExtGState. None when one of those streams cannot be scanned.
fn expand_usage(
    copier: &mut SafeCopier,
    src: usize,
    res: &Dictionary,
    used: &UsedNames,
) -> Option<UsedNames> {
    let doc = copier.source(src);
    let lookup = |category: &[u8], name: &[u8]| {
        let entries = deref(doc, res.get(category).ok()?)?.as_dict().ok()?;
        let entry = entries.get(name).ok()?;
        Some((entry.as_reference().ok(), deref(doc, entry)?))
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
            if let Some((id, entry)) = lookup(category, &name) {
                for (id, stream) in inheriting_streams(doc, category, id, entry) {
                    result.merge(copier.scan_stream(src, id, stream)?);
                }
            }
            visited.insert((category, name));
        }
    }
}

/// The content streams reached from resource `entry` (of `category`, object
/// `id` when indirect) that draw with the enclosing resources because they
/// lack their own, each with its object id when indirect.
fn inheriting_streams<'a>(
    doc: &'a Document,
    category: &[u8],
    id: Option<ObjectId>,
    entry: &'a Object,
) -> Vec<(Option<ObjectId>, &'a lopdf::Stream)> {
    let resource_less_form = |obj: &'a Object| {
        obj.as_stream()
            .ok()
            .filter(|s| has_own_content(&s.dict) && !s.dict.has(b"Resources"))
    };
    let with_id = |obj: &'a Object| Some((obj.as_reference().ok(), deref(doc, obj)?));
    match category {
        XOBJECT | PATTERN => resource_less_form(entry)
            .map(|s| (id, s))
            .into_iter()
            .collect(),
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
                .filter_map(|(_, glyph)| {
                    let (id, glyph) = with_id(glyph)?;
                    Some((id, glyph.as_stream().ok()?))
                })
                .collect()
        }
        EXT_G_STATE => entry
            .as_dict()
            .ok()
            .and_then(|gs| deref(doc, gs.get(b"SMask").ok()?))
            .and_then(|mask| mask.as_dict().ok())
            .and_then(|mask| with_id(mask.get(b"G").ok()?))
            .and_then(|(id, group)| Some((id, resource_less_form(group)?)))
            .into_iter()
            .collect(),
        _ => vec![],
    }
}

/// Counters and messages for the "what was removed" summary.
#[derive(Default, Debug, Clone, PartialEq)]
pub struct RebuildReport {
    pub links_kept: u32,
    pub links_dropped: u32,
    pub comments_kept: u32,
    pub comments_dropped: u32,
    pub fields_flattened: u32,
    pub warnings: Vec<String>,
    /// Pages whose object graph was too deep, so some nested content was
    /// dropped (each also has a warning). The other warnings are pages that
    /// could not be analysed and kept all their resources.
    pub too_deep_pages: u32,
    /// DCT (JPEG) images whose metadata `Policy::strip_image_metadata` removed.
    pub images_cleaned: u32,
}

/// Page rotation after turning a page with `/Rotate` value `current` by a
/// further `delta` degrees, in 0, 90, 180 or 270. Hostile values (fractional,
/// off-grid, huge) snap to the nearest quarter turn without overflowing.
pub(crate) fn add_rotation(current: Option<&Object>, delta: i64) -> i64 {
    let current = match current {
        Some(Object::Integer(i)) => i.rem_euclid(360) as f64,
        Some(Object::Real(f)) if f.is_finite() => f64::from(*f).rem_euclid(360.0),
        _ => 0.0,
    };
    let current = (current / 90.0).round() as i64 * 90;
    (current + delta.rem_euclid(360)).rem_euclid(360)
}

/// Copy page `page_id` of source `src` into `out` WITHOUT annotations (Task 2
/// adds them). Returns the new page id. Rotation is the inherited /Rotate plus
/// `rotate_delta`, normalized. The page has no /Parent: assembly sets it.
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
    let current = get_inherited_attr(doc, page_id, b"Rotate");
    let rotate = add_rotation(current.as_ref().and_then(|r| deref(doc, r)), rotate_delta);
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
    let mut over_limit = false;
    let mut contents = Vec::with_capacity(content_ids.len());
    for id in &content_ids {
        // Over a decoding limit counts as undecodable: all resources kept.
        if let (false, Ok(stream)) = (over_limit, doc.get_object(*id).and_then(Object::as_stream)) {
            match copier.decode_for_scan(stream) {
                Some(content) => {
                    joined.extend_from_slice(&content);
                    joined.push(b'\n');
                }
                None => over_limit = true,
            }
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
        let used = if over_limit {
            None
        } else {
            scan_content(&joined)
        };
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
        report.too_deep_pages += 1;
    }
    if !problems.is_empty() {
        let number = copier.page_number(src, page_id);
        for problem in problems {
            report.warnings.push(format!("Page {number}: {problem}"));
        }
    }

    Ok(out.add_object(page))
}

/// One page of a rebuilt document.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutPage {
    /// Page object `page` of source `src`, turned a further `rotate` degrees.
    Page {
        src: usize,
        page: ObjectId,
        rotate: i64,
    },
    /// An empty page with the MediaBox and /Rotate of the nearest real output
    /// page (previous first), US Letter when there is none.
    Blank,
}

const LETTER: [i64; 4] = [0, 0, 612, 792];

/// Build a fresh document (catalog with /Type /Pages, plus /OCProperties
/// when optional-content groups were copied; no Info) from
/// `pages`. Nothing from `sources` reaches the output except what each kept
/// page displays and the annotations `policy` keeps; a source page that
/// appears more than once gets independent copies, and links resolve to its
/// FIRST copy.
pub fn rebuild_document(
    sources: &[Document],
    pages: &[OutPage],
    policy: &Policy,
) -> Result<(Document, RebuildReport), String> {
    let version = sources
        .iter()
        .map(|d| d.version.as_str())
        .chain(["1.7"])
        .max()
        .unwrap_or("1.7");
    let mut out = Document::with_version(version);
    let mut copier = SafeCopier::new(sources, policy.strip_image_metadata);
    let mut report = RebuildReport::default();
    let mut links = PendingLinks::default();
    let mut replies = PendingReplies::default();
    let mut annot_map = HashMap::new();
    let mut page_map: HashMap<(usize, ObjectId), ObjectId> = HashMap::new();

    let mut slots: Vec<Option<ObjectId>> = Vec::with_capacity(pages.len());
    for entry in pages {
        let OutPage::Page { src, page, rotate } = *entry else {
            slots.push(None);
            continue;
        };
        if src >= sources.len() {
            return Err(format!(
                "Page refers to document {} but only {} were given",
                src + 1,
                sources.len()
            ));
        }
        let new_page = copy_page(&mut out, &mut copier, src, page, rotate, &mut report)?;
        rebuild_annotations(
            &mut out,
            &mut copier,
            src,
            page,
            new_page,
            policy,
            &mut report,
            &mut links,
            &mut replies,
            &mut annot_map,
        )?;
        page_map.entry((src, page)).or_insert(new_page);
        slots.push(Some(new_page));
    }
    finish_links(&mut out, &page_map, &annot_map, links, replies, &mut report);

    let mut kids: Vec<ObjectId> = Vec::with_capacity(slots.len());
    for (i, slot) in slots.iter().enumerate() {
        match slot {
            Some(id) => kids.push(*id),
            None => {
                let reference = slots[..i]
                    .iter()
                    .rev()
                    .chain(&slots[i + 1..])
                    .find_map(|k| *k);
                kids.push(add_blank_page(&mut out, reference));
            }
        }
    }

    let pages_id = out.new_object_id();
    for &id in &kids {
        if let Ok(dict) = out.get_dictionary_mut(id) {
            dict.set("Parent", pages_id);
        }
    }
    let count = kids.len() as i64;
    let kids: Vec<Object> = kids.into_iter().map(Object::Reference).collect();
    out.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => count }),
    );
    let mut catalog = dictionary! { "Type" => "Catalog", "Pages" => pages_id };
    if let Some(oc) = optional_content(&copier, sources) {
        catalog.set("OCProperties", oc);
    }
    let catalog = out.add_object(catalog);
    out.trailer.set("Root", catalog);
    report.images_cleaned = copier.images_cleaned;
    // Safety net: objects created and then abandoned (dropped links) go too.
    out.prune_objects();
    Ok((out, report))
}

/// Nesting accepted in an optional-content `/Order` array, and entries read
/// from one source's `/Order` in all.
const MAX_ORDER_DEPTH: usize = 32;
const MAX_ORDER_ITEMS: usize = 100_000;

/// Guards of one `/Order` walk: array objects already walked and the
/// entries left to read.
struct OrderWalk {
    seen: HashSet<ObjectId>,
    budget: usize,
}

impl OrderWalk {
    /// The array behind `obj`, following a chain of references. None when it
    /// is not an array or any object on the chain was already walked; every
    /// id on the chain is marked walked.
    fn array<'a>(&mut self, doc: &'a Document, mut obj: &'a Object) -> Option<&'a [Object]> {
        for _ in 0..32 {
            match obj {
                Object::Reference(id) => {
                    if !self.seen.insert(*id) {
                        return None;
                    }
                    // One link at a time: `get_object` would skip the
                    // rest of a chain.
                    obj = doc.objects.get(id)?;
                }
                Object::Array(items) => return Some(items),
                _ => return None,
            }
        }
        None
    }
}

/// A minimal `/OCProperties` for the optional-content groups the copier
/// actually copied, so layers hidden by default stay hidden: `/OCGs` lists
/// them, `/D /OFF` the ones each source shows off by default (its /BaseState,
/// /ON and /OFF resolved), and `/D /Order` is the source order restricted to
/// them. Everything else (/Configs, /AS, /Locked, /RBGroups) is left out.
/// None when no group was copied.
pub(crate) fn optional_content(copier: &SafeCopier, sources: &[Document]) -> Option<Dictionary> {
    let mut groups: Vec<Object> = Vec::new();
    let mut in_groups: HashSet<ObjectId> = HashSet::new();
    let mut hidden: Vec<Object> = Vec::new();
    let mut order: Vec<Object> = Vec::new();
    for (src, doc) in sources.iter().enumerate() {
        let Some(props) = doc
            .catalog()
            .ok()
            .and_then(|c| deref(doc, c.get(b"OCProperties").ok()?))
            .and_then(|p| p.as_dict().ok())
        else {
            continue;
        };
        let refs_in = |obj: Option<&Object>| -> Vec<ObjectId> {
            obj.and_then(|o| deref(doc, o))
                .and_then(|o| o.as_array().ok())
                .map(|items| items.iter().filter_map(|o| o.as_reference().ok()).collect())
                .unwrap_or_default()
        };
        let config = props
            .get(b"D")
            .ok()
            .and_then(|d| deref(doc, d))
            .and_then(|d| d.as_dict().ok());
        let base_off = config.and_then(|d| name_of(d, b"BaseState")) == Some(b"OFF".as_slice());
        let on: HashSet<ObjectId> = refs_in(config.and_then(|d| d.get(b"ON").ok()))
            .into_iter()
            .collect();
        let off: HashSet<ObjectId> = refs_in(config.and_then(|d| d.get(b"OFF").ok()))
            .into_iter()
            .collect();
        let listed = refs_in(props.get(b"OCGs").ok());
        for &id in &listed {
            let Some(new_id) = copier.copied(src, id) else {
                continue;
            };
            if !in_groups.insert(new_id) {
                continue;
            }
            let new_ref = Object::Reference(new_id);
            let is_hidden = if base_off {
                !on.contains(&id)
            } else {
                off.contains(&id)
            };
            if is_hidden {
                hidden.push(new_ref.clone());
            }
            groups.push(new_ref);
        }
        let mut walk = OrderWalk {
            seen: HashSet::new(),
            budget: MAX_ORDER_ITEMS,
        };
        if let Some(items) = config
            .and_then(|d| d.get(b"Order").ok())
            .and_then(|o| walk.array(doc, o))
        {
            let listed: HashSet<ObjectId> = listed.iter().copied().collect();
            order.extend(filter_order(copier, doc, src, &listed, items, 0, &mut walk));
        }
    }
    if groups.is_empty() {
        return None;
    }
    let mut config = dictionary! { "OFF" => hidden };
    if !order.is_empty() {
        config.set("Order", order);
    }
    Some(dictionary! { "OCGs" => groups, "D" => config })
}

/// `/Order` entries of source `src` that point at copied groups (of `listed`), mapped to
/// their output ids. A nested array survives only with at least one group;
/// a text label is kept only as the first element of such an array. An
/// array object is walked once (see `OrderWalk`): a second reference to it,
/// including one from inside itself, is dropped, as is everything past the
/// entry budget.
fn filter_order(
    copier: &SafeCopier,
    doc: &Document,
    src: usize,
    listed: &HashSet<ObjectId>,
    items: &[Object],
    depth: usize,
    walk: &mut OrderWalk,
) -> Vec<Object> {
    if depth >= MAX_ORDER_DEPTH {
        return vec![];
    }
    let mut kept = Vec::new();
    for (i, item) in items.iter().enumerate() {
        if walk.budget == 0 {
            break;
        }
        walk.budget -= 1;
        match item {
            Object::Reference(id) => match copier.copied(src, *id) {
                Some(new_id) if listed.contains(id) => kept.push(Object::Reference(new_id)),
                Some(_) => {}
                None => {
                    if let Some(nested) = walk.array(doc, item) {
                        let inner = filter_order(copier, doc, src, listed, nested, depth + 1, walk);
                        if !inner.is_empty() {
                            kept.push(Object::Array(inner));
                        }
                    }
                }
            },
            Object::Array(nested) => {
                let inner = filter_order(copier, doc, src, listed, nested, depth + 1, walk);
                if !inner.is_empty() {
                    kept.push(Object::Array(inner));
                }
            }
            Object::String(..) if i == 0 && depth > 0 => kept.push(item.clone()),
            _ => {}
        }
    }
    // A label alone is not a group.
    if kept.iter().all(|o| matches!(o, Object::String(..))) {
        kept.clear();
    }
    kept
}

/// Empty page sized and turned like output page `reference`.
fn add_blank_page(out: &mut Document, reference: Option<ObjectId>) -> ObjectId {
    let (media, rotate) = reference
        .and_then(|id| out.get_dictionary(id).ok())
        .map(|d| {
            (
                d.get(b"MediaBox").ok().cloned(),
                d.get(b"Rotate").ok().cloned(),
            )
        })
        .unwrap_or((None, None));
    let media = media.unwrap_or_else(|| Object::Array(LETTER.iter().map(|&v| v.into()).collect()));
    let contents = out.add_object(lopdf::Stream::new(Dictionary::new(), Vec::new()));
    let mut page = dictionary! {
        "Type" => "Page",
        "MediaBox" => media,
        "Resources" => Dictionary::new(),
        "Contents" => contents,
    };
    if let Some(rotate) = rotate {
        page.set("Rotate", rotate);
    }
    out.add_object(page)
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
        let mut copier = SafeCopier::new(&sources, false);
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
        let mut copier = SafeCopier::new(&sources, false);
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
    fn border_style_dict_is_not_an_action() {
        let dashed = Object::Dictionary(
            dictionary! { "W" => 1, "S" => "D", "D" => vec![3.into(), 2.into()] },
        );
        assert!(!is_blocked(&dashed));
        let typed = Object::Dictionary(
            dictionary! { "Type" => "Border", "S" => "D", "D" => vec![3.into()] },
        );
        assert!(!is_blocked(&typed));
        let js = Object::Dictionary(
            dictionary! { "S" => "JavaScript", "JS" => Object::string_literal("x"), "W" => 1 },
        );
        assert!(is_blocked(&js));
        let goto = Object::Dictionary(dictionary! { "S" => "Unknown", "D" => vec![Object::Null] });
        assert!(
            is_blocked(&goto),
            "payload rule still applies to other /S names"
        );
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

    // ---- final review fixes -------------------------------------------

    /// Resolve a direct or indirect dictionary of the output.
    fn out_dict<'a>(out: &'a Document, obj: &'a Object) -> &'a Dictionary {
        deref(out, obj).unwrap().as_dict().unwrap()
    }

    #[test]
    fn name_keyed_maps_keep_every_name() {
        // Glyphs named /A and /P, a colorant named /A and an XObject named /A
        // are names, not the structural /A (action) and /P (parent) keys.
        let mut src = Src::new();
        let glyph = |doc: &mut Document, body: &[u8]| {
            doc.add_object(Stream::new(dictionary! {}, body.to_vec()))
        };
        let ga = glyph(&mut src.doc, b"0 0 d0 0 0 1 1 re f");
        let gp = glyph(&mut src.doc, b"0 0 d0 0 0 1 1 re f");
        let t3 = src.doc.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type3",
            "FontBBox" => vec![0.into(), 0.into(), 1.into(), 1.into()],
            "FontMatrix" => vec![1.into(), 0.into(), 0.into(), 1.into(), 0.into(), 0.into()],
            "CharProcs" => dictionary! { "A" => ga, "P" => gp },
            "Encoding" => dictionary! { "Differences" => vec![65.into(), Object::Name(b"A".to_vec()), Object::Name(b"P".to_vec())] },
            "FirstChar" => 65, "LastChar" => 66, "Widths" => vec![1.into(), 1.into()],
        });
        let img = src.doc.add_object(image(b"GLYPHIMG_A"));
        let gi = glyph(&mut src.doc, b"0 0 d0 /A Do");
        let t3r = src.doc.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type3",
            "FontBBox" => vec![0.into(), 0.into(), 1.into(), 1.into()],
            "FontMatrix" => vec![1.into(), 0.into(), 0.into(), 1.into(), 0.into(), 0.into()],
            "CharProcs" => dictionary! { "g" => gi },
            "Encoding" => dictionary! { "Differences" => vec![97.into(), Object::Name(b"g".to_vec())] },
            "FirstChar" => 97, "LastChar" => 97, "Widths" => vec![1.into()],
            "Resources" => dictionary! { "XObject" => dictionary! { "A" => img } },
        });
        let tint = dictionary! {
            "FunctionType" => 2, "Domain" => vec![0.into(), 1.into()],
            "C0" => vec![0.into(), 0.into(), 0.into(), 0.into()],
            "C1" => vec![1.into(), 0.into(), 0.into(), 0.into()], "N" => 1,
        };
        let separation: Object = vec![
            Object::Name(b"Separation".to_vec()),
            Object::Name(b"A".to_vec()),
            Object::Name(b"DeviceCMYK".to_vec()),
            tint.clone().into(),
        ]
        .into();
        let device_n: Object = vec![
            Object::Name(b"DeviceN".to_vec()),
            vec![Object::Name(b"A".to_vec())].into(),
            Object::Name(b"DeviceCMYK".to_vec()),
            tint.into(),
            dictionary! { "Colorants" => dictionary! { "A" => separation } }.into(),
        ]
        .into();
        src.add_page(
            dictionary! {
                "Font" => dictionary! { "T3" => t3, "T3R" => t3r },
                "ColorSpace" => dictionary! { "CSN" => device_n },
            },
            b"BT /T3 12 Tf (AB) Tj /T3R 12 Tf (a) Tj ET /CSN cs 1 scn",
        );
        let (bytes, out, _) = rebuild(src.finish(), &[1]);

        let procs = out
            .objects
            .values()
            .filter_map(|o| o.as_dict().ok())
            .filter(|d| name_of(d, b"Subtype") == Some(b"Type3"))
            .find(|d| !d.has(b"Resources"))
            .expect("Type3 font copied")
            .get(b"CharProcs")
            .unwrap();
        let procs = out_dict(&out, procs);
        assert!(procs.has(b"A"), "glyph /A kept");
        assert!(procs.has(b"P"), "glyph /P kept");

        assert!(contains(&bytes, b"GLYPHIMG_A"), "Type3 resource /A kept");

        let page = out
            .objects
            .values()
            .filter_map(|o| o.as_dict().ok())
            .find(|d| name_of(d, b"Type") == Some(b"Page"))
            .unwrap();
        let spaces = out_dict(&out, page.get(b"Resources").unwrap())
            .get(b"ColorSpace")
            .unwrap();
        let cs = deref(&out, out_dict(&out, spaces).get(b"CSN").unwrap())
            .unwrap()
            .as_array()
            .unwrap();
        let colorants = out_dict(&out, &cs[4]).get(b"Colorants").unwrap();
        assert!(out_dict(&out, colorants).has(b"A"), "colorant /A kept");
    }

    #[test]
    fn hidden_optional_content_stays_hidden() {
        let mut src = Src::new();
        let ocg = |doc: &mut Document, name: &str| {
            doc.add_object(dictionary! { "Type" => "OCG", "Name" => Object::string_literal(name) })
        };
        let hidden = ocg(&mut src.doc, "Hidden");
        let shown = ocg(&mut src.doc, "Shown");
        let other = ocg(&mut src.doc, "SECRET_OTHERLAYER");
        let page = src.add_page(
            dictionary! { "Properties" => dictionary! { "oc1" => hidden, "oc2" => shown } },
            b"/OC /oc1 BDC 0 0 1 1 re f EMC /OC /oc2 BDC 0 0 1 1 re f EMC",
        );
        src.add_page(
            dictionary! { "Properties" => dictionary! { "oc3" => other } },
            b"/OC /oc3 BDC 0 0 1 1 re f EMC",
        );
        // Object ids survive the save/load in `finish`.
        let mut doc = src.finish();
        let refs = |ids: &[ObjectId]| -> Object {
            ids.iter()
                .map(|&id| Object::Reference(id))
                .collect::<Vec<_>>()
                .into()
        };
        let catalog = doc.trailer.get(b"Root").unwrap().as_reference().unwrap();
        doc.get_dictionary_mut(catalog).unwrap().set(
            "OCProperties",
            dictionary! {
                "OCGs" => refs(&[hidden, shown, other]),
                "D" => dictionary! {
                    "OFF" => refs(&[hidden, other]),
                    "ON" => refs(&[shown]),
                    "Order" => vec![Object::from(hidden), vec![Object::from(shown), other.into()].into(), other.into()],
                    "AS" => vec![dictionary! { "Event" => "View", "OCGs" => refs(&[other]) }.into()],
                },
            },
        );
        let pages = [OutPage::Page {
            src: 0,
            page,
            rotate: 0,
        }];
        let (out, _) = rebuild_document(&[doc], &pages, &PAGE_TOOLS).unwrap();

        let copied_page = out.get_pages()[&1];
        let props = out_dict(
            &out,
            out_dict(
                &out,
                out.get_dictionary(copied_page)
                    .unwrap()
                    .get(b"Resources")
                    .unwrap(),
            )
            .get(b"Properties")
            .unwrap(),
        );
        let new_hidden = props.get(b"oc1").unwrap().as_reference().unwrap();
        let new_shown = props.get(b"oc2").unwrap().as_reference().unwrap();

        let oc = out_dict(
            &out,
            out.catalog()
                .unwrap()
                .get(b"OCProperties")
                .expect("/OCProperties"),
        );
        let ids = |obj: &Object| -> Vec<ObjectId> {
            obj.as_array()
                .unwrap()
                .iter()
                .filter_map(|o| o.as_reference().ok())
                .collect()
        };
        assert_eq!(ids(oc.get(b"OCGs").unwrap()), vec![new_hidden, new_shown]);
        let d = out_dict(&out, oc.get(b"D").unwrap());
        assert_eq!(ids(d.get(b"OFF").unwrap()), vec![new_hidden]);
        assert!(!d.has(b"AS"), "auto-state entries are dropped");
        let order = d.get(b"Order").unwrap().as_array().unwrap();
        assert_eq!(order.len(), 2, "{order:?}");
        assert_eq!(order[0].as_reference().unwrap(), new_hidden);
        assert_eq!(ids(&order[1]), vec![new_shown]);

        let mut bytes = Vec::new();
        out.clone().save_to(&mut bytes).unwrap();
        assert!(!contains(&bytes, b"SECRET_OTHERLAYER"));
    }

    #[test]
    fn cyclic_type3_resources_terminate() {
        // /Resources -> /Font -> (direct) Type3 font -> /Resources (the same
        // object): no memoized reference breaks this cycle by itself.
        let mut src = Src::new();
        let res_id = src.doc.new_object_id();
        let glyph = src
            .doc
            .add_object(Stream::new(dictionary! {}, b"0 0 d0 /T3 1 Tf".to_vec()));
        let font = dictionary! {
            "Type" => "Font", "Subtype" => "Type3",
            "FontBBox" => vec![0.into(), 0.into(), 1.into(), 1.into()],
            "FontMatrix" => vec![1.into(), 0.into(), 0.into(), 1.into(), 0.into(), 0.into()],
            "CharProcs" => dictionary! { "g" => glyph },
            "Encoding" => dictionary! { "Differences" => vec![97.into(), Object::Name(b"g".to_vec())] },
            "FirstChar" => 97, "LastChar" => 97, "Widths" => vec![1.into()],
            "Resources" => res_id,
        };
        src.doc.objects.insert(
            res_id,
            Object::Dictionary(dictionary! { "Font" => dictionary! { "T3" => font } }),
        );
        let page = src.add_page(dictionary! {}, b"BT /T3 12 Tf (a) Tj ET");
        src.doc
            .get_dictionary_mut(page)
            .unwrap()
            .set("Resources", res_id);
        let doc = src.finish();
        let pages = [OutPage::Page {
            src: 0,
            page,
            rotate: 0,
        }];
        let (mut out, _) = rebuild_document(&[doc], &pages, &PAGE_TOOLS).unwrap();
        let mut bytes = Vec::new();
        out.save_to(&mut bytes).unwrap();
        assert!(Document::load_mem(&bytes).is_ok());
    }

    #[test]
    fn deep_graph_pages_counted_apart_from_undecodable_ones() {
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
        src.add_page(dictionary! {}, b"BT ( unterminated");
        let (_, _, report) = rebuild(src.finish(), &[1, 2]);
        assert_eq!(report.warnings.len(), 2, "{:?}", report.warnings);
        assert_eq!(report.too_deep_pages, 1);
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

    // ---- residual findings: amplification guards ------------------------

    /// Type3 font without /CharProcs (so every resource is kept) drawing
    /// from `resources`.
    fn t3_using(resources: Object) -> Object {
        dictionary! {
            "Type" => "Font", "Subtype" => "Type3",
            "FontBBox" => vec![0.into(), 0.into(), 1.into(), 1.into()],
            "FontMatrix" => vec![1.into(), 0.into(), 0.into(), 1.into(), 0.into(), 0.into()],
            "Resources" => resources,
        }
        .into()
    }

    /// Output size and time of copying page 1 of `doc`.
    fn measure(doc: Document) -> (usize, std::time::Duration) {
        let start = std::time::Instant::now();
        let (bytes, _, _) = rebuild(doc, &[1]);
        (bytes.len(), start.elapsed())
    }

    /// k levels of `/Resources` objects, each drawing twice (through two
    /// direct Type3 fonts) from the level below: 2^k paths to the bottom.
    fn resources_diamond(k: usize) -> Document {
        let mut src = Src::new();
        let mut res = src.doc.add_object(dictionary! {});
        for _ in 0..k {
            res = src.doc.add_object(dictionary! {
                "Font" => dictionary! { "a" => t3_using(res.into()), "b" => t3_using(res.into()) },
            });
        }
        src.add_page(
            dictionary! { "Font" => dictionary! { "T" => t3_using(res.into()) } },
            b"BT /T 1 Tf ET",
        );
        src.finish()
    }

    /// Same shape through shared `/Font` category dictionaries, with direct
    /// `/Resources` in between.
    fn category_diamond(k: usize) -> Document {
        let mut src = Src::new();
        let mut fonts = src.doc.add_object(dictionary! {});
        for _ in 0..k {
            let res = || t3_using(dictionary! { "Font" => fonts }.into());
            fonts = src
                .doc
                .add_object(dictionary! { "a" => res(), "b" => res() });
        }
        src.add_page(dictionary! { "Font" => fonts }, b"BT /a 1 Tf ET");
        src.finish()
    }

    fn assert_linear(build: fn(usize) -> Document) {
        let (small, _) = measure(build(12));
        let (large, elapsed) = measure(build(24));
        assert!(
            elapsed < std::time::Duration::from_secs(1),
            "k=24 took {elapsed:?}"
        );
        assert!(
            large < 3 * small,
            "output {small} B at k=12, {large} B at k=24"
        );
    }

    #[test]
    fn shared_type3_resources_are_copied_once() {
        assert_linear(resources_diamond);
    }

    #[test]
    fn shared_resource_categories_are_copied_once() {
        assert_linear(category_diamond);
    }

    /// One page showing one layer, whose source `/D /Order` is the array
    /// object that `order` builds (given the layer and the array's own id).
    fn rebuild_with_order(order: impl FnOnce(&mut Document, ObjectId, ObjectId)) -> Document {
        let mut src = Src::new();
        let ocg = src
            .doc
            .add_object(dictionary! { "Type" => "OCG", "Name" => Object::string_literal("L") });
        let page = src.add_page(
            dictionary! { "Properties" => dictionary! { "oc1" => ocg } },
            b"/OC /oc1 BDC 0 0 1 1 re f EMC",
        );
        let mut doc = src.finish();
        let order_id = doc.new_object_id();
        order(&mut doc, ocg, order_id);
        let catalog = doc.trailer.get(b"Root").unwrap().as_reference().unwrap();
        doc.get_dictionary_mut(catalog).unwrap().set(
            "OCProperties",
            dictionary! {
                "OCGs" => vec![Object::from(ocg)],
                "D" => dictionary! { "Order" => order_id },
            },
        );
        let pages = [OutPage::Page {
            src: 0,
            page,
            rotate: 0,
        }];
        let start = std::time::Instant::now();
        let (mut out, _) = rebuild_document(&[doc], &pages, &PAGE_TOOLS).unwrap();
        let elapsed = start.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(1),
            "took {elapsed:?}"
        );
        let mut bytes = Vec::new();
        out.save_to(&mut bytes).unwrap();
        Document::load_mem(&bytes).unwrap()
    }

    /// The `/D /Order` of the output's `/OCProperties`.
    fn out_order(out: &Document) -> Vec<Object> {
        let oc = out_dict(out, out.catalog().unwrap().get(b"OCProperties").unwrap());
        let d = out_dict(out, oc.get(b"D").unwrap());
        deref(out, d.get(b"Order").unwrap())
            .unwrap()
            .as_array()
            .unwrap()
            .clone()
    }

    #[test]
    fn self_referencing_layer_order_terminates() {
        let out = rebuild_with_order(|doc, ocg, order_id| {
            let me = Object::Reference(order_id);
            let nested: Object = vec![me.clone(), me.clone()].into();
            doc.objects
                .insert(order_id, vec![ocg.into(), me.clone(), me, nested].into());
        });
        let order = out_order(&out);
        assert_eq!(order.len(), 1, "{order:?}");
        assert!(order[0].as_reference().is_ok());
    }

    #[test]
    fn shared_layer_order_arrays_are_walked_once() {
        let out = rebuild_with_order(|doc, ocg, order_id| {
            let mut level = doc.add_object(vec![Object::from(ocg)]);
            for _ in 0..25 {
                level = doc.add_object(vec![Object::from(level), level.into()]);
            }
            doc.objects
                .insert(order_id, vec![Object::from(level)].into());
        });
        assert!(!out_order(&out).is_empty());
    }

    #[test]
    fn layer_order_cycle_through_reference_chain_is_dropped() {
        // /Order -> A -> B -> [layer, A, B]: every id on the chain counts as
        // walked, so neither back-reference adds a nested copy.
        let out = rebuild_with_order(|doc, ocg, order_id| {
            let array = doc.new_object_id();
            doc.objects.insert(order_id, Object::Reference(array));
            doc.objects.insert(
                array,
                vec![ocg.into(), order_id.into(), array.into()].into(),
            );
        });
        let order = out_order(&out);
        assert_eq!(order.len(), 1, "{order:?}");
        assert!(order[0].as_reference().is_ok());
    }

    #[test]
    fn layer_order_aliases_of_a_wide_array_are_walked_once() {
        // 5000 distinct references, each an alias object of one array of
        // 5000 entries: the array is walked once, not once per alias.
        let out = rebuild_with_order(|doc, ocg, order_id| {
            let mut wide = vec![Object::from(ocg)];
            wide.extend((0..5000).map(|_| Object::Reference((999_999, 0))));
            let wide = doc.add_object(wide);
            let aliases: Vec<Object> = (0..5000)
                .map(|_| doc.add_object(Object::Reference(wide)).into())
                .collect();
            doc.objects.insert(order_id, aliases.into());
        });
        assert_eq!(out_order(&out).len(), 1);
    }

    #[test]
    fn long_layer_list_and_order_stay_linear() {
        // 100000 /OCGs entries with the copied layer last, and an /Order
        // naming it 100000 times.
        let mut src = Src::new();
        let ocg = src
            .doc
            .add_object(dictionary! { "Type" => "OCG", "Name" => Object::string_literal("L") });
        let page = src.add_page(
            dictionary! { "Properties" => dictionary! { "oc1" => ocg } },
            b"/OC /oc1 BDC 0 0 1 1 re f EMC",
        );
        let mut doc = src.finish();
        let mut listed: Vec<Object> = (0..100_000)
            .map(|i| Object::Reference((1_000_000 + i, 0)))
            .collect();
        listed.push(ocg.into());
        let order: Vec<Object> = (0..100_000).map(|_| Object::from(ocg)).collect();
        let catalog = doc.trailer.get(b"Root").unwrap().as_reference().unwrap();
        doc.get_dictionary_mut(catalog).unwrap().set(
            "OCProperties",
            dictionary! { "OCGs" => listed, "D" => dictionary! { "Order" => order } },
        );
        let pages = [OutPage::Page {
            src: 0,
            page,
            rotate: 0,
        }];
        let start = std::time::Instant::now();
        rebuild_document(&[doc], &pages, &PAGE_TOOLS).unwrap();
        let elapsed = start.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(1),
            "took {elapsed:?}"
        );
    }

    #[test]
    fn many_layers_with_long_off_list_stay_linear() {
        // 2000 layers drawn on the page, and an /OFF list of 200000 other
        // entries before them.
        let mut src = Src::new();
        let mut props = Dictionary::new();
        let mut content = Vec::new();
        let ocgs: Vec<ObjectId> = (0..2000)
            .map(|i| {
                let id = src.doc.add_object(
                    dictionary! { "Type" => "OCG", "Name" => Object::string_literal("L") },
                );
                props.set(format!("oc{i}"), id);
                content.extend_from_slice(format!("/OC /oc{i} BDC EMC ").as_bytes());
                id
            })
            .collect();
        let page = src.add_page(dictionary! { "Properties" => props }, &content);
        let mut doc = src.finish();
        let mut off: Vec<Object> = (0..200_000)
            .map(|i| Object::Reference((1_000_000 + i, 0)))
            .collect();
        off.extend(ocgs.iter().map(|&id| Object::from(id)));
        let listed: Vec<Object> = ocgs.iter().map(|&id| Object::from(id)).collect();
        let catalog = doc.trailer.get(b"Root").unwrap().as_reference().unwrap();
        doc.get_dictionary_mut(catalog).unwrap().set(
            "OCProperties",
            dictionary! { "OCGs" => listed, "D" => dictionary! { "OFF" => off } },
        );
        let pages = [OutPage::Page {
            src: 0,
            page,
            rotate: 0,
        }];
        let start = std::time::Instant::now();
        let (out, _) = rebuild_document(&[doc], &pages, &PAGE_TOOLS).unwrap();
        let elapsed = start.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(1),
            "took {elapsed:?}"
        );
        let oc = out_dict(&out, out.catalog().unwrap().get(b"OCProperties").unwrap());
        let d = out_dict(&out, oc.get(b"D").unwrap());
        assert_eq!(d.get(b"OFF").unwrap().as_array().unwrap().len(), 2000);
    }

    #[test]
    fn devicen_mixing_hints_keep_colorant_names() {
        // /Solidities and /DotGain map colorant names, which may be /A or
        // /JS, to values.
        let mut src = Src::new();
        let gain = dictionary! {
            "FunctionType" => 2, "Domain" => vec![0.into(), 1.into()], "N" => 1,
        };
        let device_n: Object = vec![
            Object::Name(b"DeviceN".to_vec()),
            vec![Object::Name(b"A".to_vec()), Object::Name(b"JS".to_vec())].into(),
            Object::Name(b"DeviceCMYK".to_vec()),
            dictionary! {
                "FunctionType" => 2, "Domain" => vec![0.into(), 1.into(), 0.into(), 1.into()],
                "C0" => vec![0.into(), 0.into(), 0.into(), 0.into()],
                "C1" => vec![1.into(), 0.into(), 0.into(), 0.into()], "N" => 1,
            }
            .into(),
            dictionary! {
                "MixingHints" => dictionary! {
                    "Solidities" => dictionary! { "A" => 0.5, "JS" => 0.25 },
                    "DotGain" => dictionary! { "A" => gain.clone(), "JS" => gain },
                    "PrintingOrder" => vec![Object::Name(b"A".to_vec()), Object::Name(b"JS".to_vec())],
                },
            }
            .into(),
        ]
        .into();
        src.add_page(
            dictionary! { "ColorSpace" => dictionary! { "CSN" => device_n } },
            b"/CSN cs 1 1 scn",
        );
        let (_, out, _) = rebuild(src.finish(), &[1]);
        let page = out
            .objects
            .values()
            .filter_map(|o| o.as_dict().ok())
            .find(|d| name_of(d, b"Type") == Some(b"Page"))
            .unwrap();
        let spaces = out_dict(&out, page.get(b"Resources").unwrap())
            .get(b"ColorSpace")
            .unwrap();
        let cs = deref(&out, out_dict(&out, spaces).get(b"CSN").unwrap())
            .unwrap()
            .as_array()
            .unwrap();
        let hints = out_dict(&out, out_dict(&out, &cs[4]).get(b"MixingHints").unwrap());
        for map in [&b"Solidities"[..], b"DotGain"] {
            let map = out_dict(&out, hints.get(map).unwrap());
            assert!(map.has(b"A") && map.has(b"JS"), "{map:?}");
        }
    }

    // ---- guard corpus ----------------------------------------------------

    /// One page drawing one layer, as `(document, page, layer)`.
    fn page_with_layer() -> (Document, ObjectId, ObjectId) {
        let mut src = Src::new();
        let ocg = src
            .doc
            .add_object(dictionary! { "Type" => "OCG", "Name" => Object::string_literal("L") });
        let page = src.add_page(
            dictionary! { "Properties" => dictionary! { "oc1" => ocg } },
            b"/OC /oc1 BDC 0 0 1 1 re f EMC",
        );
        (src.finish(), page, ocg)
    }

    /// Set `/OCProperties` with `/D /Order` = `order` on `doc`'s catalog.
    fn set_layer_order(doc: &mut Document, ocg: ObjectId, order: Object) {
        let catalog = doc.trailer.get(b"Root").unwrap().as_reference().unwrap();
        doc.get_dictionary_mut(catalog).unwrap().set(
            "OCProperties",
            dictionary! { "OCGs" => vec![Object::from(ocg)], "D" => dictionary! { "Order" => order } },
        );
    }

    /// Hostile shapes for every graph the rebuild walks: DAGs that double at
    /// each level, cycles, reference aliases and chains.
    fn bomb_corpus() -> Vec<(&'static str, Document)> {
        let mut corpus = vec![
            ("resources diamond", resources_diamond(40)),
            ("category diamond", category_diamond(40)),
        ];

        // A shared /Font category that loops back to itself through direct
        // Type3 fonts and direct /Resources.
        let mut src = Src::new();
        let fonts = src.doc.new_object_id();
        let t3 = || t3_using(dictionary! { "Font" => fonts }.into());
        src.doc
            .objects
            .insert(fonts, dictionary! { "a" => t3(), "b" => t3() }.into());
        src.add_page(dictionary! { "Font" => fonts }, b"BT /a 1 Tf ET");
        corpus.push(("category cycle", src.finish()));

        // 2000 alias objects of one array of 20000 numbers.
        let mut src = Src::new();
        let wide = src.doc.add_object(vec![Object::Integer(7); 20_000]);
        let aliases: Vec<Object> = (0..2000)
            .map(|_| src.doc.add_object(Object::Reference(wide)).into())
            .collect();
        page_with_evil_font(&mut src, aliases.into());
        corpus.push(("alias fan-out", src.finish()));

        // Each level an array of two aliases of the level below.
        let mut src = Src::new();
        let mut level = src.doc.add_object(vec![Object::Integer(1); 64]);
        for _ in 0..40 {
            let a = src.doc.add_object(Object::Reference(level));
            let b = src.doc.add_object(Object::Reference(level));
            level = src.doc.add_object(vec![Object::from(a), b.into()]);
        }
        page_with_evil_font(&mut src, level.into());
        corpus.push(("alias diamond", src.finish()));

        // A name map that contains itself.
        let mut src = Src::new();
        let procs = src.doc.new_object_id();
        let glyph = src
            .doc
            .add_object(Stream::new(dictionary! {}, b"0 0 d0".to_vec()));
        src.doc
            .objects
            .insert(procs, dictionary! { "g" => glyph, "h" => procs }.into());
        let mut font = t3_using(dictionary! {}.into());
        font.as_dict_mut().unwrap().set("CharProcs", procs);
        src.add_page(
            dictionary! { "Font" => dictionary! { "T" => font } },
            b"BT /T 1 Tf ET",
        );
        corpus.push(("name map cycle", src.finish()));

        // Layer /Order: a self-reference, a cycle through a chain, aliases
        // of a wide array, and a doubling DAG.
        let (mut doc, _, ocg) = page_with_layer();
        let order = doc.new_object_id();
        doc.objects
            .insert(order, vec![ocg.into(), order.into(), order.into()].into());
        set_layer_order(&mut doc, ocg, order.into());
        corpus.push(("order self-reference", doc));

        let (mut doc, _, ocg) = page_with_layer();
        let (a, b) = (doc.new_object_id(), (doc.max_id + 2, 0));
        doc.max_id += 1;
        doc.objects.insert(a, Object::Reference(b));
        doc.objects
            .insert(b, vec![ocg.into(), a.into(), b.into()].into());
        set_layer_order(&mut doc, ocg, a.into());
        corpus.push(("order chain cycle", doc));

        let (mut doc, _, ocg) = page_with_layer();
        let mut wide = vec![Object::from(ocg)];
        wide.extend((0..20_000).map(|_| Object::Reference((999_999, 0))));
        let wide = doc.add_object(wide);
        let aliases: Vec<Object> = (0..20_000)
            .map(|_| doc.add_object(Object::Reference(wide)).into())
            .collect();
        set_layer_order(&mut doc, ocg, aliases.into());
        corpus.push(("order alias fan-out", doc));

        let (mut doc, _, ocg) = page_with_layer();
        let mut level = doc.add_object(vec![Object::from(ocg)]);
        for _ in 0..40 {
            level = doc.add_object(vec![Object::from(level), level.into()]);
        }
        set_layer_order(&mut doc, ocg, level.into());
        corpus.push(("order diamond", doc));

        // A named link into a /Dests name tree whose root lists itself.
        let (mut doc, page, _) = page_with_layer();
        let link = doc.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Link",
            "Rect" => vec![0.into(), 0.into(), 1.into(), 1.into()],
            "Dest" => Object::string_literal("x"),
        });
        doc.get_dictionary_mut(page)
            .unwrap()
            .set("Annots", vec![Object::from(link)]);
        let root = doc.new_object_id();
        doc.objects.insert(
            root,
            dictionary! { "Kids" => vec![Object::from(root); 1000], "Names" => vec![] }.into(),
        );
        let catalog = doc.trailer.get(b"Root").unwrap().as_reference().unwrap();
        doc.get_dictionary_mut(catalog)
            .unwrap()
            .set("Names", dictionary! { "Dests" => root });
        corpus.push(("name tree cycle", doc));

        corpus
    }

    #[test]
    fn hostile_graphs_finish_fast_and_small() {
        for (name, doc) in bomb_corpus() {
            let page = doc.get_pages()[&1];
            let pages = [OutPage::Page {
                src: 0,
                page,
                rotate: 0,
            }];
            let start = std::time::Instant::now();
            let (mut out, _) = rebuild_document(&[doc], &pages, &PAGE_TOOLS).unwrap();
            let mut bytes = Vec::new();
            out.save_to(&mut bytes).unwrap();
            let elapsed = start.elapsed();
            assert!(
                elapsed < std::time::Duration::from_secs(1),
                "{name}: took {elapsed:?}"
            );
            assert!(bytes.len() < 1 << 20, "{name}: {} B", bytes.len());
            assert!(Document::load_mem(&bytes).is_ok(), "{name}: unreadable");
        }
    }

    // ---- decoded-content guards -----------------------------------------

    /// Per-thread net heap use, so a test can measure the peak one call
    /// reaches without other test threads interfering.
    mod alloc_meter {
        use std::alloc::{GlobalAlloc, Layout, System};
        use std::cell::Cell;

        thread_local! {
            static NET: Cell<isize> = const { Cell::new(0) };
            static PEAK: Cell<isize> = const { Cell::new(0) };
        }

        fn track(delta: isize) {
            let _ = NET.try_with(|net| {
                let now = net.get() + delta;
                net.set(now);
                let _ = PEAK.try_with(|peak| peak.set(peak.get().max(now)));
            });
        }

        struct Meter;

        unsafe impl GlobalAlloc for Meter {
            unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
                track(layout.size() as isize);
                unsafe { System.alloc(layout) }
            }
            unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
                track(layout.size() as isize);
                unsafe { System.alloc_zeroed(layout) }
            }
            unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
                track(-(layout.size() as isize));
                unsafe { System.dealloc(ptr, layout) }
            }
            unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
                track(new_size as isize - layout.size() as isize);
                unsafe { System.realloc(ptr, layout, new_size) }
            }
        }

        #[global_allocator]
        static METER: Meter = Meter;

        /// Result of `f` and the most heap it held at once beyond what was
        /// live when it started.
        pub fn peak_during<R>(f: impl FnOnce() -> R) -> (R, usize) {
            let base = NET.with(Cell::get);
            PEAK.with(|peak| peak.set(base));
            let result = f();
            (result, (PEAK.with(Cell::get) - base).max(0) as usize)
        }
    }

    /// zlib stream inflating to `1 + 258 * matches` zero bytes: one literal,
    /// then fixed-Huffman back-references (13 bits per 258 bytes).
    fn zero_bomb(matches: usize) -> Vec<u8> {
        let mut out = vec![0x78, 0x01];
        let (mut acc, mut bits) = (0u64, 0u32);
        let mut put = |out: &mut Vec<u8>, value: u64, n: u32| {
            acc |= value << bits;
            bits += n;
            while bits >= 8 {
                out.push(acc as u8);
                acc >>= 8;
                bits -= 8;
            }
        };
        // Huffman codes go most significant bit first.
        let code = |c: u64, n: u32| (0..n).fold(0, |r, i| r | ((c >> (n - 1 - i)) & 1) << i);
        put(&mut out, 0b011, 3); // BFINAL, fixed Huffman
        put(&mut out, code(0x30, 8), 8); // literal 0
        for _ in 0..matches {
            put(&mut out, code(0xC5, 8), 8); // length 258
            put(&mut out, 0, 5); // distance 1
        }
        put(&mut out, 0, 7); // end of block
        put(&mut out, 0, 7); // flush to a byte boundary
        let len = (1 + 258 * matches) as u64;
        let adler = ((len % 65521) << 16) | 1;
        out.extend_from_slice(&(adler as u32).to_be_bytes());
        out
    }

    #[test]
    fn zero_bomb_inflates_as_announced() {
        let bomb = Stream::new(dictionary! { "Filter" => "FlateDecode" }, zero_bomb(1000));
        let plain = bomb.decompressed_content().unwrap();
        assert_eq!(plain.len(), 1 + 258 * 1000);
        assert!(plain.iter().all(|&b| b == 0));
    }

    #[test]
    fn content_bomb_never_inflates_past_the_cap() {
        // ~200 MB of zeros in ~1.2 MB of page content.
        let matches = (200 << 20) / 258;
        let mut src = Src::new();
        let img = src.doc.add_object(image(b"SECRET_BOMBIMG"));
        let page = src.add_page(
            dictionary! { "XObject" => dictionary! { "Im1" => img } },
            b"",
        );
        let bomb = Stream::new(
            dictionary! { "Filter" => "FlateDecode" },
            zero_bomb(matches),
        );
        let content = src.doc.add_object(bomb);
        src.doc
            .get_dictionary_mut(page)
            .unwrap()
            .set("Contents", content);
        let doc = src.finish();
        let page = doc.get_pages()[&1];
        let pages = [OutPage::Page {
            src: 0,
            page,
            rotate: 0,
        }];
        let ((out, report), peak) =
            alloc_meter::peak_during(|| rebuild_document(&[doc], &pages, &PAGE_TOOLS).unwrap());
        assert!(
            peak < MAX_STREAM_DECODED + (16 << 20),
            "peak heap {} MB",
            peak >> 20
        );
        // Over the cap counts as undecodable: every resource is kept.
        assert_eq!(
            report.warnings,
            ["Page 1: content not decodable, kept all resources"]
        );
        let mut bytes = Vec::new();
        out.clone().save_to(&mut bytes).unwrap();
        assert!(contains(&bytes, b"SECRET_BOMBIMG"));
    }

    #[test]
    fn decode_parms_arrays_and_references_reach_their_filter() {
        let zlib = |data: &[u8]| {
            use std::io::Write;
            let mut e = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
            e.write_all(data).unwrap();
            e.finish().unwrap()
        };
        let plain: Vec<u8> = (0..60u8).collect();
        // PNG "Sub" rows of 6 bytes: without the predictor the bytes are wrong.
        let png: Vec<u8> = plain
            .chunks(6)
            .flat_map(|row| {
                std::iter::once(1u8).chain((0..6).map(move |i| if i == 0 { row[0] } else { row[i].wrapping_sub(row[i - 1]) }))
            })
            .collect();
        let params = dictionary! { "Predictor" => 12, "Columns" => 6 };
        let mut doc = Document::with_version("1.7");
        let params_id = doc.add_object(params.clone());
        let flate = || Object::Name(b"FlateDecode".to_vec());
        let cases: Vec<(Dictionary, Vec<u8>, bool)> = vec![
            (dictionary! { "Filter" => vec![flate()], "DecodeParms" => vec![params.clone().into()] }, zlib(&png), false),
            (
                dictionary! { "Filter" => vec![flate(), flate()], "DecodeParms" => vec![Object::Null, params.clone().into()] },
                zlib(&zlib(&png)),
                false,
            ),
            (dictionary! { "Filter" => "FlateDecode", "DecodeParms" => params_id }, zlib(&png), true),
            (dictionary! { "Filter" => vec![flate()], "DecodeParms" => vec![params_id.into()] }, zlib(&png), true),
        ];
        for (dict, content, needs_doc) in cases {
            let stream = Stream::new(dict.clone(), content);
            let mut charged = 0;
            let got = if needs_doc {
                strict_content_in(Some(&doc), &stream, 1 << 20, &mut charged)
            } else {
                strict_content(&stream, 1 << 20, &mut charged)
            };
            assert_eq!(got, Decoded::Content(plain.clone()), "{dict:?}");
        }
    }

    #[test]
    fn bounded_content_matches_lopdf_decoding() {
        let plain: Vec<u8> = (0..4000u32).flat_map(|i| (i % 251).to_le_bytes()).collect();
        let flate = {
            use std::io::Write;
            let mut e = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
            e.write_all(&plain).unwrap();
            e.finish().unwrap()
        };
        // PNG "Up" predictor rows of 4 bytes over `plain`.
        let png: Vec<u8> = plain
            .chunks(4)
            .enumerate()
            .flat_map(|(r, row)| {
                let prev = if r == 0 {
                    [0; 4]
                } else {
                    <[u8; 4]>::try_from(&plain[(r - 1) * 4..r * 4]).unwrap()
                };
                std::iter::once(2u8).chain(row.iter().zip(prev).map(|(b, p)| b.wrapping_sub(p)))
            })
            .collect();
        let png_flate = {
            use std::io::Write;
            let mut e = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
            e.write_all(&png).unwrap();
            e.finish().unwrap()
        };
        let lzw = weezl::encode::Encoder::with_tiff_size_switch(weezl::BitOrder::Msb, 8)
            .encode(&plain)
            .unwrap();
        let a85 = |data: &[u8]| {
            let mut out = Vec::new();
            for chunk in data.chunks(4) {
                let mut word = [0u8; 4];
                word[..chunk.len()].copy_from_slice(chunk);
                let mut n = u32::from_be_bytes(word);
                let mut digits = [0u8; 5];
                for d in digits.iter_mut().rev() {
                    *d = (n % 85) as u8 + b'!';
                    n /= 85;
                }
                out.extend_from_slice(&digits[..chunk.len() + 1]);
            }
            out.extend_from_slice(b"~>");
            out
        };
        let cases: Vec<(Dictionary, Vec<u8>)> = vec![
            (dictionary! {}, plain.clone()),
            (dictionary! { "Filter" => "FlateDecode" }, flate.clone()),
            (
                dictionary! { "Filter" => "FlateDecode",
                "DecodeParms" => dictionary! { "Predictor" => 12, "Columns" => 4 } },
                png_flate,
            ),
            (dictionary! { "Filter" => "LZWDecode" }, lzw),
            (
                dictionary! { "Filter" => vec!["ASCII85Decode".into(), "FlateDecode".into()] },
                a85(&flate),
            ),
            (
                dictionary! { "Filter" => "DCTDecode" },
                b"not decoded".to_vec(),
            ),
            (
                dictionary! { "Filter" => "FlateDecode" },
                flate[..flate.len() / 2].to_vec(),
            ),
        ];
        for (dict, content) in cases {
            let stream = Stream::new(dict.clone(), content);
            let expected = stream
                .decompressed_content()
                .unwrap_or_else(|_| stream.content.clone());
            assert!(!expected.is_empty(), "{dict:?}");
            let mut charged = 0;
            let got = bounded_content(&stream, 1 << 20, &mut charged);
            assert_eq!(got.as_deref(), Some(expected.as_slice()), "{dict:?}");
            assert_eq!(
                bounded_content(&stream, expected.len() - 1, &mut charged),
                None,
                "{dict:?}"
            );
        }
    }

    #[test]
    fn decode_budget_is_shared_by_the_whole_rebuild() {
        let mut src = Src::new();
        let img = src.doc.add_object(image(b"SECRET_USEDIMG"));
        let unused = src.doc.add_object(image(b"SECRET_UNUSEDIMG"));
        let mut content = b"/Im1 Do\n".to_vec();
        content.resize(1000, b' ');
        let res = || dictionary! { "XObject" => dictionary! { "Im1" => img, "Im2" => unused } };
        src.add_page(res(), &content);
        src.add_page(res(), &content);
        let doc = src.finish();
        let pages = doc.get_pages();
        let sources = [doc];
        let mut copier = SafeCopier::new(&sources, false);
        copier.decode_budget = 1500;
        let mut out = Document::with_version("1.7");
        let mut report = RebuildReport::default();
        let first = copy_page(&mut out, &mut copier, 0, pages[&1], 0, &mut report).unwrap();
        assert!(report.warnings.is_empty(), "{:?}", report.warnings);
        let second = copy_page(&mut out, &mut copier, 0, pages[&2], 0, &mut report).unwrap();
        // The budget left (500 B) is below the second page's content: it is
        // not scanned and keeps every resource.
        assert_eq!(
            report.warnings,
            ["Page 2: content not decodable, kept all resources"]
        );
        let bytes = assemble(out, &[first, second]);
        assert!(contains(&bytes, b"SECRET_UNUSEDIMG"));
    }

    #[test]
    fn type3_fonts_sharing_a_large_glyph_scan_it_once() {
        let mut glyph = b"0 0 d0 /ImG Do\n".to_vec();
        while glyph.len() < 128 << 10 {
            glyph.extend_from_slice(b"0 0 m 1 1 l S\n");
        }
        let mut src = Src::new();
        let glyph = src.doc.add_object(Stream::new(dictionary! {}, glyph));
        src.doc
            .get_object_mut(glyph)
            .unwrap()
            .as_stream_mut()
            .unwrap()
            .compress()
            .unwrap();
        let img = src.doc.add_object(image(b"SECRET_T3IMG"));
        let res = src
            .doc
            .add_object(dictionary! { "XObject" => dictionary! { "ImG" => img } });
        let mut fonts = Dictionary::new();
        let mut content = b"BT ".to_vec();
        for i in 0..10_000 {
            let mut font = dictionary! {
                "Type" => "Font", "Subtype" => "Type3", "CharProcs" => dictionary! { "g" => glyph },
            };
            // Half carry /Resources (scanned through `type3_usage`), half
            // draw from the page's (scanned through `expand_usage`).
            if i % 2 == 0 {
                font.set("Resources", res);
            }
            fonts.set(format!("F{i}"), src.doc.add_object(font));
            content.extend_from_slice(format!("/F{i} 1 Tf ").as_bytes());
        }
        content.extend_from_slice(b"ET");
        src.add_page(
            dictionary! { "Font" => fonts, "XObject" => dictionary! { "ImG" => img } },
            &content,
        );
        // Timed on the copy path like `measure`: `rebuild_document` also runs
        // lopdf's `prune_objects`, whose own cost grows with the object count.
        let doc = src.finish();
        let start = std::time::Instant::now();
        let (bytes, _, report) = rebuild(doc, &[1]);
        let elapsed = start.elapsed();
        // The regression this guards against was exponential (minutes, not
        // seconds); debug builds on shared CI runners need headroom.
        let limit = if cfg!(debug_assertions) { 20 } else { 2 };
        assert!(
            elapsed < std::time::Duration::from_secs(limit),
            "took {elapsed:?}"
        );
        assert!(report.warnings.is_empty(), "{:?}", report.warnings);
        assert!(
            contains(&bytes, b"SECRET_T3IMG"),
            "glyph image must be kept"
        );
    }
}
