//! Backend PDFium rendering + cropping for Stage 3 (ADR 02's finalized
//! decision: rasterize math crops in Rust, not the browser). Ported from the
//! spike. Renders a page at a target DPI and crops regions given in viewport
//! points (top-left origin, 72 DPI) — the same space as LiteParse `TextItem`s,
//! so no coordinate flip is needed.

use crate::math_heuristic::BBox;
use anyhow::{anyhow, Context, Result};
use pdfium_render::prelude::*;

/// A rendered page plus the points→pixels scale used to render it.
pub struct PageRaster {
    pub image: image::DynamicImage,
    /// Pixels per point (render_dpi / 72), derived from the actual raster width.
    pub scale: f32,
}

fn bind_pdfium() -> Result<Pdfium> {
    let mut candidates: Vec<String> = Vec::new();
    if let Ok(p) = std::env::var("PDFIUM_LIB") {
        candidates.push(p);
    }
    if let Some(home) = std::env::var_os("HOME") {
        let home = home.to_string_lossy();
        candidates.push(format!(
            "{home}/.cache/pdfium-rs/chromium_7870/pdfium-linux-x64/lib/libpdfium.so"
        ));
    }
    for path in &candidates {
        if let Ok(bindings) = Pdfium::bind_to_library(path) {
            return Ok(Pdfium::new(bindings));
        }
    }
    let bindings = Pdfium::bind_to_system_library()
        .map_err(|e| anyhow!("could not bind PDFium (set PDFIUM_LIB): {e}"))?;
    Ok(Pdfium::new(bindings))
}

/// Render one page (0-based index) of the PDF bytes at `dpi`.
pub fn render_page(pdf_bytes: &[u8], page_index: u16, dpi: f32) -> Result<PageRaster> {
    let pdfium = bind_pdfium()?;
    let document = pdfium
        .load_pdf_from_byte_slice(pdf_bytes, None)
        .context("load pdf from bytes")?;
    let page = document
        .pages()
        .get(page_index)
        .with_context(|| format!("get page index {page_index}"))?;

    let width_pts = page.width().value;
    let target_w = (width_pts * dpi / 72.0).round() as i32;
    let config = PdfRenderConfig::new().set_target_width(target_w);
    let bitmap = page.render_with_config(&config).context("render page")?;

    // Bridge across the pdfium/our image-version boundary via raw bytes.
    let pim = bitmap.as_image();
    let rgb = pim.to_rgb8();
    let (w, h) = (rgb.width(), rgb.height());
    let raw: Vec<u8> = rgb.into_raw();
    let image = image::DynamicImage::ImageRgb8(
        image::RgbImage::from_raw(w, h, raw).ok_or_else(|| anyhow!("rebuild image buffer"))?,
    );
    let scale = w as f32 / width_pts;
    Ok(PageRaster { image, scale })
}

/// Crop a region (viewport points) from a rendered page, padding by `pad_pts`
/// on every side. Clamped to the page raster.
pub fn crop(raster: &PageRaster, bbox: &BBox, pad_pts: f32) -> image::DynamicImage {
    let s = raster.scale;
    let (iw, ih) = (raster.image.width() as f32, raster.image.height() as f32);
    let x0 = ((bbox.x - pad_pts) * s).max(0.0);
    let y0 = ((bbox.y - pad_pts) * s).max(0.0);
    let x1 = ((bbox.x + bbox.width + pad_pts) * s).min(iw);
    let y1 = ((bbox.y + bbox.height + pad_pts) * s).min(ih);
    let w = (x1 - x0).max(1.0) as u32;
    let h = (y1 - y0).max(1.0) as u32;
    raster.image.crop_imm(x0 as u32, y0 as u32, w, h)
}
