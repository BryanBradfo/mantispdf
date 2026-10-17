//! Pure conversion of the raw job read by `binding` (strings and f64s, as
//! JS hands them over) into an `EditJob`. Enum-like strings and integral
//! numbers are checked here; numeric ranges and limits are checked by
//! `edit_pdf` itself, so they hold for every caller.

use super::{Align, EditItem, EditJob, MAX_IMAGES, Paint, invalid};
use crate::stamp::engine::ImageData;
use crate::stamp::fonts::StdFont;

#[derive(Debug, Clone)]
pub(crate) enum RawPaint {
    None,
    Rgb([f64; 3]),
}

#[derive(Debug, Clone)]
pub(crate) enum RawImageData {
    Jpeg(Vec<u8>),
    Rgba { width: f64, height: f64, pixels: Vec<u8> },
}

#[derive(Debug, Clone)]
pub(crate) enum RawItem {
    Text {
        page: f64,
        rect: [f64; 4],
        text: String,
        font: String,
        size: f64,
        color: [f64; 3],
        opacity: f64,
        align: String,
        line_height: f64,
    },
    Image { page: f64, rect: [f64; 4], image: RawImageData, opacity: f64, rotation: f64 },
    Rect { page: f64, rect: [f64; 4], stroke: RawPaint, width: f64, fill: RawPaint, opacity: f64 },
    Ellipse { page: f64, rect: [f64; 4], stroke: RawPaint, width: f64, fill: RawPaint, opacity: f64 },
    Line {
        page: f64,
        from: [f64; 2],
        to: [f64; 2],
        color: [f64; 3],
        width: f64,
        opacity: f64,
        arrow_start: bool,
        arrow_end: bool,
    },
    Highlight { page: f64, rect: [f64; 4], color: [f64; 3], opacity: f64 },
    Freehand { page: f64, points: Vec<[f64; 2]>, color: [f64; 3], width: f64, opacity: f64 },
    Whiteout { page: f64, rect: [f64; 4] },
}

#[derive(Debug, Clone)]
pub(crate) struct RawJob {
    pub items: Vec<RawItem>,
}

/// A whole number in `0..=max`.
fn whole(v: f64, max: f64, field: String) -> Result<u32, String> {
    if v.is_finite() && v.fract() == 0.0 && (0.0..=max).contains(&v) { Ok(v as u32) } else { Err(invalid(&field)) }
}

fn page(v: f64, i: usize) -> Result<u32, String> {
    whole(v, f64::from(u32::MAX), format!("items[{i}].page"))
}

fn font(s: &str, i: usize) -> Result<StdFont, String> {
    match s {
        "Helvetica" => Ok(StdFont::Helvetica),
        "Helvetica-Bold" => Ok(StdFont::HelveticaBold),
        "Times-Roman" => Ok(StdFont::TimesRoman),
        "Courier" => Ok(StdFont::Courier),
        _ => Err(invalid(&format!("items[{i}].font"))),
    }
}

fn align(s: &str, i: usize) -> Result<Align, String> {
    match s {
        "left" => Ok(Align::Left),
        "center" => Ok(Align::Center),
        "right" => Ok(Align::Right),
        _ => Err(invalid(&format!("items[{i}].align"))),
    }
}

fn paint(p: RawPaint) -> Paint {
    match p {
        RawPaint::None => Paint::None,
        RawPaint::Rgb(c) => Paint::Rgb(c),
    }
}

fn image(data: RawImageData, i: usize) -> Result<ImageData, String> {
    Ok(match data {
        RawImageData::Jpeg(bytes) => ImageData::Jpeg(bytes),
        RawImageData::Rgba { width, height, pixels } => ImageData::Rgba {
            width: whole(width, f64::from(u32::MAX), format!("items[{i}].image.width"))?,
            height: whole(height, f64::from(u32::MAX), format!("items[{i}].image.height"))?,
            pixels,
        },
    })
}

pub(crate) fn validate_job(raw: RawJob) -> Result<EditJob, String> {
    let images = raw.items.iter().filter(|it| matches!(it, RawItem::Image { .. })).count();
    if images > MAX_IMAGES {
        return Err(invalid("images"));
    }
    let mut items = Vec::with_capacity(raw.items.len());
    for (i, it) in raw.items.into_iter().enumerate() {
        items.push(match it {
            RawItem::Text { page: p, rect, text, font: f, size, color, opacity, align: a, line_height } => EditItem::Text {
                page: page(p, i)?,
                rect,
                text,
                font: font(&f, i)?,
                size,
                color,
                opacity,
                align: align(&a, i)?,
                line_height,
            },
            RawItem::Image { page: p, rect, image: data, opacity, rotation } => EditItem::Image {
                page: page(p, i)?,
                rect,
                image: image(data, i)?,
                opacity,
                rotation: whole(rotation, 270.0, format!("items[{i}].rotation"))
                    .ok()
                    .filter(|r| r % 90 == 0)
                    .ok_or_else(|| invalid(&format!("items[{i}].rotation")))? as u16,
            },
            RawItem::Rect { page: p, rect, stroke, width, fill, opacity } => {
                EditItem::Rect { page: page(p, i)?, rect, stroke: paint(stroke), width, fill: paint(fill), opacity }
            }
            RawItem::Ellipse { page: p, rect, stroke, width, fill, opacity } => {
                EditItem::Ellipse { page: page(p, i)?, rect, stroke: paint(stroke), width, fill: paint(fill), opacity }
            }
            RawItem::Line { page: p, from, to, color, width, opacity, arrow_start, arrow_end } => {
                EditItem::Line { page: page(p, i)?, from, to, color, width, opacity, arrow_start, arrow_end }
            }
            RawItem::Highlight { page: p, rect, color, opacity } => EditItem::Highlight { page: page(p, i)?, rect, color, opacity },
            RawItem::Freehand { page: p, points, color, width, opacity } => {
                EditItem::Freehand { page: page(p, i)?, points, color, width, opacity }
            }
            RawItem::Whiteout { page: p, rect } => EditItem::Whiteout { page: page(p, i)?, rect },
        });
    }
    Ok(EditJob { items })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(page: f64, font: &str, align: &str) -> RawItem {
        RawItem::Text {
            page,
            rect: [0.0, 0.0, 10.0, 10.0],
            text: "x".into(),
            font: font.into(),
            size: 12.0,
            color: [0.0; 3],
            opacity: 1.0,
            align: align.into(),
            line_height: 1.2,
        }
    }

    fn err(items: Vec<RawItem>) -> String {
        validate_job(RawJob { items }).unwrap_err()
    }

    fn image(rotation: f64) -> RawItem {
        RawItem::Image {
            page: 1.0,
            rect: [0.0, 0.0, 1.0, 1.0],
            image: RawImageData::Rgba { width: 1.0, height: 1.0, pixels: vec![0; 4] },
            opacity: 1.0,
            rotation,
        }
    }

    #[test]
    fn converts_every_kind() {
        let items = vec![
            text(2.0, "Courier", "center"),
            image(90.0),
            RawItem::Rect { page: 1.0, rect: [0.0; 4], stroke: RawPaint::Rgb([1.0, 0.0, 0.0]), width: 1.0, fill: RawPaint::None, opacity: 1.0 },
            RawItem::Whiteout { page: 1.0, rect: [0.0; 4] },
        ];
        let job = validate_job(RawJob { items }).unwrap();
        assert!(matches!(&job.items[0], EditItem::Text { page: 2, font: StdFont::Courier, align: Align::Center, .. }));
        assert!(matches!(&job.items[1], EditItem::Image { rotation: 90, image: ImageData::Rgba { width: 1, height: 1, .. }, .. }));
        assert!(matches!(&job.items[2], EditItem::Rect { stroke: Paint::Rgb(_), fill: Paint::None, .. }));
        assert!(matches!(&job.items[3], EditItem::Whiteout { page: 1, .. }));
    }

    #[test]
    fn rejects_bad_enums_and_numbers() {
        assert_eq!(err(vec![text(1.0, "Comic", "left")]), "Invalid edit settings: items[0].font");
        assert_eq!(err(vec![text(1.0, "Courier", "justify")]), "Invalid edit settings: items[0].align");
        assert_eq!(err(vec![text(1.5, "Courier", "left")]), "Invalid edit settings: items[0].page");
        assert_eq!(err(vec![text(-1.0, "Courier", "left")]), "Invalid edit settings: items[0].page");
        assert_eq!(err(vec![text(f64::NAN, "Courier", "left")]), "Invalid edit settings: items[0].page");
        assert_eq!(err(vec![image(45.0)]), "Invalid edit settings: items[0].rotation");
        assert_eq!(err(vec![image(360.0)]), "Invalid edit settings: items[0].rotation");
        let bad_size = RawItem::Image {
            page: 1.0,
            rect: [0.0, 0.0, 1.0, 1.0],
            image: RawImageData::Rgba { width: 1.5, height: 1.0, pixels: vec![] },
            opacity: 1.0,
            rotation: 0.0,
        };
        assert_eq!(err(vec![bad_size]), "Invalid edit settings: items[0].image.width");
    }

    #[test]
    fn caps_image_count_before_converting() {
        let mut items = vec![image(0.0); MAX_IMAGES + 1];
        assert_eq!(err(items.clone()), "Invalid edit settings: images");
        items.pop();
        assert!(validate_job(RawJob { items }).is_ok());
    }
}
