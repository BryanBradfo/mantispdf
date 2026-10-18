//! Image redaction through `redact_content`: pixels painted in new objects,
//! originals untouched, images that cannot be edited need a raster.

use super::images::{covered_pixels, inline_as_xobject};
use super::interp::{IDENTITY, Interp, Quad, decode_ops, encode_ops};
use super::*;
use crate::images::extract::ImageDecoder;
use lopdf::{Dictionary, Document, Object, ObjectId, Stream, StringFormat, dictionary};

/// A `w` x `h` uncompressed DeviceRGB image with pixel colours `f(x, y)`.
fn rgb_image(w: usize, h: usize, f: impl Fn(usize, usize) -> [u8; 3]) -> Stream {
    let mut data = Vec::new();
    for y in 0..h {
        for x in 0..w {
            data.extend(f(x, y));
        }
    }
    Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Image", "Width" => w as i64, "Height" => h as i64,
            "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8,
        },
        data,
    )
}

fn gradient(x: usize, y: usize) -> [u8; 3] {
    [(x * 10 + 5) as u8, (y * 10 + 5) as u8, 7]
}

fn jpeg(w: u16, h: u16, colour: &[u8], kind: jpeg_encoder::ColorType) -> Vec<u8> {
    let pixels: Vec<u8> = colour.iter().copied().cycle().take(usize::from(w) * usize::from(h) * colour.len()).collect();
    let mut out = Vec::new();
    jpeg_encoder::Encoder::new(&mut out, 95).encode(&pixels, w, h, kind).unwrap();
    out
}

fn jpeg_image(bytes: Vec<u8>, w: i64, h: i64, space: &str) -> Stream {
    Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Image", "Width" => w, "Height" => h,
            "ColorSpace" => Object::Name(space.as_bytes().to_vec()), "BitsPerComponent" => 8, "Filter" => "DCTDecode",
        },
        bytes,
    )
}

struct Page {
    doc: Document,
    resources: Dictionary,
    image: ObjectId,
}

/// A document whose page resources hold `image` as /Im1 (in an /XObject
/// dictionary that is its own object, as when shared between pages).
fn page_with(image: Stream) -> Page {
    let mut doc = Document::with_version("1.7");
    let image = doc.add_object(image);
    let xobjects = doc.add_object(dictionary! { "Im1" => image });
    Page { doc, resources: dictionary! { "XObject" => xobjects }, image }
}

struct Out {
    content: Vec<u8>,
    report: Report,
    doc: Document,
    resources: Dictionary,
}

fn redact_page(mut page: Page, content: &[u8], rects: &[Rect], fill: Fill, budget: &mut Budget) -> Out {
    let ops = decode_ops(content).unwrap();
    let events = Interp::new(&page.doc, page.resources.clone()).run(&ops, IDENTITY, &mut Budget::page(1 << 20)).unwrap();
    let mut resources = page.resources.clone();
    let mut edit = PageEdit::new(&mut page.doc, &mut resources, fill, budget);
    let (ops, report) = redact_content(&mut edit, &ops, &events, rects).unwrap();
    Out { content: encode_ops(&ops), report, doc: page.doc, resources }
}

fn redact(page: Page, content: &[u8], rects: &[Rect]) -> Out {
    redact_page(page, content, rects, Fill::Black, &mut Budget::page(64 << 20))
}

/// `redact_page` that may need a raster: Err(reason) then.
fn try_redact(mut page: Page, content: &[u8], rects: &[Rect], budget: &mut Budget, pixels: bool) -> Result<Out, Unsupported> {
    let ops = decode_ops(content).unwrap();
    let events = Interp::new(&page.doc, page.resources.clone()).run(&ops, IDENTITY, &mut Budget::page(1 << 20)).unwrap();
    let mut resources = page.resources.clone();
    let mut edit = PageEdit::new(&mut page.doc, &mut resources, Fill::Black, budget);
    edit.pixels = pixels;
    let (ops, report) = redact_content(&mut edit, &ops, &events, rects)?;
    Ok(Out { content: encode_ops(&ops), report, doc: page.doc, resources })
}

/// The page needs a raster for this image (when planning too, unless the
/// cause only shows in its data), never a silent removal.
fn needs_raster(page: impl Fn() -> Page, content: &[u8], rects: &[Rect], budget: usize, also_planned: bool) {
    let err = try_redact(page(), content, rects, &mut Budget::page(budget), true).map(|_| ()).unwrap_err();
    assert!(err.0.contains("image that cannot be edited"), "{err:?}");
    if also_planned {
        assert!(try_redact(page(), content, rects, &mut Budget::page(budget), false).is_err(), "the plan sees it");
    }
}

fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Rect {
    Rect { x0, y0, x1, y1 }
}

/// Names drawn by `Do` in `content`.
fn drawn(content: &[u8]) -> Vec<Vec<u8>> {
    decode_ops(content)
        .unwrap()
        .into_iter()
        .filter(|op| op.operator == "Do")
        .filter_map(|op| op.operands.first().and_then(|o| o.as_name().ok()).map(<[u8]>::to_vec))
        .collect()
}

/// The image stream the page resources name `name`.
fn xobject<'a>(out: &'a Out, name: &[u8]) -> &'a Stream {
    let dict = super::interp::page_resources_dict(&out.doc, &out.resources, b"XObject");
    let obj = dict.get(name).unwrap();
    out.doc.get_object(obj.as_reference().unwrap()).unwrap().as_stream().unwrap()
}

/// RGBA of a Flate (or raw) image after its soft mask.
fn rgba_of(out: &Out, stream: &Stream) -> (usize, usize, Vec<u8>) {
    let mut decoder = ImageDecoder::new(&out.doc, 64 << 20);
    let (w, h, mut rgba) = decoder.rgba(stream, &out.resources).unwrap();
    if let Some(alpha) = decoder.alpha(&stream.dict, w, h).unwrap() {
        for (px, a) in rgba.chunks_exact_mut(4).zip(alpha) {
            px[3] = a;
        }
    }
    (w, h, rgba)
}

fn pixel(rgba: &[u8], w: usize, x: usize, y: usize) -> [u8; 4] {
    let i = 4 * (y * w + x);
    [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]
}

const DRAW_4X4: &[u8] = b"q 40 0 0 40 0 0 cm /Im1 Do Q";

#[test]
fn covered_pixels_follow_the_placement() {
    let square = Quad([(0.0, 0.0), (40.0, 0.0), (40.0, 40.0), (0.0, 40.0)]);
    // Left half: columns 0 and 1 (column 2 only touches x = 20).
    let left = covered_pixels(4, 4, &square, &[rect(0.0, 0.0, 20.0, 40.0)]).unwrap();
    assert_eq!(left.iter().filter(|c| **c).count(), 8);
    assert!((0..4).all(|y| left[y * 4] && left[y * 4 + 1] && !left[y * 4 + 2]));
    // Row 0 is the top of the image (high y).
    let top = covered_pixels(4, 4, &square, &[rect(0.0, 35.0, 40.0, 40.0)]).unwrap();
    assert!(top[..4].iter().all(|c| *c) && !top[4..].iter().any(|c| *c));
    // A rect cutting a pixel by a sliver still covers it.
    let sliver = covered_pixels(4, 4, &square, &[rect(29.9, 0.0, 30.1, 1.0)]).unwrap();
    assert_eq!((sliver[12 + 2], sliver[12 + 3], sliver.iter().filter(|c| **c).count()), (true, true, 2));
    assert!(covered_pixels(4, 4, &Quad([(0.0, 0.0), (40.0, 0.0), (40.0, 0.0), (0.0, 0.0)]), &[rect(0.0, 0.0, 1.0, 1.0)]).is_none());
}

#[test]
fn half_covered_rgb_image_is_redrawn_with_exact_pixels() {
    let mut original = rgb_image(4, 4, gradient);
    original.dict.set("Metadata", Object::Reference((99, 0)));
    original.dict.set("OPI", dictionary! {});
    original.dict.set("Alternates", vec![]);
    let page = page_with(original.clone());
    let image_id = page.image;
    let out = redact(page, DRAW_4X4, &[rect(0.0, 0.0, 20.0, 40.0)]);
    assert_eq!(out.report.images_redacted, 1);
    let names = drawn(&out.content);
    assert_eq!(names.len(), 1);
    assert_ne!(names[0], b"Im1".to_vec());
    let new = xobject(&out, &names[0]);
    for key in [&b"Metadata"[..], b"OPI", b"Alternates"] {
        assert!(!new.dict.has(key), "{}", String::from_utf8_lossy(key));
    }
    let (w, h, rgba) = rgba_of(&out, new);
    assert_eq!((w, h), (4, 4));
    for y in 0..4 {
        for x in 0..4 {
            let want = if x < 2 { [0, 0, 0, 255] } else { [gradient(x, y)[0], gradient(x, y)[1], 7, 255] };
            assert_eq!(pixel(&rgba, w, x, y), want, "({x}, {y})");
        }
    }
    // The original object (and the shared /XObject dictionary) are untouched.
    assert_eq!(out.doc.get_object(image_id).unwrap().as_stream().unwrap().content, original.content);
}

#[test]
fn shared_xobject_dictionary_is_not_mutated() {
    let page = page_with(rgb_image(4, 4, gradient));
    let shared = page.resources.get(b"XObject").unwrap().as_reference().unwrap();
    let before = page.doc.get_object(shared).unwrap().clone();
    let out = redact(page, DRAW_4X4, &[rect(0.0, 0.0, 20.0, 40.0)]);
    assert_eq!(out.doc.get_object(shared).unwrap(), &before, "another page's view of /Im1");
    assert!(out.resources.get(b"XObject").unwrap().as_dict().is_ok(), "the page owns a copy");
}

#[test]
fn rotated_placement_covers_the_right_pixels() {
    // Unit square (u, v) lands on (40 - 40 v, 40 u): user y < 20 is u < 0.5.
    let out = redact(page_with(rgb_image(4, 4, gradient)), b"q 0 40 -40 0 40 0 cm /Im1 Do Q", &[rect(0.0, 0.0, 40.0, 20.0)]);
    let new = xobject(&out, &drawn(&out.content)[0]);
    let (w, _, rgba) = rgba_of(&out, new);
    for y in 0..4 {
        for x in 0..4 {
            assert_eq!(pixel(&rgba, w, x, y)[..3] == [0, 0, 0], x < 2, "({x}, {y})");
        }
    }
}

#[test]
fn white_fill_paints_white() {
    let out = redact_page(page_with(rgb_image(4, 4, gradient)), DRAW_4X4, &[rect(0.0, 0.0, 10.0, 10.0)], Fill::White, &mut Budget::page(64 << 20));
    let new = xobject(&out, &drawn(&out.content)[0]);
    let (w, _, rgba) = rgba_of(&out, new);
    assert_eq!(pixel(&rgba, w, 0, 3), [255, 255, 255, 255]);
    assert_eq!(pixel(&rgba, w, 1, 3)[..3], gradient(1, 3));
}

#[test]
fn image_touched_only_on_its_edge_is_untouched() {
    let out = redact(page_with(rgb_image(4, 4, gradient)), DRAW_4X4, &[rect(40.0, 0.0, 50.0, 40.0)]);
    assert_eq!(drawn(&out.content), vec![b"Im1".to_vec()]);
    assert_eq!(out.report.images_redacted, 0);
}

#[test]
fn soft_mask_is_kept_and_covered_pixels_become_opaque() {
    let mut page = page_with(rgb_image(4, 4, gradient));
    let smask = page.doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Image", "Width" => 4, "Height" => 4,
            "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8,
        },
        vec![128; 16],
    ));
    let mut image = page.doc.get_object(page.image).unwrap().as_stream().unwrap().clone();
    image.dict.set("SMask", smask);
    page.doc.objects.insert(page.image, Object::Stream(image));
    let out = redact(page, DRAW_4X4, &[rect(0.0, 0.0, 20.0, 40.0)]);
    let new = xobject(&out, &drawn(&out.content)[0]);
    assert_ne!(new.dict.get(b"SMask").unwrap(), &Object::Reference(smask), "a new mask object");
    let (w, _, rgba) = rgba_of(&out, new);
    assert_eq!(pixel(&rgba, w, 0, 0), [0, 0, 0, 255]);
    assert_eq!(pixel(&rgba, w, 3, 0)[3], 128);
}

#[test]
fn stencil_masks_stop_painting_where_covered() {
    let mask = Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Image", "Width" => 4, "Height" => 4,
            "ImageMask" => true, "BitsPerComponent" => 1,
        },
        vec![0; 4],
    );
    let out = redact(page_with(mask), DRAW_4X4, &[rect(0.0, 0.0, 20.0, 40.0)]);
    let new = xobject(&out, &drawn(&out.content)[0]);
    assert_eq!(new.dict.get(b"ImageMask").unwrap(), &Object::Boolean(true));
    let (w, _, rgba) = rgba_of(&out, new);
    assert_eq!(pixel(&rgba, w, 0, 0)[3], 0, "covered: no longer painted");
    assert_eq!(pixel(&rgba, w, 3, 0)[3], 255);
}

#[test]
fn images_that_cannot_be_edited_need_a_raster() {
    let area = [rect(0.0, 0.0, 20.0, 40.0)];
    let jpx = || {
        let mut image = rgb_image(4, 4, gradient);
        image.dict.set("Filter", "JPXDecode");
        page_with(image)
    };
    needs_raster(jpx, DRAW_4X4, &area, 64 << 20, true);
    // Over what the job has left.
    needs_raster(|| page_with(rgb_image(4, 4, gradient)), DRAW_4X4, &area, 10, true);
    // A colour-key /Mask cannot be carried over.
    let keyed = || {
        let mut image = rgb_image(4, 4, gradient);
        image.dict.set("Mask", vec![0.into(), 10.into(), 0.into(), 10.into(), 0.into(), 10.into()]);
        page_with(image)
    };
    needs_raster(keyed, DRAW_4X4, &area, 64 << 20, true);
    // A colour space we do not convert.
    let lab = || {
        let mut image = rgb_image(4, 4, gradient);
        image.dict.set("ColorSpace", vec![Object::Name(b"Lab".to_vec()), Object::Dictionary(dictionary! {})]);
        page_with(image)
    };
    needs_raster(lab, DRAW_4X4, &area, 64 << 20, true);
}

#[test]
fn a_scan_with_a_ccitt_soft_mask_needs_a_raster() {
    // form_337.pdf: a Flate ICC image whose /SMask is CCITT. Marking one line
    // must never delete the whole scan.
    let scan = || {
        let mut page = page_with(rgb_image(4, 4, gradient));
        let icc = page.doc.add_object(Stream::new(dictionary! { "N" => 3 }, vec![]));
        let mask = page.doc.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Image", "Width" => 4, "Height" => 4,
                "ColorSpace" => "DeviceGray", "BitsPerComponent" => 1, "Filter" => "CCITTFaxDecode",
            },
            vec![0; 4],
        ));
        let mut image = page.doc.get_object(page.image).unwrap().as_stream().unwrap().clone();
        image.dict.set("ColorSpace", vec![Object::Name(b"ICCBased".to_vec()), icc.into()]);
        image.dict.set("SMask", mask);
        page.doc.objects.insert(page.image, Object::Stream(image));
        page
    };
    needs_raster(scan, DRAW_4X4, &[rect(0.0, 0.0, 40.0, 5.0)], 64 << 20, true);
}

#[test]
fn degenerate_placement_under_a_rect_needs_a_raster() {
    needs_raster(|| page_with(rgb_image(4, 4, gradient)), b"q 40 0 0 0 0 10 cm /Im1 Do Q", &[rect(0.0, 0.0, 20.0, 20.0)], 64 << 20, false);
}

fn decode_jpeg(bytes: &[u8]) -> (usize, Vec<u8>) {
    let mut decoder = zune_jpeg::JpegDecoder::new(bytes);
    let pixels = decoder.decode().unwrap();
    (decoder.info().unwrap().width as usize, pixels)
}

#[test]
fn jpeg_is_reencoded_as_jpeg_with_covered_pixels_filled() {
    let colour = [200u8, 100, 50];
    let page = page_with(jpeg_image(jpeg(64, 64, &colour, jpeg_encoder::ColorType::Rgb), 64, 64, "DeviceRGB"));
    let out = redact(page, b"q 64 0 0 64 0 0 cm /Im1 Do Q", &[rect(0.0, 0.0, 32.0, 64.0)]);
    assert_eq!(out.report.images_redacted, 1);
    let new = xobject(&out, &drawn(&out.content)[0]);
    assert_eq!(new.dict.get(b"Filter").unwrap(), &Object::Name(b"DCTDecode".to_vec()));
    assert_eq!(new.dict.get(b"ColorSpace").unwrap(), &Object::Name(b"DeviceRGB".to_vec()));
    let (w, pixels) = decode_jpeg(&new.content);
    for y in [0, 31, 63] {
        for x in [0, 10, 23] {
            let p = &pixels[3 * (y * w + x)..3 * (y * w + x) + 3];
            assert!(p.iter().all(|c| *c <= 12), "covered ({x}, {y}): {p:?}");
        }
        for x in [40, 52, 63] {
            let p = &pixels[3 * (y * w + x)..3 * (y * w + x) + 3];
            assert!(p.iter().zip(colour).all(|(a, b)| a.abs_diff(b) <= 12), "kept ({x}, {y}): {p:?}");
        }
    }
}

#[test]
fn gray_jpeg_stays_gray() {
    let page = page_with(jpeg_image(jpeg(16, 16, &[180], jpeg_encoder::ColorType::Luma), 16, 16, "DeviceGray"));
    let out = redact(page, b"q 16 0 0 16 0 0 cm /Im1 Do Q", &[rect(0.0, 0.0, 8.0, 16.0)]);
    let new = xobject(&out, &drawn(&out.content)[0]);
    assert_eq!(new.dict.get(b"ColorSpace").unwrap(), &Object::Name(b"DeviceGray".to_vec()));
    let (w, pixels) = decode_jpeg(&new.content);
    assert!(pixels[0] <= 12 && pixels[w - 1].abs_diff(180) <= 12, "{} {}", pixels[0], pixels[w - 1]);
}

#[test]
fn cmyk_inverted_or_broken_jpegs_need_a_raster() {
    let cmyk = || page_with(jpeg_image(jpeg(8, 8, &[10, 20, 30, 40], jpeg_encoder::ColorType::Cmyk), 8, 8, "DeviceCMYK"));
    let inverted = || {
        let mut image = jpeg_image(jpeg(8, 8, &[90], jpeg_encoder::ColorType::Luma), 8, 8, "DeviceGray");
        image.dict.set("Decode", vec![1.into(), 0.into()]);
        page_with(image)
    };
    let broken = || page_with(jpeg_image(b"\xFF\xD8 not a jpeg".to_vec(), 8, 8, "DeviceRGB"));
    let draw: &[u8] = b"q 8 0 0 8 0 0 cm /Im1 Do Q";
    let area = [rect(0.0, 0.0, 4.0, 8.0)];
    needs_raster(cmyk, draw, &area, 64 << 20, true);
    needs_raster(inverted, draw, &area, 64 << 20, true);
    needs_raster(broken, draw, &area, 64 << 20, true);
}

fn inline_rgb() -> Vec<u8> {
    let mut content = b"q 40 0 0 40 0 0 cm BI /W 4 /H 4 /CS /RGB /BPC 8 ID ".to_vec();
    for y in 0..4 {
        for x in 0..4 {
            content.extend(gradient(x, y));
        }
    }
    content.extend_from_slice(b" EI Q");
    content
}

#[test]
fn covered_inline_image_becomes_a_redacted_xobject() {
    let page = page_with(rgb_image(1, 1, |_, _| [0, 0, 0]));
    let out = redact(page, &inline_rgb(), &[rect(0.0, 0.0, 20.0, 40.0)]);
    assert_eq!(out.report.images_redacted, 1);
    let ops = decode_ops(&out.content).unwrap();
    assert!(!ops.iter().any(|op| op.operator == "BI"));
    let names = drawn(&out.content);
    let new = xobject(&out, &names[0]);
    let (w, _, rgba) = rgba_of(&out, new);
    assert_eq!(pixel(&rgba, w, 1, 2), [0, 0, 0, 255]);
    assert_eq!(pixel(&rgba, w, 2, 2)[..3], gradient(2, 2));
    // The page's other XObject keeps its name.
    assert!(super::interp::page_resources_dict(&out.doc, &out.resources, b"XObject").has(b"Im1"));
}

#[test]
fn uncovered_inline_image_is_kept_verbatim() {
    let content = inline_rgb();
    let out = redact(page_with(rgb_image(1, 1, |_, _| [0, 0, 0])), &content, &[rect(100.0, 100.0, 120.0, 120.0)]);
    let start = content.windows(2).position(|w| w == b"BI").unwrap();
    let raw = &content[start..content.len() - 2];
    assert!(raw.ends_with(b"EI"));
    assert!(out.content.windows(raw.len()).any(|w| w == raw));
    assert_eq!(out.report, Report::default());
}

#[test]
fn inline_abbreviations_expand() {
    let ops = decode_ops(b"BI /W 2 /H 1 /CS /G /BPC 8 /F [/Fl /AHx] /DP null /IM false /D [0 1] /I true ID xx EI").unwrap();
    let Object::Stream(inline) = &ops[0].operands[0] else { panic!() };
    let x = inline_as_xobject(inline);
    for (key, value) in [
        (&b"Width"[..], Object::Integer(2)),
        (b"Height", Object::Integer(1)),
        (b"ColorSpace", Object::Name(b"DeviceGray".to_vec())),
        (b"BitsPerComponent", Object::Integer(8)),
        (b"Filter", Object::Array(vec![Object::Name(b"FlateDecode".to_vec()), Object::Name(b"ASCIIHexDecode".to_vec())])),
        (b"ImageMask", Object::Boolean(false)),
        (b"Interpolate", Object::Boolean(true)),
        (b"Subtype", Object::Name(b"Image".to_vec())),
    ] {
        assert_eq!(x.dict.get(key).unwrap(), &value, "{}", String::from_utf8_lossy(key));
    }
    assert!(x.dict.has(b"Decode") && x.dict.has(b"DecodeParms") && !x.dict.has(b"W"));
    assert_eq!(x.content, b"xx");
}

/// Object ids reachable from `obj` (references followed, bounded).
fn reachable(doc: &Document, obj: &Object, seen: &mut std::collections::HashSet<ObjectId>) {
    match obj {
        Object::Reference(id) => {
            if seen.insert(*id)
                && let Ok(target) = doc.get_object(*id)
            {
                reachable(doc, target, seen);
            }
        }
        Object::Array(items) => items.iter().for_each(|o| reachable(doc, o, seen)),
        Object::Dictionary(d) => d.iter().for_each(|(_, o)| reachable(doc, o, seen)),
        Object::Stream(s) => s.dict.iter().for_each(|(_, o)| reachable(doc, o, seen)),
        _ => {}
    }
}

#[test]
fn the_original_image_is_unreachable_from_the_redacted_page() {
    let page = page_with(rgb_image(4, 4, gradient));
    let original = page.image;
    // Another page shares the /XObject dictionary (and so the image).
    let other_page = page.resources.clone();
    let out = redact(page, DRAW_4X4, &[rect(0.0, 0.0, 20.0, 40.0)]);
    let mut seen = std::collections::HashSet::new();
    reachable(&out.doc, &Object::Dictionary(out.resources.clone()), &mut seen);
    assert!(!seen.contains(&original), "redacted page still reaches the original image");
    let mut seen = std::collections::HashSet::new();
    reachable(&out.doc, &Object::Dictionary(other_page), &mut seen);
    assert!(seen.contains(&original), "the other page keeps it");
}

#[test]
fn names_only_removed_ops_used_are_pruned_others_kept() {
    let mut page = page_with(rgb_image(4, 4, gradient));
    let far = page.doc.add_object(rgb_image(1, 1, |_, _| [1, 2, 3]));
    let unused = page.doc.add_object(rgb_image(1, 1, |_, _| [4, 5, 6]));
    page.resources.set(
        "XObject",
        dictionary! { "Im1" => page.image, "Far" => far, "Unused" => unused },
    );
    let out = redact(page, b"q 40 0 0 40 0 0 cm /Im1 Do Q q 1 0 0 1 100 100 cm /Far Do Q", &[rect(0.0, 0.0, 20.0, 40.0)]);
    let xobjects = super::interp::page_resources_dict(&out.doc, &out.resources, b"XObject");
    assert!(!xobjects.has(b"Im1"));
    assert!(xobjects.has(b"Far") && xobjects.has(b"Unused"), "names the content never used stay (forms may)");
}

fn flate(bytes: &[u8]) -> Vec<u8> {
    use std::io::Write;
    let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    enc.write_all(bytes).unwrap();
    enc.finish().unwrap()
}

#[test]
fn huge_images_need_a_raster_before_any_large_allocation() {
    // 10000 x 10000 1-bit stencil: a few KB encoded, 800 MB once expanded.
    let (w, h) = (10_000usize, 10_000usize);
    let huge = || {
        page_with(Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Image", "Width" => w as i64, "Height" => h as i64,
                "ImageMask" => true, "BitsPerComponent" => 1, "Filter" => "FlateDecode",
            },
            flate(&vec![0u8; w / 8 * h]),
        ))
    };
    needs_raster(huge, DRAW_4X4, &[rect(0.0, 0.0, 20.0, 40.0)], 64 << 20, true);
    // Within the per-image cap but over what the job has left.
    needs_raster(|| page_with(rgb_image(4, 4, gradient)), DRAW_4X4, &[rect(0.0, 0.0, 20.0, 40.0)], 4 * 4 * 8 - 1, true);
    // Enough budget: about 8 bytes per pixel are held while editing, then
    // given back (the budget bounds the peak); the new image's encoded
    // bytes stay charged.
    let mut budget = Budget::page(4 * 4 * 8 + 1024);
    let out = redact_page(page_with(rgb_image(4, 4, gradient)), DRAW_4X4, &[rect(0.0, 0.0, 20.0, 40.0)], Fill::Black, &mut budget);
    assert_eq!(out.report.images_redacted, 1);
    let created: usize = out.report.created_images.iter().map(|id| out.doc.get_object(*id).unwrap().as_stream().unwrap().content.len()).sum();
    assert!(created > 0);
    assert_eq!(budget.decoded, 4 * 4 * 8 + 1024 - created);
}

#[test]
fn jpeg_image_masks_need_a_raster() {
    let mask = || {
        let mut image = jpeg_image(jpeg(8, 8, &[90], jpeg_encoder::ColorType::Luma), 8, 8, "DeviceGray");
        image.dict.remove(b"ColorSpace");
        image.dict.set("ImageMask", true);
        page_with(image)
    };
    needs_raster(mask, b"q 8 0 0 8 0 0 cm /Im1 Do Q", &[rect(0.0, 0.0, 4.0, 8.0)], 64 << 20, true);
}

#[test]
fn alias_names_of_a_replaced_image_go_too() {
    let mut page = page_with(rgb_image(4, 4, gradient));
    let original = page.image;
    page.resources.set("XObject", dictionary! { "Im1" => original, "Alias" => original });
    let out = redact(page, DRAW_4X4, &[rect(0.0, 0.0, 20.0, 40.0)]);
    let mut seen = std::collections::HashSet::new();
    reachable(&out.doc, &Object::Dictionary(out.resources.clone()), &mut seen);
    assert!(!seen.contains(&original), "an alias name still reaches the original image");
    // An alias the new content still draws stays (it is drawn outside the areas).
    let mut page = page_with(rgb_image(4, 4, gradient));
    page.resources.set("XObject", dictionary! { "Im1" => page.image, "Alias" => page.image });
    let out = redact(page, b"q 40 0 0 40 0 0 cm /Im1 Do Q q 1 0 0 1 200 200 cm /Alias Do Q", &[rect(0.0, 0.0, 20.0, 40.0)]);
    assert!(super::interp::page_resources_dict(&out.doc, &out.resources, b"XObject").has(b"Alias"));
}

#[test]
fn calibrated_jpeg_colour_spaces_are_kept() {
    let white = || dictionary! { "WhitePoint" => vec![Object::Real(0.95), 1.into(), Object::Real(1.09)] };
    for (colour, kind, family) in [
        (vec![180u8], jpeg_encoder::ColorType::Luma, "CalGray"),
        (vec![200u8, 100, 50], jpeg_encoder::ColorType::Rgb, "CalRGB"),
    ] {
        let mut image = jpeg_image(jpeg(16, 16, &colour, kind), 16, 16, "DeviceGray");
        let space = Object::Array(vec![Object::Name(family.as_bytes().to_vec()), Object::Dictionary(white())]);
        image.dict.set("ColorSpace", space.clone());
        let out = redact(page_with(image), b"q 16 0 0 16 0 0 cm /Im1 Do Q", &[rect(0.0, 0.0, 8.0, 16.0)]);
        let new = xobject(&out, &drawn(&out.content)[0]);
        assert_eq!(new.dict.get(b"ColorSpace").unwrap(), &space, "{family}");
    }
}

/// A 4 x 1 image with `extra` dictionary entries, drawn 40 x 10, left half
/// covered; returns the redacted RGBA.
fn redact_row(extra: Dictionary, data: Vec<u8>) -> Vec<u8> {
    let mut dict = dictionary! { "Type" => "XObject", "Subtype" => "Image", "Width" => 4, "Height" => 1 };
    for (k, v) in extra.iter() {
        dict.set(k.clone(), v.clone());
    }
    let out = redact(page_with(Stream::new(dict, data)), b"q 40 0 0 10 0 0 cm /Im1 Do Q", &[rect(0.0, 0.0, 20.0, 10.0)]);
    assert_eq!(out.report.images_redacted, 1);
    rgba_of(&out, xobject(&out, &drawn(&out.content)[0])).2
}

#[test]
fn indexed_decode_and_16_bit_images_keep_their_uncovered_colours() {
    let indexed = redact_row(
        dictionary! {
            "ColorSpace" => vec![Object::Name(b"Indexed".to_vec()), Object::Name(b"DeviceRGB".to_vec()), 1.into(),
                Object::String(vec![255, 0, 0, 0, 255, 0], StringFormat::Hexadecimal)],
            "BitsPerComponent" => 8,
        },
        vec![0, 1, 0, 1],
    );
    assert_eq!(indexed, vec![0, 0, 0, 255, 0, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255]);
    let inverted = redact_row(
        dictionary! { "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8, "Decode" => vec![1.into(), 0.into()] },
        vec![0, 255, 0, 255],
    );
    assert_eq!(inverted, vec![0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255]);
    let deep = redact_row(
        dictionary! { "ColorSpace" => "DeviceGray", "BitsPerComponent" => 16 },
        vec![0x12, 0x34, 0xAB, 0xCD, 0x80, 0x00, 0xFF, 0xFF],
    );
    assert_eq!(deep, vec![0, 0, 0, 255, 0, 0, 0, 255, 0x80, 0x80, 0x80, 255, 0xFF, 0xFF, 0xFF, 255]);
}
