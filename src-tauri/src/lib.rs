mod math_heuristic;
mod math_ocr;
mod pdf_render;

use liteparse::types::PdfInput;
use liteparse::{LiteParse, LiteParseConfig, OutputFormat, ParsedPage};
use math_heuristic::MathRegion;
use math_ocr::{MathOcr, Pix2TexOnnx};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

// Stage-3 engine is heavy (three ONNX graphs, ~178 MB), so it is loaded once on
// first use and reused. Serialized behind a Mutex; a single equation decodes in
// well under a second, so contention is a non-issue.
static MATH_ENGINE: Mutex<Option<Pix2TexOnnx>> = Mutex::new(None);

/// Where the pix2tex ONNX weights live. ADR 02's sideload hook: override with
/// MANTIS_MODEL_DIR (the air-gapped / packaged path); default to the in-repo
/// `src-tauri/weights/` used in development.
fn model_dir() -> PathBuf {
    match std::env::var_os("MANTIS_MODEL_DIR") {
        Some(p) => PathBuf::from(p),
        None => PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/weights")),
    }
}

/// Stage 3: recognize one cropped math region (PNG/JPEG bytes) as LaTeX.
/// The crop is produced by the (backend PDFium) cropper per ADR 02; this command
/// is the `MathOcr` entry point the workspace calls for each detected region.
#[tauri::command]
async fn recognize_math(image: Vec<u8>) -> Result<String, String> {
    let img = image::load_from_memory(&image).map_err(|e| format!("decode image: {e}"))?;
    let mut guard = MATH_ENGINE.lock().map_err(|e| format!("engine lock: {e}"))?;
    if guard.is_none() {
        *guard = Some(Pix2TexOnnx::from_dir(model_dir()).map_err(|e| e.to_string())?);
    }
    let engine = guard.as_mut().expect("engine initialized above");
    engine.recognize(&img).map_err(|e| e.to_string())
}

/// One recognized math region, returned to the frontend for transparency.
#[derive(Serialize)]
struct MathOut {
    page: usize,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    /// Heuristic confidence (Stage-2 score); lets the frontend filter weak hits.
    score: i32,
    latex: String,
}

/// JSON shape returned to the frontend. `markdown` is the Stage-1 text with
/// recognized LaTeX stitched in; `text` is the raw Stage-1 text; `math` lists
/// every recognized region; `pages` keeps the per-item geometry.
#[derive(Serialize)]
struct ExtractResponse {
    markdown: String,
    text: String,
    math: Vec<MathOut>,
    pages: Vec<ParsedPage>,
}

/// Full extraction pipeline (ADR 01/02). Stage 1: LiteParse text + geometry.
/// Stage 2: detect math regions via the heuristic. Stage 3: render each region
/// at 300 DPI with PDFium, crop it, OCR it with pix2tex (ONNX), and stitch the
/// LaTeX back into the Markdown. Returns the integrated Markdown+LaTeX as JSON.
///
/// Bytes (not a path) are taken because a browser-dropped `File` has no real
/// filesystem path; the ArrayBuffer feeds both LiteParse and PDFium.
#[tauri::command]
async fn extract_document(bytes: Vec<u8>) -> Result<String, String> {
    let config = LiteParseConfig {
        ocr_enabled: false,
        output_format: OutputFormat::Json,
        quiet: true,
        ..Default::default()
    };

    let result = LiteParse::new(config)
        .parse_input(PdfInput::Bytes(bytes.clone()))
        .await
        .map_err(|e| format!("extraction failed: {e}"))?;

    // Stage 2: which boxes are math?
    let regions = math_heuristic::detect_math_regions(&result.pages);

    // Stage 3: crop + OCR each region, grouping by page so each page renders once.
    let mut math_out: Vec<MathOut> = Vec::new();
    let mut stitch_items: Vec<(MathRegion, String)> = Vec::new();
    if !regions.is_empty() {
        let mut guard = MATH_ENGINE.lock().map_err(|e| format!("engine lock: {e}"))?;
        if guard.is_none() {
            *guard = Some(Pix2TexOnnx::from_dir(model_dir()).map_err(|e| e.to_string())?);
        }
        let engine = guard.as_mut().expect("engine initialized above");

        let mut by_page: BTreeMap<usize, Vec<MathRegion>> = BTreeMap::new();
        for r in regions {
            by_page.entry(r.page).or_default().push(r);
        }
        for (page_number, regs) in by_page {
            let page_index = page_number.saturating_sub(1) as u16; // LiteParse is 1-based
            let raster = match pdf_render::render_page(&bytes, page_index, 300.0) {
                Ok(r) => r,
                Err(e) => {
                    log::warn!("render page {page_number} failed: {e}");
                    continue;
                }
            };
            for region in regs {
                let crop = pdf_render::crop(&raster, &region.bbox, 8.0);
                match engine.recognize(&crop) {
                    Ok(latex) => {
                        math_out.push(MathOut {
                            page: region.page,
                            x: region.bbox.x,
                            y: region.bbox.y,
                            width: region.bbox.width,
                            height: region.bbox.height,
                            score: region.score,
                            latex: latex.clone(),
                        });
                        stitch_items.push((region, latex));
                    }
                    Err(e) => log::warn!("math OCR failed on page {page_number}: {e}"),
                }
            }
        }
    }

    let markdown = stitch_latex(&result.text, &stitch_items);
    let response = ExtractResponse {
        markdown,
        text: result.text,
        math: math_out,
        pages: result.pages,
    };
    serde_json::to_string(&response).map_err(|e| e.to_string())
}

fn normalize_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Fraction of `needle`'s non-space characters that also appear in `haystack`.
/// A cheap similarity used to locate a (garbled) equation line in the text.
fn char_overlap(haystack: &str, needle: &str) -> f32 {
    use std::collections::HashSet;
    let hay: HashSet<char> = haystack.chars().filter(|c| !c.is_whitespace()).collect();
    let needle_chars: Vec<char> = needle.chars().filter(|c| !c.is_whitespace()).collect();
    if needle_chars.is_empty() {
        return 0.0;
    }
    let hit = needle_chars.iter().filter(|c| hay.contains(c)).count();
    hit as f32 / needle_chars.len() as f32
}

/// Best-effort inline stitching: replace the text line that best matches each
/// region (display equations occupy their own line) with a `$$ latex $$` block;
/// append any region we cannot confidently place. Garbled Stage-1 math text
/// makes exact matching impossible, so we match on shared-character overlap.
fn stitch_latex(text: &str, items: &[(MathRegion, String)]) -> String {
    let mut lines: Vec<String> = text.lines().map(|l| l.to_string()).collect();
    let mut used = vec![false; lines.len()];
    let mut appended: Vec<String> = Vec::new();

    for (region, latex) in items {
        let needle = normalize_ws(&region.text);
        let mut best_i: Option<usize> = None;
        let mut best = 0.0f32;
        for (i, line) in lines.iter().enumerate() {
            if used[i] || line.trim().is_empty() {
                continue;
            }
            let ov = char_overlap(line, &needle);
            if ov > best {
                best = ov;
                best_i = Some(i);
            }
        }
        let block = format!("$$\n{latex}\n$$");
        match best_i {
            Some(i) if best >= 0.4 => {
                lines[i] = block;
                used[i] = true;
            }
            _ => appended.push(block),
        }
    }

    let mut out = lines.join("\n");
    if !appended.is_empty() {
        out.push_str("\n\n");
        out.push_str(&appended.join("\n\n"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// End-to-end Stage 1→3 on a real Computer-Modern paper. Ignored by default
    /// (needs local ONNX weights + PDFium + a test PDF). Run with:
    ///   EXTRACT_TEST_PDF=/path/to/paper.pdf \
    ///     cargo test --release -- --ignored extract_with_math --nocapture
    #[test]
    #[ignore]
    fn extract_with_math() {
        let pdf_path = std::env::var("EXTRACT_TEST_PDF").unwrap_or_else(|_| {
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../wow/NeurIPS_ML4PS_2024_78.pdf"
            )
            .to_string()
        });
        let bytes = std::fs::read(&pdf_path).expect("read test pdf");
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        let json = rt.block_on(extract_document(bytes)).expect("extract");
        println!("{json}");
        // The integrated markdown must carry at least one LaTeX command.
        assert!(json.contains("\\\\"), "expected LaTeX in the integrated output");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![extract_document, recognize_math])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
