use jpeg_encoder::{ColorType, Encoder};
use lopdf::{Document, Object};
use wasm_bindgen::prelude::*;
use zune_jpeg::JpegDecoder;
use zune_jpeg::zune_core::colorspace::ColorSpace;

/// Maximum pixel dimension (width or height) after downsampling.
/// Images exceeding this are resized to fit within a MAX_DIM × MAX_DIM box.
/// 1600 px ≈ 150 DPI on a full A4 page — sharp on any screen, smaller than most print images.
const MAX_DIM: usize = 1600;

/// Box-filter downsampler. Returns None if the image already fits in max_dim.
/// Components is 1 (gray) or 3 (RGB).
fn downsample(
    pixels: &[u8],
    width: usize,
    height: usize,
    components: usize,
    max_dim: usize,
) -> Option<(Vec<u8>, usize, usize)> {
    if width <= max_dim && height <= max_dim {
        return None;
    }
    let scale = max_dim as f32 / width.max(height) as f32;
    let new_w = ((width as f32 * scale).round() as usize).max(1);
    let new_h = ((height as f32 * scale).round() as usize).max(1);

    let mut out = vec![0u8; new_w * new_h * components];
    for y in 0..new_h {
        for x in 0..new_w {
            let src_x0 = (x as f32 / scale) as usize;
            let src_y0 = (y as f32 / scale) as usize;
            let src_x1 = (((x + 1) as f32 / scale).ceil() as usize).min(width);
            let src_y1 = (((y + 1) as f32 / scale).ceil() as usize).min(height);
            for c in 0..components {
                let mut sum = 0u32;
                let mut count = 0u32;
                for sy in src_y0..src_y1 {
                    for sx in src_x0..src_x1 {
                        sum += pixels[(sy * width + sx) * components + c] as u32;
                        count += 1;
                    }
                }
                out[(y * new_w + x) * components + c] =
                    if count > 0 { (sum / count) as u8 } else { 0 };
            }
        }
    }
    Some((out, new_w, new_h))
}

/// Re-encode a JPEG (DCTDecode) buffer at the given quality.
/// Returns None if decoding fails, colorspace unsupported, or result is not smaller.
/// Returns the new bytes along with the (possibly downsampled) dimensions.
fn recompress_jpeg(jpeg_bytes: &[u8], quality: u8) -> Option<(Vec<u8>, u16, u16)> {
    let mut decoder = JpegDecoder::new(jpeg_bytes);
    let pixels = decoder.decode().ok()?;
    let info = decoder.info()?;
    let out_colorspace = decoder.get_output_colorspace()?;

    let (color_type, components) = match out_colorspace {
        ColorSpace::Luma => (ColorType::Luma, 1usize),
        ColorSpace::RGB  => (ColorType::Rgb,  3usize),
        _ => return None,
    };

    // Downsample if image exceeds MAX_DIM
    let (final_pixels, final_w, final_h) =
        if let Some((ds, dw, dh)) =
            downsample(&pixels, info.width as usize, info.height as usize, components, MAX_DIM)
        {
            (ds, dw, dh)
        } else {
            (pixels, info.width as usize, info.height as usize)
        };

    let mut out = Vec::new();
    Encoder::new(&mut out, quality)
        .encode(&final_pixels, final_w as u16, final_h as u16, color_type)
        .ok()?;

    if out.len() < jpeg_bytes.len() {
        Some((out, final_w as u16, final_h as u16))
    } else {
        None
    }
}

fn has_filter(stream: &lopdf::Stream, filter_name: &[u8]) -> bool {
    match stream.dict.get(b"Filter").ok() {
        Some(Object::Name(n)) => n == filter_name,
        Some(Object::Array(arr)) => arr.iter().any(|o| {
            matches!(o, Object::Name(n) if n == filter_name)
        }),
        _ => false,
    }
}

fn is_image_subtype(stream: &lopdf::Stream) -> bool {
    stream
        .dict
        .get(b"Subtype")
        .ok()
        .and_then(|o| o.as_name().ok())
        .map(|n| n == b"Image")
        .unwrap_or(false)
}

fn is_jpeg_image(stream: &lopdf::Stream) -> bool {
    is_image_subtype(stream) && has_filter(stream, b"DCTDecode")
}

fn is_flate_image(stream: &lopdf::Stream) -> bool {
    is_image_subtype(stream) && has_filter(stream, b"FlateDecode")
}

/// Decompress a FlateDecode image stream and JPEG-encode its pixels.
/// On success: replaces stream content with JPEG bytes and updates /Filter.
/// On failure or no size gain: leaves stream decompressed (no filter) for
/// doc.compress() to re-FlateDecode-compress in pass 2.
fn try_jpeg_encode_flate(stream: &mut lopdf::Stream, quality: u8) {
    let original_size = stream.content.len();

    // Read image dimensions from the stream dictionary
    let width = stream.dict.get(b"Width").ok()
        .and_then(|o| o.as_i64().ok())
        .unwrap_or(0) as usize;
    let height = stream.dict.get(b"Height").ok()
        .and_then(|o| o.as_i64().ok())
        .unwrap_or(0) as usize;
    let bpc = stream.dict.get(b"BitsPerComponent").ok()
        .and_then(|o| o.as_i64().ok())
        .unwrap_or(8) as usize;

    // Only handle 8-bit images
    if bpc != 8 || width == 0 || height == 0 {
        return;
    }

    // Only handle simple named colorspaces (DeviceRGB / DeviceGray)
    let components = match stream.dict.get(b"ColorSpace").ok() {
        Some(Object::Name(cs)) if cs == b"DeviceRGB" => 3usize,
        Some(Object::Name(cs)) if cs == b"DeviceGray" => 1usize,
        _ => return, // skip CMYK, ICCBased arrays, Indexed, etc.
    };

    let color_type = if components == 1 { ColorType::Luma } else { ColorType::Rgb };

    // Decompress in-place; removes /Filter and /DecodeParms from the dict
    if stream.decompress().is_err() {
        return;
    }

    // Sanity-check: decompressed size must match expected raw pixel size
    let expected = width * height * components;
    if stream.content.len() != expected {
        return;
    }

    // Downsample if image exceeds MAX_DIM
    let (enc_pixels, enc_w, enc_h, downsampled) =
        if let Some((ds, dw, dh)) = downsample(&stream.content, width, height, components, MAX_DIM) {
            (ds, dw, dh, true)
        } else {
            (stream.content.clone(), width, height, false)
        };

    // Encode as JPEG
    let mut out = Vec::new();
    if Encoder::new(&mut out, quality)
        .encode(&enc_pixels, enc_w as u16, enc_h as u16, color_type)
        .is_err()
    {
        return;
    }

    // Replace if: downsampled (always smaller after resize+quality) OR JPEG < original FlateDecode
    if downsampled || out.len() < original_size {
        stream.set_content(out);
        stream.dict.set("Filter",  Object::Name(b"DCTDecode".to_vec()));
        stream.dict.set("Width",   Object::Integer(enc_w as i64));
        stream.dict.set("Height",  Object::Integer(enc_h as i64));
    }
    // Otherwise: stream stays decompressed → doc.compress() re-FlateDecode-compresses it
}

/// Remove /Info trailer dict and /Metadata XMP stream from catalog.
/// These are pure overhead — stripping them has no visual effect.
fn strip_metadata(doc: &mut Document) {
    // 1. Remove /Info from trailer (author, dates, producer string, etc.)
    doc.trailer.remove(b"Info");

    // 2. Remove /Metadata XMP stream from document catalog.
    // Get the catalog ObjectId via trailer /Root, then remove /Metadata from it.
    let catalog_id = match doc.trailer.get(b"Root").ok()
        .and_then(|o| o.as_reference().ok())
    {
        Some(id) => id,
        None => return,
    };

    let meta_id = match doc.objects.get_mut(&catalog_id) {
        Some(Object::Dictionary(dict)) => match dict.remove(b"Metadata") {
            Some(Object::Reference(id)) => Some(id),
            _ => None,
        },
        _ => None,
    };

    if let Some(id) = meta_id {
        doc.objects.remove(&id);
    }
}

#[wasm_bindgen]
pub fn compress_pdf(pdf_bytes: &[u8], quality: u8) -> Result<Vec<u8>, JsValue> {
    let mut doc = Document::load_mem(pdf_bytes)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    strip_metadata(&mut doc);

    // Pass 1: re-encode image streams at lower quality
    for object in doc.objects.values_mut() {
        if let Object::Stream(stream) = object {
            if is_jpeg_image(stream) {
                if let Some((new_bytes, new_w, new_h)) = recompress_jpeg(&stream.content, quality) {
                    stream.set_content(new_bytes);
                    stream.dict.set("Width",  Object::Integer(new_w as i64));
                    stream.dict.set("Height", Object::Integer(new_h as i64));
                }
            } else if is_flate_image(stream) {
                try_jpeg_encode_flate(stream, quality);
            }
        }
    }

    // Pass 2: FlateDecode-compress remaining uncompressed content streams
    doc.compress();

    let mut buf = Vec::new();
    doc.save_to(&mut buf)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    Ok(buf)
}
