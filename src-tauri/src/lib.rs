use liteparse::types::PdfInput;
use liteparse::{LiteParse, LiteParseConfig, OutputFormat, ParsedPage};
use serde::Serialize;

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
    .invoke_handler(tauri::generate_handler![extract_document])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
