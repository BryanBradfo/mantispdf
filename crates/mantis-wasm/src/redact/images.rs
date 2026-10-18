//! Image redaction: the pixels of an image under a redaction area are
//! painted with the fill colour in a new image object (other users of the
//! original keep it); an image that cannot be decoded is removed entirely.

use super::interp::{Quad, Rect};
use super::{Budget, Fill};
use crate::images::extract::ImageDecoder;
use crate::rebuild::deref;
use crate::stamp::engine::ImageData;
use crate::stamp::image::{build_image, jpeg_info};
use flate2::{Compression, write::ZlibEncoder};
use lopdf::{Dictionary, Document, Object, Stream, dictionary};
use std::io::Write;
use zune_jpeg::JpegDecoder;
use zune_jpeg::zune_core::colorspace::ColorSpace;
use zune_jpeg::zune_core::options::DecoderOptions;

/// Most pixels one redacted image may have (64 MiB of RGBA).
const MAX_IMAGE_PIXELS: usize = (64 << 20) / 4;
/// Memory charged per pixel of a redacted image.
const BYTES_PER_PIXEL: usize = 8;

/// Quality of re-encoded JPEG images.
const JPEG_QUALITY: u8 = 90;

/// What happens to one placed image (one value per image, used at once).
#[derive(Debug)]
#[allow(clippy::large_enum_variant)]
pub(crate) enum ImageEdit {
    /// No pixel lies under a rect.
    Untouched,
    /// A new image (and soft mask) to draw instead.
    Replaced { image: Stream, smask: Option<Stream> },
    /// The image must not be drawn at all; the reason is reported.
    Removed(&'static str),
}

/// Which pixels of a `width` x `height` image whose unit square lands on
/// `quad` (user space) share an area with any rect, row by row from the
/// top. A pixel only grazed by a rect counts: its colour would still show
/// beside the box. None when the placement is degenerate (no area).
pub(crate) fn covered_pixels(width: usize, height: usize, quad: &Quad, rects: &[Rect]) -> Option<Vec<bool>> {
    let [p00, p10, _, p01] = quad.0;
    let (ax, ay) = (p10.0 - p00.0, p10.1 - p00.1);
    let (cx, cy) = (p01.0 - p00.0, p01.1 - p00.1);
    let det = ax * cy - ay * cx;
    let scale = ax * ax + ay * ay + cx * cx + cy * cy;
    if !det.is_finite() || det.abs() <= 1e-9 * scale {
        return None;
    }
    let (w, h) = (width as f64, height as f64);
    // User space to pixel coordinates (x right, y down from the top row).
    let to_pixel = |x: f64, y: f64| {
        let (dx, dy) = (x - p00.0, y - p00.1);
        let u = (dx * cy - dy * cx) / det;
        let v = (ax * dy - ay * dx) / det;
        (u * w, (1.0 - v) * h)
    };
    let at = |u: f64, v: f64| (p00.0 + u * ax + v * cx, p00.1 + u * ay + v * cy);
    let mut covered = vec![false; width.checked_mul(height)?];
    for r in rects {
        let corners = [to_pixel(r.x0, r.y0), to_pixel(r.x1, r.y0), to_pixel(r.x1, r.y1), to_pixel(r.x0, r.y1)];
        let range = |values: [f64; 4], len: usize| {
            let lo = values.iter().copied().fold(f64::INFINITY, f64::min).floor().max(0.0);
            let hi = values.iter().copied().fold(f64::NEG_INFINITY, f64::max).ceil().min(len as f64);
            (lo as usize)..(hi.max(lo) as usize)
        };
        let xs = range(corners.map(|c| c.0), width);
        let ys = range(corners.map(|c| c.1), height);
        for j in ys {
            let (v_top, v_bottom) = (1.0 - j as f64 / h, 1.0 - (j + 1) as f64 / h);
            for i in xs.clone() {
                let index = j * width + i;
                if covered[index] {
                    continue;
                }
                let (u0, u1) = (i as f64 / w, (i + 1) as f64 / w);
                let pixel = Quad([at(u0, v_bottom), at(u1, v_bottom), at(u1, v_top), at(u0, v_top)]);
                covered[index] = pixel.intersects(r);
            }
        }
    }
    Some(covered)
}

fn positive_int(doc: &Document, dict: &Dictionary, key: &[u8]) -> Option<usize> {
    match deref(doc, dict.get(key).ok()?)? {
        Object::Integer(i) if *i > 0 => usize::try_from(*i).ok(),
        _ => None,
    }
}

/// Redact image XObject (or inline image as a stream) `stream`, placed on
/// `quad`, with resources `res`, charging decoding to `budget`.
pub(crate) fn redact_image(
    doc: &Document,
    stream: &Stream,
    res: &Dictionary,
    quad: &Quad,
    rects: &[Rect],
    fill: Fill,
    budget: &mut Budget,
) -> ImageEdit {
    let (Some(width), Some(height)) = (positive_int(doc, &stream.dict, b"Width"), positive_int(doc, &stream.dict, b"Height")) else {
        return ImageEdit::Removed("corrupt");
    };
    // Charge the memory editing takes (RGBA, coverage, encoder input:
    // about 8 bytes a pixel) before allocating any of it.
    let pixels = width.saturating_mul(height);
    let cost = pixels.saturating_mul(BYTES_PER_PIXEL);
    if pixels > MAX_IMAGE_PIXELS || cost > budget.decoded {
        return ImageEdit::Removed("budget");
    }
    budget.decoded -= cost;
    let Some(covered) = covered_pixels(width, height, quad, rects) else {
        return ImageEdit::Removed("degenerate placement");
    };
    if !covered.contains(&true) {
        return ImageEdit::Untouched;
    }
    let filters: Vec<&[u8]> = match stream.dict.get(b"Filter") {
        Err(_) => Vec::new(),
        Ok(_) => match stream.filters() {
            Ok(f) => f,
            Err(_) => return ImageEdit::Removed("corrupt"),
        },
    };
    let mut decoder = ImageDecoder::new(doc, budget.decoded);
    let edit = if filters.contains(&&b"DCTDecode"[..]) {
        redact_jpeg(doc, stream, &filters, (width, height), &covered, fill, &mut decoder)
    } else {
        redact_samples(doc, stream, res, (width, height), &covered, fill, &mut decoder)
    };
    budget.decoded = budget.decoded.saturating_sub(decoder.charged());
    edit.unwrap_or_else(ImageEdit::Removed)
}

/// Alpha of the image's mask with covered pixels made opaque: the box
/// drawn over them must not let a cut-out of the content show through.
fn opaque_where_covered(
    decoder: &mut ImageDecoder,
    dict: &Dictionary,
    (width, height): (usize, usize),
    covered: &[bool],
) -> Result<Option<Vec<u8>>, &'static str> {
    let mut alpha = decoder.alpha(dict, width, height).map_err(|()| "mask")?;
    if let Some(alpha) = alpha.as_mut() {
        for (a, c) in alpha.iter_mut().zip(covered) {
            if *c {
                *a = 255;
            }
        }
    }
    Ok(alpha)
}

/// Any image but a JPEG: RGB Flate (with a soft mask when the original had
/// alpha), or a 1-bit Flate stencil for an /ImageMask.
fn redact_samples(
    doc: &Document,
    stream: &Stream,
    res: &Dictionary,
    (width, height): (usize, usize),
    covered: &[bool],
    fill: Fill,
    decoder: &mut ImageDecoder,
) -> Result<ImageEdit, &'static str> {
    let (w, h, mut rgba) = decoder.rgba(stream, res)?;
    if (w, h) != (width, height) {
        return Err("corrupt");
    }
    let mask = matches!(stream.dict.get(b"ImageMask").ok().and_then(|o| deref(doc, o)), Some(Object::Boolean(true)));
    if mask {
        // Covered pixels stop painting (the redaction box covers them).
        let row = width.div_ceil(8);
        let mut bits = vec![0u8; row * height];
        for (i, px) in rgba.chunks_exact(4).enumerate() {
            if px[3] != 255 || covered[i] {
                let (y, x) = (i / width, i % width);
                bits[y * row + x / 8] |= 0x80 >> (x % 8);
            }
        }
        let dict = dictionary! {
            "Type" => "XObject", "Subtype" => "Image", "Width" => width as i64, "Height" => height as i64,
            "ImageMask" => true, "BitsPerComponent" => 1, "Filter" => "FlateDecode",
        };
        return Ok(ImageEdit::Replaced { image: Stream::new(dict, flate(&bits)?).with_compression(false), smask: None });
    }
    let alpha = opaque_where_covered(decoder, &stream.dict, (width, height), covered)?;
    let [r, g, b] = fill.rgb();
    for (i, px) in rgba.chunks_exact_mut(4).enumerate() {
        if covered[i] {
            px.copy_from_slice(&[r, g, b, 255]);
        } else if let Some(alpha) = &alpha {
            px[3] = alpha[i];
        }
    }
    let built = build_image(&ImageData::Rgba { width: width as u32, height: height as u32, pixels: rgba }).map_err(|_| "corrupt")?;
    Ok(ImageEdit::Replaced { image: built.image, smask: built.smask })
}

/// A JPEG: decoded, painted and re-encoded as a JPEG in its own (Gray or
/// RGB) colour space. CMYK, inverted (/Decode), stencil (/ImageMask) or
/// filtered-twice JPEGs are removed. Its pixels are already charged to the budget.
fn redact_jpeg(
    doc: &Document,
    stream: &Stream,
    filters: &[&[u8]],
    (width, height): (usize, usize),
    covered: &[bool],
    fill: Fill,
    decoder: &mut ImageDecoder,
) -> Result<ImageEdit, &'static str> {
    if filters != [b"DCTDecode"] {
        return Err("jpeg");
    }
    if stream.dict.has(b"Decode") {
        return Err("inverted jpeg");
    }
    if matches!(stream.dict.get(b"ImageMask").ok().and_then(|o| deref(doc, o)), Some(Object::Boolean(true))) {
        // A JPEG stencil paints in the fill colour: not a picture to repaint.
        return Err("jpeg mask");
    }
    let info = jpeg_info(&stream.content).map_err(|_| "corrupt")?;
    let (kind, space, components) = match info.components {
        1 => (jpeg_encoder::ColorType::Luma, ColorSpace::Luma, 1),
        3 => (jpeg_encoder::ColorType::Rgb, ColorSpace::RGB, 3),
        _ => return Err("cmyk jpeg"),
    };
    if (info.width as usize, info.height as usize) != (width, height) {
        return Err("corrupt");
    }
    let size = width * height * components;
    let options = DecoderOptions::default()
        .set_max_width(width)
        .set_max_height(height)
        .jpeg_set_out_colorspace(space);
    let mut jpeg = JpegDecoder::new_with_options(stream.content.as_slice(), options);
    let mut pixels = jpeg.decode().map_err(|_| "corrupt")?;
    if pixels.len() != size {
        return Err("corrupt");
    }
    let alpha = opaque_where_covered(decoder, &stream.dict, (width, height), covered)?;
    let rgb = fill.rgb();
    for (i, px) in pixels.chunks_exact_mut(components).enumerate() {
        if covered[i] {
            px.copy_from_slice(&rgb[..components]);
        }
    }
    let mut out = Vec::new();
    jpeg_encoder::Encoder::new(&mut out, JPEG_QUALITY)
        .encode(&pixels, width as u16, height as u16, kind)
        .map_err(|_| "corrupt")?;
    let device = if components == 1 { "DeviceGray" } else { "DeviceRGB" };
    let colour_space = match stream.dict.get(b"ColorSpace").ok() {
        Some(cs) if space_components(doc, cs) == Some(components) => cs.clone(),
        _ => Object::Name(device.as_bytes().to_vec()),
    };
    let dict = dictionary! {
        "Type" => "XObject", "Subtype" => "Image", "Width" => width as i64, "Height" => height as i64,
        "ColorSpace" => colour_space, "BitsPerComponent" => 8, "Filter" => "DCTDecode",
    };
    let smask = alpha
        .map(|alpha| -> Result<Stream, &'static str> {
            let dict = dictionary! {
                "Type" => "XObject", "Subtype" => "Image", "Width" => width as i64, "Height" => height as i64,
                "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8, "Filter" => "FlateDecode",
            };
            Ok(Stream::new(dict, flate(&alpha)?).with_compression(false))
        })
        .transpose()?;
    Ok(ImageEdit::Replaced { image: Stream::new(dict, out).with_compression(false), smask })
}

/// Components of a Gray/RGB colour space we can keep on a re-encoded JPEG.
fn space_components(doc: &Document, cs: &Object) -> Option<usize> {
    match deref(doc, cs)? {
        Object::Name(n) => match n.as_slice() {
            b"DeviceGray" | b"CalGray" => Some(1),
            b"DeviceRGB" | b"CalRGB" => Some(3),
            _ => None,
        },
        Object::Array(items) if items.first().and_then(|o| o.as_name().ok()) == Some(b"ICCBased") => {
            let Some(Object::Stream(icc)) = items.get(1).and_then(|o| deref(doc, o)) else {
                return None;
            };
            match icc.dict.get(b"N").ok().and_then(|o| deref(doc, o)) {
                Some(Object::Integer(1)) => Some(1),
                Some(Object::Integer(3)) => Some(3),
                _ => None,
            }
        }
        _ => None,
    }
}

fn flate(bytes: &[u8]) -> Result<Vec<u8>, &'static str> {
    let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
    enc.write_all(bytes).map_err(|_| "corrupt")?;
    enc.finish().map_err(|_| "corrupt")
}

/// An inline image's stream with its abbreviated keys and names expanded,
/// usable as an image XObject.
pub(crate) fn inline_as_xobject(inline: &Stream) -> Stream {
    let filter_name = |n: &[u8]| -> Vec<u8> {
        match n {
            b"AHx" => b"ASCIIHexDecode".to_vec(),
            b"A85" => b"ASCII85Decode".to_vec(),
            b"LZW" => b"LZWDecode".to_vec(),
            b"Fl" => b"FlateDecode".to_vec(),
            b"RL" => b"RunLengthDecode".to_vec(),
            b"CCF" => b"CCITTFaxDecode".to_vec(),
            b"DCT" => b"DCTDecode".to_vec(),
            other => other.to_vec(),
        }
    };
    let space_name = |n: &[u8]| -> Vec<u8> {
        match n {
            b"G" => b"DeviceGray".to_vec(),
            b"RGB" => b"DeviceRGB".to_vec(),
            b"CMYK" => b"DeviceCMYK".to_vec(),
            b"I" => b"Indexed".to_vec(),
            other => other.to_vec(),
        }
    };
    let mut dict = dictionary! { "Type" => "XObject", "Subtype" => "Image" };
    for (key, value) in inline.dict.iter() {
        let key: &[u8] = match key.as_slice() {
            b"BPC" => b"BitsPerComponent",
            b"CS" => b"ColorSpace",
            b"D" => b"Decode",
            b"DP" => b"DecodeParms",
            b"F" => b"Filter",
            b"H" => b"Height",
            b"IM" => b"ImageMask",
            b"I" => b"Interpolate",
            b"W" => b"Width",
            b"L" | b"Length" => continue,
            other => other,
        };
        let value = match (key, value) {
            (b"Filter", Object::Name(n)) => Object::Name(filter_name(n)),
            (b"Filter", Object::Array(items)) => Object::Array(
                items
                    .iter()
                    .map(|o| match o {
                        Object::Name(n) => Object::Name(filter_name(n)),
                        other => other.clone(),
                    })
                    .collect(),
            ),
            (b"ColorSpace", Object::Name(n)) => Object::Name(space_name(n)),
            (b"ColorSpace", Object::Array(items)) => {
                let mut items = items.clone();
                for item in items.iter_mut().take(2) {
                    if let Object::Name(n) = item {
                        *n = space_name(n);
                    }
                }
                Object::Array(items)
            }
            (_, other) => other.clone(),
        };
        dict.set(key.to_vec(), value);
    }
    Stream::new(dict, inline.content.clone()).with_compression(false)
}
