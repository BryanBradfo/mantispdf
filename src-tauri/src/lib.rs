mod license;

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

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
    .invoke_handler(tauri::generate_handler![
      get_license_status,
      activate_license,
      deactivate_license
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
