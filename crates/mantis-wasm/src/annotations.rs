//! Annotations rebuilt by policy (sub-project 2c, Task 2).
//!
//! Source annotations are never copied wholesale (the safe copier would turn
//! them into `null` anyway). Each kept annotation is a NEW dictionary built
//! from an allowlist; only values such as `/AP` streams or `/QuadPoints` go
//! through the copier. Widgets become page content (flattened), so no form
//! field survives. Links and replies whose targets are not in the output are
//! dropped once every page exists (`finish_links`).

use crate::rebuild::{Policy, RebuildReport, SafeCopier, deref, name_of, unbalanced_saves};
use lopdf::{Dictionary, Document, Object, ObjectId, Stream, dictionary};
use std::collections::HashMap;

/// Markup annotations kept as comments when the policy says so.
const MARKUP_SUBTYPES: [&[u8]; 14] = [
    b"Text",
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
];

/// Keys a rebuilt comment may carry. /Popup, /IRT (handled separately), /NM,
/// /P, actions and structure hooks are left out.
const COMMENT_KEYS: [&[u8]; 23] = [
    b"Subtype",
    b"Rect",
    b"Contents",
    b"T",
    b"M",
    b"CreationDate",
    b"Subj",
    b"C",
    b"CA",
    b"F",
    b"AP",
    b"QuadPoints",
    b"InkList",
    b"Vertices",
    b"L",
    b"IC",
    b"BS",
    b"Border",
    b"Name",
    b"DA",
    b"Q",
    b"RD",
    b"LE",
];

/// Annotation flags that keep a widget off the page: Hidden (bit 2) and
/// NoView (bit 6).
const INVISIBLE_FLAGS: i64 = 2 | 32;

/// URI schemes a kept link may open. Anything else (javascript:, file:,
/// data:, smb:, relative URIs) is dropped.
const ALLOWED_SCHEMES: [&str; 3] = ["http", "https", "mailto"];

/// Link targets to resolve once every page exists:
/// (new annotation, new page holding it, source index, source target page).
// Consumed by Task 3 (assembly calls rebuild_annotations then finish_links).
#[allow(dead_code)]
#[derive(Default, Debug)]
pub struct PendingLinks {
    pub items: Vec<(ObjectId, ObjectId, usize, ObjectId)>,
}

/// `/IRT` targets not on the same page:
/// (new reply annotation, source index, source target annotation).
// Consumed by Task 3 (assembly calls rebuild_annotations then finish_links).
#[allow(dead_code)]
#[derive(Default, Debug)]
pub struct PendingReplies {
    pub items: Vec<(ObjectId, usize, ObjectId)>,
}

/// Rebuild the annotations of source page `src_page` onto output page
/// `new_page`: sets /Annots on the new page and appends flattened widget
/// drawing to its content and resources.
// Consumed by Task 3 (page tools, split, sanitize).
#[allow(dead_code, clippy::too_many_arguments)]
pub fn rebuild_annotations(
    out: &mut Document,
    copier: &mut SafeCopier,
    src: usize,
    src_page: ObjectId,
    new_page: ObjectId,
    policy: &Policy,
    report: &mut RebuildReport,
    links: &mut PendingLinks,
    replies: &mut PendingReplies,
    annot_map: &mut HashMap<(usize, ObjectId), ObjectId>,
) -> Result<(), String> {
    let doc = copier.source(src);
    let page = doc
        .get_dictionary(src_page)
        .map_err(|e| format!("Page {src_page:?} not found: {e}"))?;
    let Some(entries) = page
        .get(b"Annots")
        .ok()
        .and_then(|a| deref(doc, a))
        .and_then(|a| a.as_array().ok())
    else {
        return Ok(());
    };

    let mut new_annots: Vec<Object> = Vec::new();
    let mut flattened: Vec<(Object, [f64; 6])> = Vec::new();
    // Source annotation -> rebuilt one, for this page only. Replies resolve
    // against it first so a duplicated page gets its own reply chain.
    let mut local: HashMap<ObjectId, ObjectId> = HashMap::new();
    let mut local_replies: Vec<(ObjectId, ObjectId)> = Vec::new();

    for entry in entries {
        let Some(annot) = deref(doc, entry).and_then(|a| a.as_dict().ok()) else {
            continue;
        };
        match name_of(annot, b"Subtype") {
            Some(b"Link") => {
                if !policy.keep_links {
                    report.links_dropped += 1;
                    continue;
                }
                match rebuild_link(out, copier, src, annot, new_page, links) {
                    Some(LinkKind::Uri(id)) => {
                        report.links_kept += 1;
                        new_annots.push(id.into());
                    }
                    // Counted as kept or dropped by finish_links.
                    Some(LinkKind::Internal(id)) => new_annots.push(id.into()),
                    None => report.links_dropped += 1,
                }
            }
            Some(b"Widget") => {
                if let Some(draw) = flatten_widget(out, copier, src, annot) {
                    flattened.push(draw);
                    report.fields_flattened += 1;
                }
            }
            Some(subtype) if MARKUP_SUBTYPES.contains(&subtype) => {
                if !policy.keep_comments {
                    report.comments_dropped += 1;
                    continue;
                }
                let Some(id) = rebuild_comment(out, copier, src, annot, new_page) else {
                    report.comments_dropped += 1;
                    continue;
                };
                report.comments_kept += 1;
                new_annots.push(id.into());
                if let Ok(old) = entry.as_reference() {
                    local.insert(old, id);
                }
                if let Some(target) = annot.get(b"IRT").ok().and_then(|t| t.as_reference().ok()) {
                    local_replies.push((id, target));
                }
            }
            // Popup and every other subtype (FileAttachment, Sound, Movie,
            // Screen, RichMedia, 3D, Redact, ...) are dropped.
            _ => {}
        }
    }

    for (reply, target) in local_replies {
        match local.get(&target) {
            Some(&new_target) => set_key(out, reply, "IRT", new_target.into()),
            None => replies.items.push((reply, src, target)),
        }
    }
    for (old, new) in local {
        annot_map.entry((src, old)).or_insert(new);
    }
    if !flattened.is_empty() {
        append_flattened(out, new_page, flattened)?;
    }
    if !new_annots.is_empty() {
        set_key(out, new_page, "Annots", new_annots.into());
    }
    Ok(())
}

/// Resolve pending links and replies given (src, src_page) -> first new page
/// id. Links to pages that are not in the output are removed.
// Consumed by Task 3 (assembly, after every page is rebuilt).
#[allow(dead_code)]
pub fn finish_links(
    out: &mut Document,
    page_map: &HashMap<(usize, ObjectId), ObjectId>,
    annot_map: &HashMap<(usize, ObjectId), ObjectId>,
    links: PendingLinks,
    replies: PendingReplies,
    report: &mut RebuildReport,
) {
    for (annot, page, src, target) in links.items {
        if let Some(&new_target) = page_map.get(&(src, target)) {
            let dest: Vec<Object> = vec![new_target.into(), "Fit".into()];
            set_key(out, annot, "Dest", dest.into());
            report.links_kept += 1;
            continue;
        }
        if let Ok(page) = out.get_dictionary_mut(page) {
            let now_empty = match page.get_mut(b"Annots") {
                Ok(Object::Array(items)) => {
                    items.retain(|o| o.as_reference().ok() != Some(annot));
                    items.is_empty()
                }
                _ => false,
            };
            if now_empty {
                page.remove(b"Annots");
            }
        }
        out.objects.remove(&annot);
        report.links_dropped += 1;
    }
    for (reply, src, target) in replies.items {
        if let Some(&new_target) = annot_map.get(&(src, target)) {
            set_key(out, reply, "IRT", new_target.into());
        }
    }
}

enum LinkKind {
    Uri(ObjectId),
    Internal(ObjectId),
}

/// New link annotation for a URI action or an explicit page destination;
/// None for anything else (named destinations, other actions).
fn rebuild_link(
    out: &mut Document,
    copier: &mut SafeCopier,
    src: usize,
    annot: &Dictionary,
    new_page: ObjectId,
    links: &mut PendingLinks,
) -> Option<LinkKind> {
    let doc = copier.source(src);
    let rect = annot.get(b"Rect").ok().and_then(|r| deref(doc, r))?;
    parse_numbers::<4>(doc, rect)?;
    let rect = copier.copy(out, src, rect);
    let border = annot
        .get(b"Border")
        .ok()
        .and_then(|b| deref(doc, b))
        .filter(|b| b.as_array().is_ok())
        .map(|b| copier.copy(out, src, b))
        .unwrap_or_else(|| vec![0.into(), 0.into(), 0.into()].into());
    let mut link = dictionary! {
        "Type" => "Annot",
        "Subtype" => "Link",
        "Rect" => rect,
        "Border" => border,
        "P" => new_page,
    };

    let action = annot
        .get(b"A")
        .ok()
        .and_then(|a| deref(doc, a))
        .and_then(|a| a.as_dict().ok());
    let action_type = action.and_then(|a| name_of(a, b"S"));
    if action_type == Some(b"URI") {
        let uri = action
            .and_then(|a| deref(doc, a.get(b"URI").ok()?))
            .filter(|u| matches!(u, Object::String(bytes, _) if is_allowed_uri(bytes)))?;
        link.set("A", dictionary! { "S" => "URI", "URI" => uri.clone() });
        return Some(LinkKind::Uri(out.add_object(link)));
    }

    let dest = match annot.get(b"Dest") {
        Ok(dest) => dest,
        Err(_) if action_type == Some(b"GoTo") => action?.get(b"D").ok()?,
        Err(_) => return None,
    };
    let target = deref(doc, dest)?
        .as_array()
        .ok()?
        .first()?
        .as_reference()
        .ok()?;
    let id = out.add_object(link);
    links.items.push((id, new_page, src, target));
    Some(LinkKind::Internal(id))
}

/// New comment annotation from the allowlisted keys, values copied safely.
fn rebuild_comment(
    out: &mut Document,
    copier: &mut SafeCopier,
    src: usize,
    annot: &Dictionary,
    new_page: ObjectId,
) -> Option<ObjectId> {
    // /Rect is required; without a usable one the comment has no place.
    parse_numbers::<4>(copier.source(src), annot.get(b"Rect").ok()?)?;
    let mut comment = dictionary! { "Type" => "Annot" };
    for key in COMMENT_KEYS {
        if let Ok(value) = annot.get(key) {
            let copied = copier.copy(out, src, value);
            if !matches!(copied, Object::Null) {
                comment.set(key, copied);
            }
        }
    }
    comment.set("P", new_page);
    Some(out.add_object(comment))
}

/// The copied normal appearance of a visible widget and the `cm` matrix that
/// maps its transformed BBox onto /Rect. None when there is nothing to draw.
fn flatten_widget(
    out: &mut Document,
    copier: &mut SafeCopier,
    src: usize,
    annot: &Dictionary,
) -> Option<(Object, [f64; 6])> {
    let doc = copier.source(src);
    let flags = annot
        .get(b"F")
        .ok()
        .and_then(|f| deref(doc, f))
        .and_then(|f| f.as_i64().ok())
        .unwrap_or(0);
    if flags & INVISIBLE_FLAGS != 0 {
        return None;
    }
    let normal = deref(doc, annot.get(b"AP").ok()?)?
        .as_dict()
        .ok()?
        .get(b"N")
        .ok()?;
    // /N is either the appearance itself or a dictionary of states, of which
    // /AS names the current one.
    let appearance = match deref(doc, normal)? {
        Object::Stream(_) => normal,
        Object::Dictionary(states) => states.get(name_of(annot, b"AS")?).ok()?,
        _ => return None,
    };
    let stream = deref(doc, appearance)?.as_stream().ok()?;

    let [bx0, by0, bx1, by1] = parse_numbers::<4>(doc, stream.dict.get(b"BBox").ok()?)?;
    let [ma, mb, mc, md, me, mf] = stream
        .dict
        .get(b"Matrix")
        .ok()
        .and_then(|m| parse_numbers::<6>(doc, m))
        .unwrap_or([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
    let corners = [(bx0, by0), (bx1, by0), (bx0, by1), (bx1, by1)]
        .map(|(x, y)| (ma * x + mc * y + me, mb * x + md * y + mf));
    let x0 = corners.iter().map(|c| c.0).fold(f64::INFINITY, f64::min);
    let x1 = corners
        .iter()
        .map(|c| c.0)
        .fold(f64::NEG_INFINITY, f64::max);
    let y0 = corners.iter().map(|c| c.1).fold(f64::INFINITY, f64::min);
    let y1 = corners
        .iter()
        .map(|c| c.1)
        .fold(f64::NEG_INFINITY, f64::max);

    let [r0, r1, r2, r3] = parse_numbers::<4>(doc, annot.get(b"Rect").ok()?)?;
    let (rx0, rx1) = (r0.min(r2), r0.max(r2));
    let (ry0, ry1) = (r1.min(r3), r1.max(r3));
    let degenerate = |w: f64| !w.is_finite() || w.abs() < 1e-9;
    if [x1 - x0, y1 - y0, rx1 - rx0, ry1 - ry0]
        .into_iter()
        .any(degenerate)
    {
        return None;
    }
    let a = (rx1 - rx0) / (x1 - x0);
    let d = (ry1 - ry0) / (y1 - y0);
    let cm = [a, 0.0, 0.0, d, rx0 - a * x0, ry0 - d * y0];

    let copied = copier.copy(out, src, appearance);
    match copied {
        Object::Reference(_) => Some((copied, cm)),
        _ => None,
    }
}

/// True when a URI string (PDF text: UTF-16BE with BOM, UTF-8 with BOM, or
/// Latin-1) uses an allowed scheme. Whitespace and control characters are
/// ignored while reading the scheme, as browsers do (`java\nscript:`).
fn is_allowed_uri(bytes: &[u8]) -> bool {
    let text: String = if let Some(utf16) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        let units = utf16
            .chunks_exact(2)
            .map(|pair| u16::from_be_bytes([pair[0], pair[1]]));
        char::decode_utf16(units)
            .map(|c| c.unwrap_or(char::REPLACEMENT_CHARACTER))
            .collect()
    } else if let Some(utf8) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        String::from_utf8_lossy(utf8).into_owned()
    } else {
        bytes.iter().map(|&b| char::from(b)).collect()
    };
    let cleaned: String = text
        .chars()
        .filter(|c| !c.is_whitespace() && !c.is_control())
        .collect();
    let Some((scheme, _)) = cleaned.split_once(':') else {
        return false;
    };
    ALLOWED_SCHEMES
        .iter()
        .any(|allowed| scheme.eq_ignore_ascii_case(allowed))
}

/// `N` numbers from an array (elements may be indirect).
fn parse_numbers<const N: usize>(doc: &Document, obj: &Object) -> Option<[f64; N]> {
    let items = deref(doc, obj)?.as_array().ok()?;
    if items.len() != N {
        return None;
    }
    let mut values = [0.0; N];
    for (value, item) in values.iter_mut().zip(items) {
        *value = f64::from(deref(doc, item)?.as_float().ok()?);
    }
    values.iter().all(|v| v.is_finite()).then_some(values)
}

/// Content-stream number: rounded to 6 decimals, no exponent, no `-0`.
fn fmt_num(v: f64) -> String {
    let r = (v * 1e6).round() / 1e6;
    if r == 0.0 { "0".into() } else { format!("{r}") }
}

/// Draw the flattened appearances on top of the page. The original content
/// is wrapped in `q ... Q` so a graphics state it leaves changed (a `cm`, a
/// clip) does not displace the drawings. Each appearance becomes an XObject
/// resource under a name not already used on the page.
fn append_flattened(
    out: &mut Document,
    page_id: ObjectId,
    flattened: Vec<(Object, [f64; 6])>,
) -> Result<(), String> {
    let page = out
        .get_dictionary(page_id)
        .map_err(|e| format!("Page {page_id:?} not found: {e}"))?;
    // Resolve to owned, direct dictionaries: a referenced one could be shared
    // with another page that must not gain these names.
    let owned = |obj: Result<&Object, lopdf::Error>| match obj {
        Ok(Object::Dictionary(d)) => d.clone(),
        Ok(Object::Reference(id)) => out.get_dictionary(*id).cloned().unwrap_or_default(),
        _ => Dictionary::new(),
    };
    let mut resources = owned(page.get(b"Resources"));
    let mut xobjects = owned(resources.get(b"XObject"));
    let mut contents: Vec<Object> = match page.get(b"Contents") {
        Ok(Object::Array(items)) => items.clone(),
        Ok(other @ Object::Reference(_)) => vec![other.clone()],
        _ => vec![],
    };

    // `q` the original content leaves open would still be on the stack after
    // the wrap's `Q`; close them too. Undecodable content: assume balanced.
    let mut original = Vec::new();
    for id in contents.iter().filter_map(|c| c.as_reference().ok()) {
        if let Ok(stream) = out.get_object(id).and_then(Object::as_stream) {
            original.extend(
                stream
                    .decompressed_content()
                    .unwrap_or_else(|_| stream.content.clone()),
            );
            original.push(b'\n');
        }
    }
    let wrap = !contents.is_empty();
    let mut drawing = String::new();
    if wrap {
        drawing.push_str("Q\n");
        let open = unbalanced_saves(&original).unwrap_or(0);
        drawing.push_str(&"Q\n".repeat(open));
    }
    let mut n = 0usize;
    for (appearance, cm) in flattened {
        let name = loop {
            let candidate = format!("MantisFlat{n}");
            n += 1;
            if !xobjects.has(candidate.as_bytes()) {
                break candidate;
            }
        };
        xobjects.set(name.as_bytes(), appearance);
        let cm = cm.map(fmt_num).join(" ");
        drawing.push_str(&format!("q {cm} cm /{name} Do Q\n"));
    }
    resources.set("XObject", xobjects);

    let uncompressed =
        |bytes: &[u8]| Stream::new(Dictionary::new(), bytes.to_vec()).with_compression(false);
    if wrap {
        let open = out.add_object(uncompressed(b"q\n"));
        contents.insert(0, open.into());
    }
    let draw = out.add_object(uncompressed(drawing.as_bytes()));
    contents.push(draw.into());

    let page = out
        .get_dictionary_mut(page_id)
        .map_err(|e| format!("Page {page_id:?} not found: {e}"))?;
    page.set("Resources", resources);
    page.set("Contents", contents);
    Ok(())
}

/// Set `key` on the output dictionary `id` (no-op if it is not one).
fn set_key(out: &mut Document, id: ObjectId, key: &str, value: Object) {
    if let Ok(dict) = out.get_dictionary_mut(id) {
        dict.set(key, value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rebuild::copy_page;
    use lopdf::{Stream, dictionary};

    const KEEP_ALL: Policy = Policy {
        keep_links: true,
        keep_comments: true,
    };
    const NO_COMMENTS: Policy = Policy {
        keep_links: true,
        keep_comments: false,
    };

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack.windows(needle.len()).any(|w| w == needle)
    }

    fn rect(x0: i64, y0: i64, x1: i64, y1: i64) -> Object {
        vec![x0.into(), y0.into(), x1.into(), y1.into()].into()
    }

    /// Source document builder: a flat page tree; `finish` saves and reloads
    /// so tests run on parsed objects.
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

        fn add_page(&mut self, content: &[u8]) -> ObjectId {
            self.add_page_with(dictionary! {}, content)
        }

        fn add_page_with(&mut self, resources: Dictionary, content: &[u8]) -> ObjectId {
            let content_id = self
                .doc
                .add_object(Stream::new(dictionary! {}, content.to_vec()));
            let id = self.doc.add_object(dictionary! {
                "Type" => "Page",
                "Parent" => self.pages_id,
                "MediaBox" => rect(0, 0, 612, 792),
                "Resources" => resources,
                "Contents" => content_id,
            });
            self.kids.push(id);
            id
        }

        /// Add an indirect annotation to `page`'s /Annots.
        fn annotate(&mut self, page: ObjectId, annot: Dictionary) -> ObjectId {
            let id = self.doc.add_object(annot);
            self.list(page, id);
            id
        }

        /// Append an existing object to `page`'s /Annots.
        fn list(&mut self, page: ObjectId, id: ObjectId) {
            let page = self.doc.get_dictionary_mut(page).unwrap();
            match page.get_mut(b"Annots") {
                Ok(Object::Array(items)) => items.push(id.into()),
                _ => page.set("Annots", vec![Object::from(id)]),
            }
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

    struct Rebuilt {
        out: Document,
        pages: Vec<ObjectId>,
        report: RebuildReport,
        bytes: Vec<u8>,
    }

    impl Rebuilt {
        fn page(&self, i: usize) -> &Dictionary {
            self.out.get_dictionary(self.pages[i]).unwrap()
        }

        fn annots(&self, i: usize) -> Vec<&Dictionary> {
            match self.page(i).get(b"Annots") {
                Ok(Object::Array(items)) => items
                    .iter()
                    .map(|o| self.out.get_dictionary(o.as_reference().unwrap()).unwrap())
                    .collect(),
                _ => vec![],
            }
        }

        /// Decoded content streams of output page `i`, in order.
        fn content_streams(&self, i: usize) -> Vec<Vec<u8>> {
            let ids: Vec<ObjectId> = match self.page(i).get(b"Contents").unwrap() {
                Object::Reference(id) => vec![*id],
                Object::Array(items) => items.iter().map(|o| o.as_reference().unwrap()).collect(),
                other => panic!("unexpected /Contents {other:?}"),
            };
            ids.into_iter()
                .map(|id| {
                    let s = self.out.get_object(id).unwrap().as_stream().unwrap();
                    s.decompressed_content()
                        .unwrap_or_else(|_| s.content.clone())
                })
                .collect()
        }

        /// Concatenated decoded content of output page `i`.
        fn content(&self, i: usize) -> Vec<u8> {
            let ids: Vec<ObjectId> = match self.page(i).get(b"Contents").unwrap() {
                Object::Reference(id) => vec![*id],
                Object::Array(items) => items.iter().map(|o| o.as_reference().unwrap()).collect(),
                other => panic!("unexpected /Contents {other:?}"),
            };
            let mut joined = Vec::new();
            for id in ids {
                let s = self.out.get_object(id).unwrap().as_stream().unwrap();
                joined.extend(
                    s.decompressed_content()
                        .unwrap_or_else(|_| s.content.clone()),
                );
                joined.push(b'\n');
            }
            joined
        }

        fn xobject(&self, i: usize, name: &[u8]) -> &Stream {
            let res = self.page(i).get(b"Resources").unwrap().as_dict().unwrap();
            let xobjects = res.get(b"XObject").unwrap().as_dict().unwrap();
            let id = xobjects.get(name).unwrap().as_reference().unwrap();
            self.out.get_object(id).unwrap().as_stream().unwrap()
        }
    }

    /// Copy source pages (1-based numbers, single source) with annotations,
    /// resolve links, and serialize, mirroring what Task 3's assembly does.
    fn rebuild_pages(src: Document, numbers: &[u32], policy: &Policy) -> Rebuilt {
        let source_pages = src.get_pages();
        let sources = [src];
        let mut copier = SafeCopier::new(&sources);
        let mut out = Document::with_version("1.7");
        let mut report = RebuildReport::default();
        let mut links = PendingLinks::default();
        let mut replies = PendingReplies::default();
        let mut annot_map = HashMap::new();
        let mut page_map = HashMap::new();
        let mut pages = vec![];
        for n in numbers {
            let src_page = source_pages[n];
            let new_page = copy_page(&mut out, &mut copier, 0, src_page, 0, &mut report).unwrap();
            rebuild_annotations(
                &mut out,
                &mut copier,
                0,
                src_page,
                new_page,
                policy,
                &mut report,
                &mut links,
                &mut replies,
                &mut annot_map,
            )
            .unwrap();
            page_map.entry((0, src_page)).or_insert(new_page);
            pages.push(new_page);
        }
        finish_links(&mut out, &page_map, &annot_map, links, replies, &mut report);

        let mut doc = out.clone();
        let pages_id = doc.new_object_id();
        for &p in &pages {
            doc.get_dictionary_mut(p).unwrap().set("Parent", pages_id);
        }
        let kids: Vec<Object> = pages.iter().map(|&id| id.into()).collect();
        doc.objects.insert(
            pages_id,
            Object::Dictionary(
                dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => pages.len() as i64 },
            ),
        );
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", catalog);
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        Rebuilt {
            out,
            pages,
            report,
            bytes,
        }
    }

    fn keys(dict: &Dictionary) -> Vec<String> {
        let mut k: Vec<String> = dict
            .iter()
            .map(|(k, _)| String::from_utf8_lossy(k).into_owned())
            .collect();
        k.sort();
        k
    }

    #[test]
    fn uri_link_kept_minimal() {
        let mut src = Src::new();
        let p1 = src.add_page(b"");
        let js = src.doc.add_object(dictionary! {
            "S" => "JavaScript", "JS" => Object::string_literal("SECRET_AAJS"),
        });
        src.annotate(
            p1,
            dictionary! {
                "Type" => "Annot", "Subtype" => "Link", "Rect" => rect(10, 10, 50, 20),
                "A" => dictionary! { "S" => "URI", "URI" => Object::string_literal("https://x.test"),
                                     "Next" => js },
                "AA" => dictionary! { "E" => js },
                "StructParent" => 3,
                "NM" => Object::string_literal("SECRET_NM"),
            },
        );
        let r = rebuild_pages(src.finish(), &[1], &KEEP_ALL);
        let annots = r.annots(0);
        assert_eq!(annots.len(), 1);
        let link = annots[0];
        assert_eq!(keys(link), ["A", "Border", "P", "Rect", "Subtype", "Type"]);
        assert_eq!(link.get(b"P").unwrap().as_reference().unwrap(), r.pages[0]);
        let action = link.get(b"A").unwrap().as_dict().unwrap();
        assert_eq!(keys(action), ["S", "URI"]);
        assert_eq!(
            action.get(b"URI").unwrap().as_str().unwrap(),
            b"https://x.test"
        );
        assert!(!contains(&r.bytes, b"SECRET_AAJS"));
        assert!(!contains(&r.bytes, b"SECRET_NM"));
        assert_eq!(r.report.links_kept, 1);
    }

    fn two_pages_with_internal_link() -> Document {
        let mut src = Src::new();
        let p1 = src.add_page(b"");
        let p2 = src.add_page(b"(SECRET_PAGE2) Tj");
        src.annotate(
            p1,
            dictionary! {
                "Subtype" => "Link", "Rect" => rect(10, 10, 50, 20),
                "Dest" => vec![p2.into(), "XYZ".into(), 0.into(), 792.into(), Object::Null],
            },
        );
        src.finish()
    }

    #[test]
    fn internal_link_remapped_or_dropped() {
        let r = rebuild_pages(two_pages_with_internal_link(), &[1, 2], &KEEP_ALL);
        let annots = r.annots(0);
        assert_eq!(annots.len(), 1);
        let dest = annots[0].get(b"Dest").unwrap().as_array().unwrap();
        assert_eq!(dest[0].as_reference().unwrap(), r.pages[1]);
        assert_eq!(dest[1].as_name().unwrap(), b"Fit");
        assert_eq!(r.report.links_kept, 1);

        let r = rebuild_pages(two_pages_with_internal_link(), &[1], &KEEP_ALL);
        assert!(r.annots(0).is_empty());
        assert!(!r.page(0).has(b"Annots"));
        assert_eq!(r.report.links_dropped, 1);
        assert_eq!(r.report.links_kept, 0);
        assert!(!contains(&r.bytes, b"SECRET_PAGE2"));
        assert!(!contains(&r.bytes, b"/Link"), "dropped link object removed");
    }

    #[test]
    fn link_to_duplicated_page_points_at_first_copy() {
        let r = rebuild_pages(two_pages_with_internal_link(), &[2, 1, 2], &KEEP_ALL);
        let annots = r.annots(1);
        assert_eq!(annots.len(), 1);
        let dest = annots[0].get(b"Dest").unwrap().as_array().unwrap();
        assert_eq!(dest[0].as_reference().unwrap(), r.pages[0]);
    }

    /// One page with a widget whose appearance is `ap_n`, plus extra keys.
    fn page_with_widget(build: impl FnOnce(&mut Src) -> Dictionary) -> Document {
        let mut src = Src::new();
        let p1 = src.add_page(b"(BODY) Tj");
        let widget = build(&mut src);
        src.annotate(p1, widget);
        src.finish()
    }

    fn appearance(src: &mut Src, content: &[u8], bbox: Object, matrix: Option<Object>) -> ObjectId {
        let mut dict = dictionary! { "Type" => "XObject", "Subtype" => "Form", "BBox" => bbox };
        if let Some(m) = matrix {
            dict.set("Matrix", m);
        }
        src.doc.add_object(Stream::new(dict, content.to_vec()))
    }

    #[test]
    fn widget_flattened_with_state() {
        let doc = page_with_widget(|src| {
            let on = appearance(src, b"(ONSTATE) Tj", rect(0, 0, 10, 10), None);
            let off = appearance(src, b"(OFFSTATE) Tj", rect(0, 0, 10, 10), None);
            dictionary! {
                "Type" => "Annot", "Subtype" => "Widget", "FT" => "Btn",
                "T" => Object::string_literal("SECRET_FIELDNAME"),
                "Rect" => rect(100, 100, 110, 110), "AS" => "On",
                "AP" => dictionary! { "N" => dictionary! { "On" => on, "Off" => off } },
            }
        });
        let r = rebuild_pages(doc, &[1], &KEEP_ALL);
        assert!(r.annots(0).is_empty(), "no widget annotation left");
        let content = r.content(0);
        assert!(contains(&content, b"BODY"), "original content kept");
        assert!(contains(&content, b"/MantisFlat0 Do"));
        let flat = r.xobject(0, b"MantisFlat0");
        assert!(contains(&flat.content, b"ONSTATE"));
        assert!(!contains(&r.bytes, b"OFFSTATE"));
        assert!(!contains(&r.bytes, b"SECRET_FIELDNAME"));
        assert!(!contains(&r.bytes, b"/Widget"));
        assert_eq!(r.report.fields_flattened, 1);
    }

    fn flattened_cm(matrix: Option<Object>) -> String {
        let doc = page_with_widget(|src| {
            let n = appearance(src, b"(X) Tj", rect(0, 0, 100, 50), matrix);
            dictionary! {
                "Subtype" => "Widget", "Rect" => rect(200, 300, 300, 350),
                "AP" => dictionary! { "N" => n },
            }
        });
        let r = rebuild_pages(doc, &[1], &KEEP_ALL);
        assert_eq!(r.report.fields_flattened, 1);
        let content = String::from_utf8(r.content(0)).unwrap();
        let line = content
            .lines()
            .find(|l| l.contains("/MantisFlat0 Do"))
            .expect("draw line")
            .to_string();
        let cm_end = line.find(" cm").unwrap();
        let q = line[..cm_end].rfind('q').unwrap();
        line[q + 1..cm_end].trim().to_string()
    }

    #[test]
    fn flatten_matrix_maps_bbox_to_rect() {
        assert_eq!(flattened_cm(None), "1 0 0 1 200 300");
        assert_eq!(
            flattened_cm(Some(
                vec![1.into(), 0.into(), 0.into(), 1.into(), 0.into(), 0.into()].into()
            )),
            "1 0 0 1 200 300"
        );
        // Rotated 90: BBox [0 0 100 50] maps to x in [-50, 0], y in [0, 100].
        let rotated = vec![
            0.into(),
            1.into(),
            (-1).into(),
            0.into(),
            0.into(),
            0.into(),
        ];
        assert_eq!(flattened_cm(Some(rotated.into())), "2 0 0 0.5 300 300");
    }

    #[test]
    fn hidden_widget_skipped() {
        let doc = page_with_widget(|src| {
            let n = appearance(src, b"(SECRET_HIDDEN) Tj", rect(0, 0, 10, 10), None);
            dictionary! {
                "Subtype" => "Widget", "F" => 2, "Rect" => rect(0, 0, 10, 10),
                "AP" => dictionary! { "N" => n },
            }
        });
        let r = rebuild_pages(doc, &[1], &KEEP_ALL);
        assert!(!contains(&r.content(0), b"MantisFlat"));
        assert!(!contains(&r.bytes, b"SECRET_HIDDEN"));
        assert_eq!(r.report.fields_flattened, 0);
    }

    fn page_with_comments() -> Document {
        let mut src = Src::new();
        let p1 = src.add_page(b"");
        let popup = src.doc.add_object(dictionary! {
            "Subtype" => "Popup", "Rect" => rect(0, 0, 1, 1),
            "Contents" => Object::string_literal("SECRET_POPUP"),
        });
        let highlight = src.annotate(
            p1,
            dictionary! {
                "Type" => "Annot", "Subtype" => "Highlight", "Rect" => rect(10, 10, 100, 20),
                "QuadPoints" => vec![10.into(), 20.into(), 100.into(), 20.into(),
                                     10.into(), 10.into(), 100.into(), 10.into()],
                "Contents" => Object::string_literal("HIGHLIGHT_NOTE"),
                "Popup" => popup,
                "NM" => Object::string_literal("SECRET_NM"),
            },
        );
        src.annotate(
            p1,
            dictionary! {
                "Subtype" => "Text", "Rect" => rect(0, 0, 20, 20),
                "Contents" => Object::string_literal("REPLY_NOTE"), "IRT" => highlight,
                "RT" => "R",
            },
        );
        src.list(p1, popup);
        src.finish()
    }

    #[test]
    fn comments_policy() {
        let r = rebuild_pages(page_with_comments(), &[1], &KEEP_ALL);
        let annots = r.annots(0);
        assert_eq!(annots.len(), 2, "popup dropped, two comments kept");
        let highlight_id = r.page(0).get(b"Annots").unwrap().as_array().unwrap()[0]
            .as_reference()
            .unwrap();
        let (h, t) = (annots[0], annots[1]);
        assert_eq!(h.get(b"Subtype").unwrap().as_name().unwrap(), b"Highlight");
        assert!(h.has(b"QuadPoints"));
        assert!(!h.has(b"Popup"));
        assert_eq!(h.get(b"P").unwrap().as_reference().unwrap(), r.pages[0]);
        assert_eq!(t.get(b"IRT").unwrap().as_reference().unwrap(), highlight_id);
        assert!(!contains(&r.bytes, b"SECRET_POPUP"));
        assert!(!contains(&r.bytes, b"SECRET_NM"));
        assert_eq!(r.report.comments_kept, 2);

        let r = rebuild_pages(page_with_comments(), &[1], &NO_COMMENTS);
        assert!(r.annots(0).is_empty());
        assert_eq!(r.report.comments_dropped, 2);
        assert_eq!(r.report.comments_kept, 0);
        assert!(!contains(&r.bytes, b"HIGHLIGHT_NOTE"));
        assert!(!contains(&r.bytes, b"REPLY_NOTE"));
    }

    #[test]
    fn other_subtypes_dropped() {
        let mut src = Src::new();
        let p1 = src.add_page(b"");
        let file = src.doc.add_object(Stream::new(
            dictionary! { "Type" => "EmbeddedFile" },
            b"SECRETFILE".to_vec(),
        ));
        src.annotate(
            p1,
            dictionary! {
                "Subtype" => "FileAttachment", "Rect" => rect(0, 0, 10, 10),
                "FS" => dictionary! { "Type" => "Filespec", "F" => Object::string_literal("a.txt"),
                                      "EF" => dictionary! { "F" => file } },
            },
        );
        let r = rebuild_pages(src.finish(), &[1], &KEEP_ALL);
        assert!(r.annots(0).is_empty());
        assert!(!contains(&r.bytes, b"SECRETFILE"));
        assert!(!contains(&r.bytes, b"FileAttachment"));
        assert_eq!(r.report.comments_dropped, 0);
    }

    // ---- fix round 1 ----------------------------------------------------

    fn uri_link(src: &mut Src, page: ObjectId, uri: &[u8]) {
        src.annotate(
            page,
            dictionary! {
                "Subtype" => "Link", "Rect" => rect(10, 10, 50, 20),
                "A" => dictionary! { "S" => "URI", "URI" => Object::String(uri.to_vec(), lopdf::StringFormat::Literal) },
            },
        );
    }

    #[test]
    fn uri_link_schemes_filtered() {
        let mut src = Src::new();
        let p1 = src.add_page(b"");
        uri_link(&mut src, p1, b"javascript:alert('SECRET_JS')");
        uri_link(&mut src, p1, b" \tjava\nscript:alert('SECRET_JS2')");
        uri_link(&mut src, p1, b"file:///etc/SECRET_FILE");
        uri_link(&mut src, p1, b"relative/SECRET_REL");
        uri_link(&mut src, p1, b" HTTPS://x.test/ok");
        uri_link(&mut src, p1, b"mailto:a@x.test");
        // UTF-16BE with BOM: "http://u.test"
        let mut utf16 = vec![0xFE, 0xFF];
        utf16.extend("http://u.test".encode_utf16().flat_map(|u| u.to_be_bytes()));
        uri_link(&mut src, p1, &utf16);
        let r = rebuild_pages(src.finish(), &[1], &KEEP_ALL);
        assert_eq!(r.annots(0).len(), 3);
        assert_eq!(r.report.links_kept, 3);
        assert_eq!(r.report.links_dropped, 4);
        assert!(contains(&r.bytes, b"HTTPS://x.test/ok"));
        for secret in [&b"SECRET_JS"[..], b"SECRET_FILE", b"SECRET_REL"] {
            assert!(!contains(&r.bytes, secret));
        }
    }

    #[test]
    fn dashed_border_style_kept_on_comment() {
        let mut src = Src::new();
        let p1 = src.add_page(b"");
        src.annotate(
            p1,
            dictionary! {
                "Subtype" => "Square", "Rect" => rect(10, 10, 50, 50),
                "BS" => dictionary! { "W" => 1, "S" => "D", "D" => vec![3.into(), 2.into()] },
            },
        );
        let r = rebuild_pages(src.finish(), &[1], &KEEP_ALL);
        let annots = r.annots(0);
        assert_eq!(annots.len(), 1);
        let bs = annots[0].get(b"BS").expect("/BS kept").as_dict().unwrap();
        assert_eq!(bs.get(b"S").unwrap().as_name().unwrap(), b"D");
        assert_eq!(bs.get(b"D").unwrap().as_array().unwrap().len(), 2);
    }

    #[test]
    fn unbalanced_original_content_is_closed_before_drawing() {
        let mut src = Src::new();
        let p1 = src.add_page(b"q 2 0 0 2 0 0 cm (BODY) Tj");
        let n = appearance(&mut src, b"(X) Tj", rect(0, 0, 100, 50), None);
        src.annotate(
            p1,
            dictionary! { "Subtype" => "Widget", "Rect" => rect(200, 300, 300, 350),
            "AP" => dictionary! { "N" => n } },
        );
        let r = rebuild_pages(src.finish(), &[1], &KEEP_ALL);
        let streams = r.content_streams(0);
        assert_eq!(streams.first().unwrap(), b"q\n");
        assert_eq!(
            String::from_utf8(streams.last().unwrap().clone()).unwrap(),
            "Q\nQ\nq 1 0 0 1 200 300 cm /MantisFlat0 Do Q\n"
        );
    }

    #[test]
    fn noview_widget_skipped() {
        let doc = page_with_widget(|src| {
            let n = appearance(src, b"(SECRET_NOVIEW) Tj", rect(0, 0, 10, 10), None);
            dictionary! {
                "Subtype" => "Widget", "F" => 32, "Rect" => rect(0, 0, 10, 10),
                "AP" => dictionary! { "N" => n },
            }
        });
        let r = rebuild_pages(doc, &[1], &KEEP_ALL);
        assert!(!contains(&r.content(0), b"MantisFlat"));
        assert!(!contains(&r.bytes, b"SECRET_NOVIEW"));
        assert_eq!(r.report.fields_flattened, 0);
    }

    #[test]
    fn comment_without_valid_rect_dropped() {
        let mut src = Src::new();
        let p1 = src.add_page(b"");
        src.annotate(
            p1,
            dictionary! { "Subtype" => "Text", "Contents" => Object::string_literal("NORECT") },
        );
        src.annotate(
            p1,
            dictionary! { "Subtype" => "Text", "Rect" => vec![0.into(), 0.into(), 1.into()],
            "Contents" => Object::string_literal("SHORTRECT") },
        );
        let r = rebuild_pages(src.finish(), &[1], &KEEP_ALL);
        assert!(r.annots(0).is_empty());
        assert_eq!(r.report.comments_dropped, 2);
        assert_eq!(r.report.comments_kept, 0);
        assert!(!contains(&r.bytes, b"NORECT"));
        assert!(!contains(&r.bytes, b"SHORTRECT"));
    }

    #[test]
    fn non_normalized_rect_is_normalized() {
        let doc = page_with_widget(|src| {
            let n = appearance(src, b"(X) Tj", rect(0, 0, 100, 50), None);
            dictionary! { "Subtype" => "Widget", "Rect" => rect(300, 350, 200, 300),
            "AP" => dictionary! { "N" => n } }
        });
        let r = rebuild_pages(doc, &[1], &KEEP_ALL);
        let content = String::from_utf8(r.content(0)).unwrap();
        assert!(
            content.contains("q 1 0 0 1 200 300 cm /MantisFlat0 Do Q"),
            "{content}"
        );
    }

    #[test]
    fn two_widgets_single_wrap() {
        let mut src = Src::new();
        let p1 = src.add_page(b"(BODY) Tj");
        for x in [0, 100] {
            let n = appearance(&mut src, b"(X) Tj", rect(0, 0, 10, 10), None);
            src.annotate(
                p1,
                dictionary! { "Subtype" => "Widget", "Rect" => rect(x, 0, x + 10, 10),
                "AP" => dictionary! { "N" => n } },
            );
        }
        let r = rebuild_pages(src.finish(), &[1], &KEEP_ALL);
        let streams = r.content_streams(0);
        assert_eq!(streams.len(), 3, "q wrapper, original, one drawing stream");
        assert_eq!(streams.iter().filter(|s| s.as_slice() == b"q\n").count(), 1);
        let drawing = String::from_utf8(streams[2].clone()).unwrap();
        assert!(drawing.contains("/MantisFlat0 Do"));
        assert!(drawing.contains("/MantisFlat1 Do"));
        assert_eq!(
            drawing.matches("Q\n").count(),
            3,
            "one wrap Q + one per drawing"
        );
        assert_eq!(r.report.fields_flattened, 2);
    }

    #[test]
    fn existing_mantisflat_name_not_overwritten() {
        let mut src = Src::new();
        let img = src.doc.add_object(Stream::new(
            dictionary! { "Type" => "XObject", "Subtype" => "Image", "Width" => 1, "Height" => 1,
            "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8 },
            b"ORIGINAL_IMAGE".to_vec(),
        ));
        let p1 = src.add_page_with(
            dictionary! { "XObject" => dictionary! { "MantisFlat0" => img } },
            b"/MantisFlat0 Do",
        );
        let n = appearance(&mut src, b"(WIDGET) Tj", rect(0, 0, 10, 10), None);
        src.annotate(
            p1,
            dictionary! { "Subtype" => "Widget", "Rect" => rect(0, 0, 10, 10),
            "AP" => dictionary! { "N" => n } },
        );
        let r = rebuild_pages(src.finish(), &[1], &KEEP_ALL);
        assert!(contains(
            &r.xobject(0, b"MantisFlat0").content,
            b"ORIGINAL_IMAGE"
        ));
        assert!(contains(&r.xobject(0, b"MantisFlat1").content, b"WIDGET"));
        assert!(contains(&r.content(0), b"/MantisFlat1 Do"));
    }

    /// Page 1: Highlight. Page 2: Text replying to it.
    fn cross_page_reply() -> Document {
        let mut src = Src::new();
        let p1 = src.add_page(b"");
        let p2 = src.add_page(b"");
        let highlight = src.annotate(
            p1,
            dictionary! { "Subtype" => "Highlight", "Rect" => rect(0, 0, 10, 10),
            "Contents" => Object::string_literal("SECRET_PAGE1_NOTE") },
        );
        src.annotate(
            p2,
            dictionary! { "Subtype" => "Text", "Rect" => rect(0, 0, 10, 10), "IRT" => highlight },
        );
        src.finish()
    }

    #[test]
    fn cross_page_reply_resolved() {
        let r = rebuild_pages(cross_page_reply(), &[1, 2], &KEEP_ALL);
        let highlight = r.page(0).get(b"Annots").unwrap().as_array().unwrap()[0]
            .as_reference()
            .unwrap();
        let reply = r.annots(1)[0];
        assert_eq!(
            reply.get(b"IRT").unwrap().as_reference().unwrap(),
            highlight
        );
    }

    #[test]
    fn reply_to_dropped_page_has_no_irt() {
        let r = rebuild_pages(cross_page_reply(), &[2], &KEEP_ALL);
        let annots = r.annots(0);
        assert_eq!(annots.len(), 1);
        assert!(!annots[0].has(b"IRT"));
        assert!(!contains(&r.bytes, b"SECRET_PAGE1_NOTE"));
    }

    #[test]
    fn inline_annotation_and_indirect_annots_array() {
        let mut src = Src::new();
        let p1 = src.add_page(b"");
        let p2 = src.add_page(b"");
        let inline = dictionary! { "Subtype" => "Text", "Rect" => rect(0, 0, 10, 10),
        "Contents" => Object::string_literal("INLINE_NOTE") };
        src.doc
            .get_dictionary_mut(p1)
            .unwrap()
            .set("Annots", vec![Object::Dictionary(inline)]);
        let note = src.doc.add_object(
            dictionary! { "Subtype" => "Text", "Rect" => rect(0, 0, 10, 10),
            "Contents" => Object::string_literal("INDIRECT_NOTE") },
        );
        let array = src.doc.add_object(vec![Object::from(note)]);
        src.doc.get_dictionary_mut(p2).unwrap().set("Annots", array);
        let r = rebuild_pages(src.finish(), &[1, 2], &KEEP_ALL);
        assert_eq!(r.annots(0).len(), 1);
        assert_eq!(r.annots(1).len(), 1);
        assert!(contains(&r.bytes, b"INLINE_NOTE"));
        assert!(contains(&r.bytes, b"INDIRECT_NOTE"));
        assert_eq!(r.report.comments_kept, 2);
    }
}
