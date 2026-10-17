//! Images to PDF: one page per image, in a fresh document.

pub use crate::geometry_ops::resize::Orientation;
pub use crate::stamp::engine::ImageData;

use crate::geometry_ops::resize::{MAX_MARGIN, MAX_SHEET, MIN_SHEET};
use crate::geometry_ops::{box_object, concat};
use crate::page_content::{fmt_num, plain_stream};
use crate::pdf_util::save_pdf_with_capacity;
use crate::stamp::image::{BuiltImage, build_image};
use lopdf::{Document, Object, Stream, dictionary};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PageSize {
    /// Paper `[width, height]` in points, portrait (width <= height).
    Paper([f64; 2]),
    /// The page takes the image's natural size plus the margins.
    FitImage,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Layout {
    pub page: PageSize,
    /// Ignored for `FitImage`.
    pub orientation: Orientation,
    /// Points kept free on every side of the page.
    pub margin: f64,
}

#[derive(Debug, Clone)]
pub struct InputImage {
    pub data: ImageData,
    /// Clockwise quarter turns as displayed: 0, 90, 180 or 270.
    pub rotate: u16,
    /// Mirror left to right (applied before the rotation).
    pub flip_x: bool,
}

/// Most images in one job.
pub(crate) const MAX_IMAGES: usize = 300;
/// Most pixels in one image (an RGBA buffer or a JPEG frame).
pub(crate) const MAX_IMAGE_PIXELS: u64 = 100_000_000;
/// Most input bytes in one job: JPEG files plus RGBA buffers. wasm32 holds
/// the inputs, the built image streams and the output at once, so the peak is
/// about twice this (see the final fix report for the measurement).
/// `src/lib/imagesToPdf.ts` mirrors MAX_IMAGES, MAX_IMAGE_PIXELS and this.
pub(crate) const MAX_INPUT_BYTES: u64 = 512 * 1024 * 1024;
/// Most pixels in all of a job's RGBA images: their bytes fit the input budget.
pub(crate) const MAX_TOTAL_PIXELS: u64 = MAX_INPUT_BYTES / 4;
/// Points per CSS pixel: an image's natural size assumes 96 dpi.
const PT_PER_PX: f64 = 72.0 / 96.0;

fn invalid(field: &str) -> String {
    format!("Invalid image settings: {field}")
}

/// Every setting and budget, checked before any image is built.
fn validate(images: &[InputImage], layout: &Layout) -> Result<(), String> {
    if images.is_empty() || images.len() > MAX_IMAGES {
        return Err(invalid("images"));
    }
    let m = layout.margin;
    if !m.is_finite() || !(0.0..=MAX_MARGIN).contains(&m) {
        return Err(invalid("margin"));
    }
    if let PageSize::Paper(size) = layout.page {
        if !size.iter().all(|s| s.is_finite() && (MIN_SHEET..=MAX_SHEET).contains(s)) {
            return Err(invalid("page"));
        }
        if 2.0 * m >= size[0].min(size[1]) {
            return Err(invalid("margin"));
        }
    }
    let mut total: u64 = 0;
    for image in images {
        if !matches!(image.rotate, 0 | 90 | 180 | 270) {
            return Err(invalid("rotate"));
        }
        if let ImageData::Rgba { width, height, .. } = &image.data {
            let pixels = u64::from(*width) * u64::from(*height);
            total = total.saturating_add(pixels);
            if pixels > MAX_IMAGE_PIXELS || total > MAX_TOTAL_PIXELS {
                return Err(invalid("pixels"));
            }
        }
    }
    Ok(())
}

/// Page size and the image's matrix (unit square to page space).
fn place(px: (f64, f64), image: &InputImage, layout: &Layout) -> ([f64; 2], [f64; 6]) {
    let turned = matches!(image.rotate, 90 | 270);
    // Natural size as displayed (after the rotation).
    let (nw, nh) = (px.0 * PT_PER_PX, px.1 * PT_PER_PX);
    let (dw, dh) = if turned { (nh, nw) } else { (nw, nh) };
    let m = layout.margin;
    let (page, avail) = match layout.page {
        PageSize::FitImage => {
            let max = MAX_SHEET - 2.0 * m;
            let s = 1f64.min(max / dw).min(max / dh);
            let (w, h) = (dw * s, dh * s);
            ([(w + 2.0 * m).max(MIN_SHEET), (h + 2.0 * m).max(MIN_SHEET)], (w, h))
        }
        PageSize::Paper([a, b]) => {
            let (short, long) = (a.min(b), a.max(b));
            let landscape = match layout.orientation {
                Orientation::Auto => dw > dh,
                Orientation::Portrait => false,
                Orientation::Landscape => true,
            };
            let page = if landscape { [long, short] } else { [short, long] };
            (page, (page[0] - 2.0 * m, page[1] - 2.0 * m))
        }
    };
    let s = 1f64.min(avail.0 / dw).min(avail.1 / dh);
    let (w, h) = (dw * s, dh * s);
    let (x, y) = ((page[0] - w) / 2.0, (page[1] - h) / 2.0);
    // Drawn size before the rotation.
    let (iw, ih) = if turned { (h, w) } else { (w, h) };
    let flip = if image.flip_x { [-1.0, 0.0, 0.0, 1.0, 1.0, 0.0] } else { IDENTITY };
    let scale = [iw, 0.0, 0.0, ih, 0.0, 0.0];
    // Clockwise as displayed (y up), shifted back into the positive quadrant.
    let rotate = match image.rotate {
        90 => [0.0, -1.0, 1.0, 0.0, 0.0, iw],
        180 => [-1.0, 0.0, 0.0, -1.0, iw, ih],
        270 => [0.0, 1.0, -1.0, 0.0, ih, 0.0],
        _ => IDENTITY,
    };
    let translate = [1.0, 0.0, 0.0, 1.0, x, y];
    let matrix = concat(concat(concat(flip, scale), rotate), translate);
    (page, matrix)
}

const IDENTITY: [f64; 6] = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// Pixel size from a built image's dictionary.
fn pixel_size(stream: &Stream) -> Result<(f64, f64), String> {
    let get = |key: &[u8]| stream.dict.get(key).and_then(Object::as_i64).map_err(|_| "Invalid image".to_string());
    Ok((get(b"Width")? as f64, get(b"Height")? as f64))
}

/// One page per image, in order, in a fresh document (catalog with /Pages
/// only). Takes the inputs by value and drops each one once its XObject is
/// built, so the inputs and the built streams are never all alive at once.
pub fn images_to_pdf(images: Vec<InputImage>, layout: &Layout) -> Result<Vec<u8>, String> {
    validate(&images, layout)?;
    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();
    let mut kids = Vec::with_capacity(images.len());
    // Stream bytes written to the output, to size its buffer up front.
    let mut stream_bytes = 0usize;
    for image in images {
        let BuiltImage { image: mut stream, smask } = build_image(&image.data)?;
        let (page, m) = place(pixel_size(&stream)?, &image, layout);
        drop(image);
        stream_bytes += stream.content.len() + smask.as_ref().map_or(0, |s| s.content.len());
        if let Some(mask) = smask {
            let mask_id = doc.add_object(mask);
            stream.dict.set("SMask", mask_id);
        }
        let image_id = doc.add_object(stream);
        let ops = format!("q {} cm /Im0 Do Q", m.iter().map(|&v| fmt_num(v)).collect::<Vec<_>>().join(" "));
        let contents = doc.add_object(plain_stream(ops.into_bytes()));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => box_object([0.0, 0.0, page[0], page[1]]),
            "Resources" => dictionary! { "XObject" => dictionary! { "Im0" => image_id } },
            "Contents" => contents,
        });
        kids.push(Object::Reference(page_id));
    }
    let count = kids.len() as i64;
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => count }),
    );
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog);
    // Object syntax, page dictionaries and the xref table: well under 1 KiB a page.
    save_pdf_with_capacity(&mut doc, stream_bytes + 1024 * (count as usize + 4))
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{Document, Object, ObjectId};

    const A4: [f64; 2] = [595.28, 841.89];

    fn layout(page: PageSize, margin: f64) -> Layout {
        Layout { page, orientation: Orientation::Auto, margin }
    }

    fn rgba(width: u32, height: u32, alpha: u8) -> ImageData {
        let mut pixels = vec![0u8; (width * height * 4) as usize];
        for px in pixels.chunks_exact_mut(4) {
            px.copy_from_slice(&[10, 20, 30, alpha]);
        }
        ImageData::Rgba { width, height, pixels }
    }

    fn img(data: ImageData, rotate: u16, flip_x: bool) -> InputImage {
        InputImage { data, rotate, flip_x }
    }

    /// SOI, a baseline frame header (`width` x `height`, 3 components), EOI.
    fn jpeg(width: u16, height: u16) -> Vec<u8> {
        let mut v = vec![0xFF, 0xD8];
        let [h1, h0] = height.to_be_bytes();
        let [w1, w0] = width.to_be_bytes();
        let mut frame = vec![8, h1, h0, w1, w0, 3];
        for c in 0..3u8 {
            frame.extend_from_slice(&[c + 1, 0x11, 0]);
        }
        v.extend_from_slice(&[0xFF, 0xC0, 0x00, (frame.len() + 2) as u8]);
        v.extend_from_slice(&frame);
        v.extend_from_slice(&[0xFF, 0xD9]);
        v
    }

    fn pages(doc: &Document) -> Vec<ObjectId> {
        doc.get_pages().values().copied().collect()
    }

    fn media_box(doc: &Document, page: ObjectId) -> Vec<f64> {
        let dict = doc.get_dictionary(page).unwrap();
        dict.get(b"MediaBox")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|o| o.as_float().unwrap() as f64)
            .collect()
    }

    fn content(doc: &Document, page: ObjectId) -> String {
        String::from_utf8(doc.get_page_content(page).unwrap()).unwrap()
    }

    /// The image XObject `/Im0` of `page`.
    fn image(doc: &Document, page: ObjectId) -> lopdf::Stream {
        let dict = doc.get_dictionary(page).unwrap();
        let res = dict.get(b"Resources").unwrap().as_dict().unwrap();
        let xobj = res.get(b"XObject").unwrap().as_dict().unwrap();
        let id = xobj.get(b"Im0").unwrap().as_reference().unwrap();
        doc.get_object(id).unwrap().as_stream().unwrap().clone()
    }

    fn close(actual: &[f64], expected: &[f64]) {
        assert_eq!(actual.len(), expected.len(), "{actual:?} vs {expected:?}");
        for (a, e) in actual.iter().zip(expected) {
            assert!((a - e).abs() < 0.01, "{actual:?} vs {expected:?}");
        }
    }

    fn run(images: &[InputImage], layout: &Layout) -> Document {
        let out = images_to_pdf(images.to_vec(), layout).unwrap();
        Document::load_mem(&out).unwrap()
    }

    #[test]
    fn landscape_image_on_auto_a4_gets_a_landscape_page_and_fits_the_width() {
        let doc = run(&[img(rgba(1200, 800, 255), 0, false)], &layout(PageSize::Paper(A4), 0.0));
        let p = pages(&doc);
        assert_eq!(p.len(), 1);
        close(&media_box(&doc, p[0]), &[0.0, 0.0, 841.89, 595.28]);
        // Natural 900 x 600 pt; s = 841.89 / 900; drawn 841.89 x 561.26,
        // centred vertically: (595.28 - 561.26) / 2 = 17.01.
        assert_eq!(content(&doc, p[0]), "q 841.89 0 0 561.26 0 17.01 cm /Im0 Do Q");
    }

    #[test]
    fn small_image_is_never_scaled_up_and_is_centred() {
        let doc = run(&[img(rgba(400, 200, 255), 0, false)], &layout(PageSize::Paper(A4), 0.0));
        let p = pages(&doc);
        close(&media_box(&doc, p[0]), &[0.0, 0.0, 841.89, 595.28]);
        // 300 x 150 pt at (270.945, 222.64).
        assert_eq!(content(&doc, p[0]), "q 300 0 0 150 270.945 222.64 cm /Im0 Do Q");
    }

    #[test]
    fn forced_portrait_and_margin() {
        let l = Layout { page: PageSize::Paper(A4), orientation: Orientation::Portrait, margin: 20.0 };
        let doc = run(&[img(rgba(1200, 800, 255), 0, false)], &l);
        let p = pages(&doc);
        close(&media_box(&doc, p[0]), &[0.0, 0.0, 595.28, 841.89]);
        // Available 555.28 wide; s = 555.28 / 900; drawn 555.28 x 370.186667.
        let h = 600.0 * 555.28 / 900.0;
        let y = (841.89 - h) / 2.0;
        let expected = format!(
            "q 555.28 0 0 {} 20 {} cm /Im0 Do Q",
            crate::page_content::fmt_num(h),
            crate::page_content::fmt_num(y)
        );
        assert_eq!(content(&doc, p[0]), expected);
    }

    #[test]
    fn rotate_90_swaps_the_displayed_size() {
        // 800 x 1200 px portrait pixels, turned a quarter clockwise: displayed
        // landscape, so the same placement as the first test.
        let doc = run(&[img(rgba(800, 1200, 255), 90, false)], &layout(PageSize::Paper(A4), 0.0));
        let p = pages(&doc);
        close(&media_box(&doc, p[0]), &[0.0, 0.0, 841.89, 595.28]);
        // Unrotated drawn size 561.26 x 841.89; top-left corner goes to the
        // top-right: [0 -iw ih 0 x iw+y].
        assert_eq!(content(&doc, p[0]), "q 0 -561.26 841.89 0 0 578.27 cm /Im0 Do Q");
    }

    #[test]
    fn rotate_180_and_270() {
        let l = layout(PageSize::FitImage, 0.0);
        let doc = run(&[img(rgba(40, 80, 255), 180, false), img(rgba(40, 80, 255), 270, false)], &l);
        let p = pages(&doc);
        close(&media_box(&doc, p[0]), &[0.0, 0.0, 36.0, 60.0]);
        // 30 x 60 pt on a 36 x 60 page (minimum side), x offset 3.
        assert_eq!(content(&doc, p[0]), "q -30 0 0 -60 33 60 cm /Im0 Do Q");
        close(&media_box(&doc, p[1]), &[0.0, 0.0, 60.0, 36.0]);
        // Displayed 60 x 30 at (0, 3): [0 iw -ih 0 x+ih y].
        assert_eq!(content(&doc, p[1]), "q 0 30 -60 0 60 3 cm /Im0 Do Q");
    }

    #[test]
    fn flip_x_mirrors_with_a_negative_a() {
        let doc = run(&[img(rgba(1200, 800, 255), 0, true)], &layout(PageSize::Paper(A4), 0.0));
        let p = pages(&doc);
        assert_eq!(content(&doc, p[0]), "q -841.89 0 0 561.26 841.89 17.01 cm /Im0 Do Q");
    }

    #[test]
    fn flip_happens_before_the_rotation() {
        // Flip then a quarter turn clockwise: the transpose of the unit
        // square, scaled; [0 iw ih 0 x y].
        let doc = run(&[img(rgba(800, 1200, 255), 90, true)], &layout(PageSize::Paper(A4), 0.0));
        let p = pages(&doc);
        assert_eq!(content(&doc, p[0]), "q 0 561.26 841.89 0 0 17.01 cm /Im0 Do Q");
    }

    #[test]
    fn fit_image_page_is_natural_size_plus_margins() {
        let doc = run(&[img(rgba(1200, 800, 255), 0, false)], &layout(PageSize::FitImage, 10.0));
        let p = pages(&doc);
        close(&media_box(&doc, p[0]), &[0.0, 0.0, 920.0, 620.0]);
        assert_eq!(content(&doc, p[0]), "q 900 0 0 600 10 10 cm /Im0 Do Q");
    }

    #[test]
    fn fit_image_scales_down_a_huge_image_keeping_its_aspect() {
        // 40000 x 10 px: natural 30000 x 7.5 pt, scaled to 14400 x 3.6.
        let doc = run(&[img(rgba(40000, 10, 255), 0, false)], &layout(PageSize::FitImage, 0.0));
        let p = pages(&doc);
        close(&media_box(&doc, p[0]), &[0.0, 0.0, 14400.0, 36.0]);
        assert_eq!(content(&doc, p[0]), "q 14400 0 0 3.6 0 16.2 cm /Im0 Do Q");
    }

    #[test]
    fn jpeg_bytes_pass_through_unchanged() {
        let bytes = jpeg(120, 80);
        let doc = run(&[img(ImageData::Jpeg(bytes.clone()), 0, false)], &layout(PageSize::FitImage, 0.0));
        let p = pages(&doc);
        let im = image(&doc, p[0]);
        assert_eq!(im.dict.get(b"Filter").unwrap().as_name().unwrap(), b"DCTDecode");
        assert_eq!(im.content, bytes);
        close(&media_box(&doc, p[0]), &[0.0, 0.0, 90.0, 60.0]);
    }

    #[test]
    fn alpha_gets_a_soft_mask_and_opaque_does_not() {
        let doc = run(
            &[img(rgba(4, 4, 128), 0, false), img(rgba(4, 4, 255), 0, false)],
            &layout(PageSize::FitImage, 0.0),
        );
        let p = pages(&doc);
        let masked = image(&doc, p[0]);
        let smask = masked.dict.get(b"SMask").unwrap().as_reference().unwrap();
        assert!(doc.get_object(smask).unwrap().as_stream().is_ok());
        assert!(!image(&doc, p[1]).dict.has(b"SMask"));
    }

    #[test]
    fn page_count_matches_images_and_output_reloads() {
        let images: Vec<_> = (0..5).map(|_| img(rgba(10, 10, 255), 0, false)).collect();
        let doc = run(&images, &layout(PageSize::Paper(A4), 36.0));
        assert_eq!(pages(&doc).len(), 5);
        let catalog = doc.catalog().unwrap();
        assert!(catalog.get(b"Pages").is_ok());
    }

    #[test]
    fn too_many_images_rejected() {
        let images: Vec<_> = (0..301).map(|_| img(rgba(1, 1, 255), 0, false)).collect();
        let err = images_to_pdf(images.clone(), &layout(PageSize::FitImage, 0.0)).unwrap_err();
        assert_eq!(err, "Invalid image settings: images");
        assert!(images_to_pdf(images[..300].to_vec(), &layout(PageSize::FitImage, 0.0)).is_ok());
    }

    #[test]
    fn invalid_settings_rejected() {
        let one = [img(rgba(1, 1, 255), 0, false)];
        let bad = |l: Layout, imgs: &[InputImage]| images_to_pdf(imgs.to_vec(), &l).unwrap_err();
        assert_eq!(bad(layout(PageSize::FitImage, 0.0), &[]), "Invalid image settings: images");
        assert_eq!(bad(layout(PageSize::FitImage, -1.0), &one), "Invalid image settings: margin");
        assert_eq!(bad(layout(PageSize::FitImage, 600.0), &one), "Invalid image settings: margin");
        assert_eq!(bad(layout(PageSize::FitImage, f64::NAN), &one), "Invalid image settings: margin");
        assert_eq!(bad(layout(PageSize::Paper([10.0, 800.0]), 0.0), &one), "Invalid image settings: page");
        assert_eq!(bad(layout(PageSize::Paper([600.0, 20000.0]), 0.0), &one), "Invalid image settings: page");
        // Margins swallowing the whole paper.
        assert_eq!(bad(layout(PageSize::Paper([100.0, 100.0]), 50.0), &one), "Invalid image settings: margin");
        assert_eq!(
            bad(layout(PageSize::FitImage, 0.0), &[img(rgba(1, 1, 255), 45, false)]),
            "Invalid image settings: rotate"
        );
        // Bad pixel data is the image builder's error.
        let short = ImageData::Rgba { width: 2, height: 2, pixels: vec![0; 3] };
        assert!(images_to_pdf(vec![img(short, 0, false)], &layout(PageSize::FitImage, 0.0)).is_err());
    }

    #[test]
    fn pixel_budgets_rejected_before_any_work() {
        // Lengths are never checked: the budgets fail first.
        let huge = ImageData::Rgba { width: 20_000, height: 5_001, pixels: vec![] };
        assert_eq!(
            images_to_pdf(vec![img(huge, 0, false)], &layout(PageSize::FitImage, 0.0)).unwrap_err(),
            "Invalid image settings: pixels"
        );
        let big = || img(ImageData::Rgba { width: 10_000, height: 10_000, pixels: vec![] }, 0, false);
        let five: Vec<_> = (0..5).map(|_| big()).collect();
        assert_eq!(
            images_to_pdf(five, &layout(PageSize::FitImage, 0.0)).unwrap_err(),
            "Invalid image settings: pixels"
        );
    }

    #[test]
    fn page_objects_are_plain() {
        let doc = run(&[img(rgba(2, 2, 255), 0, false)], &layout(PageSize::FitImage, 0.0));
        let p = pages(&doc)[0];
        let dict = doc.get_dictionary(p).unwrap();
        assert_eq!(dict.get(b"Type").unwrap(), &Object::Name(b"Page".to_vec()));
        assert!(doc.trailer.get(b"Root").is_ok());
    }
}
