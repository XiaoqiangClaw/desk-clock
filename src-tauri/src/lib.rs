//! Desk Clock — Tauri v2 shell.
//!
//! Responsibilities: window/tray lifecycle, autostart, privilege/elevation
//! handling, preference persistence + cross-window sync, position restore.
//! All rendering lives in the static `ui/` frontend.
//!
//! v0.3: the clock window has no taskbar entry and lives in the system tray;
//! settings open in a separate native window (same `index.html`, switched by
//! an initialization script); preference writes are field-level merges that
//! are broadcast to every window so two windows can never clobber each other.

use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// Set by the tray "打赏支持" item. The settings window consumes it at boot,
/// so the intent survives even when the window is created for the first time
/// (a raw emit can be lost while the webview is still loading).
static DONATE_INTENT: AtomicBool = AtomicBool::new(false);

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Prefs {
    pub style: String,
    pub show_seconds: bool,
    pub hour12: bool,
    pub always_on_top: bool,
    pub autostart: bool,
    pub backdrop: String,
    pub scale: f64,
    pub opacity: f64,
    /// UI language: "zh-CN" (default) or "en".
    pub lang: String,
    /// Clock font: "" = follow style, "__custom__" = custom_font, else a preset id.
    pub font: String,
    pub custom_font: String,
    /// Clock colour: "" = follow style, "__custom__" = custom_color, else #RRGGBB.
    pub color: String,
    pub custom_color: String,
    /// Alarms: [{id, time:"HH:MM", repeat:bool}]. Managed on the JS side.
    pub alarms: Vec<serde_json::Value>,
    /// Windows only: request an elevated (administrator) process on every
    /// future launch, including autostart. Implemented with the per-user
    /// AppCompatFlags\Layers RUNASADMIN compatibility layer (no UAC needed to
    /// write it, and Windows applies it to the same exe used by the Run key).
    pub run_as_admin: bool,
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
            lang: "zh-CN".into(),
            font: String::new(),
            custom_font: String::new(),
            color: String::new(),
            custom_color: "#f6f7f9".into(),
            alarms: Vec::new(),
            run_as_admin: false,
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

// ---------------------------------------------------------------- privileges

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PrivilegeStatus {
    platform: String,
    is_elevated: bool,
    can_elevate: bool,
    run_as_admin: bool,
    note: String,
}

fn platform_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "other"
    }
}

/// Only Windows can reliably re-launch the same GUI app elevated (UAC /
/// ShellExecute "runas"). macOS/Linux need root for `shutdown`, but there is
/// no safe general-purpose auto-elevation for a desktop app — we say so
/// honestly instead of pretending.
fn can_elevate() -> bool {
    cfg!(target_os = "windows")
}

#[cfg(target_os = "windows")]
fn detect_elevated() -> bool {
    is_elevated::is_elevated()
}

#[cfg(not(target_os = "windows"))]
fn detect_elevated() -> bool {
    // `id -u` == 0 means root. Present on Linux and macOS; no extra crate.
    Command::new("id")
        .arg("-u")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "0")
        .unwrap_or(false)
}

/// HKCU AppCompatFlags\Layers: Windows applies RUNASADMIN to this executable
/// on EVERY launch (double-click, shortcut and the autostart Run entry alike).
/// HKCU writes do not need elevation themselves. Removing the value is
/// idempotent — a missing value is treated as success.
#[cfg(target_os = "windows")]
fn set_admin_compat(enabled: bool) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let key = r"HKCU\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers";
    let value = exe.as_os_str();
    let result = if enabled {
        Command::new("reg")
            .args(["add", key, "/v"])
            .arg(value)
            .args(["/t", "REG_SZ", "/d", "RUNASADMIN", "/f"])
            .output()
    } else {
        Command::new("reg")
            .args(["delete", key, "/v"])
            .arg(value)
            .arg("/f")
            .output()
    };
    let out = result.map_err(|e| e.to_string())?;
    if out.status.success() || !enabled {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[cfg(not(target_os = "windows"))]
fn set_admin_compat(_enabled: bool) -> Result<(), String> {
    // No-op: the setting is surfaced as unsupported in the UI instead.
    Ok(())
}

/// Ask Windows for an elevated copy, then terminate this one. The new process
/// is launched by ShellExecute with the "runas" verb, which shows the standard
/// UAC consent dialog. We deliberately NEVER auto-elevate from `setup()`: the
/// compatibility layer already handles future launches, so there is no loop.
#[cfg(target_os = "windows")]
fn restart_elevated_now(app: &AppHandle) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let path = exe.to_string_lossy().replace('\'', "''");
    let script = format!(
        "Start-Process -FilePath '{}' -Verb RunAs -WindowStyle Normal",
        path
    );
    Command::new("powershell")
        .args([
            "-NoProfile",
            "-WindowStyle",
            "Hidden",
            "-Command",
            script.as_str(),
        ])
        .spawn()
        .map_err(|e| e.to_string())?;
    app.exit(0);
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn restart_elevated_now(_app: &AppHandle) -> Result<(), String> {
    Err("此平台不支持自动提权；如需完整系统权限，请手动以 root/管理员身份启动本程序。".into())
}

fn privilege_status(prefs: &Prefs) -> PrivilegeStatus {
    let elevated = detect_elevated();
    let can = can_elevate();
    let note = match platform_name() {
        "windows" => {
            if elevated {
                "当前已以管理员身份运行。开机自启、定时关机及系统级设置均可正常使用。"
            } else {
                "当前为标准权限。Windows 下定时关机与开机自启通常无需提权；需要完整权限可勾选下方选项，之后每次启动（含开机自启）都会自动请求管理员身份。"
            }
        }
        "macos" => "定时关机需要 root 权限；macOS 不支持 GUI 应用自动提权，如需请在终端以 sudo 启动。开机自启通过 LaunchAgent 实现，无需提权。",
        "linux" => "定时关机需要 root / polkit 授权；本应用不会自动提权。开机自启通过用户级 desktop 项实现，无需提权。",
        _ => "此平台未提供系统级权限集成。",
    };
    PrivilegeStatus {
        platform: platform_name().into(),
        is_elevated: elevated,
        can_elevate: can,
        run_as_admin: prefs.run_as_admin && can,
        note: note.into(),
    }
}

// ------------------------------------------------------------------- commands

#[tauri::command]
fn get_prefs(state: State<'_, PrefsState>) -> Result<Prefs, String> {
    Ok(state.0.lock().map_err(|e| e.to_string())?.clone())
}

/// Field-level MERGE. Both windows send only the keys they changed; Rust owns
/// the authoritative full object, persists it, and broadcasts it back so every
/// window converges on the same state without write-back loops.
#[tauri::command]
fn set_prefs(
    app: AppHandle,
    state: State<'_, PrefsState>,
    patch: serde_json::Value,
) -> Result<Prefs, String> {
    let base = state.0.lock().map_err(|e| e.to_string())?.clone();
    let mut current = base.clone();
    if let Some(obj) = patch.as_object() {
        let mut merged = serde_json::to_value(&base).map_err(|e| e.to_string())?;
        if let Some(map) = merged.as_object_mut() {
            for (k, v) in obj {
                map.insert(k.clone(), v.clone());
            }
        }
        current = serde_json::from_value(merged).unwrap_or(base);
    }

    // Window effects belong to the CLOCK window, never to the settings window
    // that happened to issue the invoke.
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_always_on_top(current.always_on_top);
    }

    write_prefs(&app, &current)?;
    {
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        *guard = current.clone();
    }
    // Guard dropped before emitting: a listener may immediately invoke again.
    let _ = app.emit("prefs-changed", &current);
    Ok(current)
}

/// Frontend asks Rust to move the CLOCK window to a logical position and
/// returns the resulting physical position for the frontend to persist.
#[tauri::command]
fn set_window_position(app: AppHandle, x: f64, y: f64) -> Result<(f64, f64), String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "main window missing".to_string())?;
    win.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)))
        .map_err(|e| e.to_string())?;
    let pos = win.outer_position().map_err(|e| e.to_string())?;
    Ok((pos.x as f64, pos.y as f64))
}

/// Resize the native CLOCK window to match the visual scale (logical pixels).
#[tauri::command]
fn set_window_size(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "main window missing".to_string())?;
    win.set_size(tauri::Size::Logical(tauri::LogicalSize::new(width, height)))
        .map_err(|e| e.to_string())
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

#[tauri::command]
fn get_privilege_status(state: State<'_, PrefsState>) -> Result<PrivilegeStatus, String> {
    let prefs = state.0.lock().map_err(|e| e.to_string())?.clone();
    Ok(privilege_status(&prefs))
}

/// Persist the user's choice. On Windows this writes/removes the RUNASADMIN
/// compatibility layer, which is what makes the NEXT launch (and autostart)
/// elevated. On other platforms the choice is recorded but reported as
/// unsupported.
#[tauri::command]
fn set_run_as_admin(
    app: AppHandle,
    state: State<'_, PrefsState>,
    enabled: bool,
) -> Result<PrivilegeStatus, String> {
    set_admin_compat(enabled)?;
    let mut prefs = state.0.lock().map_err(|e| e.to_string())?.clone();
    prefs.run_as_admin = enabled && can_elevate();
    write_prefs(&app, &prefs)?;
    {
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        *guard = prefs.clone();
    }
    let _ = app.emit("prefs-changed", &prefs);
    Ok(privilege_status(&prefs))
}

#[tauri::command]
fn restart_elevated(app: AppHandle) -> Result<(), String> {
    restart_elevated_now(&app)
}

fn show_main_now(app: &AppHandle) -> Result<(), String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "main window missing".to_string())?;
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

/// Create the settings window on demand. Both the async command and the tray
/// menu handler call this; the tray path runs it on a separate thread because
/// WebviewWindowBuilder::build() deadlocks in synchronous event handlers on
/// Windows (wry/WebView2 #583).
fn ensure_settings_window(app: &AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("settings") {
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(
        app,
        "settings",
        WebviewUrl::App(PathBuf::from("index.html")),
    )
    .title("Desk Clock · 设置")
    .inner_size(430.0, 680.0)
    .min_inner_size(360.0, 420.0)
    .resizable(true)
    .decorations(true)
    .transparent(false)
    .skip_taskbar(false)
    .center()
    // Injected before any page script: switches the SAME index.html into
    // settings-only layout. No query-string / asset-path pitfalls.
    .initialization_script("window.__DC_VIEW__='settings';")
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn open_settings(app: AppHandle) -> Result<(), String> {
    ensure_settings_window(&app)
}

#[tauri::command]
fn close_settings(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("settings") {
        win.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn show_main_window(app: AppHandle) -> Result<(), String> {
    show_main_now(&app)
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn take_donate_intent() -> bool {
    DONATE_INTENT.swap(false, Ordering::SeqCst)
}

// --------------------------------------------------------------------- tray

fn build_tray(app: &AppHandle) -> Result<(), String> {
    let show_i = MenuItem::with_id(app, "show", "显示时钟", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let settings_i = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let donate_i = MenuItem::with_id(app, "donate", "打赏支持", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let quit_i =
        MenuItem::with_id(app, "quit", "退出", true, None::<&str>).map_err(|e| e.to_string())?;

    // append() takes &dyn IsMenuItem individually — no array coercion needed.
    // Linux also requires a menu for the tray icon to become visible.
    let menu = Menu::new(app).map_err(|e| e.to_string())?;
    menu.append(&show_i).map_err(|e| e.to_string())?;
    menu.append(&settings_i).map_err(|e| e.to_string())?;
    menu.append(&donate_i).map_err(|e| e.to_string())?;
    menu.append(&quit_i).map_err(|e| e.to_string())?;

    let mut builder = TrayIconBuilder::with_id("desk-clock-tray")
        .menu(&menu)
        .tooltip("Desk Clock · 桌面时钟")
        .show_menu_on_left_click(true);
    if let Some(icon) = app.default_window_icon() {
        // `Image<'_>` borrows the app's icon; build a fully-owned copy.
        let owned =
            tauri::image::Image::new_owned(icon.rgba().to_vec(), icon.width(), icon.height());
        builder = builder.icon(owned);
    }
    builder.build(app).map_err(|e| e.to_string())?;
    Ok(())
}

// ------------------------------------------------------------- shutdown timer

/// Holds the human-readable "HH:MM" target of the active shutdown timer.
/// The OS owns the real countdown, so it survives an app restart; this is
/// only the label shown in the settings panel.
struct ShutdownState(Mutex<Option<String>>);

#[cfg(target_os = "windows")]
fn os_schedule(seconds: u64) -> Result<(), String> {
    let out = Command::new("shutdown")
        .args(["/s", "/t"])
        .arg(seconds.to_string())
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}

#[cfg(target_os = "macos")]
fn os_schedule(seconds: u64) -> Result<(), String> {
    let mins = (seconds / 60).max(1);
    let out = Command::new("shutdown")
        .arg("-h")
        .arg(format!("+{}", mins))
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}

#[cfg(target_os = "linux")]
fn os_schedule(seconds: u64) -> Result<(), String> {
    let mins = (seconds / 60).max(1);
    let out = Command::new("shutdown")
        .arg("-h")
        .arg(format!("+{}", mins))
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn os_schedule(_seconds: u64) -> Result<(), String> {
    Err("unsupported platform".into())
}

#[cfg(target_os = "windows")]
fn os_cancel() -> Result<(), String> {
    let out = Command::new("shutdown")
        .args(["/a"])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn os_cancel() -> Result<(), String> {
    let out = Command::new("shutdown")
        .args(["-c"])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn os_cancel() -> Result<(), String> {
    Err("unsupported platform".into())
}

/// `label` is computed on the JS side from a real local Date, so the displayed
/// shutdown time always matches the user's actual timezone.
#[tauri::command]
fn schedule_shutdown(
    state: State<'_, ShutdownState>,
    minutes: f64,
    label: String,
) -> Result<String, String> {
    let mins = minutes.max(1.0).min(1440.0);
    let seconds = (mins * 60.0) as u64;
    os_schedule(seconds)?;
    *state.0.lock().map_err(|e| e.to_string())? = Some(label.clone());
    Ok(label)
}

#[tauri::command]
fn cancel_shutdown(state: State<'_, ShutdownState>) -> Result<(), String> {
    os_cancel()?;
    *state.0.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}

#[tauri::command]
fn get_shutdown_status(state: State<'_, ShutdownState>) -> Result<Option<String>, String> {
    Ok(state.0.lock().map_err(|e| e.to_string())?.clone())
}

/// Restore a remembered position. Saved coords are PHYSICAL pixels; convert to
/// logical with the window's current scale factor. If the position would land
/// off-screen (monitor unplugged), fall back to the centered default.
fn restore_position(win: &WebviewWindow, prefs: &Prefs) {
    let (Some(x), Some(y)) = (prefs.x, prefs.y) else {
        return;
    };
    let Ok(scale) = win.scale_factor() else {
        return;
    };
    let lx = x / scale;
    let ly = y / scale;

    let mut on_screen = false;
    if let Ok(monitors) = win.available_monitors() {
        for m in monitors {
            let pos = m.position();
            let size = m.size();
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
        let _ = win.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(
            lx, ly,
        )));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle();
            // macOS uses a LaunchAgent; Windows/Linux register natively.
            let _ = handle.plugin(tauri_plugin_autostart::init(
                MacosLauncher::LaunchAgent,
                Some(vec!["--startup"]),
            ));

            let prefs = read_prefs(handle);
            app.manage(PrefsState(Mutex::new(prefs.clone())));
            app.manage(ShutdownState(Mutex::new(None)));

            if let Some(win) = app.get_webview_window("main") {
                // Restore remembered SIZE first (before position, so WM clamping
                // uses the correct window dimensions).
                let _ = win.set_size(tauri::Size::Logical(tauri::LogicalSize::new(
                    640.0 * prefs.scale,
                    220.0 * prefs.scale,
                )));
                restore_position(&win, &prefs);
                let _ = win.set_always_on_top(prefs.always_on_top);
            }

            // The clock is tray-resident: no taskbar button, closing hides it.
            if let Err(e) = build_tray(handle) {
                eprintln!("Desk Clock: tray init failed: {}", e);
            }
            Ok(())
        })
        // Any window close (the settings X, Alt+F4 on the clock) hides that
        // window instead of destroying it / exiting the process. Only the tray
        // "退出" item calls app.exit().
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .on_menu_event(|app, event| {
            let id: &str = event.id().as_ref();
            match id {
                "show" => {
                    let _ = show_main_now(app);
                }
                "settings" => {
                    let h = app.clone();
                    std::thread::spawn(move || {
                        let _ = ensure_settings_window(&h);
                    });
                }
                "donate" => {
                    DONATE_INTENT.store(true, Ordering::SeqCst);
                    let h = app.clone();
                    std::thread::spawn(move || {
                        let _ = ensure_settings_window(&h);
                        let _ = h.emit("show-donate", ());
                    });
                }
                "quit" => app.exit(0),
                _ => {}
            }
        })
        .on_tray_icon_event(|app, event| {
            // Left click is the familiar "show the clock" gesture on
            // Windows/macOS. Linux does not emit tray click events at all, so
            // there the tray menu's 显示时钟 item is the equivalent.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = show_main_now(app);
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_prefs,
            set_prefs,
            set_window_position,
            set_window_size,
            set_autostart,
            get_autostart,
            get_privilege_status,
            set_run_as_admin,
            restart_elevated,
            open_settings,
            close_settings,
            show_main_window,
            quit_app,
            take_donate_intent,
            schedule_shutdown,
            cancel_shutdown,
            get_shutdown_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running Desk Clock");
}
