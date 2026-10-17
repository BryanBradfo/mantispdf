//! Image XObjects for image stamps: raw RGBA (Flate RGB + optional SMask)
//! or JPEG bytes passed through as `/DCTDecode`.

use super::engine::ImageData;
use flate2::{Compression, write::ZlibEncoder};
use lopdf::{Object, Stream, dictionary};
use std::io::Write;

/// An image XObject and, when some pixel is not fully opaque, its soft mask.
/// Nothing is added to a document yet: the engine validates every image
/// before it writes anything.
pub(crate) struct BuiltImage {
    pub image: Stream,
    pub smask: Option<Stream>,
}

pub(crate) fn build_image(data: &ImageData) -> Result<BuiltImage, String> {
    match data {
        ImageData::Rgba { width, height, pixels } => build_rgba(*width, *height, pixels),
        ImageData::Jpeg(bytes) => build_jpeg(bytes),
    }
}

fn flate(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
    enc.write_all(bytes).map_err(|e| format!("Failed to compress image: {e}"))?;
    enc.finish().map_err(|e| format!("Failed to compress image: {e}"))
}

fn image_stream(width: u32, height: u32, color_space: &str, filter: &str, data: Vec<u8>) -> Stream {
    let dict = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Image",
        "Width" => i64::from(width),
        "Height" => i64::from(height),
        "ColorSpace" => Object::Name(color_space.as_bytes().to_vec()),
        "BitsPerComponent" => 8,
        "Filter" => Object::Name(filter.as_bytes().to_vec()),
    };
    // The data is already encoded: never let lopdf compress it again.
    Stream::new(dict, data).with_compression(false)
}

fn build_rgba(width: u32, height: u32, pixels: &[u8]) -> Result<BuiltImage, String> {
    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|n| n.checked_mul(4));
    if width == 0 || height == 0 || expected != Some(pixels.len()) {
        return Err(format!(
            "Invalid image data: expected {width}x{height} RGBA pixels, got {} bytes",
            pixels.len()
        ));
    }
    let count = pixels.len() / 4;
    let mut rgb = Vec::with_capacity(count * 3);
    let mut alpha = Vec::with_capacity(count);
    for px in pixels.chunks_exact(4) {
        rgb.extend_from_slice(&px[..3]);
        alpha.push(px[3]);
    }
    let smask = if alpha.iter().any(|&a| a < 255) {
        Some(image_stream(width, height, "DeviceGray", "FlateDecode", flate(&alpha)?))
    } else {
        None
    };
    let image = image_stream(width, height, "DeviceRGB", "FlateDecode", flate(&rgb)?);
    Ok(BuiltImage { image, smask })
}

/// What the embedding needs from a JPEG header.
#[derive(Debug, PartialEq)]
pub(crate) struct JpegInfo {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) components: u8,
    pub(crate) adobe: bool,
}

/// Read the frame header (SOF) and note an Adobe APP14 segment. Markers are
/// walked by their lengths up to the first scan; entropy-coded data is never
/// touched.
pub(crate) fn jpeg_info(bytes: &[u8]) -> Result<JpegInfo, String> {
    let bad = || "Invalid JPEG image".to_string();
    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return Err(bad());
    }
    let mut i = 2;
    let mut adobe = false;
    loop {
        // Skip to a marker, past any 0xFF fill bytes.
        if *bytes.get(i).ok_or_else(bad)? != 0xFF {
            return Err(bad());
        }
        while bytes.get(i) == Some(&0xFF) {
            i += 1;
        }
        let marker = *bytes.get(i).ok_or_else(bad)?;
        i += 1;
        match marker {
            0x01 | 0xD0..=0xD7 => continue,
            0xD9 | 0xDA => return Err(bad()), // end or scan before a frame header
            _ => {}
        }
        let len = usize::from(u16::from_be_bytes([
            *bytes.get(i).ok_or_else(bad)?,
            *bytes.get(i + 1).ok_or_else(bad)?,
        ]));
        if len < 2 {
            return Err(bad());
        }
        let seg = bytes.get(i + 2..i + len).ok_or_else(bad)?;
        match marker {
            0xEE if seg.starts_with(b"Adobe") => adobe = true,
            // Lossless, hierarchical and arithmetic-coded frames: viewers
            // decode these unreliably.
            0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF => {
                return Err("Unsupported JPEG image".into());
            }
            // Baseline, extended sequential and progressive (Huffman).
            0xC0..=0xC2 => {
                if seg.len() < 6 {
                    return Err(bad());
                }
                if seg[0] != 8 {
                    return Err("Unsupported JPEG image: only 8-bit samples are supported".into());
                }
                let height = u32::from(u16::from_be_bytes([seg[1], seg[2]]));
                let width = u32::from(u16::from_be_bytes([seg[3], seg[4]]));
                let components = seg[5];
                if width == 0 || height == 0 || !matches!(components, 1 | 3 | 4) {
                    return Err("Unsupported JPEG image".into());
                }
                return Ok(JpegInfo { width, height, components, adobe });
            }
            _ => {}
        }
        i += len;
    }
}

/// Copy of a JPEG without its metadata segments: APP1 (Exif, XMP), APP13
/// (Photoshop/IPTC) and COM. Viewers disagree on whether an Exif orientation
/// inside a PDF image applies, and GPS or camera data should not leak into the
/// PDF. APP0, APP2 (ICC), APP14 (Adobe), the tables, the frame header and the
/// entropy-coded data are kept byte for byte. A walk that goes wrong keeps the
/// rest of the input untouched.
pub(crate) fn strip_jpeg_metadata(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    out.extend_from_slice(&bytes[..2.min(bytes.len())]);
    let mut i = 2;
    while i + 1 < bytes.len() {
        if bytes[i] != 0xFF {
            break;
        }
        let marker = bytes[i + 1];
        if marker == 0xFF {
            // Fill byte before a marker.
            out.push(0xFF);
            i += 1;
            continue;
        }
        if marker == 0x01 || (0xD0..=0xD8).contains(&marker) {
            out.extend_from_slice(&bytes[i..i + 2]);
            i += 2;
            continue;
        }
        if marker == 0xD9 || marker == 0xDA || i + 3 >= bytes.len() {
            break; // end, first scan, or truncated: keep the rest as is
        }
        let len = usize::from(u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]));
        if len < 2 || i + 2 + len > bytes.len() {
            break;
        }
        if !matches!(marker, 0xE1 | 0xED | 0xFE) {
            out.extend_from_slice(&bytes[i..i + 2 + len]);
        }
        i += 2 + len;
    }
    out.extend_from_slice(&bytes[i.min(bytes.len())..]);
    out
}

fn build_jpeg(bytes: &[u8]) -> Result<BuiltImage, String> {
    let info = jpeg_info(bytes)?;
    let color_space = match info.components {
        1 => "DeviceGray",
        3 => "DeviceRGB",
        _ => "DeviceCMYK",
    };
    let mut image = image_stream(info.width, info.height, color_space, "DCTDecode", strip_jpeg_metadata(bytes));
    // Adobe (Photoshop) CMYK JPEGs store inverted samples, flagged by APP14.
    if info.components == 4 && info.adobe {
        let decode: Vec<Object> = [1, 0, 1, 0, 1, 0, 1, 0].into_iter().map(Object::Integer).collect();
        image.dict.set("Decode", decode);
    }
    Ok(BuiltImage { image, smask: None })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SOI, optional APP14 Adobe, SOF0 with `components`, then EOI.
    fn header(components: u8, adobe: bool) -> Vec<u8> {
        header_with(0xC0, components, adobe)
    }

    fn header_with(sof_marker: u8, components: u8, adobe: bool) -> Vec<u8> {
        let mut v = vec![0xFF, 0xD8];
        if adobe {
            let body = b"Adobe\x00\x64\x00\x00\x00\x00\x00";
            v.extend_from_slice(&[0xFF, 0xEE, 0x00, (body.len() + 2) as u8]);
            v.extend_from_slice(body);
        }
        let mut frame = vec![8, 0, 2, 0, 3, components];
        for c in 0..components {
            frame.extend_from_slice(&[c + 1, 0x11, 0]);
        }
        v.extend_from_slice(&[0xFF, sof_marker, 0x00, (frame.len() + 2) as u8]);
        v.extend_from_slice(&frame);
        v.extend_from_slice(&[0xFF, 0xD9]);
        v
    }

    #[test]
    fn sof_dimensions_and_components() {
        let info = jpeg_info(&header(3, false)).unwrap();
        assert_eq!(info, JpegInfo { width: 3, height: 2, components: 3, adobe: false });
    }

    #[test]
    fn only_baseline_extended_and_progressive_frames() {
        for sof in [0xC0, 0xC1, 0xC2] {
            assert!(jpeg_info(&header_with(sof, 3, false)).is_ok(), "SOF {sof:#X}");
        }
        // Lossless, hierarchical and arithmetic-coded frames.
        for sof in [0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF] {
            assert_eq!(
                jpeg_info(&header_with(sof, 3, false)).unwrap_err(),
                "Unsupported JPEG image",
                "SOF {sof:#X}"
            );
        }
    }

    #[test]
    fn cmyk_adobe_gets_inverted_decode() {
        let built = build_jpeg(&header(4, true)).unwrap();
        assert_eq!(built.image.dict.get(b"ColorSpace").unwrap().as_name().unwrap(), b"DeviceCMYK");
        assert_eq!(built.image.dict.get(b"Decode").unwrap().as_array().unwrap().len(), 8);
        let plain = build_jpeg(&header(4, false)).unwrap();
        assert!(!plain.image.dict.has(b"Decode"));
    }

    #[test]
    fn strips_exif_xmp_iptc_and_comments_but_keeps_the_rest() {
        let seg = |m: u8, body: &[u8]| {
            let mut v = vec![0xFF, m, 0, (body.len() + 2) as u8];
            v.extend_from_slice(body);
            v
        };
        let scan = [0xFF, 0xDA, 0, 4, 0xAA, 0xBB, 0x12, 0xFF, 0x00, 0xE1, 0xFF, 0xD9];
        let mut input = vec![0xFF, 0xD8];
        input.extend(seg(0xE0, b"JFIF\0"));
        input.extend(seg(0xE1, b"Exif\0\0orientation-6"));
        input.extend(seg(0xE1, b"http://ns.adobe.com/xap/1.0/\0xmp"));
        input.extend(seg(0xE2, b"ICC_PROFILE\0icc"));
        input.extend(seg(0xED, b"Photoshop 3.0"));
        input.extend(seg(0xFE, b"comment"));
        input.extend(seg(0xEE, b"Adobe\0\x64\0\0\0\0\0"));
        input.extend(seg(0xC0, &[8, 0, 2, 0, 3, 1, 1, 0x11, 0]));
        input.extend_from_slice(&scan);
        let out = strip_jpeg_metadata(&input);
        let has = |hay: &[u8], needle: &[u8]| hay.windows(needle.len()).any(|w| w == needle);
        assert!(!has(&out, b"Exif") && !has(&out, b"xmp") && !has(&out, b"Photoshop") && !has(&out, b"comment"));
        for kept in [&b"JFIF"[..], b"ICC_PROFILE", b"Adobe"] {
            assert!(has(&out, kept));
        }
        assert!(out.ends_with(&scan), "scan data must be byte-identical");
        let mut expected = vec![0xFF, 0xD8];
        expected.extend(seg(0xE0, b"JFIF\0"));
        expected.extend(seg(0xE2, b"ICC_PROFILE\0icc"));
        expected.extend(seg(0xEE, b"Adobe\0\x64\0\0\0\0\0"));
        expected.extend(seg(0xC0, &[8, 0, 2, 0, 3, 1, 1, 0x11, 0]));
        expected.extend_from_slice(&scan);
        assert_eq!(out, expected);
        // Already clean input is returned unchanged.
        assert_eq!(strip_jpeg_metadata(&expected), expected);
        let built = build_jpeg(&input).unwrap();
        assert_eq!(built.image.content, expected);
    }

    #[test]
    fn gray_jpeg_and_garbage() {
        let built = build_jpeg(&header(1, false)).unwrap();
        assert_eq!(built.image.dict.get(b"ColorSpace").unwrap().as_name().unwrap(), b"DeviceGray");
        assert!(build_jpeg(b"not a jpeg").is_err());
        assert!(build_jpeg(&[0xFF, 0xD8, 0xFF, 0xDA, 0, 2]).is_err());
        assert!(build_jpeg(&[0xFF, 0xD8, 0xFF, 0xC0, 0, 50]).is_err());
    }

    #[test]
    fn rgba_length_mismatch_rejected() {
        assert!(build_rgba(2, 2, &[0; 15]).is_err());
        assert!(build_rgba(0, 1, &[]).is_err());
    }
}
