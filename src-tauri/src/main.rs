// Tauri shell: window, file access, settings and ROM discovery. A port of
// src/main/main.ts (the Electron shell) with the same behaviour; the renderer
// reaches these commands through src/renderer/tauriHost.ts.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

// ---------------------------------------------------------------- command line
/// Launch options. VICE's spellings are accepted so tools that drive x64sc
/// (e.g. C64 Dev Machine) can pass the same arguments.
#[derive(Serialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
struct LaunchArgs {
    #[serde(skip_serializing_if = "Option::is_none")]
    file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reu: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reu_image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sid2: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    warp: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    attach_only: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rom_dirs: Option<Vec<String>>,
}

fn num(s: Option<&String>) -> Option<i64> {
    let s = s?.as_str();
    let l = s.to_lowercase();
    if let Some(h) = l.strip_prefix("0x").or_else(|| l.strip_prefix('$')) {
        let h: String = h.chars().take_while(|c| c.is_ascii_hexdigit()).collect();
        i64::from_str_radix(&h, 16).ok()
    } else {
        let d: String = s.trim_start().chars().enumerate()
            .take_while(|(i, c)| c.is_ascii_digit() || (*i == 0 && (*c == '-' || *c == '+')))
            .map(|(_, c)| c).collect();
        d.parse().ok()
    }
}

fn parse_args(argv: &[String]) -> LaunchArgs {
    let media = RegexBuilder::new(r"\.(prg|p00|d64|g64|t64|tap|crt|sid|bin|c64s)$").case_insensitive(true).build().unwrap();
    let digits = Regex::new(r"^\d+$").unwrap();
    let mut a = LaunchArgs::default();
    let mut i = 0;
    while i < argv.len() {
        let t = &argv[i];
        if !t.starts_with('-') {
            if media.is_match(t) && Path::new(t).exists() { a.file = Some(t.clone()); }
            i += 1;
            continue;
        }
        let k = t.strip_prefix("--").or_else(|| t.strip_prefix('-')).unwrap_or(t).to_lowercase();
        let next = argv.get(i + 1);
        match k.as_str() {
            "autostart" => if let Some(n) = next { a.file = Some(n.clone()); i += 1; },
            "attach" => if let Some(n) = next { a.file = Some(n.clone()); a.attach_only = Some(true); i += 1; },
            "reu" => {
                if a.reu.is_none() { a.reu = Some(512); }
                if let Some(n) = next { if digits.is_match(n) { a.reu = num(Some(n)); i += 1; } }
            }
            "reusize" => { a.reu = num(next); i += 1; }
            "reuimage" | "reu-image" => { a.reu_image = next.cloned(); i += 1; if a.reu.is_none() { a.reu = Some(16384); } }
            "sid2" | "sid2address" => { a.sid2 = num(next); i += 1; }
            "warp" => a.warp = Some(true),
            // VICE's ROM search path (';' on Windows, ':' elsewhere). The Dev Machine
            // passes its bundled vice folder here on macOS.
            "directory" | "romdir" => {
                let sep = if cfg!(windows) { ';' } else { ':' };
                a.rom_dirs = Some(next.map(|n| n.split(sep).filter(|s| !s.is_empty()).map(String::from).collect()).unwrap_or_default());
                i += 1;
            }
            _ => {} // unknown VICE options (e.g. -sidextra 1) are ignored
        }
        i += 1;
    }
    a
}

#[derive(Default)]
struct Shell {
    /// macOS hands files opened from Finder or `open -a C64EMUL8R x.prg` over as
    /// open-file events instead of argv; one that arrives before the page asks for
    /// its arguments waits here.
    opened_file: Mutex<Option<String>>,
    page_ready: Mutex<bool>,
}

fn cli_args(app: &AppHandle) -> LaunchArgs {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let mut a = parse_args(&argv);
    if a.file.is_none() { a.file = app.state::<Shell>().opened_file.lock().unwrap().clone(); }
    a
}

// ---------------------------------------------------------------- paths
/// Electron's userData folder, so settings and install-path.txt stay where they were:
/// %APPDATA%\c64emul8r, ~/Library/Application Support/c64emul8r, ~/.config/c64emul8r.
fn user_data(app: &AppHandle) -> PathBuf {
    app.path().config_dir().unwrap_or_else(|_| PathBuf::from(".")).join("c64emul8r")
}

fn home(app: &AppHandle) -> PathBuf {
    app.path().home_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// Node's path.join output style: native separators throughout.
fn show(p: &Path) -> String {
    let s = p.to_string_lossy().to_string();
    if cfg!(windows) { s.replace('/', "\\") } else { s }
}

fn is_packaged() -> bool { !cfg!(debug_assertions) }

// ---------------------------------------------------------------- ROMs
fn rom_patterns() -> Vec<(&'static str, Regex, &'static [u64])> {
    let re = |s: &str| RegexBuilder::new(s).case_insensitive(true).build().unwrap();
    vec![
        ("basic", re(r"^(basic|basic[-_. ].*|.*901226-01.*)(\.bin|\.rom)?$"), &[8192]),
        ("kernal", re(r"^(kernal|kernal[-_. ].*|.*901227-0[1-3].*)(\.bin|\.rom)?$"), &[8192]),
        ("chargen", re(r"^(chargen|char|characters|chargen[-_. ].*|.*901225-01.*)(\.bin|\.rom)?$"), &[4096]),
        ("dos1541", re(r"^(dos1541|d1541ii|1541|dos1541[-_. ].*|.*325302-01.*|.*901229-0[3-6].*)(\.bin|\.rom)?$"), &[16384, 32768]),
    ]
}

fn read_names(d: &Path) -> Vec<String> {
    match fs::read_dir(d) {
        Ok(rd) => rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string()).collect(),
        Err(_) => vec![],
    }
}

/// Where a macOS app bundle keeps ROMs: VICE under share/vice, C64 Dev Machine
/// under vice (its Included Files), older VICE builds under ROM.
fn bundle_rom_dirs(bundle: &Path) -> Vec<PathBuf> {
    ["share/vice", "vice", "ROM", ""].iter().map(|d| bundle.join("Contents").join("Resources").join(d)).collect()
}

fn vice_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut out = vec![];
    let home = home(app);
    let mac = cfg!(target_os = "macos");
    // Bundled with C64 Dev Machine (Windows): <dm>/c64emul8r/C64EMUL8R.exe next to <dm>/vice/win
    if is_packaged() && cfg!(windows) {
        if let Some(dm) = std::env::current_exe().ok().and_then(|e| e.parent()?.parent().map(Path::to_path_buf)) {
            out.push(dm.join("vice").join("win"));
            out.push(dm.join("vice"));
        }
    }
    let roots: Vec<PathBuf> = if mac {
        vec!["/Applications".into(), home.join("Applications"), home.join("Desktop"), home.join("Downloads")]
    } else if cfg!(windows) {
        vec!["C:/Program Files".into(), "C:/Program Files (x86)".into(), home.join("Desktop"), home.join("Downloads"), "C:/".into()]
    } else {
        vec!["/usr/share".into(), "/usr/local/share".into(), "/usr/lib".into(), "/usr/local/lib".into(), home.join("Desktop"), home.join("Downloads")]
    };
    let name = RegexBuilder::new("vice|c64|commodore").case_insensitive(true).build().unwrap();
    let vice = RegexBuilder::new("vice").case_insensitive(true).build().unwrap();
    let app_re = RegexBuilder::new(r"\.app$").case_insensitive(true).build().unwrap();
    let add = |out: &mut Vec<PathBuf>, d: PathBuf| {
        if mac && app_re.is_match(&d.to_string_lossy()) { out.extend(bundle_rom_dirs(&d)); } else { let v = d.join("vice"); out.push(d); out.push(v); }
    };
    for root in roots {
        if fs::read_dir(&root).is_err() { continue; }
        for e in read_names(&root) {
            if !name.is_match(&e) { continue; }
            let d = root.join(&e);
            add(&mut out, d.clone());
            // VICE's macOS download is a folder of apps (x64sc.app, vsid.app, ...)
            for sub in read_names(&d) {
                if vice.is_match(&sub) || (mac && app_re.is_match(&sub)) { add(&mut out, d.join(sub)); }
            }
        }
    }
    out
}

fn find_roms_in(dir: &Path, pats: &[(&'static str, Regex, &'static [u64])]) -> BTreeMap<String, String> {
    let mut found = BTreeMap::new();
    for d in [dir.to_path_buf(), dir.join("C64"), dir.join("DRIVES"), dir.join("roms"), dir.join("ROM")] {
        for name in read_names(&d) {
            for (kind, re, sizes) in pats {
                if found.contains_key(*kind) || !re.is_match(&name) { continue; }
                let p = d.join(&name);
                if let Ok(m) = fs::metadata(&p) { if sizes.contains(&m.len()) { found.insert(kind.to_string(), show(&p)); } }
            }
        }
    }
    found
}

/// ROM paths only; the renderer reads the data with read_file.
#[tauri::command]
fn roms_find(app: AppHandle, preferred: Option<String>) -> BTreeMap<String, String> {
    let mut dirs: Vec<PathBuf> = vec![];
    if let Some(p) = preferred.filter(|p| !p.is_empty()) { dirs.push(p.into()); }
    for d in cli_args(&app).rom_dirs.unwrap_or_default() { if !d.is_empty() { dirs.push(d.into()); } }
    dirs.push(user_data(&app).join("roms"));
    dirs.extend(vice_dirs(&app));
    let pats = rom_patterns();
    let mut result = BTreeMap::new();
    for d in dirs {
        if !d.exists() { continue; }
        for (k, v) in find_roms_in(&d, &pats) { result.entry(k).or_insert(v); }
        if ["basic", "kernal", "chargen", "dos1541"].iter().all(|k| result.contains_key(*k)) { break; }
    }
    result
}

#[derive(Serialize)]
struct Palette { name: String, text: String }

#[tauri::command]
fn roms_palettes(rom_path: Option<String>) -> Vec<Palette> {
    let mut out = vec![];
    let Some(rp) = rom_path.filter(|p| !p.is_empty()) else { return out };
    let Some(d) = Path::new(&rp).parent() else { return out };
    for f in read_names(d) {
        if !f.to_lowercase().ends_with(".vpl") { continue; }
        if let Ok(text) = fs::read_to_string(d.join(&f)) {
            out.push(Palette { name: f.strip_suffix(".vpl").unwrap_or(&f).to_string(), text });
        }
    }
    out
}

// ---------------------------------------------------------------- files
#[derive(Deserialize)]
struct Filter { name: String, extensions: Vec<String> }

fn media_filters() -> Vec<Filter> {
    vec![
        Filter { name: "C64 media".into(), extensions: ["prg", "p00", "d64", "g64", "tap", "t64", "crt", "sid", "bin", "c64s"].iter().map(|s| s.to_string()).collect() },
        Filter { name: "All files".into(), extensions: vec!["*".into()] },
    ]
}

fn dialog_for(app: &AppHandle, filters: Vec<Filter>, default_path: Option<String>) -> tauri_plugin_dialog::FileDialogBuilder<tauri::Wry> {
    let mut d = app.dialog().file();
    if let Some(w) = app.get_webview_window("main") { d = d.set_parent(&w); }
    for f in &filters {
        let ext: Vec<&str> = f.extensions.iter().map(String::as_str).collect();
        d = d.add_filter(&f.name, &ext);
    }
    if let Some(p) = default_path.filter(|p| !p.is_empty()) {
        let p = PathBuf::from(p);
        if p.is_dir() { d = d.set_directory(&p); } else {
            if let Some(parent) = p.parent().filter(|q| !q.as_os_str().is_empty()) { d = d.set_directory(parent); }
            if let Some(n) = p.file_name() { d = d.set_file_name(n.to_string_lossy()); }
        }
    }
    d
}

#[derive(Serialize)]
struct Picked { path: String, name: String }

#[tauri::command]
async fn open_file(app: AppHandle, filters: Option<Vec<Filter>>, default_path: Option<String>) -> Option<Picked> {
    let p = dialog_for(&app, filters.unwrap_or_else(media_filters), default_path).blocking_pick_file()?.into_path().ok()?;
    Some(Picked { name: p.file_name()?.to_string_lossy().to_string(), path: show(&p) })
}

#[tauri::command]
async fn save_file(app: AppHandle, default_name: String, filters: Option<Vec<Filter>>) -> Option<String> {
    let p = dialog_for(&app, filters.unwrap_or_default(), Some(default_name)).blocking_save_file()?.into_path().ok()?;
    Some(show(&p))
}

#[tauri::command]
async fn choose_dir(app: AppHandle, default_path: Option<String>) -> Option<String> {
    let mut d = app.dialog().file();
    if let Some(w) = app.get_webview_window("main") { d = d.set_parent(&w); }
    if let Some(p) = default_path.filter(|p| !p.is_empty()) { d = d.set_directory(p); }
    Some(show(&d.blocking_pick_folder()?.into_path().ok()?))
}

#[tauri::command]
async fn read_file(path: String) -> Result<Response, String> {
    fs::read(&path).map(Response::new).map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_text(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Raw body = the file data, header x-path = the URI-encoded destination.
#[tauri::command]
async fn write_file(request: Request<'_>) -> Result<(), String> {
    let path = request.headers().get("x-path").and_then(|v| v.to_str().ok()).ok_or("missing x-path")?;
    let path = percent_decode(path);
    let InvokeBody::Raw(data) = request.body() else { return Err("expected raw data".into()) };
    fs::write(&path, data).map_err(|e| e.to_string())
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) { out.push(v); i += 3; continue; }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DirEntry { name: String, is_dir: bool, size: u64 }

#[tauri::command]
async fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let mut out = vec![];
    for e in fs::read_dir(&path).map_err(|e| e.to_string())?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') { continue; }
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let size = if is_dir { 0 } else { e.metadata().map(|m| m.len()).unwrap_or(0) };
        out.push(DirEntry { name, is_dir, size });
    }
    Ok(out)
}

#[tauri::command]
fn join_path(parts: Vec<String>) -> String {
    let mut p = PathBuf::new();
    for s in parts { p.push(s); }
    show(&p)
}

#[tauri::command]
fn dirname(p: String) -> String {
    match Path::new(&p).parent() {
        Some(d) if !d.as_os_str().is_empty() => show(d),
        _ => ".".into(),
    }
}

#[tauri::command]
fn home_dir(app: AppHandle) -> String { show(&home(&app)) }

#[tauri::command]
fn app_args(app: AppHandle) -> LaunchArgs {
    *app.state::<Shell>().page_ready.lock().unwrap() = true;
    cli_args(&app)
}

// ---------------------------------------------------------------- settings
#[tauri::command]
fn settings_load(app: AppHandle) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(user_data(&app).join("settings.json")).ok()?).ok()
}

#[tauri::command]
fn settings_save(app: AppHandle, s: Value) -> Result<(), String> {
    let dir = user_data(&app);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join("settings.json"), serde_json::to_string_pretty(&s).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

#[tauri::command]
fn toggle_fullscreen(window: WebviewWindow) {
    let on = window.is_fullscreen().unwrap_or(false);
    let _ = window.set_fullscreen(!on);
}

#[tauri::command]
fn set_title(window: WebviewWindow, t: String) { let _ = window.set_title(&t); }

#[tauri::command]
fn toggle_devtools(window: WebviewWindow) {
    if window.is_devtools_open() { window.close_devtools(); } else { window.open_devtools(); }
}

// ---------------------------------------------------------------- capture hook
/// Developer aid: C64EMUL8R_CAPTURE="out.png|delayMs|js;;js" runs the JS steps,
/// saves the C64 screen canvas as a PNG and quits (see tauriHost.ts).
#[derive(Serialize)]
struct Capture { out: String, delay: u64, js: String }

#[tauri::command]
fn capture_config() -> Option<Capture> {
    let cap = std::env::var("C64EMUL8R_CAPTURE").ok().filter(|s| !s.is_empty())?;
    let mut it = cap.splitn(3, '|');
    let out = it.next().unwrap_or_default().to_string();
    let delay = it.next().and_then(|d| d.parse().ok()).unwrap_or(3000);
    Some(Capture { out, delay, js: it.next().unwrap_or_default().to_string() })
}

#[tauri::command]
fn capture_log(msg: String) { println!("{msg}"); }

/// Runs a capture step as a native script, outside the page's CSP.
#[tauri::command]
fn capture_eval(window: WebviewWindow, code: String) -> Result<(), String> {
    window.eval(&code).map_err(|e| e.to_string())
}

#[tauri::command]
fn capture_quit(app: AppHandle) { app.exit(0); }

// ---------------------------------------------------------------- startup
fn send_launch(app: &AppHandle, a: LaunchArgs) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.emit("launch-args", a);
    }
}

fn main() {
    let capture = std::env::var("C64EMUL8R_CAPTURE").map(|s| !s.is_empty()).unwrap_or(false);
    let mut builder = tauri::Builder::default();
    // One window: launching again (e.g. after every build) hands the file to the
    // running emulator instead of starting a second copy.
    if !capture {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            send_launch(app, parse_args(argv.get(1..).unwrap_or(&[])));
        }));
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .manage(Shell::default())
        .setup(|app| {
            // Let other tools (C64 Dev Machine) find the installed executable.
            if is_packaged() {
                if let Ok(exe) = std::env::current_exe() {
                    let dir = user_data(app.handle());
                    let _ = fs::create_dir_all(&dir);
                    let _ = fs::write(dir.join("install-path.txt"), exe.to_string_lossy().as_bytes());
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            roms_find, roms_palettes, open_file, save_file, choose_dir, read_file, read_text, write_file,
            list_dir, join_path, dirname, home_dir, app_args, settings_load, settings_save,
            toggle_fullscreen, set_title, toggle_devtools, capture_config, capture_log, capture_eval, capture_quit
        ])
        .build(tauri::generate_context!())
        .expect("error while building C64EMUL8R")
        .run(|_app, _event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = &_event {
                for u in urls {
                    let Ok(p) = u.to_file_path() else { continue };
                    let path = p.to_string_lossy().to_string();
                    let shell = _app.state::<Shell>();
                    if *shell.page_ready.lock().unwrap() {
                        send_launch(_app, LaunchArgs { file: Some(path), ..Default::default() });
                    } else {
                        *shell.opened_file.lock().unwrap() = Some(path);
                    }
                }
            }
        });
}
