mod license;
mod math_heuristic;
mod math_ocr;
mod model_assets;
mod pdf_render;

use liteparse::types::PdfInput;
use liteparse::{LiteParse, LiteParseConfig, OutputFormat, ParsedPage};
use math_heuristic::MathRegion;
use math_ocr::{MathOcr, Pix2TexOnnx};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Manager};

// Stage-3 engine is heavy (three ONNX graphs, ~178 MB), so it is loaded once on
// first use and reused. Serialized behind a Mutex; a single equation decodes in
// well under a second, so contention is a non-issue.
static MATH_ENGINE: Mutex<Option<Pix2TexOnnx>> = Mutex::new(None);

/// Resolve the weights directory and whether we may download into it:
/// - MANTIS_MODEL_DIR (ADR 02 sideload / air-gapped): used as-is, never fetched.
/// - otherwise: the OS app-data dir (Tauri's AppLocalData), where the weights
///   are downloaded + SHA-256-verified on first run.
fn resolve_model_dir(app: &AppHandle) -> Result<(PathBuf, bool), String> {
    if let Some(p) = std::env::var_os("MANTIS_MODEL_DIR") {
        return Ok((PathBuf::from(p), false));
    }
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("resolve app data dir: {e}"))?
        .join("weights");
    Ok((dir, true))
}

/// Locate the libpdfium bundled in the installer (via Tauri's resource dir),
/// trying the layouts the bundler may produce. None in dev — `pdf_render` then
/// falls back to PDFIUM_LIB / the pdfium-rs cache / the system library.
fn resolve_pdfium(app: &AppHandle) -> Option<PathBuf> {
    let base = app.path().resource_dir().ok()?;
    let names = ["libpdfium.so", "libpdfium.dylib", "pdfium.dll"];
    for sub in ["", "resources", "lib"] {
        for name in names {
            let p = if sub.is_empty() {
                base.join(name)
            } else {
                base.join(sub).join(name)
            };
            if p.exists() {
                return Some(p);
            }
        }
    }
    None
}

/// Lazily initialize and lock the shared engine. On first init, ensure the
/// weights are present (download + SHA-256 verify when `download`), then open
/// the ONNX sessions. Subsequent calls reuse the loaded engine.
fn locked_engine(
    model_dir: &Path,
    download: bool,
) -> Result<MutexGuard<'static, Option<Pix2TexOnnx>>, String> {
    let mut guard = MATH_ENGINE.lock().map_err(|e| format!("engine lock: {e}"))?;
    if guard.is_none() {
        if download {
            model_assets::ensure_weights(model_dir).map_err(|e| e.to_string())?;
        }
        *guard = Some(Pix2TexOnnx::from_dir(model_dir).map_err(|e| e.to_string())?);
    }
    Ok(guard)
}

/// Resolve the app-config dir where the license state lives.
fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| format!("resolve app config dir: {e}"))
}

/// License (ADR 03) — entitlement is resolved and enforced in the backend.
#[tauri::command]
async fn get_license_status(app: AppHandle) -> Result<license::LicenseStatus, String> {
    Ok(license::current_status(&config_dir(&app)?))
}

#[tauri::command]
async fn activate_license(app: AppHandle, key: String) -> Result<license::LicenseStatus, String> {
    license::activate(&key, &config_dir(&app)?).map_err(|e| e.to_string())
}

#[tauri::command]
async fn deactivate_license(app: AppHandle) -> Result<(), String> {
    license::deactivate(&config_dir(&app)?).map_err(|e| e.to_string())
}

/// Stage 3: recognize one cropped math region (PNG/JPEG bytes) as LaTeX.
/// Pro-gated: returns an error to free users (the workspace gates this in UI).
#[tauri::command]
async fn recognize_math(app: AppHandle, image: Vec<u8>) -> Result<String, String> {
    if !license::current_status(&config_dir(&app)?).is_pro() {
        return Err("MantisPDF Pro required for math OCR.".into());
    }
    let img = image::load_from_memory(&image).map_err(|e| format!("decode image: {e}"))?;
    let (dir, download) = resolve_model_dir(&app)?;
    let mut guard = locked_engine(&dir, download)?;
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
    /// True when math regions were detected but Stage-3 OCR was skipped because
    /// the app is unlicensed — the frontend shows the "Upgrade to Pro" CTA.
    pro_locked: bool,
}

/// Core extraction pipeline (Stages 1→3), independent of Tauri so it is unit
/// testable. Stage 1: LiteParse text + geometry. Stage 2: detect math regions.
/// Stage 3: render each region at 300 DPI with PDFium (`pdfium_lib`), crop, OCR
/// with pix2tex (weights in `model_dir`, fetched on first run when `download`),
/// and stitch the LaTeX into the Markdown.
async fn extract_pipeline(
    bytes: Vec<u8>,
    model_dir: &Path,
    pdfium_lib: Option<&Path>,
    download: bool,
    pro: bool,
) -> Result<ExtractResponse, String> {
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

    // Stage 2: which boxes are math? (Always runs — cheap, and powers the
    // "N math regions detected" upsell for free users.)
    let regions = math_heuristic::detect_math_regions(&result.pages);

    let mut math_out: Vec<MathOut> = Vec::new();
    let mut stitch_items: Vec<(MathRegion, String)> = Vec::new();

    if !pro {
        // Free tier: report detected regions (empty LaTeX) but skip Stage 3.
        for region in &regions {
            math_out.push(MathOut {
                page: region.page,
                x: region.bbox.x,
                y: region.bbox.y,
                width: region.bbox.width,
                height: region.bbox.height,
                score: region.score,
                latex: String::new(),
            });
        }
    } else if !regions.is_empty() {
        // Pro tier — Stage 3: crop + OCR each region, one render per page.
        let mut guard = locked_engine(model_dir, download)?;
        let engine = guard.as_mut().expect("engine initialized above");

        let mut by_page: BTreeMap<usize, Vec<MathRegion>> = BTreeMap::new();
        for r in regions {
            by_page.entry(r.page).or_default().push(r);
        }
        for (page_number, regs) in by_page {
            let page_index = page_number.saturating_sub(1) as u16; // LiteParse is 1-based
            let raster = match pdf_render::render_page(&bytes, page_index, 300.0, pdfium_lib) {
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
    Ok(ExtractResponse {
        markdown,
        text: result.text,
        pro_locked: !pro && !math_out.is_empty(),
        math: math_out,
        pages: result.pages,
    })
}

/// Full extraction pipeline exposed to the frontend. Resolves the weights dir
/// (download-on-first-run into Tauri's AppLocalData) and the bundled libpdfium
/// (from the resource dir), runs the pipeline, and returns the integrated
/// Markdown+LaTeX as JSON.
#[tauri::command]
async fn extract_document(app: AppHandle, bytes: Vec<u8>) -> Result<String, String> {
    // Stage-3 is Pro-gated; Stages 1-2 (text + region detection) stay free.
    let pro = license::current_status(&config_dir(&app)?).is_pro();
    let (model_dir, download) = resolve_model_dir(&app)?;
    let pdfium = resolve_pdfium(&app);
    let response = extract_pipeline(bytes, &model_dir, pdfium.as_deref(), download, pro).await?;
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

    // Strip leading indentation from every line. LiteParse preserves the PDF's
    // visual indentation, which CommonMark would render as gray indented code
    // blocks instead of prose. The stitched `$$` blocks start at column 0, so
    // they're unaffected.
    let mut out = lines
        .iter()
        .map(|l| l.trim_start())
        .collect::<Vec<_>>()
        .join("\n");
    if !appended.is_empty() {
        out.push_str("\n\n");
        out.push_str(&appended.join("\n\n"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stitch_strips_leading_indentation() {
        // LiteParse preserves the PDF's indentation; CommonMark would render
        // these as code blocks. After stitching, no line keeps leading spaces.
        let text = "             A. Author\n    Indented abstract line.\nNormal line.";
        let out = stitch_latex(text, &[]);
        assert!(
            out.lines().all(|l| !l.starts_with(' ') && !l.starts_with('\t')),
            "expected no leading indentation, got: {out:?}"
        );
        assert!(out.contains("A. Author"));
        assert!(out.contains("Indented abstract line."));
    }

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
        // Use the dev weights dir directly (no download), and let PDFium bind
        // via the dev fallback (pdfium-rs cache / system).
        let weights = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/weights"));
        // pro = true to exercise Stage 3 (licensing is gated at the command layer).
        let resp = rt
            .block_on(extract_pipeline(bytes, weights, None, false, true))
            .expect("extract");
        let json = serde_json::to_string(&resp).unwrap();
        println!("{json}");
        // The integrated markdown must carry at least one LaTeX command.
        assert!(json.contains("\\\\"), "expected LaTeX in the integrated output");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      // Point liteparse-pdfium (Stage 1) at the bundled libpdfium. It loads the
      // library at runtime by searching PDFIUM_LIB_PATH — it does NOT know about
      // Tauri's resource dir — so without this Stage-1 extraction panics with
      // "could not find pdfium shared library". (Our own pdf_render for Stage 3
      // resolves the same lib via the resource dir.) A user-set value wins.
      if std::env::var_os("PDFIUM_LIB_PATH").is_none() {
        if let Ok(res) = app.handle().path().resource_dir() {
          let dir = res.join("resources");
          if dir.join("libpdfium.so").exists()
            || dir.join("libpdfium.dylib").exists()
            || dir.join("pdfium.dll").exists()
          {
            std::env::set_var("PDFIUM_LIB_PATH", &dir);
          }
        }
      }
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      extract_document,
      recognize_math,
      get_license_status,
      activate_license,
      deactivate_license
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
