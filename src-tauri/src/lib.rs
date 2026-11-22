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
      // Automatic updates (desktop only): the updater checks latest.json on the GitHub release, the process
      // plugin relaunches the app once the new version is installed.
      #[cfg(desktop)]
      {
        app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
        app.handle().plugin(tauri_plugin_process::init())?;
      }
      // Linux shells show a generic icon for a window without one (no installed .desktop to match, e.g. a
      // freshly run AppImage): give the main window the app icon.
      #[cfg(target_os = "linux")]
      if let (Some(window), Some(icon)) = (app.get_webview_window("main"), app.default_window_icon().cloned()) {
        let _ = window.set_icon(icon);
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
