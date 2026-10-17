//! Validation of an images-to-PDF job coming from JS. The Reflect layer
//! (`binding`) only copies raw values into the `Raw*` structs; every range
//! and type check lives here so it is unit-testable without a JS runtime.

use super::to_pdf::{ImageData, InputImage, Layout, MAX_IMAGES, MAX_IMAGE_PIXELS, Orientation, PageSize};
use crate::geometry_ops::resize::{MAX_MARGIN, MAX_SHEET, MIN_SHEET};
use crate::stamp::image::jpeg_info;

/// Total encoded bytes (JPEG files plus RGBA buffers) one job may carry.
pub(crate) const MAX_INPUT_BYTES: u64 = 1 << 30;

pub(crate) fn invalid(field: &str) -> String {
    format!("Invalid image settings: {field}")
}

pub(crate) enum RawData {
    Jpeg(Vec<u8>),
    Rgba { width: f64, height: f64, pixels: Vec<u8> },
}

pub(crate) struct RawImage {
    pub data: RawData,
    pub rotate: f64,
    pub flip_x: bool,
}

pub(crate) enum RawPage {
    Fit,
    Paper([f64; 2]),
}

pub(crate) struct RawLayout {
    pub page: RawPage,
    pub orientation: String,
    pub margin: f64,
}

/// Adds `len` to the running input size; errors once the cap is exceeded.
pub(crate) fn add_input_bytes(total: u64, len: u64) -> Result<u64, String> {
    let sum = total.saturating_add(len);
    if sum > MAX_INPUT_BYTES { Err(invalid("size")) } else { Ok(sum) }
}

fn dimension(v: f64, field: &str) -> Result<u32, String> {
    if v.is_finite() && v.fract() == 0.0 && v >= 1.0 && v <= f64::from(u32::MAX) {
        Ok(v as u32)
    } else {
        Err(invalid(field))
    }
}

fn orientation(s: &str) -> Result<Orientation, String> {
    match s {
        "auto" => Ok(Orientation::Auto),
        "portrait" => Ok(Orientation::Portrait),
        "landscape" => Ok(Orientation::Landscape),
        _ => Err(invalid("orientation")),
    }
}

pub(crate) fn validate_layout(raw: RawLayout) -> Result<Layout, String> {
    let page = match raw.page {
        RawPage::Fit => PageSize::FitImage,
        RawPage::Paper(size) => {
            if !size.iter().all(|s| s.is_finite() && (MIN_SHEET..=MAX_SHEET).contains(s)) {
                return Err(invalid("page"));
            }
            PageSize::Paper(size)
        }
    };
    let m = raw.margin;
    if !m.is_finite() || !(0.0..=MAX_MARGIN).contains(&m) {
        return Err(invalid("margin"));
    }
    if let PageSize::Paper(size) = page {
        if 2.0 * m >= size[0].min(size[1]) {
            return Err(invalid("margin"));
        }
    }
    Ok(Layout { page, orientation: orientation(&raw.orientation)?, margin: m })
}

pub(crate) fn validate_images(raw: Vec<RawImage>) -> Result<Vec<InputImage>, String> {
    if raw.is_empty() || raw.len() > MAX_IMAGES {
        return Err(invalid("images"));
    }
    let mut bytes: u64 = 0;
    let mut out = Vec::with_capacity(raw.len());
    for (i, img) in raw.into_iter().enumerate() {
        let rotate = match img.rotate {
            r if r == 0.0 => 0,
            r if r == 90.0 => 90,
            r if r == 180.0 => 180,
            r if r == 270.0 => 270,
            _ => return Err(invalid(&format!("images[{i}].rotate"))),
        };
        let data = match img.data {
            RawData::Jpeg(b) => {
                bytes = add_input_bytes(bytes, b.len() as u64)?;
                // Frames are decoded by the viewer, so the frame size counts
                // against the same per-image bound as an RGBA buffer.
                let info = jpeg_info(&b).map_err(|e| format!("{e} (image {})", i + 1))?;
                if u64::from(info.width) * u64::from(info.height) > MAX_IMAGE_PIXELS {
                    return Err(invalid(&format!("images[{i}].pixels")));
                }
                ImageData::Jpeg(b)
            }
            RawData::Rgba { width, height, pixels } => {
                bytes = add_input_bytes(bytes, pixels.len() as u64)?;
                let w = dimension(width, &format!("images[{i}].width"))?;
                let h = dimension(height, &format!("images[{i}].height"))?;
                let count = u64::from(w) * u64::from(h);
                if count > MAX_IMAGE_PIXELS {
                    return Err(invalid(&format!("images[{i}].pixels")));
                }
                if count * 4 != pixels.len() as u64 {
                    return Err(invalid(&format!("images[{i}].pixels")));
                }
                ImageData::Rgba { width: w, height: h, pixels }
            }
        };
        out.push(InputImage { data, rotate, flip_x: img.flip_x });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rgba(w: f64, h: f64, len: usize) -> RawImage {
        RawImage { data: RawData::Rgba { width: w, height: h, pixels: vec![0; len] }, rotate: 0.0, flip_x: false }
    }

    fn jpeg_header(w: u16, h: u16) -> Vec<u8> {
        let mut v = vec![0xFF, 0xD8, 0xFF, 0xC0, 0, 11, 8];
        v.extend_from_slice(&h.to_be_bytes());
        v.extend_from_slice(&w.to_be_bytes());
        v.extend_from_slice(&[3, 1, 0x11, 0, 0xFF, 0xD9]);
        v
    }

    fn layout() -> RawLayout {
        RawLayout { page: RawPage::Paper([595.0, 842.0]), orientation: "auto".into(), margin: 36.0 }
    }

    #[test]
    fn accepts_valid_images() {
        let imgs = vec![
            rgba(2.0, 2.0, 16),
            RawImage { data: RawData::Jpeg(jpeg_header(10, 10)), rotate: 270.0, flip_x: true },
        ];
        let out = validate_images(imgs).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[1].rotate, 270);
        assert!(out[1].flip_x);
    }

    #[test]
    fn rejects_bad_counts() {
        assert_eq!(validate_images(vec![]).unwrap_err(), "Invalid image settings: images");
        let many = (0..=MAX_IMAGES).map(|_| rgba(1.0, 1.0, 4)).collect();
        assert_eq!(validate_images(many).unwrap_err(), "Invalid image settings: images");
    }

    #[test]
    fn rejects_bad_rgba() {
        for (w, h, len) in [(2.0, 2.0, 15), (0.0, 2.0, 0), (-1.0, 1.0, 4), (1.5, 1.0, 4), (f64::NAN, 1.0, 4)] {
            assert!(validate_images(vec![rgba(w, h, len)]).is_err(), "{w} {h} {len}");
        }
        let e = validate_images(vec![rgba(20_000.0, 20_000.0, 4)]).unwrap_err();
        assert_eq!(e, "Invalid image settings: images[0].pixels");
    }

    #[test]
    fn rejects_bad_rotation() {
        let mut i = rgba(1.0, 1.0, 4);
        i.rotate = 45.0;
        assert_eq!(validate_images(vec![i]).unwrap_err(), "Invalid image settings: images[0].rotate");
        let mut i = rgba(1.0, 1.0, 4);
        i.rotate = f64::NAN;
        assert!(validate_images(vec![i]).is_err());
    }

    #[test]
    fn jpeg_frame_counts_against_pixel_bound() {
        let big = RawImage { data: RawData::Jpeg(jpeg_header(65535, 65535)), rotate: 0.0, flip_x: false };
        assert_eq!(validate_images(vec![big]).unwrap_err(), "Invalid image settings: images[0].pixels");
        let junk = RawImage { data: RawData::Jpeg(vec![1, 2, 3, 4, 5]), rotate: 0.0, flip_x: false };
        assert!(validate_images(vec![junk]).is_err());
    }

    #[test]
    fn input_byte_cap() {
        assert_eq!(add_input_bytes(0, MAX_INPUT_BYTES).unwrap(), MAX_INPUT_BYTES);
        assert!(add_input_bytes(MAX_INPUT_BYTES, 1).is_err());
        assert!(add_input_bytes(u64::MAX, u64::MAX).is_err());
    }

    #[test]
    fn layout_bounds() {
        let l = validate_layout(layout()).unwrap();
        assert_eq!(l.page, PageSize::Paper([595.0, 842.0]));
        assert_eq!(l.orientation, Orientation::Auto);
        let fit = RawLayout { page: RawPage::Fit, orientation: "portrait".into(), margin: 0.0 };
        assert_eq!(validate_layout(fit).unwrap().page, PageSize::FitImage);
        for bad in [
            RawLayout { page: RawPage::Paper([10.0, 842.0]), ..layout() },
            RawLayout { page: RawPage::Paper([595.0, f64::NAN]), ..layout() },
            RawLayout { margin: -1.0, ..layout() },
            RawLayout { margin: 1000.0, ..layout() },
            RawLayout { margin: 300.0, page: RawPage::Paper([595.0, 842.0]), ..layout() },
            RawLayout { orientation: "diagonal".into(), ..layout() },
        ] {
            assert!(validate_layout(bad).is_err());
        }
    }
}
