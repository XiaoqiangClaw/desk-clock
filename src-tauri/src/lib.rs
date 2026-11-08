//! Desk Clock — Tauri v2 shell.
//!
//! Responsibilities (and ONLY these): window, autostart, preference persistence,
//! position restore. All rendering lives in the static `ui/` frontend.
//!
//! Window mutations (always-on-top, position) are handled here in Rust so the
//! coordinate system is consistent (logical on the way in, physical on the way
//! out, converted with the window's own scale factor) and so the frontend never
//! needs window-API permissions for them.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prefs {
    pub style: String,
    pub show_seconds: bool,
    pub hour12: bool,
    pub always_on_top: bool,
    pub autostart: bool,
    pub backdrop: String,
    pub scale: f64,
    pub opacity: f64,
    /// Physical pixels (as reported by tauri://move events), restored as logical
    /// via the window's current scale factor. Kept as f64 for JS interop.
    pub x: Option<f64>,
    pub y: Option<f64>,
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            style: "flip".into(),
            show_seconds: true,
            hour12: false,
            always_on_top: false,
            autostart: false,
            backdrop: "none".into(),
            scale: 1.0,
            opacity: 1.0,
            x: None,
            y: None,
        }
    }
}

/// Holds the last fully-hydrated prefs so partial writes never clobber fields.
struct PrefsState(Mutex<Prefs>);

fn prefs_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("prefs.json")
}

fn read_prefs(app: &AppHandle) -> Prefs {
    match fs::read_to_string(prefs_path(app)) {
        Ok(s) => serde_json::from_str::<Prefs>(&s).unwrap_or_default(),
        Err(_) => Prefs::default(),
    }
}

fn write_prefs(app: &AppHandle, prefs: &Prefs) -> Result<(), String> {
    let p = prefs_path(app);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // Temp file + rename: an interrupted write can never corrupt prefs.
    let tmp = p.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(prefs).map_err(|e| e.to_string())?;
    fs::write(&tmp, body).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_prefs(state: State<'_, PrefsState>) -> Result<Prefs, String> {
    Ok(state.0.lock().map_err(|e| e.to_string())?.clone())
}

/// The frontend sends the FULL merged prefs object (key must be `prefs`).
/// Position/scale changes from move/resize events also arrive here.
#[tauri::command]
fn set_prefs(
    app: AppHandle,
    win: WebviewWindow,
    state: State<'_, PrefsState>,
    prefs: Prefs,
) -> Result<(), String> {
    // Window effects are applied here so coordinates stay in one system.
    if win.set_always_on_top(prefs.always_on_top).is_err() {
        // Non-fatal: some WMs refuse; keep saving prefs anyway.
    }

    write_prefs(&app, &prefs)?;
    *state.0.lock().map_err(|e| e.to_string())? = prefs;
    Ok(())
}

/// Frontend asks Rust to move the window to a logical position and returns the
/// resulting physical position (after WM clamping) for the frontend to persist.
#[tauri::command]
fn set_window_position(win: WebviewWindow, x: f64, y: f64) -> Result<(f64, f64), String> {
    win.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)))
        .map_err(|e| e.to_string())?;
    let scale = win.scale_factor().map_err(|e| e.to_string())?;
    let pos = win.outer_position().map_err(|e| e.to_string())?;
    Ok((pos.x as f64, pos.y as f64))
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let mgr = app.autolaunch();
    if enabled {
        mgr.enable().map_err(|e| e.to_string())?;
    } else {
        mgr.disable().map_err(|e| e.to_string())?;
    }
    Ok(mgr.is_enabled().unwrap_or(false))
}

#[tauri::command]
fn get_autostart(app: AppHandle) -> Result<bool, String> {
    Ok(app.autolaunch().is_enabled().unwrap_or(false))
}

/// Restore a remembered position. Saved coords are PHYSICAL pixels; convert to
/// logical with the window's current scale factor. If the position would land
/// off-screen (monitor unplugged), fall back to the centered default.
fn restore_position(win: &WebviewWindow, prefs: &Prefs) {
    let (Some(x), Some(y)) = (prefs.x, prefs.y) else { return };
    let Ok(scale) = win.scale_factor() else { return };
    let lx = x / scale;
    let ly = y / scale;

    let mut on_screen = false;
    if let Ok(monitors) = win.available_monitors() {
        for m in monitors {
            let pos = m.position();
            let size = m.size();
            // Physical-space containment with a small tolerance.
            if x >= pos.x as f64 - 40.0
                && y >= pos.y as f64 - 40.0
                && x < pos.x as f64 + size.width as f64
                && y < pos.y as f64 + size.height as f64
            {
                on_screen = true;
                break;
            }
        }
    }
    if on_screen {
        let _ = win.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(lx, ly)));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // macOS uses a LaunchAgent; Windows/Linux register natively.
            app.handle().plugin(tauri_plugin_autostart::init(
                MacosLauncher::LaunchAgent,
                Some(vec!["--startup"]),
            ));

            let prefs = read_prefs(app.handle());
            app.manage(PrefsState(Mutex::new(prefs.clone())));

            if let Some(win) = app.get_webview_window("main") {
                restore_position(&win, &prefs);
                let _ = win.set_always_on_top(prefs.always_on_top);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_prefs,
            set_prefs,
            set_window_position,
            set_autostart,
            get_autostart
        ])
        .run(tauri::generate_context!())
        .expect("error while running Desk Clock");
}
