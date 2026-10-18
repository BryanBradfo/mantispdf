//! Raster fallback: a page the interpreter cannot guarantee is replaced by
//! a picture of it (rendered by the caller) with the areas painted over.

/// A rendering of 1-based `page`: `width` x `height` RGBA pixels of its
/// visible box at `dpi`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PageRaster {
    pub(crate) page: u32,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) dpi: f64,
    pub(crate) rgba: Vec<u8>,
}

use super::interp::{concat, encode_ops};
use super::page::flate_stream;
use super::{Fill, RedactRect};
use crate::stamp::engine::ImageData;
use crate::stamp::geometry::{VisibleBox, read_box};
use crate::stamp::image::build_image;
use lopdf::content::Operation;
use lopdf::{Dictionary, Document, Object, ObjectId, dictionary};

/// Most pixels a raster may have.
const MAX_RASTER_PIXELS: u64 = 100_000_000;
/// Highest rendering resolution accepted.
const MAX_DPI: f64 = 2400.0;
/// How far (pixels) a raster may differ from the expected size.
const SIZE_SLACK: f64 = 2.0;
/// Name of the picture on a rasterized page.
const RASTER_NAME: &str = "RedactedPage";

fn invalid() -> String {
    super::invalid("raster")
}

/// The raster must show the page's visible box at its dpi (within 2 px),
/// with exactly `width * height` RGBA pixels, at most 100 M of them.
fn check(raster: &PageRaster, vb: &VisibleBox) -> Result<(), String> {
    let (w, h) = (u64::from(raster.width), u64::from(raster.height));
    if !(raster.dpi.is_finite() && raster.dpi > 0.0 && raster.dpi <= MAX_DPI) || w == 0 || h == 0 || w * h > MAX_RASTER_PIXELS {
        return Err(invalid());
    }
    let expected = |points: f64| points * raster.dpi / 72.0;
    if (expected(vb.width()) - w as f64).abs() > SIZE_SLACK || (expected(vb.height()) - h as f64).abs() > SIZE_SLACK {
        return Err(invalid());
    }
    if raster.rgba.len() as u64 != w * h * 4 {
        return Err(invalid());
    }
    Ok(())
}

/// Paint every pixel an area touches with the fill colour (the caller is
/// trusted to have done it, but this does not depend on that).
fn paint_areas(rgba: &mut [u8], (w, h): (usize, usize), vb: &VisibleBox, areas: &[RedactRect], fill: Fill) {
    let (sx, sy) = (w as f64 / vb.width(), h as f64 / vb.height());
    let [r, g, b] = fill.rgb();
    for area in areas {
        let [x, y, aw, ah] = area.rect;
        let span = |lo: f64, hi: f64, len: usize| {
            let lo = lo.floor().clamp(0.0, len as f64) as usize;
            let hi = hi.ceil().clamp(0.0, len as f64) as usize;
            lo..hi.max(lo)
        };
        let columns = span(x * sx, (x + aw) * sx, w);
        // Rows run from the top of the visible box.
        let rows = span((vb.height() - (y + ah)) * sy, (vb.height() - y) * sy, h);
        for row in rows {
            for col in columns.clone() {
                let i = 4 * (row * w + col);
                rgba[i..i + 4].copy_from_slice(&[r, g, b, 255]);
            }
        }
    }
}

fn box_array(b: [f64; 4]) -> Object {
    Object::Array(b.iter().map(|v| Object::Real(*v as f32)).collect())
}

/// Replace `page` by a page with the same geometry (MediaBox, CropBox,
/// Rotate, UserUnit) showing only `raster`, the areas painted over.
/// Nothing else of the original page is kept.
pub(crate) fn rasterize_page(doc: &mut Document, page: ObjectId, raster: &PageRaster, areas: &[RedactRect], fill: Fill) -> Result<(), String> {
    let vb = VisibleBox::of_page(doc, page);
    check(raster, &vb)?;
    let (w, h) = (raster.width as usize, raster.height as usize);
    let mut rgba = raster.rgba.clone();
    paint_areas(&mut rgba, (w, h), &vb, areas, fill);
    // Flatten over white: the page is opaque.
    for px in rgba.chunks_exact_mut(4) {
        let a = u32::from(px[3]);
        for c in &mut px[..3] {
            *c = ((u32::from(*c) * a + 255 * (255 - a) + 127) / 255) as u8;
        }
        px[3] = 255;
    }
    let image = build_image(&ImageData::Rgba { width: raster.width, height: raster.height, pixels: rgba }).map_err(|_| invalid())?.image;
    let image = doc.add_object(image);
    let old = doc.get_dictionary(page).map_err(|_| invalid())?.clone();
    // The picture fills the visible box, upright as the page is viewed.
    let m = concat(&[vb.width(), 0.0, 0.0, vb.height(), 0.0, 0.0], &vb.matrix());
    let ops = vec![
        Operation::new("q", vec![]),
        Operation::new("cm", m.iter().map(|v| Object::Real(*v as f32)).collect()),
        Operation::new("Do", vec![Object::Name(RASTER_NAME.as_bytes().to_vec())]),
        Operation::new("Q", vec![]),
    ];
    let content = doc.add_object(flate_stream(Dictionary::new(), &encode_ops(&ops)));
    let mut fresh = dictionary! {
        "Type" => "Page",
        "MediaBox" => box_array(read_box(doc, page, b"MediaBox").unwrap_or([0.0, 0.0, 612.0, 792.0])),
        "Contents" => content,
        "Resources" => dictionary! { "XObject" => dictionary! { RASTER_NAME => image } },
    };
    if let Ok(parent) = old.get(b"Parent") {
        fresh.set("Parent", parent.clone());
    }
    if let Some(crop) = read_box(doc, page, b"CropBox") {
        fresh.set("CropBox", box_array(crop));
    }
    if vb.rotate != 0 {
        fresh.set("Rotate", vb.rotate);
    }
    if let Ok(unit) = old.get(b"UserUnit") {
        fresh.set("UserUnit", unit.clone());
    }
    doc.objects.insert(page, Object::Dictionary(fresh));
    Ok(())
}
