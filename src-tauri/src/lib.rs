mod math_ocr;

use liteparse::types::PdfInput;
use liteparse::{LiteParse, LiteParseConfig, OutputFormat, ParsedPage};
use math_ocr::{MathOcr, Pix2TexOnnx};
use serde::Serialize;
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

/// JSON shape returned to the frontend for the extraction spike. Mirrors
/// LiteParse's `ParseResult` (which isn't `Serialize` itself).
#[derive(Serialize)]
struct ExtractResponse {
    text: String,
    pages: Vec<ParsedPage>,
}

/// Stage 1 of the extraction pipeline: parse a PDF (passed as raw bytes from the
/// frontend) with LiteParse and return its text + per-item bounding boxes as a
/// JSON string. OCR is disabled — this is the born-digital text/geometry
/// skeleton (see docs/architecture/01-extraction-engine.md).
///
/// Bytes (not a path) are taken because a browser-dropped `File` has no real
/// filesystem path; passing the ArrayBuffer is the robust, cross-platform Tauri
/// v2 pattern and feeds straight into `PdfInput::Bytes`.
#[tauri::command]
async fn extract_document(bytes: Vec<u8>) -> Result<String, String> {
    let config = LiteParseConfig {
        ocr_enabled: false,
        output_format: OutputFormat::Json,
        quiet: true,
        ..Default::default()
    };

    let result = LiteParse::new(config)
        .parse_input(PdfInput::Bytes(bytes))
        .await
        .map_err(|e| format!("extraction failed: {e}"))?;

    let response = ExtractResponse {
        text: result.text,
        pages: result.pages,
    };
    serde_json::to_string(&response).map_err(|e| e.to_string())
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
