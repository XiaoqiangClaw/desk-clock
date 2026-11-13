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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

/// Set by the tray "打赏支持" item. The settings window consumes it at boot,
/// so the intent survives even when the window is created for the first time.
static DONATE_INTENT: AtomicBool = AtomicBool::new(false);
/// True once the user explicitly asked to quit. The global CloseRequested
/// handler hides every window; without this flag app.exit() only hides them
/// and the process keeps running (tray "quit" and the settings quit button
/// both appeared to do nothing).
static QUITTING: AtomicBool = AtomicBool::new(false);
/// v0.7.6: generation counter for alert auto-close. A reused popup must not
/// be closed by the stale timer of a PREVIOUS alarm.
static ALERT_GENERATION: AtomicU64 = AtomicU64::new(0);
/// Last left-click on the tray icon. Only Windows emits a native
/// DoubleClick event; on macOS we detect the second click ourselves.
static LAST_TRAY_CLICK: Mutex<Option<std::time::Instant>> = Mutex::new(None);

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
    /// v0.6.2: alarm ring duration (seconds), auto-stop.
    pub alarm_ring_seconds: f64,
    /// v0.4: "shutdown" | "reboot".
    pub timer_action: String,
    /// v0.4: "duration" | "clock".
    pub timer_mode: String,
    /// v0.6.2: "popup" | "silent".
    pub timer_warn_mode: String,
    /// v0.6.2: warn this many seconds before the OS action.
    pub timer_warn_seconds: f64,
    /// v0.4: request OS time sync at startup.
    pub auto_time_sync: bool,
    /// v0.4/v0.5: extra timezone windows [{id,label,offsetMinutes,style?,showSeconds?,visible?}].
    pub extra_clocks: Vec<serde_json::Value>,
    /// Windows only: request an elevated (administrator) process on every
    /// future launch, including autostart (RUNASADMIN compatibility layer).
    pub run_as_admin: bool,
    // ---- v0.7.0 (released): voice time announcement (default OFF) ----
    /// Master switch; false = feature off (default).
    pub announce_enabled: bool,
    /// hourly | half | quarter | interval | custom.
    pub announce_rule: String,
    /// Interval (minutes, 5-120) used by the `interval` rule.
    pub announce_interval: f64,
    /// Custom time list [{id,time:"HH:MM"}] used by the `custom` rule.
    pub announce_times: Vec<serde_json::Value>,
    /// voiceURI ("" = auto-match the UI language).
    pub announce_voice: String,
    /// Speech rate 0.5-2.
    pub announce_rate: f64,
    /// Speech volume 0-1.
    pub announce_volume: f64,
    /// Chime before speaking: none | gentle | bell | tick | rise | chord.
    pub announce_chime: String,
    /// Enable a quiet (no-announce) window.
    pub announce_quiet: bool,
    /// Quiet window start "HH:MM".
    pub announce_quiet_start: String,
    /// Quiet window end "HH:MM" (may cross midnight).
    pub announce_quiet_end: String,
    /// Also speak the date / weekday.
    pub announce_include_date: bool,
    /// "" = follow the UI language; else "zh-CN" / "en".
    pub announce_lang: String,
    /// v0.7.3: runtime calendar auto-sync switch (default ON). Without this
    /// field, set_prefs / prefs-changed drop it and the UI switch never sticks.
    pub calendar_auto_sync: bool,
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
            alarm_ring_seconds: 30.0,
            timer_action: "shutdown".into(),
            timer_mode: "duration".into(),
            timer_warn_mode: "popup".into(),
            timer_warn_seconds: 30.0,
            auto_time_sync: false,
            extra_clocks: Vec::new(),
            run_as_admin: false,
            // v0.7.0 (released): voice time announcement — default OFF.
            announce_enabled: false,
            announce_rule: "hourly".into(),
            announce_interval: 30.0,
            announce_times: Vec::new(),
            announce_voice: String::new(),
            announce_rate: 1.0,
            announce_volume: 1.0,
            announce_chime: "gentle".into(),
            announce_quiet: false,
            announce_quiet_start: "22:00".into(),
            announce_quiet_end: "07:00".into(),
            announce_include_date: false,
            announce_lang: String::new(),
            calendar_auto_sync: true,
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

/// v0.6.2：generation 让「取消 / 重新排程」即时作废旧的提醒线程。
#[derive(Debug, Clone, Default)]
struct TimerSnapshot {
    info: Option<TimerInfo>,
    generation: u64,
    warn_seconds: f64,
    warn_mode: String,
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
        reg_command()
            .args(["add", key, "/v"])
            .arg(value)
            .args(["/t", "REG_SZ", "/d", "RUNASADMIN", "/f"])
            .output()
    } else {
        reg_command()
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

// ------------------------------------------------------- Windows autostart

/// Windows Run value name. The autostart plugin uses `package_info().name`,
/// i.e. the Cargo package name "desk-clock".
#[cfg(target_os = "windows")]
const WIN_RUN_APP_NAME: &str = "desk-clock";
#[cfg(target_os = "windows")]
const WIN_RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(target_os = "windows")]
const WIN_RUN_KEY_HKLM: &str = r"HKLM\Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(target_os = "windows")]
const WIN_APPCOMPAT_LAYERS_KEY: &str =
    r"HKCU\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers";

/// `reg.exe` without flashing a console window in a GUI app.
#[cfg(target_os = "windows")]
fn reg_command() -> Command {
    use std::os::windows::process::CommandExt;
    let mut c = Command::new("reg");
    // CREATE_NO_WINDOW
    c.creation_flags(0x0800_0000);
    c
}

/// v0.7.6: fix the upstream `auto-launch 0.6.0` Windows defect.
///
/// Its `enable_with_root_key()` writes
/// `format!("{} {}", app_path, args.join(" "))` WITHOUT quoting app_path.
/// Any install path containing a space (`C:\Program Files\...`, a user name
/// with a space, ...) makes Windows parse `C:\Program` as the executable and
/// silently skip the app at logon. Worse, `is_enabled()` only checks that
/// the value EXISTS, so the UI happily reports "enabled" while nothing ever
/// starts — exactly the "autostart still fails" symptom.
///
/// After the plugin's enable() we overwrite the Run value with a properly
/// quoted absolute path and read it back to verify.
#[cfg(target_os = "windows")]
fn repair_windows_run_value() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let value = format!("\"{}\" --startup", exe.display());
    // The plugin uses WindowsEnableMode::Dynamic: when the app runs elevated
    // it writes HKLM (which Windows also executes at logon). Repair that one
    // too when writable, otherwise the unquoted HKLM entry stays broken.
    let hklm = reg_command()
        .args(["query", WIN_RUN_KEY_HKLM, "/v", WIN_RUN_APP_NAME])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if hklm {
        let _ = reg_command()
            .args(["add", WIN_RUN_KEY_HKLM, "/v", WIN_RUN_APP_NAME, "/t", "REG_SZ", "/d"])
            .arg(&value)
            .arg("/f")
            .output();
    }
    let out = reg_command()
        .args(["add", WIN_RUN_KEY, "/v", WIN_RUN_APP_NAME, "/t", "REG_SZ", "/d"])
        .arg(&value)
        .arg("/f")
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let q = reg_command()
        .args(["query", WIN_RUN_KEY, "/v", WIN_RUN_APP_NAME])
        .output()
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&q.stdout).to_string();
    if !text.contains(&format!("\"{}\"", exe.display())) {
        return Err(format!("Run value read-back mismatch: {}", text.trim()));
    }
    Ok(value)
}

#[cfg(not(target_os = "windows"))]
fn repair_windows_run_value() -> Result<String, String> {
    Ok(String::new())
}

/// Read the real Windows state back, so the user can SEE why autostart
/// fails instead of guessing. Never mutates anything.
#[cfg(target_os = "windows")]
fn windows_autostart_probe() -> serde_json::Value {
    let exe = std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let query = |key: &str, name: &str| -> Option<String> {
        reg_command()
            .args(["query", key, "/v", name])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
    };
    let run = query(WIN_RUN_KEY, WIN_RUN_APP_NAME)
        .or_else(|| query(WIN_RUN_KEY_HKLM, WIN_RUN_APP_NAME));
    let registered = run.is_some();
    let run_text = run.unwrap_or_default();
    let quoted = run_text.contains(&format!("\"{}\"", exe));
    let matches = run_text.contains(&exe);
    let layers = query(WIN_APPCOMPAT_LAYERS_KEY, &exe);
    let elevated_compat = layers.as_ref().map(|s| s.contains("RUNASADMIN")).unwrap_or(false);
    let approved = query(
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run",
        WIN_RUN_APP_NAME,
    );
    // Enabled entries start with 02/06; Task Manager writes 03/01/00... when
    // the user disables an item. Report the raw hex instead of guessing when
    // reg.exe output cannot be parsed, so the UI never shows a false verdict.
    let approved_hex = approved
        .as_ref()
        .and_then(|s| s.split_whitespace().last().map(|v| v.to_string()))
        .unwrap_or_default();
    let disabled_by_task_manager = !approved_hex.is_empty()
        && !approved_hex.starts_with("02")
        && !approved_hex.starts_with("06");
    // Compute before `exe` is moved into the JSON value below.
    let exe_exists = !exe.is_empty() && std::path::Path::new(&exe).exists();
    serde_json::json!({
        "platform": "windows",
        "exeExists": exe_exists,
        "exePath": exe,
        "runValue": run_text.trim(),
        "registered": registered,
        "pathQuoted": quoted,
        "pathMatchesExe": matches,
        "runAsAdminCompat": elevated_compat,
        "disabledByTaskManager": disabled_by_task_manager,
        "startupApprovedHex": approved_hex
    })
}

#[cfg(not(target_os = "windows"))]
fn windows_autostart_probe() -> serde_json::Value {
    serde_json::json!({ "platform": std::env::consts::OS, "supported": false })
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
            force_quit(handle.clone());
        } else {
            // v0.7.5: UAC 取消后单实例锁已被 destroy 且无法重新初始化。
            // 启动一个普通权限副本重新持锁，再退出本进程，避免之后出现
            // 两个进程同时跑托盘 / 闹钟 / 定时任务。
            if let Ok(exe) = std::env::current_exe() {
                let _ = Command::new(exe).spawn();
            }
            force_quit(handle);
        }
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
        // v0.7.6: the plugin writes an UNQUOTED exe path into the Run value.
        // Repair it immediately (and verify by reading back), otherwise any
        // install path containing a space silently breaks logon startup while
        // is_enabled() still says "on".
        #[cfg(target_os = "windows")]
        repair_windows_run_value()?;
    } else {
        mgr.disable().map_err(|e| e.to_string())?;
    }
    // v0.7: read the system state back instead of trusting the write.
    // If the registration silently failed, return an error so the UI can show
    // failure rather than a false "enabled" (old code just returned is_enabled()).
    let actual = mgr.is_enabled().map_err(|e| e.to_string())?;
    if actual != enabled {
        return Err(format!(
            "autostart write did not stick (wanted {}, system reports {})",
            enabled, actual
        ));
    }
    Ok(actual)
}

#[tauri::command]
fn get_autostart(app: AppHandle) -> Result<bool, String> {
    // A read error must not be reported as "not enabled": that silently
    // cleared the saved checkbox and desynced UI from the real system state.
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

/// v0.7.6: expose the REAL OS state for the "autostart still fails" case.
/// Returns the registry command, whether the path is quoted / points at this
/// very executable, whether a RUNASADMIN compat layer will trigger UAC at
/// logon, and whether Task Manager disabled the entry.
#[tauri::command]
fn get_autostart_diagnostics(app: AppHandle) -> Result<serde_json::Value, String> {
    let mut v = windows_autostart_probe();
    if let Some(o) = v.as_object_mut() {
        o.insert(
            "pluginEnabled".into(),
            serde_json::json!(app.autolaunch().is_enabled().unwrap_or(false)),
        );
        o.insert(
            "savedIntent".into(),
            serde_json::json!(read_prefs(&app).autostart),
        );
    }
    Ok(v)
}

/// One-click repair: re-register through the plugin, then overwrite the Run
/// value with a quoted absolute path and read it back. Used by the settings
/// "修复开机自启" button and by the startup self-heal path.
#[tauri::command]
fn repair_autostart(app: AppHandle) -> Result<serde_json::Value, String> {
    let mgr = app.autolaunch();
    // disable() first so a stale/unquoted value cannot survive.
    let _ = mgr.disable();
    mgr.enable().map_err(|e| e.to_string())?;
    let value = repair_windows_run_value()?;
    let mut v = windows_autostart_probe();
    if let Some(o) = v.as_object_mut() {
        o.insert("pluginEnabled".into(), serde_json::json!(mgr.is_enabled().unwrap_or(false)));
        o.insert("repairedCommand".into(), serde_json::json!(value));
    }
    Ok(v)
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
fn ensure_settings_window(app: &AppHandle, target: Option<&str>) -> Result<(), String> {
    if let Some(t) = target {
        let legacy = app
            .try_state::<PrefsState>()
            .and_then(|s| s.0.lock().ok().map(|g| g.clone()))
            .unwrap_or_default();
        let mut all = read_clocks(app, &legacy);
        if let Some(o) = all.as_object_mut() {
            o.insert("activeId".into(), serde_json::json!(t));
        }
        let _ = write_clocks(app, &all);
        // 已存在的设置窗口不会重新 boot，用定向事件让它切目标。
        let _ = app.emit("settings-target-changed", serde_json::json!({ "id": t }));
    }
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
    .title("Desk Clock v0.7.6 · 设置")
    // v0.5.1：固定尺寸（用户要求）。内容再多也在面板内用滚轮滚动，
    // 隐藏滚动条；760×700 已能容纳最复杂的一页，且兼容 1366×768 小屏。
    .inner_size(760.0, 700.0)
    .min_inner_size(760.0, 700.0)
    .max_inner_size(760.0, 700.0)
    .resizable(false)
    .decorations(true)
    .transparent(false)
    .skip_taskbar(false)
    .center()
    .initialization_script("window.__DC_VIEW__='settings';window.__DC_SETTINGS__=1;")
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn open_settings(app: AppHandle, id: Option<String>) -> Result<(), String> {
    ensure_settings_window(&app, id.as_deref())
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
    force_quit(app);
}

/// End the process for real. app.exit() alone is swallowed by the global
/// CloseRequested handler (every window answers with prevent_close + hide),
/// so the tray "退出" item and the settings quit button used to do nothing.
fn force_quit(app: AppHandle) {
    QUITTING.store(true, Ordering::SeqCst);
    app.exit(0);
    // Fallback: if the event loop did not terminate, end the process anyway.
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_millis(1500));
        std::process::exit(0);
    });
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
    _offset: f64,
    _style: Option<&str>,
    _show_seconds: bool,
    visible: bool,
) -> Result<(), String> {
    let win_label = format!("clock-{}", id);
    if app.get_webview_window(&win_label).is_some() {
        return Ok(());
    }
    // JSON-encode every injected value so quotes/unicode can never break the
    // script. Rust resolves the values; the frontend only supplies ids.
    let label_json = serde_json::to_string(label).unwrap_or_else(|_| "\"\"".into());
    let count = app
        .webview_windows()
        .keys()
        .filter(|k| k.starts_with("clock-"))
        .count() as f64;
    // 🔴 v0.5.1：新窗口错开位置，否则全部 .center() 完全重叠、看起来像没显示。
    let x = 160.0 + (count % 6.0) * 46.0;
    let y = 140.0 + (count % 6.0) * 40.0;
    // v0.6：置顶取自本窗口自己的配置（所有窗口平等）。
    let legacy = read_prefs(app);
    let mut all = read_clocks(app, &legacy);
    let mut cfg = ensure_clock_cfg(&mut all, id);
    let on_top = cfg.get("alwaysOnTop").and_then(|v| v.as_bool()).unwrap_or(false);
    let (px, py) = match (
        cfg.get("x").and_then(|v| v.as_f64()),
        cfg.get("y").and_then(|v| v.as_f64()),
    ) {
        (Some(a), Some(b)) => (a, b),
        _ => (x, y),
    };
    if let Some(o) = cfg.as_object_mut() {
        o.insert("x".into(), serde_json::json!(px));
        o.insert("y".into(), serde_json::json!(py));
    }
    if let Some(clocks) = all.get_mut("clocks").and_then(|c| c.as_object_mut()) {
        clocks.insert(id.to_string(), cfg.clone());
    }
    let _ = write_clocks(app, &all);
    // v0.6.1：注入值取自该窗口自己的 clocks.json 配置（权威），
    // 不再用 legacy extra_clocks 的旧 offset/style/showSeconds —— 否则用户
    // 事后在设置里改过的时区（尤其改回「本机时间」时 tzOffset=null），
    // 重启后会被旧注入值拉回去。
    let tz_offset_json = serde_json::to_string(
        &cfg.get("tzOffset").cloned().unwrap_or(serde_json::Value::Null),
    )
    .unwrap_or_else(|_| "null".into());
    let inj_style = cfg.get("style").and_then(|v| v.as_str()).unwrap_or("");
    let style_json = serde_json::to_string(inj_style).unwrap_or_else(|_| "\"\"".into());
    let inj_secs = cfg.get("showSeconds").and_then(|v| v.as_bool()).unwrap_or(true);
    let init = format!(
        "window.__DC_EXTRA__=1;window.__DC_CLOCK_ID__={};window.__DC_TZ_OFFSET__={};window.__DC_TZ_LABEL__={};window.__DC_STYLE__={};window.__DC_SHOW_SECONDS__={};",
        serde_json::to_string(id).unwrap_or_else(|_| "\"\"".into()),
        tz_offset_json, label_json, style_json, inj_secs
    );
    let win = tauri::WebviewWindowBuilder::new(
        app,
        &win_label,
        WebviewUrl::App(PathBuf::from("index.html")),
    )
    .title(format!("Desk Clock v0.7.6 · {}", label))
    // v0.6.2：优先用前端测量并持久化的内容尺寸；缺省回退旧固定外壳。
    .inner_size(
        cfg.get("w").and_then(|v| v.as_f64()).filter(|v| *v > 0.0).unwrap_or(640.0),
        cfg.get("h").and_then(|v| v.as_f64()).filter(|v| *v > 0.0).unwrap_or(220.0),
    )
    .min_inner_size(240.0, 96.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .skip_taskbar(true)
    .always_on_top(on_top)
    .position(px, py)
    .visible(visible)
    .initialization_script(init.as_str())
    .build()
    .map_err(|e| e.to_string())?;
    // v0.6.1：额外时钟窗口与主窗口完全平等，按自己的 clickThrough 配置决定是否穿透。
    // 默认 false ⇒ 可以拖动、可以点齿轮；想不挡其它应用可在「窗口」页开鼠标穿透。
    let ct = cfg.get("clickThrough").and_then(|v| v.as_bool()).unwrap_or(false);
    let _ = win.set_ignore_cursor_events(ct);
    Ok(())
}

/// v0.5.1：窗口创建放到后台线程执行。
/// 同步 Tauri 命令里直接 `WebviewWindowBuilder::build()` 在 Windows WebView2
/// 上会与主线程互锁（本项目 ensure_settings_window 已有同样规避），
/// 表现为「点了添加但窗口不出现 / 整个程序卡顿」。命令立即返回，
/// 真正建窗在独立线程完成。
#[tauri::command]
fn add_clock_window(
    app: AppHandle,
    state: State<'_, PrefsState>,
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
    // v0.6.1：创建表单已精简为「名称 + 添加窗口」，不再接受时区/样式/秒覆盖。
    // 保留这三个 Tauri 命令参数只为兼容旧前端调用；哑元消费掉避免 unused 警告。
    let _ = (offset, style, show_seconds);
    let vis = visible.unwrap_or(true);
    let lbl = label.clone();

    // v0.6.1：新建窗口 = 完整复制 main 当前配置（样式/颜色/字体/大小/时区…），
    // 不再在创建时覆盖任何显示项。名称由 extra_clocks[].label 单独维护，
    // 时区/样式等事后通过「正在编辑」下拉框进该窗口自己的设置页修改。
    {
        let legacy = state.0.lock().map(|g| g.clone()).unwrap_or_default();
        let mut all = read_clocks(&app, &legacy);
        let base = all
            .get("clocks")
            .and_then(|c| c.get("main"))
            .cloned()
            .unwrap_or_else(default_window_prefs);
        let mut cfg = base;
        if let Some(o) = cfg.as_object_mut() {
            // 仅清空位置，让新窗口错开显示、不叠在主窗口上。
            o.insert("x".into(), serde_json::Value::Null);
            o.insert("y".into(), serde_json::Value::Null);
        }
        if let Some(clocks) = all.get_mut("clocks").and_then(|c| c.as_object_mut()) {
            clocks.insert(clean.clone(), cfg);
        }
        let _ = write_clocks(&app, &all);
    }

    std::thread::spawn(move || {
        // 注入值由 spawn_extra_window 从 clocks.json 读取（权威），
        // 这里三个显示项参数只传哑值占位，不再参与配置。
        let _ = spawn_extra_window(&app, &clean, &lbl, 0.0, None, true, vis);
    });
    Ok(())
}

/// v0.5.1：隐藏后重新显示时同样用后台线程建窗，避免同步 build 死锁。
#[tauri::command]
fn set_clock_window_visible(app: AppHandle, id: String, visible: bool) -> Result<(), String> {
    let clean: String = id.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    let win_label = format!("clock-{}", clean);
    let win = app.get_webview_window(&win_label);
    if let Some(win) = win {
        if visible { win.show().map_err(|e| e.to_string())?; }
        else { win.hide().map_err(|e| e.to_string())?; }
        // v0.5.1：Tauri 的 hide() 不会让 document.hidden 变 true，
        // 隐藏的窗口仍会每秒 tick 而白耗资源。显式通知该窗口停/复表。
        let _ = app.emit_to(win_label.as_str(), "clock-visibility", visible);
        return Ok(());
    }
    if !visible { return Ok(()); }
    // Window doesn't exist yet (hidden at startup): rebuild it from prefs.
    let prefs = read_prefs(&app);
    for v in prefs.extra_clocks.iter() {
        let vid = v.get("id").and_then(|x| x.as_str()).unwrap_or("");
        if vid != clean { continue; }
        let lbl = v.get("label").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let off = v.get("offset").and_then(|x| x.as_f64()).unwrap_or(0.0);
        let st = v.get("style").and_then(|x| x.as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string());
        let secs = v.get("showSeconds").and_then(|x| x.as_bool()).unwrap_or(true);
        let id2 = clean.clone();
        std::thread::spawn(move || {
            let _ = spawn_extra_window(&app, &id2, &lbl, off, st.as_deref(), secs, true);
        });
        return Ok(());
    }
    Ok(())
}

#[tauri::command]
fn close_clock_window(app: AppHandle, state: State<'_, PrefsState>, id: String) -> Result<(), String> {
    let clean: String = id.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    let win_label = format!("clock-{}", clean);
    if let Some(win) = app.get_webview_window(&win_label) {
        win.destroy().map_err(|e| e.to_string())?;
    }
    // v0.6：同步删掉该窗口的配置，避免残留
    let legacy = state.0.lock().map(|g| g.clone()).unwrap_or_default();
    let mut all = read_clocks(&app, &legacy);
    if let Some(clocks) = all.get_mut("clocks").and_then(|c| c.as_object_mut()) {
        clocks.remove(&clean);
    }
    if all.get("activeId").and_then(|v| v.as_str()) == Some(clean.as_str()) {
        if let Some(o) = all.as_object_mut() {
            o.insert("activeId".into(), serde_json::json!("main"));
        }
    }
    let _ = write_clocks(&app, &all);
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

// ================================================================
// v0.6.0：每窗口完整配置（clocks.json）
//
// 所有时钟窗口完全平等：每个窗口一份完整配置，主窗口只是默认存在的那一个。
// 每窗口配置用 serde_json::Value 读写，保持配置字段灵活可扩展。
// 旧 prefs.json 继续存全局项与窗口清单（extra_clocks），升级不丢配置。
// ================================================================

/// 每窗口完整配置的默认值（与前端 DEFAULTS 的每窗口部分一致）。
fn default_window_prefs() -> serde_json::Value {
    serde_json::json!({
        "style": "flip",
        "showSeconds": true,
        "hour12": false,
        "showSeparator": true,
        "alwaysOnTop": false,
        "backdrop": "none",
        "scale": 1.0,
        "opacity": 1.0,
        "font": "",
        "customFont": "",
        "color": "",
        "customColor": "#f6f7f9",
        "analogTheme": "dark",
        "analogPenetrate": false,
        "clickThrough": false,
        "tzOffset": serde_json::Value::Null,
        "tzLabel": "",
        "x": serde_json::Value::Null,
        "y": serde_json::Value::Null
    })
}

fn clocks_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("clocks.json")
}

/// 读 clocks.json；不存在时用旧 prefs 的 extra_clocks 与全局值迁移。
fn read_clocks(app: &AppHandle, legacy: &Prefs) -> serde_json::Value {
    if let Ok(s) = fs::read_to_string(clocks_path(app)) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
            if v.get("clocks").map(|c| c.is_object()).unwrap_or(false) {
                return v;
            }
        }
    }
    // ---- 迁移：main 用旧全局值；extra_clocks 逐条补齐 ----
    let mut base = default_window_prefs();
    if let Some(o) = base.as_object_mut() {
        o.insert("style".into(), serde_json::json!(legacy.style));
        o.insert("showSeconds".into(), serde_json::json!(legacy.show_seconds));
        o.insert("hour12".into(), serde_json::json!(legacy.hour12));
        o.insert("showSeparator".into(), serde_json::json!(legacy.show_separator));
        o.insert("alwaysOnTop".into(), serde_json::json!(legacy.always_on_top));
        o.insert("backdrop".into(), serde_json::json!(legacy.backdrop));
        o.insert("scale".into(), serde_json::json!(legacy.scale));
        o.insert("opacity".into(), serde_json::json!(legacy.opacity));
        o.insert("font".into(), serde_json::json!(legacy.font));
        o.insert("customFont".into(), serde_json::json!(legacy.custom_font));
        o.insert("color".into(), serde_json::json!(legacy.color));
        o.insert("customColor".into(), serde_json::json!(legacy.custom_color));
        o.insert("analogTheme".into(), serde_json::json!(legacy.analog_theme));
        o.insert("analogPenetrate".into(), serde_json::json!(legacy.analog_penetrate));
        o.insert("clickThrough".into(), serde_json::json!(legacy.click_through));
        o.insert("x".into(), serde_json::json!(legacy.x));
        o.insert("y".into(), serde_json::json!(legacy.y));
    }
    let mut clocks = serde_json::Map::new();
    clocks.insert("main".into(), base.clone());
    for v in legacy.extra_clocks.iter() {
        let Some(id) = v.get("id").and_then(|x| x.as_str()) else { continue };
        let clean: String = id.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
        if clean.is_empty() {
            continue;
        }
        let mut cfg = base.clone();
        if let Some(o) = cfg.as_object_mut() {
            if let Some(off) = v.get("offset").and_then(|x| x.as_f64()) {
                o.insert("tzOffset".into(), serde_json::json!(off));
            }
            if let Some(lbl) = v.get("label").and_then(|x| x.as_str()) {
                o.insert("tzLabel".into(), serde_json::json!(lbl));
            }
            if let Some(st) = v.get("style").and_then(|x| x.as_str()) {
                if !st.is_empty() {
                    o.insert("style".into(), serde_json::json!(st));
                }
            }
            if let Some(s) = v.get("showSeconds").and_then(|x| x.as_bool()) {
                o.insert("showSeconds".into(), serde_json::json!(s));
            }
        }
        clocks.insert(clean, cfg);
    }
    serde_json::json!({ "activeId": "main", "clocks": clocks })
}

fn write_clocks(app: &AppHandle, v: &serde_json::Value) -> Result<(), String> {
    let p = clocks_path(app);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = p.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    fs::write(&tmp, body).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
    Ok(())
}

/// 保证某窗口配置存在（缺失时用 main 或默认值补）。
fn ensure_clock_cfg(all: &mut serde_json::Value, id: &str) -> serde_json::Value {
    let clocks = all
        .get_mut("clocks")
        .and_then(|c| c.as_object_mut());
    let Some(clocks) = clocks else {
        return default_window_prefs();
    };
    if let Some(v) = clocks.get(id) {
        return v.clone();
    }
    // 新窗口：复制 main 当前配置（避免新窗口“什么都没配”），再覆盖时区/名称
    let base = clocks
        .get("main")
        .cloned()
        .unwrap_or_else(default_window_prefs);
    clocks.insert(id.to_string(), base.clone());
    base
}

#[tauri::command]
fn get_window_configs(app: AppHandle, state: State<'_, PrefsState>) -> Result<serde_json::Value, String> {
    let legacy = state.0.lock().map_err(|e| e.to_string())?.clone();
    Ok(read_clocks(&app, &legacy))
}

/// v0.7.5: 统一的窗口 id 消毒。只允许 main 或短字母数字 id，
/// 避免受损 WebView 用任意字符串制造幻影窗口配置。
fn sanitize_clock_id(id: &str) -> Result<String, String> {
    if id == "main" {
        return Ok("main".into());
    }
    if !id.is_empty()
        && id.len() <= 32
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Ok(id.to_string());
    }
    Err("invalid clock id".into())
}

/// 设置窗口切换「当前编辑目标」并持久化。
#[tauri::command]
fn set_active_clock(app: AppHandle, state: State<'_, PrefsState>, id: String) -> Result<(), String> {
    let id = sanitize_clock_id(&id)?;
    let legacy = state.0.lock().map_err(|e| e.to_string())?.clone();
    let mut all = read_clocks(&app, &legacy);
    if let Some(o) = all.as_object_mut() {
        o.insert("activeId".into(), serde_json::json!(id));
    }
    write_clocks(&app, &all)
}

/// 单个窗口的完整配置（时钟窗口启动 / 设置窗口读取目标时用）。
#[tauri::command]
fn get_window_prefs(app: AppHandle, state: State<'_, PrefsState>, id: String) -> Result<serde_json::Value, String> {
    let id = sanitize_clock_id(&id)?;
    let legacy = state.0.lock().map_err(|e| e.to_string())?.clone();
    let mut all = read_clocks(&app, &legacy);
    let cfg = ensure_clock_cfg(&mut all, &id);
    let _ = write_clocks(&app, &all);
    Ok(cfg)
}

/// 字段级 patch 写入某窗口，并广播（各窗口只应用自己 id；设置窗口应用当前目标）。
#[tauri::command]
fn set_window_prefs(
    app: AppHandle,
    state: State<'_, PrefsState>,
    id: String,
    patch: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let id = sanitize_clock_id(&id)?;
    // v0.7.5: patch 字段白名单，防止受损 WebView 往 clocks.json 写任意字段。
    const ALLOWED: &[&str] = &[
        "name", "tzOffset", "tzLabel", "style", "showSeconds", "showSeparator",
        "hour12", "alwaysOnTop", "clickThrough", "scale", "opacity", "font",
        "customFont", "color", "customColor", "analogTheme", "analogPenetrate",
        "backdrop", "visible", "x", "y", "w", "h",
    ];
    let legacy = state.0.lock().map_err(|e| e.to_string())?.clone();
    let mut all = read_clocks(&app, &legacy);
    let mut cfg = ensure_clock_cfg(&mut all, &id);
    if let (Some(obj), Some(p)) = (cfg.as_object_mut(), patch.as_object()) {
        for (k, v) in p {
            if ALLOWED.contains(&k.as_str()) {
                obj.insert(k.clone(), v.clone());
            }
        }
    }
    if let Some(clocks) = all.get_mut("clocks").and_then(|c| c.as_object_mut()) {
        clocks.insert(id.clone(), cfg.clone());
    }
    write_clocks(&app, &all)?;

    // 应用到真实窗口（仅当该窗口存在）
    let win_label = if id == "main" { "main".to_string() } else { format!("clock-{}", id) };
    if let Some(win) = app.get_webview_window(&win_label) {
        if let Some(v) = cfg.get("alwaysOnTop").and_then(|x| x.as_bool()) {
            let _ = win.set_always_on_top(v);
        }
        // v0.6.1：所有窗口平等，鼠标穿透由每个窗口自己的配置决定。
        if let Some(v) = cfg.get("clickThrough").and_then(|x| x.as_bool()) {
            let _ = win.set_ignore_cursor_events(v);
        }
        if let Some(sc) = cfg.get("scale").and_then(|x| x.as_f64()) {
            // v0.6.2：优先用前端测量并持久化的内容尺寸，避免透明外壳贴边时可见内容离边太远。
            let cw = cfg.get("w").and_then(|x| x.as_f64());
            let ch = cfg.get("h").and_then(|x| x.as_f64());
            let (w, h) = match (cw, ch) {
                (Some(w), Some(h)) if w > 0.0 && h > 0.0 => (w, h),
                _ => (640.0 * sc, 220.0 * sc),
            };
            let _ = win.set_size(tauri::Size::Logical(tauri::LogicalSize::new(w, h)));
        }
    }

    let _ = app.emit(
        "window-prefs-changed",
        serde_json::json!({ "id": id, "prefs": cfg }),
    );
    Ok(cfg)
}

/// 某窗口专属的位置/尺寸命令（不再硬编码 main）。
#[tauri::command]
fn set_window_geometry(
    app: AppHandle,
    id: String,
    x: Option<f64>,
    y: Option<f64>,
    scale: Option<f64>,
    w: Option<f64>,
    h: Option<f64>,
) -> Result<(), String> {
    let id = sanitize_clock_id(&id)?;
    // v0.7.5: 拒绝 NaN / 无穷 / 越界几何参数。
    for v in [x, y, scale, w, h].into_iter().flatten() {
        if !v.is_finite() || v.abs() > 100_000.0 {
            return Err("invalid window geometry".into());
        }
    }
    if let Some(sc) = scale {
        if sc <= 0.0 || sc > 5.0 {
            return Err("invalid scale".into());
        }
    }
    let win_label = if id == "main" { "main".to_string() } else { format!("clock-{}", id) };
    let win = app
        .get_webview_window(&win_label)
        .ok_or_else(|| "window missing".to_string())?;
    // v0.6.2：w/h = #app 内容尺寸（逻辑像素）。持久化到 clocks.json，
    // 供重启建窗与 preset_position_for 的 outer_size() 贴边计算使用。
    let (cw, ch) = match (w, h) {
        (Some(w), Some(h)) if w > 0.0 && h > 0.0 => (Some(w), Some(h)),
        _ => (None, None),
    };
    if let (Some(w), Some(h)) = (cw, ch) {
        win.set_size(tauri::Size::Logical(tauri::LogicalSize::new(w, h)))
            .map_err(|e| e.to_string())?;
    } else if let Some(sc) = scale {
        win.set_size(tauri::Size::Logical(tauri::LogicalSize::new(640.0 * sc, 220.0 * sc)))
            .map_err(|e| e.to_string())?;
    }
    if let (Some(w), Some(h)) = (cw, ch) {
        let legacy = app
            .try_state::<PrefsState>()
            .and_then(|s| s.0.lock().ok().map(|g| g.clone()))
            .unwrap_or_default();
        let mut all = read_clocks(&app, &legacy);
        let mut cfg = ensure_clock_cfg(&mut all, &id);
        if let Some(o) = cfg.as_object_mut() {
            o.insert("w".into(), serde_json::json!(w));
            o.insert("h".into(), serde_json::json!(h));
        }
        if let Some(clocks) = all.get_mut("clocks").and_then(|c| c.as_object_mut()) {
            clocks.insert(id.clone(), cfg);
        }
        let _ = write_clocks(&app, &all);
    }
    if let (Some(x), Some(y)) = (x, y) {
        win.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
            x as i32, y as i32,
        )))
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 九宫格定位作用于指定窗口（不再固定 main）。
#[tauri::command]
fn preset_position_for(
    app: AppHandle,
    state: State<'_, PrefsState>,
    id: String,
    pos: String,
) -> Result<(f64, f64), String> {
    let id = sanitize_clock_id(&id)?;
    let win_label = if id == "main" { "main".to_string() } else { format!("clock-{}", id) };
    let win = app
        .get_webview_window(&win_label)
        .ok_or_else(|| "window missing".to_string())?;
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
    win.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(x, y)))
        .map_err(|e| e.to_string())?;
    let legacy = state.0.lock().map(|g| g.clone()).unwrap_or_default();
    let mut all = read_clocks(&app, &legacy);
    let mut cfg = ensure_clock_cfg(&mut all, &id);
    if let Some(o) = cfg.as_object_mut() {
        o.insert("x".into(), serde_json::json!(x as f64));
        o.insert("y".into(), serde_json::json!(y as f64));
    }
    if let Some(clocks) = all.get_mut("clocks").and_then(|c| c.as_object_mut()) {
        clocks.insert(id.clone(), cfg.clone());
    }
    let _ = write_clocks(&app, &all);
    let _ = app.emit(
        "window-prefs-changed",
        serde_json::json!({ "id": id, "prefs": cfg }),
    );
    Ok((x as f64, y as f64))
}

// ------------------------------------------------------------- external link

/// The frontend passes an IDENTIFIER, never a raw URL: Rust resolves the
/// actual address, so no window can make the app open an arbitrary target.
/// 用系统默认方式打开一个 URL（项目页 / Releases / 更新安装包直链）。
/// 不走 Tauri shell 插件，直接用平台原生命令；调用方需自行保证 url 可信。
fn shell_open(url: &str) -> Result<(), String> {
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

#[tauri::command]
fn open_link(kind: String) -> Result<(), String> {
    let url = match kind.as_str() {
        "project" => "https://github.com/xiaoqiangclub/desk-clock",
        "releases" => "https://github.com/xiaoqiangclub/desk-clock/releases/latest",
        _ => return Err("unknown link".into()),
    };
    shell_open(url)
}

/// 一键更新：打开「当前平台对应的新版本安装包」直链。
/// URL 必须由前端从本项目 Releases 资源列表中取出；这里只放行本项目 release 直链，避免任意 URL 打开。
#[tauri::command]
fn open_update_installer(url: String) -> Result<(), String> {
    validate_update_url(&url)?;
    shell_open(&url)
}

/// v0.7.5: 严格校验更新包直链。旧实现只做 starts_with(prefix)，会放行
/// 同前缀下的任意路径甚至非安装包资产。这里限定：本项目 release 下载路径
/// + 合法 vX.Y.Z tag + 已知安装包后缀 + 无路径穿越。
fn validate_update_url(url: &str) -> Result<String, String> {
    let prefix = "https://github.com/xiaoqiangclub/desk-clock/releases/download/";
    let rest = url
        .strip_prefix(prefix)
        .ok_or_else(|| "invalid update asset url".to_string())?;
    let mut parts = rest.split('/');
    let tag = parts.next().unwrap_or("");
    let name = parts.next().unwrap_or("");
    if tag.is_empty() || name.is_empty() || parts.next().is_some() {
        return Err("invalid update asset path".into());
    }
    let mut tc = tag.chars();
    if tc.next() != Some('v') || !tc.all(|c| c.is_ascii_digit() || c == '.') {
        return Err("invalid update tag".into());
    }
    let allowed = [
        ".exe", ".msi", ".dmg", ".app.tar.gz", ".AppImage", ".deb", ".rpm",
    ];
    if !allowed.iter().any(|s| name.ends_with(s))
        || name.contains("..")
        || name.contains('\\')
        || name.contains('/')
    {
        return Err("invalid update asset name".into());
    }
    Ok(name.to_string())
}

/// 用系统 curl 下载到临时目录（Windows 10+/macOS/Linux 均自带，零新 Rust 依赖）。
/// 任何失败都返回 Err，由前端回退到「打开下载页 + 提示手动安装」。
fn download_update(url: &str, name: &str) -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join("desk-clock-update");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(name);
    let _ = fs::remove_file(&dest);
    let out = Command::new("curl")
        .args([
            "-fL",
            "--retry",
            "2",
            "--connect-timeout",
            "15",
            "--max-time",
            "600",
            "--silent",
            "--show-error",
            "-o",
        ])
        .arg(&dest)
        .arg(url)
        .output()
        .map_err(|e| format!("curl unavailable: {}", e))?;
    if !out.status.success() {
        let _ = fs::remove_file(&dest);
        return Err(format!(
            "download failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let len = fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    if len < 1024 * 1024 {
        let _ = fs::remove_file(&dest);
        return Err("download too small (not an installer)".into());
    }
    Ok(dest)
}

#[cfg(target_os = "windows")]
fn launch_installer(path: &PathBuf) -> Result<(), String> {
    let name = path.to_string_lossy();
    let mut cmd = if name.ends_with(".msi") {
        let mut c = Command::new("msiexec");
        c.args(["/i"]).arg(path).args(["/passive", "/norestart"]);
        c
    } else {
        let mut c = Command::new(path);
        c.arg("/S"); // NSIS 静默安装
        c
    };
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn launch_installer(path: &PathBuf) -> Result<(), String> {
    Command::new("open")
        .arg(path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn launch_installer(path: &PathBuf) -> Result<(), String> {
    let name = path.to_string_lossy();
    if name.ends_with(".AppImage") {
        let _ = Command::new("chmod").args(["+x"]).arg(path).status();
        Command::new(path).spawn().map_err(|e| e.to_string())?;
    } else {
        // deb / rpm 交给系统包管理器打开，不做静默提权。
        Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn launch_installer(_path: &PathBuf) -> Result<(), String> {
    Err("unsupported platform".into())
}

/// v0.7.5 一键更新：自动下载 + 启动安装器 + 退出当前进程。
/// 失败时返回 Err，前端负责打开 releases 页面并提示手动安装。
#[tauri::command]
fn auto_update(app: AppHandle, url: String) -> Result<String, String> {
    let name = validate_update_url(&url)?;
    let dest = download_update(&url, &name)?;
    launch_installer(&dest)?;
    // 让 IPC 先把成功结果返回给前端，再退出；否则前端只会看到通道中断。
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        force_quit(app);
    });
    Ok(dest.to_string_lossy().into_owned())
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

/// Show / hide the settings window from a tray double click (or the menu
/// fallback on platforms that emit no tray click events at all).
fn toggle_settings_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("settings") {
        if win.is_visible().unwrap_or(true) {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.set_focus();
        }
        return;
    }
    // Building a window inside a synchronous tray handler deadlocks on Windows.
    let h = app.clone();
    std::thread::spawn(move || {
        let _ = ensure_settings_window(&h, None);
    });
}

/// 2 = native double click (Windows only), 1 = plain left click, 0 = ignore.
fn tray_event_kind(event: TrayIconEvent) -> u8 {
    match event {
        TrayIconEvent::DoubleClick {
            button: MouseButton::Left,
            ..
        } => 2,
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } => 1,
        _ => 0,
    }
}

/// macOS has no native DoubleClick event, so treat two left clicks within
/// 400 ms as one. Linux emits no tray events at all (upstream limitation) —
/// the "显示 / 隐藏设置" menu item is the fallback there.
fn second_click_within(max_ms: u64) -> bool {
    let now = std::time::Instant::now();
    let mut last = LAST_TRAY_CLICK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let hit = last
        .map(|t| now.duration_since(t) < std::time::Duration::from_millis(max_ms))
        .unwrap_or(false);
    *last = if hit { None } else { Some(now) };
    hit
}

fn build_tray(app: &AppHandle) -> Result<(), String> {
    let show_i = MenuItem::with_id(app, "show", "显示时钟", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let settings_i = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let toggle_settings_i = MenuItem::with_id(
        app,
        "toggle_settings",
        "显示 / 隐藏设置",
        true,
        None::<&str>,
    )
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
    menu.append(&toggle_settings_i).map_err(|e| e.to_string())?;
    menu.append(&unclick_i).map_err(|e| e.to_string())?;
    menu.append(&update_i).map_err(|e| e.to_string())?;
    menu.append(&donate_i).map_err(|e| e.to_string())?;
    menu.append(&quit_i).map_err(|e| e.to_string())?;

    let mut builder = TrayIconBuilder::with_id("desk-clock-tray")
        .menu(&menu)
        .tooltip("Desk Clock · 桌面时钟")
        // Left click must reach on_tray_icon_event so a double click can
        // toggle settings. Right-click menus are unaffected by this flag.
        .show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        let owned =
            tauri::image::Image::new_owned(icon.rgba().to_vec(), icon.width(), icon.height());
        builder = builder.icon(owned);
    }
    builder.build(app).map_err(|e| e.to_string())?;
    Ok(())
}

// ------------------------------------------------------------- OS timer

struct TimerState(Mutex<TimerSnapshot>);

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
/// v0.6.2: a popup warning is emitted `warn_seconds` before the OS action;
/// "silent" mode skips it. A generation counter invalidates stale warning
/// threads whenever the timer is cancelled or re-scheduled.
#[tauri::command]
fn schedule_timer(
    state: State<'_, TimerState>,
    app: AppHandle,
    action: String,
    minutes: f64,
    label: String,
    warn_mode: Option<String>,
    warn_seconds: Option<f64>,
) -> Result<String, String> {
    let mins = minutes.max(1.0).min(1440.0);
    let seconds = (mins * 60.0) as u64;
    let act = if action == "reboot" { "reboot" } else { "shutdown" };
    let mode = if warn_mode.as_deref() == Some("silent") { "silent" } else { "popup" };
    let ahead = warn_seconds.unwrap_or(30.0).max(5.0).min(300.0);
    // v0.7.5: 已有任务时先撤销旧的 OS 计划并作废旧提醒线程，
    // 避免重载 / 多窗口 / 旧计划残留导致重复关机。
    {
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        if guard.info.is_some() {
            let _ = os_cancel();
            guard.info = None;
            guard.generation = guard.generation.wrapping_add(1);
        }
    }
    os_schedule(seconds, act == "reboot")?;
    let generation = {
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        guard.generation = guard.generation.wrapping_add(1);
        guard.info = Some(TimerInfo { label: label.clone(), action: act.into() });
        guard.warn_mode = mode.into();
        guard.warn_seconds = ahead;
        guard.generation
    };
    // Persist the choice so the UI restores it after a settings-window reload.
    patch_prefs(&app, "timerAction", serde_json::json!(act));
    patch_prefs(&app, "timerWarnMode", serde_json::json!(mode));
    patch_prefs(&app, "timerWarnSeconds", serde_json::json!(ahead));
    let _ = app.emit(
        "timer-state",
        serde_json::json!({ "active": true, "action": act, "label": label }),
    );
    if mode == "popup" {
        let app2 = app.clone();
        let act2 = act.to_string();
        let label2 = label.clone();
        let wait = seconds.saturating_sub(ahead.max(0.0) as u64);
        std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(wait);
            loop {
                let expired = {
                    let guard = match app2.try_state::<TimerState>() {
                        Some(s) => s,
                        None => return,
                    };
                    let g = match guard.0.lock() { Ok(g) => g, Err(_) => return };
                    g.generation != generation || g.info.is_none()
                };
                if expired { return; }
                if std::time::Instant::now() >= deadline {
                    let _ = app2.emit("timer-warning", serde_json::json!({
                        "action": act2, "label": label2, "warnSeconds": ahead
                    }));
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
        });
    }
    Ok(label)
}

fn cancel_timer_inner(app: &AppHandle, state: &State<'_, TimerState>) -> Result<(), String> {
    // v0.7.5: 先执行 OS 取消，但无论成败都清本地状态并广播，
    // 避免「UI 显示已终止、系统关机仍会执行」或状态卡死。
    let result = os_cancel();
    {
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        guard.info = None;
        guard.generation = guard.generation.wrapping_add(1);
    }
    let _ = app.emit("timer-cancelled", ());
    let _ = app.emit("timer-state", serde_json::json!({ "active": false }));
    result
}

#[tauri::command]
fn cancel_timer(state: State<'_, TimerState>, app: AppHandle) -> Result<(), String> {
    cancel_timer_inner(&app, &state)
}

#[tauri::command]
fn get_timer_status(state: State<'_, TimerState>) -> Result<Option<TimerInfo>, String> {
    Ok(state.0.lock().map_err(|e| e.to_string())?.info.clone())
}

// Backwards-compatible aliases (v0.3 callers).
#[tauri::command]
fn schedule_shutdown(state: State<'_, TimerState>, app: AppHandle, minutes: f64, label: String) -> Result<String, String> {
    schedule_timer(state, app, "shutdown".into(), minutes, label, Some("silent".into()), None)
}

#[tauri::command]
fn cancel_shutdown(state: State<'_, TimerState>, app: AppHandle) -> Result<(), String> {
    cancel_timer_inner(&app, &state)
}

#[tauri::command]
fn get_shutdown_status(state: State<'_, TimerState>) -> Result<Option<String>, String> {
    Ok(state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .info
        .as_ref()
        .map(|t| t.label.clone()))
}

// ------------------------------------------------------------- alert popup

/// v0.6.2: 独立、屏幕居中的提醒窗口（闹钟 / 定时任务提前提醒）。
/// 用独立静态页 `alert.html` 渲染，无 drag-region，按钮必然可点。
///
/// 🔴 v0.7.6 真根因修复（前两版改透明/尺寸/超时都没打中）：
/// 官方 `docs.rs/tauri::webview::WebviewWindowBuilder::build` 明确写着
/// "On Windows, this function deadlocks when used in a synchronous command
///  or event handlers ... You should use async commands and separate threads
///  when creating windows."。旧实现是【同步命令里直接 build()】，Windows
///  主线程自己等自己 → 死锁：弹窗根本没被创建，IPC 也不返回，界面永远不出现。
/// 项目里 `add_clock_window` / `ensure_settings_window` 早就用独立线程规避，
/// 唯独这里漏了。现在改成 async 命令 + std::thread::spawn 双保险，立即返回。
#[tauri::command]
async fn show_alert(app: AppHandle, payload: serde_json::Value) -> Result<(), String> {
    schedule_alert_autoclose(&app, &payload);
    if let Some(win) = app.get_webview_window("alert") {
        // Schedule before emit(): emit() takes payload by value.
        let _ = app.emit("alert-payload", payload);
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    let h = app.clone();
    std::thread::spawn(move || {
        // 无状态并发保护：建窗前再查一次。同一分钟多个闹钟同时命中时，
        // 后到线程若发现窗口已被前一个建好，就只更新内容，不抢建同名窗口。
        if let Some(existing) = h.get_webview_window("alert") {
            let _ = h.emit("alert-payload", payload.clone());
            let _ = existing.show();
            let _ = existing.set_focus();
            return;
        }
        let init = format!(
            "window.__DC_ALERT__={};",
            serde_json::to_string(&payload).unwrap_or_else(|_| "{}".into())
        );
        let built = tauri::WebviewWindowBuilder::new(
            &h,
            "alert",
            WebviewUrl::App(PathBuf::from("alert.html")),
        )
        .title("Desk Clock v0.7.6 · 提醒")
        // v0.7.6 二次修订：不再固定 260px（内容只占上半截，下方留一大块
        // 空白 = 主人截图里的「上下黑边」）。先给一个紧凑初值，前端量出
        // 真实内容高度后立刻通过 resize_alert 精确调整。
        .inner_size(360.0, 176.0)
        .resizable(false)
        .decorations(false)
        // v0.7.5: an opaque window is mandatory. A transparent WebView can fail
        // to paint, leaving an invisible always-on-top rectangle that swallows
        // every click. Never make this transparent.
        .transparent(false)
        .shadow(false)
        .visible(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .center()
        .initialization_script(init.as_str())
        .build();
        match built {
            Ok(win) => {
                let _ = win.show();
                let _ = win.set_focus();
            }
            Err(e) => {
                // 竞态：另一个线程刚抢先建好同名窗口 → 不是失败，更新内容即可。
                if let Some(existing) = h.get_webview_window("alert") {
                    let _ = h.emit("alert-payload", payload.clone());
                    let _ = existing.show();
                    let _ = existing.set_focus();
                    return;
                }
                eprintln!("Desk Clock: alert window build failed: {}", e);
                // 兜底：原生窗口真建不出来时，通知主窗口显示页内提醒层，
                // 保证用户至少能看到内容、能手动停止闹铃。
                let _ = h.emit("alert-build-failed", serde_json::json!({ "error": e.to_string() }));
            }
        }
    });
    Ok(())
}

/// Hard safety net: even if the frontend ring timer never fires (JS paused,
/// main window hidden, ...), the alert window must not stay on screen forever.
/// close() really closes it now because CloseRequested lets the "alert" label
/// through instead of hiding it.
fn schedule_alert_autoclose(app: &AppHandle, payload: &serde_json::Value) {
    let secs = payload
        .get("seconds")
        .and_then(|v| v.as_u64())
        .unwrap_or(30)
        .min(600)
        .max(5)
        + 10;
    let generation = ALERT_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let h = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(secs));
        // A newer alert reused this window: leave it open, its own timer wins.
        if ALERT_GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        if let Some(win) = h.get_webview_window("alert") {
            let _ = win.close();
        }
    });
}

#[tauri::command]
fn close_alert(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("alert") {
        let _ = win.close();
    }
    Ok(())
}

/// v0.7.6 二次修订：提醒窗按内容自适应高度。
/// 前端测量卡片真实高度后调用；Rust 侧 clamp 防止异常值把窗口撑爆或压没，
/// 并重新居中。窗口尺寸变化不会再触发「固定高度留白」。
#[tauri::command]
fn resize_alert(app: AppHandle, height: f64) -> Result<(), String> {
    if !height.is_finite() {
        return Err("invalid alert height".into());
    }
    let h = height.clamp(120.0, 420.0);
    if let Some(win) = app.get_webview_window("alert") {
        win.set_size(tauri::Size::Logical(tauri::LogicalSize::new(360.0, h)))
            .map_err(|e| e.to_string())?;
        let _ = win.center();
    }
    Ok(())
}

#[tauri::command]
fn alert_action(
    app: AppHandle,
    state: State<'_, TimerState>,
    action: String,
    kind: String,
) -> Result<(), String> {
    if action == "terminate" && kind == "timer" {
        // 取消失败时绝不广播 terminate（否则 UI 显示已终止但系统仍会关机）。
        if let Err(e) = cancel_timer_inner(&app, &state) {
            let _ = app.emit("timer-cancel-failed", serde_json::json!({ "error": e }));
            if let Some(win) = app.get_webview_window("alert") {
                let _ = win.close();
            }
            return Err(e);
        }
    }
    let _ = app.emit(
        "alert-action",
        serde_json::json!({ "action": action, "kind": kind }),
    );
    if let Some(win) = app.get_webview_window("alert") {
        let _ = win.close();
    }
    Ok(())
}

/// Restore a remembered position for ANY clock window.
/// v0.6.1: x/y live in clocks.json (per-window), legacy prefs.json is only a
/// migration fallback. Coordinates are PHYSICAL pixels.
fn restore_window_position(win: &WebviewWindow, app: &AppHandle, id: &str, legacy: &Prefs) {
    let mut all = read_clocks(app, legacy);
    let cfg = ensure_clock_cfg(&mut all, id);
    let _ = write_clocks(app, &all);
    let (x, y) = match (
        cfg.get("x").and_then(|v| v.as_f64()),
        cfg.get("y").and_then(|v| v.as_f64()),
    ) {
        (Some(a), Some(b)) => (a, b),
        _ => match (legacy.x, legacy.y) {
            (Some(a), Some(b)) => (a, b),
            _ => return,
        },
    };
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
        let _ = win.set_position(tauri::Position::Physical(
            tauri::PhysicalPosition::new(x as i32, y as i32),
        ));
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
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // NSIS 安装器通过单实例通道请求优雅退出，避免 RestartManager 的
            // WM_CLOSE 被「关窗隐藏到托盘」拦截后无法自动关闭运行中的工具。
            if args.iter().any(|a| a == "--dc-exit-for-install") {
                force_quit(app.clone());
                return;
            }
            let _ = show_main_now(app);
        }))
        // v0.7: autostart MUST be registered on the Builder chain (official API).
        // Its setup hook creates the AutoLaunchManager state; registering it lazily
        // inside .setup() via `let _ = handle.plugin(...)` silently dropped init
        // errors and left the state missing, so app.autolaunch() could not work —
        // the classic "checkbox looks on, but Windows never starts the app" symptom.
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--startup"]),
        ))
        .setup(|app| {
            let handle = app.handle();
            let prefs = read_prefs(handle);
            app.manage(PrefsState(Mutex::new(prefs.clone())));
            app.manage(TimerState(Mutex::new(TimerSnapshot::default())));
            // v0.7.5: 重装 / 换安装路径 / 用户手动删掉启动项后自愈。
            // prefs.autostart 记录的是用户在应用里的意图；系统里被关掉时
            // 重新注册一次。用户在应用里主动关闭时 prefs 会写成 false，
            // 因此不会违背用户意图强行打开。
            if prefs.autostart {
                let mgr = handle.autolaunch();
                if !mgr.is_enabled().unwrap_or(false) {
                    if let Err(e) = mgr.enable() {
                        eprintln!("Desk Clock: autostart re-enable failed: {}", e);
                    }
                }
                // v0.7.6: even when the entry EXISTS it may be broken (unquoted
                // path / stale install location). Always rewrite + verify it on
                // startup so a reboot actually launches this executable.
                if let Err(e) = repair_windows_run_value() {
                    eprintln!("Desk Clock: autostart Run value repair failed: {}", e);
                }
            }

            {
                let mut all = read_clocks(handle, &prefs);
                let main_cfg = ensure_clock_cfg(&mut all, "main");
                let _ = write_clocks(handle, &all);
                let on_top = main_cfg
                    .get("alwaysOnTop").and_then(|v| v.as_bool())
                    .unwrap_or(prefs.always_on_top);
                let click_through = main_cfg
                    .get("clickThrough").and_then(|v| v.as_bool())
                    .unwrap_or(prefs.click_through);
                let scale = main_cfg
                    .get("scale").and_then(|v| v.as_f64())
                    .unwrap_or(prefs.scale);
                // v0.6.2：启动时优先用持久化的内容尺寸，避免贴边不对称；
                // 前端 boot 后还会再测量一次并校正。
                let mw = main_cfg.get("w").and_then(|v| v.as_f64()).filter(|v| *v > 0.0);
                let mh = main_cfg.get("h").and_then(|v| v.as_f64()).filter(|v| *v > 0.0);
                if let Some(win) = app.get_webview_window("main") {
                    let (w, h) = match (mw, mh) {
                        (Some(w), Some(h)) => (w, h),
                        _ => (640.0 * scale, 220.0 * scale),
                    };
                    let _ = win.set_size(tauri::Size::Logical(tauri::LogicalSize::new(w, h)));
                    let _ = win.set_always_on_top(on_top);
                    if click_through {
                        let _ = win.set_ignore_cursor_events(true);
                    }
                    restore_window_position(&win, handle, "main", &prefs);
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
        // Exceptions: an explicit quit, and the alert popup — the latter MUST
        // really close, otherwise it stays as an invisible click-swallowing
        // rectangle in the screen centre until the process is restarted.
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if QUITTING.load(Ordering::SeqCst) || window.label() == "alert" {
                        return;
                    }
                    api.prevent_close();
                    let _ = window.hide();
                    // Tauri hide() 不触发 document.hidden；定向通知该窗口停表。
                    let label = window.label().to_string();
                    let _ = window
                        .app_handle()
                        .emit_to(label.as_str(), "clock-visibility", false);
                }
                tauri::WindowEvent::Focused(true) => {
                    let label = window.label().to_string();
                    let _ = window
                        .app_handle()
                        .emit_to(label.as_str(), "clock-visibility", true);
                }
                _ => {}
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
                        let _ = ensure_settings_window(&h, None);
                    });
                }
                "toggle_settings" => {
                    toggle_settings_window(app);
                }
                "unclick" => {
                    for (label, win) in app.webview_windows() {
                        if label == "main" || label.starts_with("clock-") {
                            let _ = win.set_ignore_cursor_events(false);
                        }
                    }
                    let legacy = app
                        .try_state::<PrefsState>()
                        .and_then(|s| s.0.lock().ok().map(|g| g.clone()))
                        .unwrap_or_default();
                    let mut all = read_clocks(app, &legacy);
                    if let Some(clocks) = all.get_mut("clocks").and_then(|c| c.as_object_mut()) {
                        for (_id, cfg) in clocks.iter_mut() {
                            if let Some(o) = cfg.as_object_mut() {
                                o.insert("clickThrough".into(), serde_json::json!(false));
                            }
                        }
                    }
                    let _ = write_clocks(app, &all);
                    patch_prefs(app, "clickThrough", serde_json::json!(false));
                }
                "update" => {
                    let _ = open_link("releases".into());
                }
                "donate" => {
                    DONATE_INTENT.store(true, Ordering::SeqCst);
                    let h = app.clone();
                    std::thread::spawn(move || {
                        let _ = ensure_settings_window(&h, None);
                        let _ = h.emit("show-donate", ());
                    });
                }
                "quit" => force_quit(app.clone()),
                _ => {}
            }
        })
        .on_tray_icon_event(|app, event| {
            match tray_event_kind(event) {
                2 => toggle_settings_window(app),
                1 => {
                    if second_click_within(400) {
                        toggle_settings_window(app);
                    } else {
                        let _ = show_main_now(app);
                    }
                }
                _ => {}
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
            get_autostart_diagnostics,
            repair_autostart,
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
            get_window_configs,
            set_active_clock,
            get_window_prefs,
            set_window_prefs,
            set_window_geometry,
            preset_position_for,
            open_link,
            open_update_installer,
            auto_update,
            sync_system_time,
            schedule_timer,
            cancel_timer,
            get_timer_status,
            schedule_shutdown,
            cancel_shutdown,
            get_shutdown_status,
            show_alert,
            close_alert,
            resize_alert,
            alert_action
        ])
        .run(tauri::generate_context!())
        .expect("error while running Desk Clock");
}
