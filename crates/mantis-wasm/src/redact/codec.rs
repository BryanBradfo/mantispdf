//! Content operators: decoded strictly (every byte parsed, inline images
//! measured) and encoded back.

use super::{Budget, Unsupported};
use crate::rebuild::{
    Decoded, MAX_STREAM_DECODED, decode_complete, decode_inline_dict, deref, inline_image_extent, is_pdf_regular,
    skip_literal_string, strict_content_in,
};
use lopdf::content::{Content, Operation};
use lopdf::{Dictionary, Document, Object, Stream};

/// `[` / `<<` nesting deeper than this is unsupported (the parser recurses).
const MAX_NESTING: usize = 64;

fn unparsable() -> Unsupported {
    Unsupported::new("content cannot be parsed")
}

/// True when unfiltered inline image data is exactly `H * ceil(W * BPC *
/// components / 8)` bytes (anything else could hide where the image ends).
/// Filtered data cannot be measured before decoding and passes.
fn inline_data_fits(dict: &Dictionary, len: usize) -> bool {
    let get = |abbr: &[u8], full: &[u8]| dict.get(abbr).or_else(|_| dict.get(full)).ok();
    if get(b"F", b"Filter").is_some() {
        return true;
    }
    let positive = |o: Option<&Object>| o.and_then(|o| o.as_i64().ok()).filter(|v| *v > 0).map(|v| v as u64);
    let mask = matches!(get(b"IM", b"ImageMask"), Some(Object::Boolean(true)));
    let components = if mask {
        Some(1)
    } else {
        match get(b"CS", b"ColorSpace") {
            Some(Object::Name(n)) => match n.as_slice() {
                b"G" | b"DeviceGray" | b"I" | b"Indexed" => Some(1),
                b"RGB" | b"DeviceRGB" => Some(3),
                b"CMYK" | b"DeviceCMYK" => Some(4),
                _ => None,
            },
            Some(Object::Array(items)) => match items.first() {
                Some(Object::Name(n)) if n == b"I" || n == b"Indexed" => Some(1),
                _ => None,
            },
            _ => None,
        }
    };
    let bpc = match get(b"BPC", b"BitsPerComponent") {
        None if mask => Some(1),
        other => positive(other),
    };
    let (Some(w), Some(h), Some(bpc), Some(n)) = (positive(get(b"W", b"Width")), positive(get(b"H", b"Height")), bpc, components) else {
        return false;
    };
    let expected = w
        .checked_mul(bpc)
        .and_then(|bits| bits.checked_mul(n))
        .map(|bits| bits.div_ceil(8))
        .and_then(|row| row.checked_mul(h));
    expected == Some(len as u64)
}

/// Decode content into operations; inline images become one `BI` operation
/// whose operands are a stream (dictionary + data) and the original
/// `BI ... EI` bytes (written back verbatim). Errors when any byte cannot be
/// parsed, `[` / `<<` nest too deep, or unfiltered inline image data does
/// not have the length its dictionary implies.
pub(crate) fn decode_ops(c: &[u8]) -> Result<Vec<Operation>, Unsupported> {
    let mut ops = Vec::new();
    let mut segment_start = 0;
    let mut depth = 0usize;
    let enter = |depth: &mut usize| {
        *depth += 1;
        if *depth > MAX_NESTING { Err(Unsupported::new("content nests too deep")) } else { Ok(()) }
    };
    let mut i = 0;
    while i < c.len() {
        match c[i] {
            b'[' => {
                enter(&mut depth)?;
                i += 1;
            }
            b'<' if c.get(i + 1) == Some(&b'<') => {
                enter(&mut depth)?;
                i += 2;
            }
            b']' => {
                depth = depth.saturating_sub(1);
                i += 1;
            }
            b'>' if c.get(i + 1) == Some(&b'>') => {
                depth = depth.saturating_sub(1);
                i += 2;
            }
            b'%' => {
                while i < c.len() && c[i] != b'\n' && c[i] != b'\r' {
                    i += 1;
                }
            }
            b'(' => i = skip_literal_string(c, i),
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
                if &c[start..i] == b"BI" {
                    let (dict_tokens, end) = inline_image_extent(c, i).ok_or_else(unparsable)?;
                    ops.extend(decode_complete(&c[segment_start..start]).ok_or_else(unparsable)?);
                    let dict = decode_inline_dict(dict_tokens).ok_or_else(unparsable)?;
                    // `ID`, one whitespace byte, data, whitespace, `EI`.
                    let data_start = i + dict_tokens.len() + 3;
                    let data = &c[data_start..end - 3];
                    if !inline_data_fits(&dict, data.len()) {
                        return Err(Unsupported::new("inline image data of unexpected length"));
                    }
                    let mut image = Stream::new(dict, data.to_vec());
                    image.dict.remove(b"Length");
                    let raw = Object::String(c[start..end].to_vec(), lopdf::StringFormat::Literal);
                    ops.push(Operation::new("BI", vec![Object::Stream(image), raw]));
                    segment_start = end;
                    i = end;
                }
            }
            _ => i += 1,
        }
    }
    ops.extend(decode_complete(&c[segment_start..]).ok_or_else(unparsable)?);
    Ok(ops)
}

/// Content bytes of `ops`; inline images (`BI` ops from `decode_ops`) are
/// written back as `BI <dict> ID <data> EI` with their data unchanged.
pub(crate) fn encode_ops(ops: &[Operation]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut run: Vec<Operation> = Vec::new();
    let flush = |run: &mut Vec<Operation>, out: &mut Vec<u8>| {
        if !run.is_empty() {
            // Writing to a Vec cannot fail.
            out.extend(Content { operations: std::mem::take(run) }.encode().unwrap_or_default());
            out.push(b'\n');
        }
    };
    for op in ops {
        match (op.operator.as_str(), op.operands.as_slice()) {
            ("BI", [Object::Stream(_), Object::String(raw, _)]) => {
                flush(&mut run, &mut out);
                out.extend_from_slice(raw);
                out.push(b'\n');
            }
            ("BI", [Object::Stream(image)]) => {
                flush(&mut run, &mut out);
                out.extend_from_slice(b"BI\n");
                for (key, value) in image.dict.iter() {
                    let entry = Operation::new("", vec![Object::Name(key.clone()), value.clone()]);
                    out.extend(Content { operations: vec![entry] }.encode().unwrap_or_default());
                    out.push(b'\n');
                }
                out.extend_from_slice(b"ID ");
                out.extend_from_slice(&image.content);
                out.extend_from_slice(b"\nEI\n");
            }
            _ => run.push(op.clone()),
        }
    }
    flush(&mut run, &mut out);
    out
}

/// The operations of content `items` (streams, direct or by reference),
/// concatenated. Decoding is charged to `budget.decoded`.
pub(crate) fn content_ops(doc: &Document, items: &[Object], budget: &mut Budget) -> Result<Vec<Operation>, Unsupported> {
    let mut content = Vec::new();
    for item in items {
        let Some(Object::Stream(stream)) = deref(doc, item) else {
            continue;
        };
        let mut charged = 0;
        let decoded = strict_content_in(Some(doc), stream, MAX_STREAM_DECODED.min(budget.decoded), &mut charged);
        budget.decoded = budget.decoded.saturating_sub(charged);
        match decoded {
            Decoded::Content(bytes) => {
                content.extend(bytes);
                content.push(b'\n');
            }
            Decoded::TooLarge => return Err(Unsupported::new("content too large")),
            Decoded::Failed => return Err(Unsupported::new("content cannot be decoded")),
        }
    }
    decode_ops(&content)
}
