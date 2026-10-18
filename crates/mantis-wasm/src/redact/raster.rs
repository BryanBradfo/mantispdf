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
use crate::stamp::geometry::{VisibleBox, read_box};
use lopdf::content::Operation;
use lopdf::{Dictionary, Document, Object, ObjectId, dictionary};

/// Most pixels a raster may have (A4 at 200 dpi is about 3.9 M).
pub(crate) const MAX_RASTER_PIXELS: u64 = 32_000_000;
/// Highest rendering resolution accepted.
const MAX_DPI: f64 = 2400.0;
/// How far (pixels) a raster may differ from the expected size.
const SIZE_SLACK: f64 = 2.0;
/// Name of the picture on a rasterized page.
const RASTER_NAME: &str = "RedactedPage";

fn invalid() -> String {
    super::invalid("raster")
}

/// The raster must show the page's visible box at its dpi (within 2 px; in
/// points or in /UserUnit-scaled points),
/// with exactly `width * height` RGBA pixels, at most 32 M of them.
fn check(raster: &PageRaster, vb: &VisibleBox, user_unit: f64) -> Result<(), String> {
    let (w, h) = (u64::from(raster.width), u64::from(raster.height));
    if !(raster.dpi.is_finite() && raster.dpi > 0.0 && raster.dpi <= MAX_DPI) || w == 0 || h == 0 || w * h > MAX_RASTER_PIXELS {
        return Err(invalid());
    }
    // pdf.js 4 (what the app renders with) ignores /UserUnit; a renderer
    // that applies it gives a picture `user_unit` times larger. Either fits.
    let fits = |scale: f64| {
        let expected = |points: f64| points * scale * raster.dpi / 72.0;
        (expected(vb.width()) - w as f64).abs() <= SIZE_SLACK && (expected(vb.height()) - h as f64).abs() <= SIZE_SLACK
    };
    if !fits(1.0) && !fits(user_unit) {
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
/// Nothing else of the original page is kept. Returns the image's id.
pub(crate) fn rasterize_page(doc: &mut Document, page: ObjectId, raster: PageRaster, areas: &[RedactRect], fill: Fill) -> Result<ObjectId, String> {
    let vb = VisibleBox::of_page(doc, page);
    let user_unit = match doc.get_dictionary(page).ok().and_then(|d| d.get(b"UserUnit").ok()) {
        Some(Object::Integer(u)) => *u as f64,
        Some(Object::Real(u)) => f64::from(*u),
        _ => 1.0,
    };
    let user_unit = if user_unit.is_finite() && user_unit > 0.0 { user_unit } else { 1.0 };
    check(&raster, &vb, user_unit)?;
    let (w, h) = (raster.width as usize, raster.height as usize);
    let mut rgba = raster.rgba;
    paint_areas(&mut rgba, (w, h), &vb, areas, fill);
    // Flatten over white into RGB, in place (the page is opaque): pixel i
    // moves from 4i to 3i, never past pixels still to be read.
    let pixels = w * h;
    for i in 0..pixels {
        let a = u32::from(rgba[4 * i + 3]);
        for c in 0..3 {
            let v = u32::from(rgba[4 * i + c]);
            rgba[3 * i + c] = ((v * a + 255 * (255 - a) + 127) / 255) as u8;
        }
    }
    rgba.truncate(3 * pixels);
    let dict = dictionary! {
        "Type" => "XObject", "Subtype" => "Image", "Width" => i64::from(raster.width), "Height" => i64::from(raster.height),
        "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8,
    };
    let image = flate_stream(dict, &rgba);
    drop(rgba);
    let image_id = doc.add_object(image);
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
        "Resources" => dictionary! { "XObject" => dictionary! { RASTER_NAME => image_id } },
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
    Ok(image_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rasters_over_32_million_pixels_are_refused() {
        // 8000 x 4001 at 72 dpi: the right size and data for an 8000 x 4001 pt
        // page, one row over the cap.
        let vb = VisibleBox { x0: 0.0, y0: 0.0, x1: 8000.0, y1: 4001.0, rotate: 0 };
        let raster = PageRaster { page: 1, width: 8000, height: 4001, dpi: 72.0, rgba: vec![0; 8000 * 4001 * 4] };
        assert_eq!(check(&raster, &vb, 1.0), Err(invalid()));
        let vb = VisibleBox { x0: 0.0, y0: 0.0, x1: 8000.0, y1: 4000.0, rotate: 0 };
        let raster = PageRaster { page: 1, width: 8000, height: 4000, dpi: 72.0, rgba: vec![0; 8000 * 4000 * 4] };
        assert_eq!(check(&raster, &vb, 1.0), Ok(()));
    }

}
