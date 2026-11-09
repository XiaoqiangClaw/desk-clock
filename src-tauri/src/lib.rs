//! Desk Clock — Tauri v2 shell.
//!
//! Responsibilities: window/tray lifecycle, single-instance enforcement,
//! autostart, privilege/elevation, preference persistence + cross-window sync,
//! position presets, multiple timezone clock windows, OS timers (shutdown /
//! reboot), system time sync and external links.
//! All rendering lives in the static `ui/` frontend.
//!
//! v0.4: one process owns any number of clock windows; settings opens in its
//! own native window (same `index.html`, switched by an initialization
//! script); preference writes are field-level merges broadcast to all windows.

use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// Set by the tray "打赏支持" item. The settings window consumes it at boot,
/// so the intent survives even when the window is created for the first time.
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
    /// v0.4: show the ":" separators (hiding keeps the spacing).
    pub show_separator: bool,
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
    /// v0.4: analog dial theme, "dark" or "light".
    pub analog_theme: String,
    /// v0.4: let the analog hands extend past the rim.
    pub analog_penetrate: bool,
    /// v0.4: let mouse clicks pass through the clock window.
    pub click_through: bool,
    /// Alarms: [{id, time:"HH:MM", repeat:bool}]. Managed on the JS side.
    pub alarms: Vec<serde_json::Value>,
    /// v0.4: play a chime when an alarm fires.
    pub alarm_sound: bool,
    /// v0.5: alarm ring tone id (gentle|bell|tick|rise|chord|custom).
    pub alarm_tone: String,
    /// v0.4: "shutdown" | "reboot".
    pub timer_action: String,
    /// v0.4: "duration" | "clock".
    pub timer_mode: String,
    /// v0.4: request OS time sync at startup.
    pub auto_time_sync: bool,
    /// v0.4/v0.5: extra timezone windows [{id,label,offsetMinutes,style?,showSeconds?,visible?}].
    pub extra_clocks: Vec<serde_json::Value>,
    /// Windows only: request an elevated (administrator) process on every
    /// future launch, including autostart (RUNASADMIN compatibility layer).
    pub run_as_admin: bool,
    /// Physical pixels (as reported by tauri://move events).
    pub x: Option<f64>,
    pub y: Option<f64>,
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            style: "flip".into(),
            show_seconds: true,
            hour12: false,
            show_separator: true,
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
            analog_theme: "dark".into(),
            analog_penetrate: false,
            click_through: false,
            alarms: Vec::new(),
            alarm_sound: true,
            alarm_tone: "gentle".into(),
            timer_action: "shutdown".into(),
            timer_mode: "duration".into(),
            auto_time_sync: false,
            extra_clocks: Vec::new(),
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

/// Merge one field into the authoritative prefs, persist and broadcast.
/// Used by Rust-side actions (tray click-through toggle) so the UI stays in
/// sync without any window having to write back.
fn patch_prefs(app: &AppHandle, key: &str, value: serde_json::Value) {
    let Some(state) = app.try_state::<PrefsState>() else {
        return;
    };
    let mut guard = match state.0.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let mut merged = serde_json::to_value(&*guard).unwrap_or_else(|_| serde_json::json!({}));
    if let Some(map) = merged.as_object_mut() {
        map.insert(key.to_string(), value);
    }
    if let Ok(next) = serde_json::from_value::<Prefs>(merged) {
        *guard = next.clone();
        drop(guard);
        let _ = write_prefs(app, &next);
        let _ = app.emit("prefs-changed", &next);
    }
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

#[derive(Debug, Clone, Serialize)]
struct TimerInfo {
    label: String,
    action: String,
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

fn can_elevate() -> bool {
    cfg!(target_os = "windows")
}

#[cfg(target_os = "windows")]
fn detect_elevated() -> bool {
    is_elevated::is_elevated()
}

#[cfg(not(target_os = "windows"))]
fn detect_elevated() -> bool {
    Command::new("id")
        .arg("-u")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "0")
        .unwrap_or(false)
}

/// HKCU AppCompatFlags\Layers: Windows applies RUNASADMIN to this executable
/// on EVERY launch (double-click, shortcut and the autostart Run entry alike).
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
    Ok(())
}

/// Ask Windows for an elevated copy, then terminate this one.
///
/// 🔴 v0.5 修复（权限界面卡死）：旧实现在同步 Tauri 命令里 `child.wait()`
/// 等 UAC 用户点击，前端 invoke 会一直 pending，按钮永远显示「正在请求授权…」。
/// 现在：spawn 后立刻返回，另起后台线程等结果；只有提权真正成功才退出本进程，
/// 取消/超时都保持当前时钟继续运行。命令本身不再阻塞 IPC。
#[cfg(target_os = "windows")]
fn restart_elevated_now(app: &AppHandle) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let path = exe.to_string_lossy().replace('\'', "''");
    let script = format!(
        "try {{ Start-Process -FilePath '{}' -Verb RunAs -WindowStyle Normal -ErrorAction Stop }} catch {{ exit 1 }}",
        path
    );
    // 🔴 单实例插件会持有 Windows 命名互斥锁；不先释放，新起的提权进程会被
    // 当成「第二个实例」直接退出，提权永远不会生效。签名见
    // tauri-plugin-single-instance::destroy<R: Runtime, M: Manager<R>>(&M)。
    tauri_plugin_single_instance::destroy(app);
    let mut child = Command::new("powershell")
        .args([
            "-NoProfile",
            "-WindowStyle",
            "Hidden",
            "-Command",
            script.as_str(),
        ])
        .spawn()
        .map_err(|e| e.to_string())?;
    // 后台线程等待 UAC 结果；成功才退出当前进程。绝不阻塞命令返回。
    let handle = app.clone();
    std::thread::spawn(move || {
        let ok = child.wait().map(|s| s.success()).unwrap_or(false);
        if ok {
            handle.exit(0);
        }
        // 取消授权：什么都不做，当前时钟照常运行；前端会自行恢复按钮状态。
    });
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
        "macos" => "定时关机 / 系统校时需要 root 权限；macOS 不支持 GUI 应用自动提权，如需请在终端以 sudo 启动。开机自启通过 LaunchAgent 实现，无需提权。",
        "linux" => "定时关机 / 系统校时需要 root / polkit 授权；本应用不会自动提权。开机自启通过用户级 desktop 项实现，无需提权。",
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

/// Field-level MERGE. Rust owns the authoritative full object, persists it,
/// and broadcasts it back so every window converges without write-back loops.
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

    // Window effects belong to the CLOCK window, never to the settings window.
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_always_on_top(current.always_on_top);
    }

    write_prefs(&app, &current)?;
    {
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        *guard = current.clone();
    }
    let _ = app.emit("prefs-changed", &current);
    Ok(current)
}

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

#[tauri::command]
fn set_window_size(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "main window missing".to_string())?;
    win.set_size(tauri::Size::Logical(tauri::LogicalSize::new(width, height)))
        .map_err(|e| e.to_string())
}

/// v0.4: snap the main clock to one of nine positions on its CURRENT monitor.
/// All math is done in physical pixels, so high-DPI / mixed-scale setups work.
#[tauri::command]
fn preset_position(app: AppHandle, pos: String) -> Result<(f64, f64), String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "main window missing".to_string())?;
    let monitor = win
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| win.primary_monitor().ok().flatten())
        .ok_or_else(|| "no monitor available".to_string())?;
    let area = monitor.work_area();
    let size = win.outer_size().map_err(|e| e.to_string())?;
    let margin: i32 = 12;

    let left = area.position.x + margin;
    let top = area.position.y + margin;
    let right = area.position.x + area.size.width as i32 - size.width as i32 - margin;
    let bottom = area.position.y + area.size.height as i32 - size.height as i32 - margin;
    let cx = area.position.x + (area.size.width as i32 - size.width as i32) / 2;
    let cy = area.position.y + (area.size.height as i32 - size.height as i32) / 2;

    let (x, y) = match pos.as_str() {
        "top-left" => (left, top),
        "top-center" => (cx, top),
        "top-right" => (right, top),
        "center-left" => (left, cy),
        "center" => (cx, cy),
        "center-right" => (right, cy),
        "bottom-left" => (left, bottom),
        "bottom-center" => (cx, bottom),
        "bottom-right" => (right, bottom),
        _ => (cx, cy),
    };
    let position = tauri::Position::Physical(tauri::PhysicalPosition::new(x, y));
    win.set_position(position).map_err(|e| e.to_string())?;
    // Persist the result so the position survives a restart (frontend also
    // listens to tauri://move, but a programmatic move may not emit it).
    let after = win.outer_position().map_err(|e| e.to_string())?;
    patch_prefs(
        &app,
        "x",
        serde_json::json!(after.x as f64),
    );
    patch_prefs(
        &app,
        "y",
        serde_json::json!(after.y as f64),
    );
    Ok((after.x as f64, after.y as f64))
}

/// v0.4: click-through. Only the main window is affected; the tray always
/// offers a way back even when the clock no longer receives mouse events.
#[tauri::command]
fn set_click_through(app: AppHandle, enabled: bool) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        win.set_ignore_cursor_events(enabled)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
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

/// Create the settings window on demand. The async command and the tray menu
/// handler both call this; the tray path runs it on a separate thread because
/// WebviewWindowBuilder::build() deadlocks in synchronous handlers on Windows.
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
    .inner_size(560.0, 640.0)
    .min_inner_size(460.0, 480.0)
    .resizable(true)
    .decorations(true)
    .transparent(false)
    .skip_taskbar(false)
    .center()
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

// ------------------------------------------------------ extra clock windows

/// Build ONE extra timezone clock window. Each window gets its own injected
/// offset AND (v0.5 manager) its own style / showSeconds override; everything
/// else (font, colour, scale…) still follows the shared global prefs.
fn spawn_extra_window(
    app: &AppHandle,
    id: &str,
    label: &str,
    offset: f64,
    style: Option<&str>,
    show_seconds: bool,
    visible: bool,
) -> Result<(), String> {
    let win_label = format!("clock-{}", id);
    if app.get_webview_window(&win_label).is_some() {
        return Ok(());
    }
    // JSON-encode every injected value so quotes/unicode can never break the
    // script. Rust resolves the values; the frontend only supplies ids.
    let label_json = serde_json::to_string(label).unwrap_or_else(|_| "\"\"".into());
    let offset_json = serde_json::to_string(&offset).unwrap_or_else(|_| "0".into());
    let style_json = serde_json::to_string(&style.unwrap_or("")).unwrap_or_else(|_| "\"\"".into());
    let init = format!(
        "window.__DC_EXTRA__=1;window.__DC_TZ_OFFSET__={};window.__DC_TZ_LABEL__={};window.__DC_STYLE__={};window.__DC_SHOW_SECONDS__={};",
        offset_json, label_json, style_json, show_seconds
    );
    tauri::WebviewWindowBuilder::new(
        app,
        &win_label,
        WebviewUrl::App(PathBuf::from("index.html")),
    )
    .title(format!("Desk Clock · {}", label))
    .inner_size(640.0, 220.0)
    .min_inner_size(240.0, 96.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .skip_taskbar(true)
    .always_on_top(true)
    .center()
    .visible(visible)
    .initialization_script(init.as_str())
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// v0.5 manager: create / re-create a clock window with its own settings.
/// Editing an existing id destroys the old window first so the new style and
/// visibility take effect immediately.
#[tauri::command]
fn add_clock_window(
    app: AppHandle,
    id: String,
    label: String,
    offset: f64,
    style: Option<String>,
    show_seconds: Option<bool>,
    visible: Option<bool>,
) -> Result<(), String> {
    // Sanitise the id: it becomes part of a window label. Keep it alnum only.
    let clean: String = id.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    if clean.is_empty() {
        return Err("invalid clock id".into());
    }
    let win_label = format!("clock-{}", clean);
    if let Some(win) = app.get_webview_window(&win_label) {
        win.destroy().map_err(|e| e.to_string())?;
    }
    let st = style.filter(|s| !s.is_empty());
    spawn_extra_window(
        &app,
        &clean,
        &label,
        offset.clamp(-840.0, 840.0),
        st.as_deref(),
        show_seconds.unwrap_or(true),
        visible.unwrap_or(true),
    )
}

/// v0.5 manager: hide/show a clock window without destroying its config.
#[tauri::command]
fn set_clock_window_visible(app: AppHandle, id: String, visible: bool) -> Result<(), String> {
    let clean: String = id.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    let win_label = format!("clock-{}", clean);
    let win = app.get_webview_window(&win_label);
    if let Some(win) = win {
        if visible { win.show().map_err(|e| e.to_string())?; }
        else { win.hide().map_err(|e| e.to_string())?; }
        return Ok(());
    }
    if !visible { return Ok(()); }
    // Window doesn't exist yet (hidden at startup): rebuild it from prefs.
    let prefs = read_prefs(&app);
    for v in prefs.extra_clocks.iter() {
        let vid = v.get("id").and_then(|x| x.as_str()).unwrap_or("");
        if vid != clean { continue; }
        let lbl = v.get("label").and_then(|x| x.as_str()).unwrap_or("");
        let off = v.get("offset").and_then(|x| x.as_f64()).unwrap_or(0.0);
        let st = v.get("style").and_then(|x| x.as_str()).filter(|s| !s.is_empty());
        let secs = v.get("showSeconds").and_then(|x| x.as_bool()).unwrap_or(true);
        return spawn_extra_window(&app, &clean, lbl, off, st, secs, true);
    }
    Ok(())
}

#[tauri::command]
fn close_clock_window(app: AppHandle, id: String) -> Result<(), String> {
    let clean: String = id.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    let win_label = format!("clock-{}", clean);
    if let Some(win) = app.get_webview_window(&win_label) {
        win.destroy().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn list_clock_windows(app: AppHandle) -> Vec<String> {
    app.webview_windows()
        .keys()
        .filter(|k| k.starts_with("clock-"))
        .cloned()
        .collect()
}

// ------------------------------------------------------------- external link

/// The frontend passes an IDENTIFIER, never a raw URL: Rust resolves the
/// actual address, so no window can make the app open an arbitrary target.
#[tauri::command]
fn open_link(kind: String) -> Result<(), String> {
    let url = match kind.as_str() {
        "project" => "https://github.com/xiaoqiangclub/desk-clock",
        "releases" => "https://github.com/xiaoqiangclub/desk-clock/releases/latest",
        _ => return Err("unknown link".into()),
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("rundll32");
        c.args(["url.dll,FileProtocolHandler", url]);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg(url);
        c
    };
    #[cfg(target_os = "linux")]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(url);
        c
    };
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(url);
        c
    };
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

// ------------------------------------------------------------- system time

/// Ask the OS to re-sync its clock. These commands generally need admin/root;
/// failures are returned honestly to the UI instead of pretending success.
#[cfg(target_os = "windows")]
fn os_time_sync() -> Result<String, String> {
    let out = Command::new("w32tm")
        .args(["/resync", "/nowait"])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok("已向 Windows 时间服务请求同步（可能需要几分钟生效）。".into())
    } else {
        Err(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }
}

#[cfg(target_os = "macos")]
fn os_time_sync() -> Result<String, String> {
    let out = Command::new("sntp")
        .args(["-sS", "time.apple.com"])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok("已与 time.apple.com 校时。".into())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[cfg(target_os = "linux")]
fn os_time_sync() -> Result<String, String> {
    let out = Command::new("timedatectl")
        .args(["set-ntp", "true"])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok("已启用系统网络时间同步（systemd-timesyncd / chrony）。".into())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn os_time_sync() -> Result<String, String> {
    Err("unsupported platform".into())
}

#[tauri::command]
fn sync_system_time() -> Result<String, String> {
    os_time_sync()
}

// --------------------------------------------------------------------- tray

fn build_tray(app: &AppHandle) -> Result<(), String> {
    let show_i = MenuItem::with_id(app, "show", "显示时钟", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let settings_i = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let unclick_i = MenuItem::with_id(app, "unclick", "恢复鼠标（关闭穿透）", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let update_i = MenuItem::with_id(app, "update", "检查更新", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let donate_i = MenuItem::with_id(app, "donate", "打赏支持", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let quit_i =
        MenuItem::with_id(app, "quit", "退出", true, None::<&str>).map_err(|e| e.to_string())?;

    let menu = Menu::new(app).map_err(|e| e.to_string())?;
    menu.append(&show_i).map_err(|e| e.to_string())?;
    menu.append(&settings_i).map_err(|e| e.to_string())?;
    menu.append(&unclick_i).map_err(|e| e.to_string())?;
    menu.append(&update_i).map_err(|e| e.to_string())?;
    menu.append(&donate_i).map_err(|e| e.to_string())?;
    menu.append(&quit_i).map_err(|e| e.to_string())?;

    let mut builder = TrayIconBuilder::with_id("desk-clock-tray")
        .menu(&menu)
        .tooltip("Desk Clock · 桌面时钟")
        .show_menu_on_left_click(true);
    if let Some(icon) = app.default_window_icon() {
        let owned =
            tauri::image::Image::new_owned(icon.rgba().to_vec(), icon.width(), icon.height());
        builder = builder.icon(owned);
    }
    builder.build(app).map_err(|e| e.to_string())?;
    Ok(())
}

// ------------------------------------------------------------- OS timer

struct TimerState(Mutex<Option<TimerInfo>>);

/// `reboot` switches the shutdown flag on every supported platform.
#[cfg(target_os = "windows")]
fn os_schedule(seconds: u64, reboot: bool) -> Result<(), String> {
    let flag = if reboot { "/r" } else { "/s" };
    let out = Command::new("shutdown")
        .args([flag, "/t"])
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
fn os_schedule(seconds: u64, reboot: bool) -> Result<(), String> {
    let mins = (seconds / 60).max(1);
    let flag = if reboot { "-r" } else { "-h" };
    let out = Command::new("shutdown")
        .arg(flag)
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
fn os_schedule(seconds: u64, reboot: bool) -> Result<(), String> {
    let mins = (seconds / 60).max(1);
    let flag = if reboot { "-r" } else { "-h" };
    let out = Command::new("shutdown")
        .arg(flag)
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
fn os_schedule(_seconds: u64, _reboot: bool) -> Result<(), String> {
    Err("unsupported platform".into())
}

#[cfg(target_os = "windows")]
fn os_cancel() -> Result<(), String> {
    let out = Command::new("shutdown").args(["/a"]).output().map_err(|e| e.to_string())?;
    if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).to_string()) }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn os_cancel() -> Result<(), String> {
    let out = Command::new("shutdown").args(["-c"]).output().map_err(|e| e.to_string())?;
    if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).to_string()) }
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn os_cancel() -> Result<(), String> {
    Err("unsupported platform".into())
}

/// `label` is computed on the JS side from a real local Date, so the displayed
/// time always matches the user's actual timezone (including next-day targets).
#[tauri::command]
fn schedule_timer(
    state: State<'_, TimerState>,
    app: AppHandle,
    action: String,
    minutes: f64,
    label: String,
) -> Result<String, String> {
    let mins = minutes.max(1.0).min(1440.0);
    let seconds = (mins * 60.0) as u64;
    let act = if action == "reboot" { "reboot" } else { "shutdown" };
    os_schedule(seconds, act == "reboot")?;
    *state.0.lock().map_err(|e| e.to_string())? = Some(TimerInfo {
        label: label.clone(),
        action: act.into(),
    });
    // Persist the choice so the UI restores it after a settings-window reload.
    patch_prefs(&app, "timerAction", serde_json::json!(act));
    Ok(label)
}

#[tauri::command]
fn cancel_timer(state: State<'_, TimerState>) -> Result<(), String> {
    os_cancel()?;
    *state.0.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}

#[tauri::command]
fn get_timer_status(state: State<'_, TimerState>) -> Result<Option<TimerInfo>, String> {
    Ok(state.0.lock().map_err(|e| e.to_string())?.clone())
}

// Backwards-compatible aliases (v0.3 callers).
#[tauri::command]
fn schedule_shutdown(state: State<'_, TimerState>, minutes: f64, label: String) -> Result<String, String> {
    let mins = minutes.max(1.0).min(1440.0);
    os_schedule((mins * 60.0) as u64, false)?;
    *state.0.lock().map_err(|e| e.to_string())? = Some(TimerInfo { label: label.clone(), action: "shutdown".into() });
    Ok(label)
}

#[tauri::command]
fn cancel_shutdown(state: State<'_, TimerState>) -> Result<(), String> {
    os_cancel()?;
    *state.0.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}

#[tauri::command]
fn get_shutdown_status(state: State<'_, TimerState>) -> Result<Option<String>, String> {
    Ok(state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        .map(|t| t.label.clone()))
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
        let _ = win.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(lx, ly)));
    }
}

/// Restore extra timezone windows from prefs on startup. Runs on a worker
/// thread with a small delay to avoid the WebView2 synchronous-build deadlock.
fn restore_extra_windows(app: AppHandle, prefs: &Prefs) {
    let items: Vec<(String, String, f64, Option<String>, bool, bool)> = prefs
        .extra_clocks
        .iter()
        .filter_map(|v| {
            let id = v.get("id")?.as_str()?.to_string();
            let label = v.get("label")?.as_str()?.to_string();
            let offset = v.get("offset").and_then(|x| x.as_f64())?;
            let style = v.get("style").and_then(|x| x.as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string());
            let show_seconds = v.get("showSeconds").and_then(|x| x.as_bool()).unwrap_or(true);
            let visible = v.get("visible").and_then(|x| x.as_bool()).unwrap_or(true);
            Some((id, label, offset, style, show_seconds, visible))
        })
        .collect();
    if items.is_empty() {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(600));
        for (id, label, offset, style, secs, vis) in items {
            let clean: String = id.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
            if clean.is_empty() {
                continue;
            }
            let _ = spawn_extra_window(&app, &clean, &label, offset, style.as_deref(), secs, vis);
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Single instance MUST be registered first. A second launch hands its
        // args to this callback and exits; we simply bring the clock back.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = show_main_now(app);
        }))
        .setup(|app| {
            let handle = app.handle();
            // macOS uses a LaunchAgent; Windows/Linux register natively.
            let _ = handle.plugin(tauri_plugin_autostart::init(
                MacosLauncher::LaunchAgent,
                Some(vec!["--startup"]),
            ));

            let prefs = read_prefs(handle);
            app.manage(PrefsState(Mutex::new(prefs.clone())));
            app.manage(TimerState(Mutex::new(None)));

            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_size(tauri::Size::Logical(tauri::LogicalSize::new(
                    640.0 * prefs.scale,
                    220.0 * prefs.scale,
                )));
                restore_position(&win, &prefs);
                let _ = win.set_always_on_top(prefs.always_on_top);
                if prefs.click_through {
                    let _ = win.set_ignore_cursor_events(true);
                }
            }

            if let Err(e) = build_tray(handle) {
                eprintln!("Desk Clock: tray init failed: {}", e);
            }

            // Restore extra timezone windows and (optionally) sync the OS
            // clock once at startup. Both run off the main thread.
            restore_extra_windows(handle.clone(), &prefs);
            if prefs.auto_time_sync {
                std::thread::spawn(|| {
                    let _ = os_time_sync();
                });
            }
            Ok(())
        })
        // Any window close hides that window instead of quitting the process.
        // Only the tray "退出" item calls app.exit().
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
                "unclick" => {
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.set_ignore_cursor_events(false);
                    }
                    patch_prefs(app, "clickThrough", serde_json::json!(false));
                }
                "update" => {
                    let _ = open_link("releases".into());
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
            preset_position,
            set_click_through,
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
            add_clock_window,
            close_clock_window,
            set_clock_window_visible,
            list_clock_windows,
            open_link,
            sync_system_time,
            schedule_timer,
            cancel_timer,
            get_timer_status,
            schedule_shutdown,
            cancel_shutdown,
            get_shutdown_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running Desk Clock");
}
