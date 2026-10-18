//! Extract the images drawn by a PDF's pages.
//!
//! Pages are walked in order through their /XObject resources (Form
//! XObjects recursively, with cycle and depth guards). Each image object is
//! extracted once, credited to the first page that uses it. A JPEG
//! (/DCTDecode) comes back as its original bytes; anything else is decoded
//! within budgets and converted to RGBA8 by `colour`. Inline images (BI/ID/EI
//! in page and form content) cannot be extracted; they are counted.

use std::collections::{BTreeMap, HashSet};

use lopdf::{Dictionary, Document, Object, ObjectId, Stream};

use super::colour::{self, Base, Invalid, Layout, Space};
use crate::pdf_util::{get_inherited_attr, load_pdf};
use crate::rebuild::{Decoded, MAX_STREAM_DECODED, count_inline_images, deref, filter_params, name_of, strict_content_in};

pub enum ExtractedKind {
    Jpeg(Vec<u8>),
    Rgba { width: u32, height: u32, pixels: Vec<u8> },
}

pub struct Extracted {
    /// 1-based page number of the first page that uses the image.
    pub page: u32,
    /// 1-based order of the image among those extracted for that page.
    pub index: u32,
    pub kind: ExtractedKind,
}

pub struct ExtractResult {
    pub images: Vec<Extracted>,
    /// (reason, count), sorted by reason. "alpha dropped" counts images that
    /// were extracted, but opaque because their mask could not be applied.
    pub skipped: Vec<(String, u32)>,
}

/// Deepest Form XObject nesting walked.
const MAX_DEPTH: usize = 16;
/// Decoded bytes all image streams of one job may produce together.
const JOB_DECODED: usize = 512 << 20;
/// RGBA pixels one job may produce together.
const JOB_PIXELS: u64 = 400_000_000;
/// Decoded bytes of an /Indexed lookup stream (256 entries of 4 bytes, with
/// room for trailing junk).
const MAX_LOOKUP: usize = 64 << 10;
/// Deepest chain of colour space indirections (named resources, /Alternate).
const MAX_SPACE_DEPTH: usize = 8;

type Skip = &'static str;
const COLOUR_SPACE: Skip = "colour space";
const CORRUPT: Skip = "corrupt";
const TOO_LARGE: Skip = "too large";
const BUDGET: Skip = "budget";
const INLINE: Skip = "inline";
const ALPHA_DROPPED: Skip = "alpha dropped";

pub fn extract_images(pdf: &[u8]) -> Result<ExtractResult, String> {
    Ok(extract_from_doc(&load_pdf(pdf)?))
}

pub(crate) fn extract_from_doc(doc: &Document) -> ExtractResult {
    extract_within(doc, JOB_DECODED, JOB_PIXELS)
}

/// `extract_from_doc` with explicit job budgets (decoded bytes, pixels).
fn extract_within(doc: &Document, max_decoded: usize, max_pixels: u64) -> ExtractResult {
    let mut walker = Walker {
        doc,
        max_decoded,
        max_pixels,
        seen_images: HashSet::new(),
        seen_forms: HashSet::new(),
        images: Vec::new(),
        skipped: BTreeMap::new(),
        charged: 0,
        content_charged: 0,
        pixels: 0,
    };
    for (page, page_id) in doc.get_pages() {
        if let Ok(page_dict) = doc.get_dictionary(page_id) {
            let streams: Vec<&Stream> = match page_dict.get(b"Contents").ok().and_then(|c| deref(doc, c)) {
                Some(Object::Stream(s)) => vec![s],
                Some(Object::Array(items)) => items
                    .iter()
                    .filter_map(|o| deref(doc, o).and_then(|o| o.as_stream().ok()))
                    .collect(),
                _ => Vec::new(),
            };
            walker.count_inline(&streams);
        }
        if let Some(resources) = get_inherited_attr(doc, page_id, b"Resources") {
            let mut index = 0;
            walker.walk(&resources, page, &mut index, 0);
        }
    }
    ExtractResult {
        images: walker.images,
        skipped: walker.skipped.into_iter().map(|(r, n)| (r.to_string(), n)).collect(),
    }
}

/// Decodes single images for editing their pixels (redaction), with the
/// same conversions and budgets as extraction.
pub(crate) struct ImageDecoder<'d> {
    walker: Walker<'d>,
}

impl<'d> ImageDecoder<'d> {
    /// A decoder that may decode `max_decoded` bytes in all.
    pub(crate) fn new(doc: &'d Document, max_decoded: usize) -> ImageDecoder<'d> {
        let walker = Walker {
            doc,
            max_decoded,
            max_pixels: JOB_PIXELS,
            seen_images: HashSet::new(),
            seen_forms: HashSet::new(),
            images: Vec::new(),
            skipped: BTreeMap::new(),
            charged: 0,
            content_charged: 0,
            pixels: 0,
        };
        ImageDecoder { walker }
    }

    /// `(width, height, RGBA)` of a non-JPEG image, without its /SMask or
    /// /Mask; an /ImageMask comes back black where it paints and transparent
    /// elsewhere. Errors name why it cannot be decoded (JPEG included).
    pub(crate) fn rgba(&mut self, stream: &Stream, res: &Dictionary) -> Result<(usize, usize, Vec<u8>), &'static str> {
        let filters: Vec<&[u8]> = match stream.dict.get(b"Filter") {
            Err(_) => Vec::new(),
            Ok(_) => stream.filters().map_err(|_| CORRUPT)?,
        };
        for filter in filters {
            match filter {
                b"JPXDecode" => return Err("jpeg2000"),
                b"JBIG2Decode" => return Err("jbig2"),
                b"CCITTFaxDecode" => return Err("ccitt"),
                b"DCTDecode" => return Err("jpeg"),
                _ => {}
            }
        }
        let (layout, rgba, _) = self.walker.opaque_rgba(stream, res)?;
        self.walker.pixels += layout.pixels() as u64;
        Ok((layout.width, layout.height, rgba))
    }

    /// Alpha (one byte per pixel) of the /SMask or /Mask stream of `dict` for
    /// an image of `width` x `height`. Ok(None): no mask. Err: a mask that
    /// cannot be applied (other size, undecodable, colour-key array).
    pub(crate) fn alpha(&mut self, dict: &Dictionary, width: usize, height: usize) -> Result<Option<Vec<u8>>, ()> {
        let layout = Layout::new(width as i64, height as i64, 8, 1).map_err(|_| ())?;
        self.walker.alpha(dict, &layout)
    }

    /// Decoded bytes charged so far.
    pub(crate) fn charged(&self) -> usize {
        self.walker.charged
    }
}

struct Walker<'d> {
    doc: &'d Document,
    seen_images: HashSet<ObjectId>,
    seen_forms: HashSet<ObjectId>,
    images: Vec<Extracted>,
    skipped: BTreeMap<Skip, u32>,
    max_decoded: usize,
    max_pixels: u64,
    /// Decoded image bytes so far (against `max_decoded`).
    charged: usize,
    /// Decoded content bytes scanned for inline images (against `max_decoded`).
    content_charged: usize,
    /// RGBA pixels so far (against `max_pixels`).
    pixels: u64,
}

impl<'d> Walker<'d> {
    fn skip(&mut self, reason: Skip) {
        self.skip_n(reason, 1);
    }

    fn skip_n(&mut self, reason: Skip, n: u32) {
        if n > 0 {
            *self.skipped.entry(reason).or_insert(0) += n;
        }
    }

    /// Count the inline images of content split over `streams`. Content that
    /// cannot be decoded or scanned within the budget is not counted.
    fn count_inline(&mut self, streams: &[&Stream]) {
        let mut joined = Vec::new();
        for stream in streams {
            let left = self.max_decoded.saturating_sub(self.content_charged);
            if left == 0 {
                return;
            }
            match strict_content_in(Some(self.doc), stream, MAX_STREAM_DECODED.min(left), &mut self.content_charged) {
                Decoded::Content(data) => {
                    joined.extend_from_slice(&data);
                    joined.push(b'\n');
                }
                _ => return,
            }
        }
        if let Some(n) = count_inline_images(&joined) {
            self.skip_n(INLINE, u32::try_from(n).unwrap_or(u32::MAX));
        }
    }

    /// Visit the /XObject entries of a resource dictionary.
    fn walk(&mut self, resources: &Object, page: u32, index: &mut u32, depth: usize) {
        let doc = self.doc;
        let Some(Object::Dictionary(res)) = deref(doc, resources) else {
            return;
        };
        let Some(Object::Dictionary(xobjects)) = res.get(b"XObject").ok().and_then(|o| deref(doc, o)) else {
            return;
        };
        for (_, value) in xobjects.iter() {
            let id = match value {
                Object::Reference(id) => Some(*id),
                _ => None,
            };
            let Some(Object::Stream(stream)) = deref(doc, value) else {
                continue;
            };
            match name_of(&stream.dict, b"Subtype") {
                Some(b"Image") => match id {
                    None => self.skip(INLINE),
                    Some(id) if self.seen_images.insert(id) => match self.image(stream, res) {
                        Ok(kind) => {
                            *index += 1;
                            self.images.push(Extracted { page, index: *index, kind });
                        }
                        Err(reason) => self.skip(reason),
                    },
                    Some(_) => {}
                },
                Some(b"Form") if depth < MAX_DEPTH && id.is_none_or(|id| self.seen_forms.insert(id)) => {
                    self.count_inline(&[stream]);
                    if let Ok(inner) = stream.dict.get(b"Resources") {
                        self.walk(inner, page, index, depth + 1);
                    }
                }
                _ => {}
            }
        }
    }

    /// One image object, or the reason it is skipped.
    fn image(&mut self, stream: &Stream, res: &Dictionary) -> Result<ExtractedKind, Skip> {
        let filters: Vec<&[u8]> = match stream.dict.get(b"Filter") {
            Err(_) => Vec::new(),
            Ok(_) => stream.filters().map_err(|_| CORRUPT)?,
        };
        for filter in &filters {
            match *filter {
                b"JPXDecode" => return Err("jpeg2000"),
                b"JBIG2Decode" => return Err("jbig2"),
                b"CCITTFaxDecode" => return Err("ccitt"),
                _ => {}
            }
        }
        if let Some((&last, outer)) = filters.split_last()
            && last == b"DCTDecode"
        {
            let jpeg = self.jpeg(stream, outer)?;
            if self.has_mask(&stream.dict) {
                self.skip(ALPHA_DROPPED);
            }
            return Ok(ExtractedKind::Jpeg(jpeg));
        }

        let (layout, mut rgba, masked) = self.opaque_rgba(stream, res)?;
        if masked {
            match self.alpha(&stream.dict, &layout) {
                Ok(Some(alpha)) => colour::apply_alpha(&mut rgba, &alpha),
                Ok(None) => {}
                Err(()) => self.skip(ALPHA_DROPPED),
            }
        }
        self.pixels += layout.pixels() as u64;
        Ok(ExtractedKind::Rgba { width: layout.width as u32, height: layout.height as u32, pixels: rgba })
    }

    /// RGBA of a non-JPEG image before its /SMask or /Mask (stencil masks:
    /// black where they paint, transparent elsewhere), and whether such a
    /// mask may apply (false for stencil masks). Checks, but does not
    /// charge, the pixel budget.
    fn opaque_rgba(&mut self, stream: &Stream, res: &Dictionary) -> Result<(Layout, Vec<u8>, bool), Skip> {
        let dict = &stream.dict;
        let mask = self.bool_of(dict, b"ImageMask");
        let (space, bpc) = if mask {
            (None, 1)
        } else {
            let cs = dict.get(b"ColorSpace").map_err(|_| COLOUR_SPACE)?;
            let space = self.space(cs, res, 0)?;
            (Some(space), self.int_of(dict, b"BitsPerComponent").ok_or(CORRUPT)?)
        };
        let components = space.as_ref().map_or(1, Space::components);
        let layout = self.layout(dict, bpc, components)?;
        let pixels = layout.pixels() as u64;
        if self.pixels + pixels > self.max_pixels {
            return Err(BUDGET);
        }
        let data = self.samples(stream, &layout)?;
        let decode = self.decode_of(dict);
        let rgba = match &space {
            None => colour::stencil_rgba(&data, &layout, decode.as_deref()),
            Some(space) => colour::to_rgba(&data, &layout, space, decode.as_deref()),
        }
        .ok_or(CORRUPT)?;
        Ok((layout, rgba, space.is_some()))
    }

    /// The JPEG inside a /DCTDecode image: its raw bytes, or (behind other
    /// filters) the bytes those filters decode to.
    fn jpeg(&mut self, stream: &Stream, outer: &[&[u8]]) -> Result<Vec<u8>, Skip> {
        if outer.is_empty() {
            return Ok(stream.content.clone());
        }
        let mut dict = Dictionary::new();
        dict.set("Filter", outer.iter().map(|f| Object::Name(f.to_vec())).collect::<Vec<_>>());
        // The outer filters keep their own parameters (an array loses the
        // entry of the DCTDecode filter).
        if let Ok(params) = stream.dict.get(b"DecodeParms") {
            match deref(self.doc, params) {
                Some(Object::Array(items)) => {
                    dict.set("DecodeParms", items.iter().take(outer.len()).cloned().collect::<Vec<_>>())
                }
                _ => dict.set("DecodeParms", params.clone()),
            }
        }
        self.decoded(&Stream::new(dict, stream.content.clone()))
    }

    /// Sample data of an image: decoded within the budgets and at least as
    /// long as the layout needs.
    fn samples(&mut self, stream: &Stream, layout: &Layout) -> Result<Vec<u8>, Skip> {
        if layout.data_len() > MAX_STREAM_DECODED {
            return Err(TOO_LARGE);
        }
        if self.charged + layout.data_len() > self.max_decoded {
            return Err(BUDGET);
        }
        let mut data = self.decoded(stream)?;
        self.undo_tiff_predictor(stream, &mut data)?;
        if data.len() < layout.data_len() {
            return Err(CORRUPT);
        }
        Ok(data)
    }

    /// Undo a TIFF predictor (/Predictor 2) after Flate or LZW, which the
    /// decoders leave in place: 8 and 16 bits per component, else corrupt.
    fn undo_tiff_predictor(&self, stream: &Stream, data: &mut [u8]) -> Result<(), Skip> {
        let Ok(filters) = stream.filters() else {
            return Ok(());
        };
        let Some(&last) = filters.last() else {
            return Ok(());
        };
        if last != b"FlateDecode" && last != b"LZWDecode" {
            return Ok(());
        }
        let Some(Some(params)) = filter_params(Some(self.doc), stream, filters.len()).pop() else {
            return Ok(());
        };
        let int = |key: &[u8], default: i64| self.int_of(params, key).unwrap_or(default);
        if int(b"Predictor", 1) != 2 {
            return Ok(());
        }
        let (colors, columns, bits) = (int(b"Colors", 1), int(b"Columns", 1), int(b"BitsPerComponent", 8));
        if !(1..=32).contains(&colors) || columns < 1 || !matches!(bits, 8 | 16) {
            return Err(CORRUPT);
        }
        let (colors, bytes) = (colors as usize, bits as usize / 8);
        let row = usize::try_from(columns)
            .ok()
            .and_then(|c| c.checked_mul(colors * bytes))
            .filter(|&row| row <= data.len())
            .ok_or(CORRUPT)?;
        for row in data.chunks_exact_mut(row) {
            if bytes == 1 {
                for i in colors..row.len() {
                    row[i] = row[i].wrapping_add(row[i - colors]);
                }
            } else {
                for i in colors..row.len() / 2 {
                    let prev = u16::from_be_bytes([row[2 * (i - colors)], row[2 * (i - colors) + 1]]);
                    let cur = u16::from_be_bytes([row[2 * i], row[2 * i + 1]]);
                    row[2 * i..2 * i + 2].copy_from_slice(&cur.wrapping_add(prev).to_be_bytes());
                }
            }
        }
        Ok(())
    }

    /// A stream's content after its filters, charged to the job budget.
    fn decoded(&mut self, stream: &Stream) -> Result<Vec<u8>, Skip> {
        if self.charged >= self.max_decoded {
            return Err(BUDGET);
        }
        let cap = MAX_STREAM_DECODED.min(self.max_decoded - self.charged);
        match strict_content_in(Some(self.doc), stream, cap, &mut self.charged) {
            Decoded::Content(data) => Ok(data),
            Decoded::TooLarge if cap < MAX_STREAM_DECODED => Err(BUDGET),
            Decoded::TooLarge => Err(TOO_LARGE),
            Decoded::Failed => Err(CORRUPT),
        }
    }

    /// True when the image has an /SMask or /Mask entry (of any kind).
    fn has_mask(&self, dict: &Dictionary) -> bool {
        [b"SMask".as_slice(), b"Mask"]
            .iter()
            .any(|key| dict.get(key).ok().and_then(|o| deref(self.doc, o)).is_some_and(|o| !matches!(o, Object::Null)))
    }

    /// Alpha from a same-size /SMask (soft mask) or /Mask (stencil) stream.
    /// Ok(None): no mask. Err: a mask that cannot be applied (other
    /// dimensions, undecodable, over a budget, a colour-key /Mask array);
    /// the image then stays opaque.
    fn alpha(&mut self, dict: &Dictionary, image: &Layout) -> Result<Option<Vec<u8>>, ()> {
        let doc = self.doc;
        let get = |key: &[u8]| dict.get(key).ok().and_then(|o| deref(doc, o)).filter(|o| !matches!(o, Object::Null));
        let (mask, stencil) = match (get(b"SMask"), get(b"Mask")) {
            (Some(Object::Stream(s)), _) => (s, false),
            (Some(_), _) => return Err(()),
            (None, Some(Object::Stream(s))) => (s, true),
            (None, Some(_)) => return Err(()),
            (None, None) => return Ok(None),
        };
        let bpc = if stencil { 1 } else { self.int_of(&mask.dict, b"BitsPerComponent").ok_or(())? };
        let layout = self.layout(&mask.dict, bpc, 1).map_err(|_| ())?;
        if (layout.width, layout.height) != (image.width, image.height) {
            return Err(());
        }
        let data = self.samples(mask, &layout).map_err(|_| ())?;
        let decode = self.decode_of(&mask.dict);
        let alpha = if stencil {
            colour::stencil_alpha(&data, &layout, decode.as_deref())
        } else {
            colour::gray_alpha(&data, &layout, decode.as_deref())
        };
        alpha.map(Some).ok_or(())
    }

    fn layout(&self, dict: &Dictionary, bpc: i64, components: usize) -> Result<Layout, Skip> {
        let width = self.int_of(dict, b"Width").ok_or(CORRUPT)?;
        let height = self.int_of(dict, b"Height").ok_or(CORRUPT)?;
        Layout::new(width, height, bpc, components).map_err(|e| match e {
            Invalid::Corrupt => CORRUPT,
            Invalid::TooLarge => TOO_LARGE,
        })
    }

    fn int_of(&self, dict: &Dictionary, key: &[u8]) -> Option<i64> {
        match deref(self.doc, dict.get(key).ok()?)? {
            Object::Integer(i) => Some(*i),
            Object::Real(r) if r.fract() == 0.0 && r.is_finite() => Some(*r as i64),
            _ => None,
        }
    }

    fn bool_of(&self, dict: &Dictionary, key: &[u8]) -> bool {
        dict.get(key).ok().and_then(|o| deref(self.doc, o)).and_then(|o| o.as_bool().ok()) == Some(true)
    }

    /// The /Decode array as numbers, None when absent or malformed.
    fn decode_of(&self, dict: &Dictionary) -> Option<Vec<f64>> {
        let Object::Array(items) = deref(self.doc, dict.get(b"Decode").ok()?)? else {
            return None;
        };
        items
            .iter()
            .map(|v| match deref(self.doc, v)? {
                Object::Integer(i) => Some(*i as f64),
                Object::Real(r) => Some(f64::from(*r)),
                _ => None,
            })
            .collect()
    }

    /// Resolve an image colour space (a name, a named resource, or an array).
    fn space(&mut self, obj: &Object, res: &Dictionary, depth: usize) -> Result<Space, Skip> {
        let doc = self.doc;
        if depth > MAX_SPACE_DEPTH {
            return Err(COLOUR_SPACE);
        }
        match deref(doc, obj).ok_or(COLOUR_SPACE)? {
            Object::Name(name) => match name.as_slice() {
                b"DeviceGray" | b"G" | b"CalGray" => Ok(Space::Device(Base::Gray)),
                b"DeviceRGB" | b"RGB" | b"CalRGB" => Ok(Space::Device(Base::Rgb)),
                b"DeviceCMYK" | b"CMYK" | b"CalCMYK" => Ok(Space::Device(Base::Cmyk)),
                other => {
                    let named = res
                        .get(b"ColorSpace")
                        .ok()
                        .and_then(|o| deref(doc, o))
                        .and_then(|o| o.as_dict().ok())
                        .and_then(|d| d.get(other).ok())
                        .ok_or(COLOUR_SPACE)?;
                    self.space(named, res, depth + 1)
                }
            },
            Object::Array(items) => {
                let family = items.first().and_then(|o| deref(doc, o)).and_then(|o| o.as_name().ok());
                match family.ok_or(COLOUR_SPACE)? {
                    b"ICCBased" => {
                        let Some(Object::Stream(icc)) = items.get(1).and_then(|o| deref(doc, o)) else {
                            return Err(COLOUR_SPACE);
                        };
                        if let Some(base) = self.int_of(&icc.dict, b"N").and_then(Base::from_components) {
                            return Ok(Space::Device(base));
                        }
                        let alternate = icc.dict.get(b"Alternate").map_err(|_| COLOUR_SPACE)?;
                        self.space(alternate, res, depth + 1)
                    }
                    b"Indexed" | b"I" => self.indexed(items, res, depth),
                    b"CalGray" | b"CalRGB" | b"CalCMYK" | b"DeviceGray" | b"DeviceRGB" | b"DeviceCMYK" => {
                        self.space(&items[0], res, depth + 1)
                    }
                    _ => Err(COLOUR_SPACE),
                }
            }
            _ => Err(COLOUR_SPACE),
        }
    }

    /// [/Indexed base hival lookup] over a Gray, RGB or CMYK base.
    fn indexed(&mut self, items: &[Object], res: &Dictionary, depth: usize) -> Result<Space, Skip> {
        let doc = self.doc;
        let [_, base, hival, lookup] = items else {
            return Err(COLOUR_SPACE);
        };
        let Space::Device(base) = self.space(base, res, depth + 1)? else {
            return Err(COLOUR_SPACE);
        };
        let hival = match deref(doc, hival) {
            Some(Object::Integer(h)) => u8::try_from(*h).map_err(|_| COLOUR_SPACE)?,
            _ => return Err(COLOUR_SPACE),
        };
        let lookup = match deref(doc, lookup) {
            Some(Object::String(bytes, _)) => bytes.clone(),
            Some(Object::Stream(s)) => {
                let mut charged = 0;
                match strict_content_in(Some(doc), s, MAX_LOOKUP, &mut charged) {
                    Decoded::Content(data) => data,
                    _ => return Err(CORRUPT),
                }
            }
            _ => return Err(COLOUR_SPACE),
        };
        Ok(Space::Indexed { base, hival, lookup })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{Dictionary, Document, Object, ObjectId, Stream, dictionary};
    use std::io::Write;

    fn flate(data: &[u8]) -> Vec<u8> {
        let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(data).unwrap();
        enc.finish().unwrap()
    }

    /// An image XObject stream: `extra` adds to Type/Subtype/Width/Height.
    fn image(w: i64, h: i64, mut extra: Dictionary, data: Vec<u8>) -> Stream {
        let mut dict = dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => w,
            "Height" => h,
        };
        for (k, v) in std::mem::take(&mut extra).into_iter() {
            dict.set(k, v);
        }
        Stream::new(dict, data)
    }

    fn flate_image(w: i64, h: i64, extra: Dictionary, raw: &[u8]) -> Stream {
        let mut s = image(w, h, extra, flate(raw));
        s.dict.set("Filter", "FlateDecode");
        s
    }

    /// Save a document whose pages have these /XObject resource dicts.
    fn save(doc: Document, pages: Vec<Dictionary>) -> Vec<u8> {
        save_with(doc, pages.into_iter().map(|x| (x, b"q Q".to_vec())).collect())
    }

    /// `save` with each page's content stream.
    fn save_with(mut doc: Document, pages: Vec<(Dictionary, Vec<u8>)>) -> Vec<u8> {
        let pages_id = doc.new_object_id();
        let kids: Vec<Object> = pages
            .into_iter()
            .map(|(xobjects, content)| {
                let content = doc.add_object(Stream::new(Dictionary::new(), content));
                doc.add_object(dictionary! {
                    "Type" => "Page",
                    "Parent" => pages_id,
                    "MediaBox" => vec![0.into(), 0.into(), 100.into(), 100.into()],
                    "Resources" => dictionary! { "XObject" => xobjects },
                    "Contents" => content,
                })
                .into()
            })
            .collect();
        let count = kids.len() as i64;
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => count }),
        );
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", catalog);
        let mut out = Vec::new();
        doc.save_to(&mut out).unwrap();
        out
    }

    fn one(stream: Stream) -> (Document, ObjectId) {
        let mut doc = Document::with_version("1.7");
        let id = doc.add_object(stream);
        (doc, id)
    }

    fn single(stream: Stream) -> ExtractResult {
        let (doc, id) = one(stream);
        extract_images(&save(doc, vec![dictionary! { "Im0" => id }])).unwrap()
    }

    fn rgba(e: &Extracted) -> (u32, u32, &[u8]) {
        match &e.kind {
            ExtractedKind::Rgba { width, height, pixels } => (*width, *height, pixels),
            ExtractedKind::Jpeg(_) => panic!("expected rgba"),
        }
    }

    fn skipped(r: &ExtractResult) -> Vec<(&str, u32)> {
        r.skipped.iter().map(|(s, n)| (s.as_str(), *n)).collect()
    }

    #[test]
    fn jpeg_passthrough_is_byte_identical() {
        let jpeg = b"\xFF\xD8\xFF\xE0not really a jpeg\xFF\xD9".to_vec();
        let mut s = image(2, 2, dictionary! { "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8 }, jpeg.clone());
        s.dict.set("Filter", "DCTDecode");
        let r = single(s);
        assert_eq!(r.images.len(), 1);
        assert_eq!((r.images[0].page, r.images[0].index), (1, 1));
        match &r.images[0].kind {
            ExtractedKind::Jpeg(bytes) => assert_eq!(bytes, &jpeg),
            _ => panic!("expected jpeg"),
        }
    }

    #[test]
    fn jpeg_behind_flate_is_unwrapped() {
        let jpeg = b"\xFF\xD8jpeg bytes\xFF\xD9".to_vec();
        let mut s = image(2, 2, dictionary! { "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8 }, flate(&jpeg));
        s.dict.set("Filter", vec![Object::Name(b"FlateDecode".to_vec()), Object::Name(b"DCTDecode".to_vec())]);
        let r = single(s);
        match &r.images[0].kind {
            ExtractedKind::Jpeg(bytes) => assert_eq!(bytes, &jpeg),
            _ => panic!("expected jpeg"),
        }
    }

    #[test]
    fn flate_rgb_2x2() {
        let raw = [255, 0, 0, 0, 255, 0, 0, 0, 255, 1, 2, 3];
        let r = single(flate_image(2, 2, dictionary! { "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8 }, &raw));
        assert_eq!(rgba(&r.images[0]), (2, 2, &[255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 1, 2, 3, 255][..]));
        assert!(r.skipped.is_empty());
    }

    #[test]
    fn gray_1bit_with_decode() {
        let extra = dictionary! {
            "ColorSpace" => "DeviceGray",
            "BitsPerComponent" => 1,
            "Decode" => vec![1.into(), 0.into()],
        };
        let r = single(image(2, 1, extra, vec![0b1000_0000]));
        assert_eq!(rgba(&r.images[0]).2, &[0, 0, 0, 255, 255, 255, 255, 255]);
    }

    #[test]
    fn indexed_rgb_with_hival_1_and_stream_lookup() {
        let mut doc = Document::with_version("1.7");
        let lookup = doc.add_object(Stream::new(Dictionary::new(), vec![0, 255, 0, 9, 9, 9]));
        let cs = vec![Object::Name(b"Indexed".to_vec()), "DeviceRGB".into(), 1.into(), lookup.into()];
        let id = doc.add_object(image(2, 1, dictionary! { "ColorSpace" => cs, "BitsPerComponent" => 8 }, vec![1, 0]));
        let r = extract_images(&save(doc, vec![dictionary! { "Im0" => id }])).unwrap();
        assert_eq!(rgba(&r.images[0]).2, &[9, 9, 9, 255, 0, 255, 0, 255]);

        // String lookup.
        let cs = vec![
            Object::Name(b"Indexed".to_vec()),
            "DeviceGray".into(),
            1.into(),
            Object::String(vec![10, 20], lopdf::StringFormat::Hexadecimal),
        ];
        let r = single(image(1, 1, dictionary! { "ColorSpace" => cs, "BitsPerComponent" => 8 }, vec![1]));
        assert_eq!(rgba(&r.images[0]).2, &[20, 20, 20, 255]);
    }

    #[test]
    fn cmyk_and_icc_based() {
        let r = single(image(1, 1, dictionary! { "ColorSpace" => "DeviceCMYK", "BitsPerComponent" => 8 }, vec![0, 128, 255, 51]));
        assert_eq!(rgba(&r.images[0]).2, &[204, 102, 0, 255]);

        let mut doc = Document::with_version("1.7");
        let icc = doc.add_object(Stream::new(dictionary! { "N" => 3 }, b"profile".to_vec()));
        let cs = vec![Object::Name(b"ICCBased".to_vec()), icc.into()];
        let id = doc.add_object(image(1, 1, dictionary! { "ColorSpace" => cs, "BitsPerComponent" => 8 }, vec![1, 2, 3]));
        let r = extract_images(&save(doc, vec![dictionary! { "Im0" => id }])).unwrap();
        assert_eq!(rgba(&r.images[0]).2, &[1, 2, 3, 255]);
    }

    #[test]
    fn sixteen_bit_gray() {
        let r = single(image(2, 1, dictionary! { "ColorSpace" => "DeviceGray", "BitsPerComponent" => 16 }, vec![0xAB, 0xCD, 0x01, 0xFF]));
        assert_eq!(rgba(&r.images[0]).2, &[0xAB, 0xAB, 0xAB, 255, 1, 1, 1, 255]);
    }

    #[test]
    fn image_mask_is_black_on_transparent() {
        let r = single(image(2, 1, dictionary! { "ImageMask" => true }, vec![0b0100_0000]));
        assert_eq!(rgba(&r.images[0]).2, &[0, 0, 0, 255, 0, 0, 0, 0]);
    }

    #[test]
    fn smask_becomes_alpha_when_dims_match() {
        let mut doc = Document::with_version("1.7");
        let smask = doc.add_object(flate_image(2, 1, dictionary! { "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8 }, &[0, 128]));
        let id = doc.add_object(image(2, 1, dictionary! { "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8, "SMask" => smask }, vec![1, 2, 3, 4, 5, 6]));
        // A soft mask of other dimensions is ignored.
        let odd = doc.add_object(image(3, 1, dictionary! { "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8 }, vec![0, 0, 0]));
        let id2 = doc.add_object(image(1, 1, dictionary! { "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8, "SMask" => odd }, vec![7]));
        let r = extract_images(&save(doc, vec![dictionary! { "Im0" => id, "Im1" => id2 }])).unwrap();
        assert_eq!(skipped(&r), vec![("alpha dropped", 1)]);
        let by_index = |i: u32| r.images.iter().find(|e| e.index == i).unwrap();
        let pixels: Vec<&[u8]> = (1..=2).map(|i| rgba(by_index(i)).2).collect();
        assert!(pixels.contains(&&[1, 2, 3, 0, 4, 5, 6, 128][..]));
        assert!(pixels.contains(&&[7, 7, 7, 255][..]));
        // The soft masks themselves are not extracted as images.
        assert_eq!(r.images.len(), 2);
    }

    #[test]
    fn stencil_mask_becomes_alpha() {
        let mut doc = Document::with_version("1.7");
        let mask = doc.add_object(image(2, 1, dictionary! { "ImageMask" => true }, vec![0b0100_0000]));
        let id = doc.add_object(image(2, 1, dictionary! { "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8, "Mask" => mask }, vec![9, 9]));
        let r = extract_images(&save(doc, vec![dictionary! { "Im0" => id }])).unwrap();
        assert_eq!(rgba(&r.images[0]).2, &[9, 9, 9, 255, 9, 9, 9, 0]);
    }

    #[test]
    fn nested_form_image_is_found() {
        let mut doc = Document::with_version("1.7");
        let img = doc.add_object(image(1, 1, dictionary! { "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8 }, vec![42]));
        let inner = doc.add_object(Stream::new(
            dictionary! { "Type" => "XObject", "Subtype" => "Form", "Resources" => dictionary! { "XObject" => dictionary! { "I" => img } } },
            b"/I Do".to_vec(),
        ));
        let outer_id = doc.new_object_id();
        // The outer form also lists itself: a cycle that must terminate.
        doc.objects.insert(
            outer_id,
            Object::Stream(Stream::new(
                dictionary! { "Type" => "XObject", "Subtype" => "Form", "Resources" => dictionary! { "XObject" => dictionary! { "F" => inner, "Self" => outer_id } } },
                b"/F Do".to_vec(),
            )),
        );
        let r = extract_images(&save(doc, vec![dictionary! { "Fm0" => outer_id }])).unwrap();
        assert_eq!(r.images.len(), 1);
        assert_eq!(rgba(&r.images[0]).2, &[42, 42, 42, 255]);
    }

    #[test]
    fn shared_image_is_extracted_once_with_first_page() {
        let mut doc = Document::with_version("1.7");
        let a = doc.add_object(image(1, 1, dictionary! { "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8 }, vec![1]));
        let b = doc.add_object(image(1, 1, dictionary! { "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8 }, vec![2]));
        let r = extract_images(&save(doc, vec![dictionary! { "A" => a }, dictionary! { "A" => a, "B" => b }])).unwrap();
        let found: Vec<(u32, u32, u8)> = r.images.iter().map(|e| (e.page, e.index, rgba(e).2[0])).collect();
        assert_eq!(found, vec![(1, 1, 1), (2, 1, 2)]);
    }

    #[test]
    fn unsupported_filters_and_spaces_are_skipped_with_reasons() {
        let mut doc = Document::with_version("1.7");
        let mut ids = Vec::new();
        for filter in ["JPXDecode", "JBIG2Decode", "CCITTFaxDecode"] {
            let mut s = image(1, 1, dictionary! { "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8 }, vec![0]);
            s.dict.set("Filter", filter);
            ids.push(doc.add_object(s));
        }
        let lab = vec![Object::Name(b"Lab".to_vec()), Object::Dictionary(Dictionary::new())];
        ids.push(doc.add_object(image(1, 1, dictionary! { "ColorSpace" => lab, "BitsPerComponent" => 8 }, vec![0, 0, 0])));
        let mut xobjects = Dictionary::new();
        for (i, id) in ids.iter().enumerate() {
            xobjects.set(format!("I{i}"), *id);
        }
        let r = extract_images(&save(doc, vec![xobjects])).unwrap();
        assert!(r.images.is_empty());
        assert_eq!(skipped(&r), vec![("ccitt", 1), ("colour space", 1), ("jbig2", 1), ("jpeg2000", 1)]);
    }

    #[test]
    fn direct_image_stream_is_skipped_as_inline() {
        // Only reachable in a document built in memory: PDF syntax cannot
        // hold a stream as a direct object.
        let mut doc = Document::with_version("1.7");
        let direct = Object::Stream(image(1, 1, dictionary! { "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8 }, vec![0]));
        let pages_id = doc.new_object_id();
        let page = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
            "Resources" => dictionary! { "XObject" => dictionary! { "D" => direct } },
        });
        doc.objects.insert(pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1 }));
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", catalog);
        let r = extract_from_doc(&doc);
        assert!(r.images.is_empty());
        assert_eq!(skipped(&r), vec![("inline", 1)]);
    }

    #[test]
    fn malformed_dicts_are_skipped_without_panic() {
        let mut doc = Document::with_version("1.7");
        let gray = || dictionary! { "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8 };
        let cases = vec![
            image(0, 1, gray(), vec![0]),
            image(1, 1, dictionary! { "ColorSpace" => "DeviceGray", "BitsPerComponent" => 3 }, vec![0]),
            image(4, 4, gray(), vec![0; 5]),
            image(100_000, 100_000, gray(), vec![0; 16]),
            {
                let mut s = image(1, 1, gray(), vec![]);
                s.dict.remove(b"Width");
                s
            },
            {
                let mut s = image(1, 1, gray(), vec![0]);
                s.dict.set("ColorSpace", 7);
                s
            },
            {
                let mut s = image(1, 1, gray(), b"not zlib".to_vec());
                s.dict.set("Filter", "FlateDecode");
                s
            },
        ];
        let mut xobjects = Dictionary::new();
        for (i, s) in cases.into_iter().enumerate() {
            xobjects.set(format!("I{i}"), doc.add_object(s));
        }
        let r = extract_images(&save(doc, vec![xobjects])).unwrap();
        assert!(r.images.is_empty());
        let mut got = skipped(&r);
        got.sort();
        assert_eq!(got, vec![("colour space", 1), ("corrupt", 5), ("too large", 1)]);
    }

    #[test]
    fn job_budgets_skip_later_images() {
        let mut doc = Document::with_version("1.7");
        let gray = || dictionary! { "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8 };
        let a = doc.add_object(image(2, 2, gray(), vec![1; 4]));
        let b = doc.add_object(image(2, 2, gray(), vec![2; 4]));
        let doc = load_pdf(&save(doc, vec![dictionary! { "A" => a, "B" => b }])).unwrap();
        // Pixels: room for one 2x2 image.
        let r = extract_within(&doc, JOB_DECODED, 6);
        assert_eq!((r.images.len(), skipped(&r)), (1, vec![("budget", 1)]));
        // Decoded bytes: room for one 4-byte image.
        let r = extract_within(&doc, 6, JOB_PIXELS);
        assert_eq!((r.images.len(), skipped(&r)), (1, vec![("budget", 1)]));
    }

    /// 2x1 RGB, Flate + PNG predictor (rows prefixed with filter type 0),
    /// with these /DecodeParms.
    fn predicted_rgb(doc: &mut Document, parms: Object) -> ObjectId {
        let raw = [0, 10, 20, 30, 40, 50, 60];
        let mut s = flate_image(2, 1, dictionary! { "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8 }, &raw);
        s.dict.set("DecodeParms", parms);
        doc.add_object(s)
    }

    #[test]
    fn decode_parms_array_and_reference_undo_the_predictor() {
        let parms = || dictionary! { "Predictor" => 15, "Colors" => 3, "Columns" => 2 };
        let mut doc = Document::with_version("1.7");
        let a = predicted_rgb(&mut doc, vec![Object::Dictionary(parms())].into());
        let parms_id = doc.add_object(parms());
        let b = predicted_rgb(&mut doc, parms_id.into());
        let c = predicted_rgb(&mut doc, vec![Object::Reference(parms_id)].into());
        let r = extract_images(&save(doc, vec![dictionary! { "A" => a, "B" => b, "C" => c }])).unwrap();
        assert_eq!(r.images.len(), 3);
        for e in &r.images {
            assert_eq!(rgba(e).2, &[10, 20, 30, 255, 40, 50, 60, 255]);
        }
    }

    #[test]
    fn tiff_predictor_is_undone_for_8_and_16_bit() {
        let mut doc = Document::with_version("1.7");
        let mut rgb = flate_image(2, 1, dictionary! { "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8 }, &[10, 20, 30, 5, 5, 250]);
        rgb.dict.set("DecodeParms", dictionary! { "Predictor" => 2, "Colors" => 3, "Columns" => 2 });
        let rgb = doc.add_object(rgb);
        let mut gray = flate_image(2, 1, dictionary! { "ColorSpace" => "DeviceGray", "BitsPerComponent" => 16 }, &[0x01, 0xFF, 0x00, 0x02]);
        gray.dict.set("DecodeParms", dictionary! { "Predictor" => 2, "BitsPerComponent" => 16, "Columns" => 2 });
        let gray = doc.add_object(gray);
        let mut nibbles = flate_image(2, 1, dictionary! { "ColorSpace" => "DeviceGray", "BitsPerComponent" => 4 }, &[0x12]);
        nibbles.dict.set("DecodeParms", dictionary! { "Predictor" => 2, "BitsPerComponent" => 4, "Columns" => 2 });
        let nibbles = doc.add_object(nibbles);
        let r = extract_images(&save(doc, vec![dictionary! { "A" => rgb, "B" => gray, "C" => nibbles }])).unwrap();
        assert_eq!(r.images.len(), 2);
        assert_eq!(rgba(&r.images[0]).2, &[10, 20, 30, 255, 15, 25, 24, 255]);
        // 0x01FF + 0x0002 = 0x0201: high bytes 0x01 then 0x02.
        assert_eq!(rgba(&r.images[1]).2, &[1, 1, 1, 255, 2, 2, 2, 255]);
        assert_eq!(skipped(&r), vec![("corrupt", 1)]);
    }

    #[test]
    fn unusable_alpha_is_reported_and_the_image_kept() {
        let mut doc = Document::with_version("1.7");
        let mut bad = image(2, 1, dictionary! { "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8 }, vec![0, 0]);
        bad.dict.set("Filter", "JBIG2Decode");
        let bad = doc.add_object(bad);
        let id = doc.add_object(image(2, 1, dictionary! { "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8, "SMask" => bad }, vec![5, 6]));
        let r = extract_images(&save(doc, vec![dictionary! { "A" => id }])).unwrap();
        assert_eq!(rgba(&r.images[0]).2, &[5, 5, 5, 255, 6, 6, 6, 255]);
        assert_eq!(skipped(&r), vec![("alpha dropped", 1)]);
    }

    #[test]
    fn inline_images_in_content_are_counted() {
        let mut doc = Document::with_version("1.7");
        let inline = b"q BI /W 1 /H 1 /CS /G /BPC 8 ID \x00 EI Q ".to_vec();
        let form = doc.add_object(Stream::new(
            dictionary! { "Type" => "XObject", "Subtype" => "Form", "Resources" => Dictionary::new() },
            inline.clone(),
        ));
        let page1 = [inline.clone(), inline.clone(), b"(BI) Tj /Fm Do".to_vec()].concat();
        let r = extract_images(&save_with(
            doc,
            vec![(dictionary! { "Fm" => form }, page1), (dictionary! { "Fm" => form }, b"/Fm Do".to_vec())],
        ))
        .unwrap();
        // Two on page 1, one in the form (walked once).
        assert_eq!(skipped(&r), vec![("inline", 3)]);
    }

    #[test]
    fn invalid_pdf_is_an_error() {
        assert!(extract_images(b"not a pdf").is_err());
    }
}
