//! Validation of a stamp job coming from JS. The Reflect layer (`binding`)
//! only copies raw values into the `Raw*` structs; every range and type check
//! lives in `validate_job` so it is unit-testable without a JS runtime.

use super::engine::{
    Anchor, Bates, ImageData, ImageStamp, MAX_BATES_AFFIX_CHARS, MAX_COORD, MAX_IMAGES, MAX_TEMPLATE_CHARS, MAX_TEXTS,
    MAX_TOTAL_PIXELS, PageSelection, StampJob, TextStamp, uses_bates_token,
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
    /// Optional visible-space baseline origin `[x, y]`.
    pub at: Option<[f64; 2]>,
    /// Optional 1-based page the text is restricted to.
    pub page: Option<f64>,
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

fn coord(v: f64, field: &str) -> Result<f64, String> {
    if v.is_finite() && v.abs() <= MAX_COORD { Ok(v) } else { Err(invalid(field)) }
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

    if raw.texts.len() > MAX_TEXTS {
        return Err(invalid("texts"));
    }
    if raw.images.len() > MAX_IMAGES {
        return Err(invalid("images"));
    }

    let mut texts = Vec::with_capacity(raw.texts.len());
    for (i, t) in raw.texts.into_iter().enumerate() {
        let f = |name: &str| format!("texts[{i}].{name}");
        if !t.size.is_finite() || !(1.0..=500.0).contains(&t.size) {
            return Err(invalid(&f("size")));
        }
        if t.template.chars().count() > MAX_TEMPLATE_CHARS {
            return Err(invalid(&f("template")));
        }
        // A page-only text is not part of the selection, so it has no Bates
        // number to print.
        if t.page.is_some() && uses_bates_token(&t.template) {
            return Err(invalid(&format!("{} ({{bates}} needs a page selection)", f("template"))));
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
            margin_x: coord(t.margin_x, &f("marginX"))?,
            margin_y: coord(t.margin_y, &f("marginY"))?,
            at: match t.at {
                None => None,
                Some(a) if a.iter().all(|v| v.is_finite() && v.abs() <= MAX_COORD) => Some(a),
                Some(_) => return Err(invalid(&f("at"))),
            },
            page_only: match t.page {
                None => None,
                Some(p) => Some(int_in(p, 1.0, f64::from(u32::MAX), &f("page"))? as u32),
            },
        });
    }

    let mut images = Vec::with_capacity(raw.images.len());
    let mut total_pixels: u64 = 0;
    for (i, im) in raw.images.into_iter().enumerate() {
        let f = |name: &str| format!("images[{i}].{name}");
        let image = match im.image {
            RawImageData::Rgba { width, height, pixels } => {
                let w = int_in(width, 1.0, MAX_PIXELS as f64, &f("image.width"))? as u64;
                let h = int_in(height, 1.0, MAX_PIXELS as f64, &f("image.height"))? as u64;
                total_pixels += w * h;
                if w * h > MAX_PIXELS || total_pixels > MAX_TOTAL_PIXELS || pixels.len() as u64 != w * h * 4 {
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
        if ![x, y, w, h].iter().all(|v| v.is_finite() && v.abs() <= MAX_COORD) || w <= 0.0 || h <= 0.0 {
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
        Some(b) if b.prefix.chars().count() > MAX_BATES_AFFIX_CHARS => return Err(invalid("bates.prefix")),
        Some(b) if b.suffix.chars().count() > MAX_BATES_AFFIX_CHARS => return Err(invalid("bates.suffix")),
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
            at: None,
            page: None,
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
    fn absolute_placement_and_page() {
        let mut j = job();
        j.texts[0].at = Some([100.0, -20.5]);
        j.texts[0].page = Some(3.0);
        let out = validate_job(j).unwrap();
        assert_eq!(out.texts[0].at, Some([100.0, -20.5]));
        assert_eq!(out.texts[0].page_only, Some(3));
        let out = validate_job(job()).unwrap();
        assert_eq!((out.texts[0].at, out.texts[0].page_only), (None, None));
        for bad in [[f64::NAN, 0.0], [0.0, f64::INFINITY], [1e6 + 1.0, 0.0], [0.0, -2e6]] {
            let mut j = job();
            j.texts[0].at = Some(bad);
            assert_eq!(err(j), "Invalid stamp settings: texts[0].at");
        }
        let mut j = job();
        j.texts[0].at = Some([1e6, -1e6]);
        assert!(validate_job(j).is_ok());
        for bad in [0.0, 1.5, -1.0, f64::NAN] {
            let mut j = job();
            j.texts[0].page = Some(bad);
            assert_eq!(err(j), "Invalid stamp settings: texts[0].page");
        }
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
    fn bounds_on_coordinates_and_margins() {
        for (field, v) in [("marginX", 1e6 + 1.0), ("marginX", -2e6), ("marginY", 1e7)] {
            let mut j = job();
            if field == "marginX" { j.texts[0].margin_x = v } else { j.texts[0].margin_y = v }
            assert_eq!(err(j), format!("Invalid stamp settings: texts[0].{field}"));
        }
        let mut j = job();
        j.texts[0].margin_x = -1e6;
        j.texts[0].margin_y = 1e6;
        assert!(validate_job(j).is_ok());
        for rect in [[1e6 + 1.0, 0.0, 1.0, 1.0], [0.0, -2e6, 1.0, 1.0], [0.0, 0.0, 2e6, 1.0], [0.0, 0.0, 1.0, 1e7]] {
            let mut j = job();
            let mut im = rgba(1.0, 1.0, 4);
            im.rect = rect;
            j.images.push(im);
            assert_eq!(err(j), "Invalid stamp settings: images[0].rect");
        }
        let mut j = job();
        let mut im = rgba(1.0, 1.0, 4);
        im.rect = [-1e6, 1e6, 1e6, 1e6];
        j.images.push(im);
        assert!(validate_job(j).is_ok());
    }

    #[test]
    fn bounds_on_template_and_counts() {
        let mut j = job();
        j.texts[0].template = "é".repeat(2000);
        assert!(validate_job(j).is_ok());
        let mut j = job();
        j.texts[0].template = "x".repeat(2001);
        assert_eq!(err(j), "Invalid stamp settings: texts[0].template");

        let mut j = job();
        j.texts = (0..64).map(|_| text()).collect();
        assert!(validate_job(j).is_ok());
        let mut j = job();
        j.texts = (0..65).map(|_| text()).collect();
        assert_eq!(err(j), "Invalid stamp settings: texts");

        let mut j = job();
        j.images = (0..16).map(|_| rgba(1.0, 1.0, 4)).collect();
        assert!(validate_job(j).is_ok());
        let mut j = job();
        j.images = (0..17).map(|_| rgba(1.0, 1.0, 4)).collect();
        assert_eq!(err(j), "Invalid stamp settings: images");
    }

    #[test]
    fn bounds_on_total_pixels() {
        // Images within the 40M per-image cap that exceed 100M together.
        // (Zeroed buffers are lazily mapped, so this stays cheap.)
        let big = || rgba(8000.0, 5000.0, 8000 * 5000 * 4);
        let mut j = job();
        j.images = vec![big(), big()];
        assert!(validate_job(j).is_ok());
        let mut j = job();
        j.images = vec![big(), big(), rgba(5000.0, 4001.0, 5000 * 4001 * 4)];
        assert_eq!(err(j), "Invalid stamp settings: images[2].image.pixels");
        let mut j = job();
        j.images = vec![big(), big(), rgba(5000.0, 4000.0, 5000 * 4000 * 4)];
        assert!(validate_job(j).is_ok());
    }

    #[test]
    fn rejects_bates_token_in_page_only_text() {
        let mut j = job();
        j.texts[0].template = "Doc {bates}".into();
        j.texts[0].page = Some(1.0);
        assert_eq!(err(j), "Invalid stamp settings: texts[0].template ({bates} needs a page selection)");
        // Literal braces and selection texts are fine.
        let mut j = job();
        j.texts[0].template = "{{bates}}".into();
        j.texts[0].page = Some(1.0);
        assert!(validate_job(j).is_ok());
        let mut j = job();
        j.texts[0].template = "{bates}".into();
        assert!(validate_job(j).is_ok());
    }

    #[test]
    fn bounds_on_bates_affixes() {
        let bates = |prefix: &str, suffix: &str| {
            let mut j = job();
            j.bates = Some(RawBates { prefix: prefix.into(), suffix: suffix.into(), start: 1.0, digits: 6.0 });
            j
        };
        assert!(validate_job(bates(&"é".repeat(100), &"x".repeat(100))).is_ok());
        assert_eq!(err(bates(&"x".repeat(101), "")), "Invalid stamp settings: bates.prefix");
        assert_eq!(err(bates("", &"x".repeat(101))), "Invalid stamp settings: bates.suffix");
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
