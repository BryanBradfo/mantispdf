use jpeg_encoder::{ColorType, Encoder};
use lopdf::{Document, Object};
use wasm_bindgen::prelude::*;
use zune_jpeg::JpegDecoder;
use zune_jpeg::zune_core::colorspace::ColorSpace;

/// Re-encode a JPEG (DCTDecode) buffer at the given quality.
/// Returns None if decoding fails, colorspace unsupported, or result is not smaller.
fn recompress_jpeg(jpeg_bytes: &[u8], quality: u8) -> Option<Vec<u8>> {
    let mut decoder = JpegDecoder::new(jpeg_bytes);
    let pixels = decoder.decode().ok()?;
    let info = decoder.info()?;
    let out_colorspace = decoder.get_output_colorspace()?;

    let color_type = match out_colorspace {
        ColorSpace::Luma => ColorType::Luma,
        ColorSpace::RGB => ColorType::Rgb,
        _ => return None,
    };

    let mut out = Vec::new();
    Encoder::new(&mut out, quality)
        .encode(&pixels, info.width as u16, info.height as u16, color_type)
        .ok()?;

    if out.len() < jpeg_bytes.len() { Some(out) } else { None }
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

    // Encode as JPEG
    let mut out = Vec::new();
    if Encoder::new(&mut out, quality)
        .encode(&stream.content, width as u16, height as u16, color_type)
        .is_err()
    {
        return;
    }

    // Only replace if the JPEG is smaller than the original compressed stream
    if out.len() < original_size {
        stream.set_content(out);
        stream.dict.set("Filter", Object::Name(b"DCTDecode".to_vec()));
    }
    // Otherwise: stream stays decompressed (no /Filter) → doc.compress() re-FlateDecode-compresses it
}

#[wasm_bindgen]
pub fn compress_pdf(pdf_bytes: &[u8], quality: u8) -> Result<Vec<u8>, JsValue> {
    let mut doc = Document::load_mem(pdf_bytes)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    // Pass 1: re-encode image streams at lower quality
    for object in doc.objects.values_mut() {
        if let Object::Stream(stream) = object {
            if is_jpeg_image(stream) {
                if let Some(new_bytes) = recompress_jpeg(&stream.content, quality) {
                    stream.set_content(new_bytes);
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
