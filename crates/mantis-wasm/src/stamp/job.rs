//! Validation of a stamp job coming from JS. The Reflect layer (`binding`)
//! only copies raw values into the `Raw*` structs; every range and type check
//! lives in `validate_job` so it is unit-testable without a JS runtime.

use super::engine::{
    Anchor, Bates, ImageData, ImageStamp, PageSelection, StampJob, TextStamp,
};
use super::fonts::StdFont;

const MAX_PIXELS: u64 = 40_000_000;
/// Largest integer a JS number holds exactly.
const MAX_SAFE_INT: f64 = 9_007_199_254_740_991.0;

pub(crate) enum RawPages {
    All,
    List(Vec<f64>),
}

pub(crate) struct RawText {
    pub template: String,
    pub font: String,
    pub size: f64,
    pub color: [f64; 3],
    pub opacity: f64,
    pub anchor: String,
    pub margin_x: f64,
    pub margin_y: f64,
}

pub(crate) enum RawImageData {
    Rgba { width: f64, height: f64, pixels: Vec<u8> },
    Jpeg(Vec<u8>),
}

pub(crate) struct RawImage {
    pub image: RawImageData,
    pub page: f64,
    pub rect: [f64; 4],
    pub opacity: f64,
}

pub(crate) struct RawBates {
    pub prefix: String,
    pub suffix: String,
    pub start: f64,
    pub digits: f64,
}

pub(crate) struct RawJob {
    pub pages: RawPages,
    pub texts: Vec<RawText>,
    pub images: Vec<RawImage>,
    pub number_start: f64,
    pub bates: Option<RawBates>,
}

pub(crate) fn invalid(field: &str) -> String {
    format!("Invalid stamp settings: {field}")
}

fn int_in(v: f64, min: f64, max: f64, field: &str) -> Result<f64, String> {
    if v.is_finite() && v.fract() == 0.0 && v >= min && v <= max {
        Ok(v)
    } else {
        Err(invalid(field))
    }
}

fn finite(v: f64, field: &str) -> Result<f64, String> {
    if v.is_finite() { Ok(v) } else { Err(invalid(field)) }
}

fn opacity(v: f64, field: &str) -> Result<f64, String> {
    if v.is_finite() && (0.0..=1.0).contains(&v) { Ok(v) } else { Err(invalid(field)) }
}

fn parse_font(s: &str) -> Option<StdFont> {
    match s {
        "Helvetica" => Some(StdFont::Helvetica),
        "Helvetica-Bold" => Some(StdFont::HelveticaBold),
        "Times-Roman" => Some(StdFont::TimesRoman),
        "Courier" => Some(StdFont::Courier),
        _ => None,
    }
}

fn parse_anchor(s: &str) -> Option<Anchor> {
    match s {
        "top-left" => Some(Anchor::TopLeft),
        "top-center" => Some(Anchor::TopCenter),
        "top-right" => Some(Anchor::TopRight),
        "middle-left" => Some(Anchor::MiddleLeft),
        "center" => Some(Anchor::Center),
        "middle-right" => Some(Anchor::MiddleRight),
        "bottom-left" => Some(Anchor::BottomLeft),
        "bottom-center" => Some(Anchor::BottomCenter),
        "bottom-right" => Some(Anchor::BottomRight),
        _ => None,
    }
}

pub(crate) fn validate_job(raw: RawJob) -> Result<StampJob, String> {
    let pages = match raw.pages {
        RawPages::All => PageSelection::All,
        RawPages::List(list) => {
            let mut out = Vec::with_capacity(list.len());
            for (i, p) in list.into_iter().enumerate() {
                out.push(int_in(p, 1.0, f64::from(u32::MAX), &format!("pages[{i}]"))? as u32);
            }
            PageSelection::List(out)
        }
    };

    let mut texts = Vec::with_capacity(raw.texts.len());
    for (i, t) in raw.texts.into_iter().enumerate() {
        let f = |name: &str| format!("texts[{i}].{name}");
        if !t.size.is_finite() || !(1.0..=500.0).contains(&t.size) {
            return Err(invalid(&f("size")));
        }
        let font = parse_font(&t.font).ok_or_else(|| invalid(&f("font")))?;
        let anchor = parse_anchor(&t.anchor).ok_or_else(|| invalid(&f("anchor")))?;
        let mut color = [0.0; 3];
        for (c, v) in color.iter_mut().zip(t.color) {
            if !v.is_finite() || !(0.0..=1.0).contains(&v) {
                return Err(invalid(&f("color")));
            }
            *c = v;
        }
        texts.push(TextStamp {
            template: t.template,
            font,
            size: t.size,
            color,
            opacity: opacity(t.opacity, &f("opacity"))?,
            anchor,
            margin_x: finite(t.margin_x, &f("marginX"))?,
            margin_y: finite(t.margin_y, &f("marginY"))?,
        });
    }

    let mut images = Vec::with_capacity(raw.images.len());
    for (i, im) in raw.images.into_iter().enumerate() {
        let f = |name: &str| format!("images[{i}].{name}");
        let image = match im.image {
            RawImageData::Rgba { width, height, pixels } => {
                let w = int_in(width, 1.0, MAX_PIXELS as f64, &f("image.width"))? as u64;
                let h = int_in(height, 1.0, MAX_PIXELS as f64, &f("image.height"))? as u64;
                if w * h > MAX_PIXELS || pixels.len() as u64 != w * h * 4 {
                    return Err(invalid(&f("image.pixels")));
                }
                ImageData::Rgba { width: w as u32, height: h as u32, pixels }
            }
            RawImageData::Jpeg(bytes) => {
                if bytes.is_empty() {
                    return Err(invalid(&f("image.bytes")));
                }
                ImageData::Jpeg(bytes)
            }
        };
        let [x, y, w, h] = im.rect;
        if ![x, y, w, h].iter().all(|v| v.is_finite()) || w <= 0.0 || h <= 0.0 {
            return Err(invalid(&f("rect")));
        }
        images.push(ImageStamp {
            image,
            page: int_in(im.page, 1.0, f64::from(u32::MAX), &f("page"))? as u32,
            rect: [x, y, w, h],
            opacity: opacity(im.opacity, &f("opacity"))?,
        });
    }

    let bates = match raw.bates {
        None => None,
        Some(b) => Some(Bates {
            prefix: b.prefix,
            suffix: b.suffix,
            start: int_in(b.start, 0.0, MAX_SAFE_INT, "bates.start")? as u64,
            digits: int_in(b.digits, 1.0, 12.0, "bates.digits")? as u8,
        }),
    };

    Ok(StampJob {
        pages,
        texts,
        images,
        number_start: int_in(raw.number_start, -MAX_SAFE_INT, MAX_SAFE_INT, "numberStart")? as i64,
        bates,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text() -> RawText {
        RawText {
            template: "{n}".into(),
            font: "Helvetica".into(),
            size: 12.0,
            color: [0.0, 0.0, 0.0],
            opacity: 1.0,
            anchor: "bottom-center".into(),
            margin_x: 36.0,
            margin_y: 36.0,
        }
    }

    fn job() -> RawJob {
        RawJob { pages: RawPages::All, texts: vec![text()], images: vec![], number_start: 1.0, bates: None }
    }

    fn rgba(w: f64, h: f64, len: usize) -> RawImage {
        RawImage {
            image: RawImageData::Rgba { width: w, height: h, pixels: vec![0; len] },
            page: 1.0,
            rect: [0.0, 0.0, 10.0, 10.0],
            opacity: 1.0,
        }
    }

    fn err(raw: RawJob) -> String {
        validate_job(raw).err().expect("expected error")
    }

    #[test]
    fn accepts_valid_job() {
        let j = validate_job(job()).unwrap();
        assert_eq!(j.texts.len(), 1);
        assert_eq!(j.number_start, 1);
    }

    #[test]
    fn rejects_bad_text_fields() {
        let mut j = job();
        j.texts[0].size = 0.5;
        assert_eq!(err(j), "Invalid stamp settings: texts[0].size");
        let mut j = job();
        j.texts[0].size = 501.0;
        assert_eq!(err(j), "Invalid stamp settings: texts[0].size");
        let mut j = job();
        j.texts[0].size = f64::NAN;
        assert_eq!(err(j), "Invalid stamp settings: texts[0].size");
        let mut j = job();
        j.texts[0].opacity = 1.5;
        assert_eq!(err(j), "Invalid stamp settings: texts[0].opacity");
        let mut j = job();
        j.texts[0].font = "Comic".into();
        assert_eq!(err(j), "Invalid stamp settings: texts[0].font");
        let mut j = job();
        j.texts[0].anchor = "left".into();
        assert_eq!(err(j), "Invalid stamp settings: texts[0].anchor");
        let mut j = job();
        j.texts[0].color = [0.0, 2.0, 0.0];
        assert_eq!(err(j), "Invalid stamp settings: texts[0].color");
        let mut j = job();
        j.texts[0].margin_x = f64::INFINITY;
        assert_eq!(err(j), "Invalid stamp settings: texts[0].marginX");
    }

    #[test]
    fn rejects_bad_pages_and_start() {
        let mut j = job();
        j.pages = RawPages::List(vec![1.0, 0.0]);
        assert_eq!(err(j), "Invalid stamp settings: pages[1]");
        let mut j = job();
        j.pages = RawPages::List(vec![1.5]);
        assert_eq!(err(j), "Invalid stamp settings: pages[0]");
        let mut j = job();
        j.number_start = f64::NAN;
        assert_eq!(err(j), "Invalid stamp settings: numberStart");
    }

    #[test]
    fn validates_rgba_pixels() {
        let mut j = job();
        j.images.push(rgba(2.0, 2.0, 16));
        assert!(validate_job(j).is_ok());
        let mut j = job();
        j.images.push(rgba(2.0, 2.0, 15));
        assert_eq!(err(j), "Invalid stamp settings: images[0].image.pixels");
        let mut j = job();
        j.images.push(rgba(0.0, 2.0, 0));
        assert_eq!(err(j), "Invalid stamp settings: images[0].image.width");
        let mut j = job();
        j.images.push(rgba(10_000.0, 10_000.0, 0));
        assert_eq!(err(j), "Invalid stamp settings: images[0].image.pixels");
    }

    #[test]
    fn rejects_bad_image_geometry() {
        let mut j = job();
        let mut im = rgba(1.0, 1.0, 4);
        im.rect = [0.0, 0.0, -1.0, 5.0];
        j.images.push(im);
        assert_eq!(err(j), "Invalid stamp settings: images[0].rect");
        let mut j = job();
        let mut im = rgba(1.0, 1.0, 4);
        im.page = 0.0;
        j.images.push(im);
        assert_eq!(err(j), "Invalid stamp settings: images[0].page");
        let mut j = job();
        j.images.push(RawImage {
            image: RawImageData::Jpeg(vec![]),
            page: 1.0,
            rect: [0.0, 0.0, 1.0, 1.0],
            opacity: 1.0,
        });
        assert_eq!(err(j), "Invalid stamp settings: images[0].image.bytes");
    }

    #[test]
    fn validates_bates() {
        let mut j = job();
        j.bates = Some(RawBates { prefix: "A".into(), suffix: "".into(), start: 5.0, digits: 6.0 });
        let out = validate_job(j).unwrap();
        assert_eq!(out.bates.unwrap().digits, 6);
        for digits in [0.0, 13.0, 2.5] {
            let mut j = job();
            j.bates = Some(RawBates { prefix: "".into(), suffix: "".into(), start: 1.0, digits });
            assert_eq!(err(j), "Invalid stamp settings: bates.digits");
        }
        let mut j = job();
        j.bates = Some(RawBates { prefix: "".into(), suffix: "".into(), start: -1.0, digits: 3.0 });
        assert_eq!(err(j), "Invalid stamp settings: bates.start");
    }
}
