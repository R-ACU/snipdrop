use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    io::BufWriter,
    path::PathBuf,
    sync::{mpsc, Mutex, OnceLock},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Listener, Manager,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Shot {
    id: String,
    path: String,
    file_name: String,
    data_url: String,
    width: i32,
    height: i32,
    created_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShotMeta {
    id: String,
    path: String,
    file_name: String,
    width: i32,
    height: i32,
    created_at: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct HotkeyStatus {
    ok: bool,
    message: String,
}

// Modifier-Bitmaske für den konfigurierbaren Hotkey.
const MOD_CTRL: u8 = 1;
const MOD_SHIFT: u8 = 2;
const MOD_ALT: u8 = 4;
const MOD_WIN: u8 = 8;

// Vom Keyboard-Hook live gelesen: Haupt-Taste (VK-Code) + benötigte Modifier.
// Default: Win + Shift + S (VK_S = 0x53).
static HOTKEY_VK: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0x53);
static HOTKEY_MODS: std::sync::atomic::AtomicU8 =
    std::sync::atomic::AtomicU8::new(MOD_WIN | MOD_SHIFT);
// Farbe der gestrichelten Auswahl-Umrandung als COLORREF (0x00BBGGRR). Wird vom
// Paint-Handler des nativen Overlays gelesen und aus den Settings gesetzt. Default weiss.
static SELECTION_COLOR: std::sync::atomic::AtomicU32 =
    std::sync::atomic::AtomicU32::new(0x00ff_ffff);
// Vom Nutzer gewaehlter Screenshot-Speicherordner. Leer = Default (Pictures\SnipDrop).
// Wird beim Start aus den Settings gesetzt und von output_directory() gelesen, damit
// die freie Funktion ohne State-Zugriff den konfigurierten Pfad kennt.
static SCREENSHOT_DIR: Mutex<String> = Mutex::new(String::new());

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HotkeyConfig {
    mods: u8,
    vk: u32,
    label: String,
}

impl Default for HotkeyConfig {
    fn default() -> Self {
        HotkeyConfig {
            mods: MOD_WIN | MOD_SHIFT,
            vk: 0x53,
            label: "Win + Shift + S".to_string(),
        }
    }
}

// App-Einstellungen (getrennt von hotkey.json persistiert, damit bestehende
// Hotkey-Configs nicht migriert werden müssen).
// thumbnail_dismiss: wie das Eck-Thumbnail verschwindet —
//   "timeout" = nach 3 s, "paste" = beim Einfügen (Ctrl+V), "never" = gar nicht.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    thumbnail_dismiss: String,
    // Farbe der gestrichelten Auswahl-Umrandung beim Snip, als "#rrggbb".
    // serde-default, damit aeltere settings.json (ohne Feld) weiter laden.
    #[serde(default = "default_selection_color")]
    selection_color: String,
    // SSH-Ziel fuer "Per SSH senden": SSH-Alias aus ~/.ssh/config ODER "user@host".
    // Leer = nicht konfiguriert. serde-default fuer aeltere settings.json.
    #[serde(default)]
    ssh_host: String,
    // Remote-Verzeichnis, in das der Screenshot hochgeladen wird (POSIX-Pfad).
    #[serde(default = "default_ssh_remote_dir")]
    ssh_remote_dir: String,
    // Optionaler Pfad zum privaten SSH-Key (scp/ssh -i). Leer = ssh waehlt selbst
    // (Default-Keys / ssh-agent / ~/.ssh/config). Fuer Keys mit Nicht-Standard-Namen.
    #[serde(default)]
    ssh_identity_file: String,
    // Auto-Modus: ist er an, wird jeder neue Snip automatisch per scp hochgeladen
    // und der Remote-Pfad statt des lokalen Pfads in die Zwischenablage gelegt.
    // So liefert Ctrl+V im SSH-Terminal direkt den Remote-Pfad, ohne Sende-Button.
    #[serde(default)]
    ssh_auto: bool,
    // Optionale Aufbewahrung: Remote-Screenshots, die aelter als so viele Tage sind,
    // werden beim Oeffnen der SSH-Galerie geloescht. 0 = aus (kein Auto-Loeschen).
    #[serde(default)]
    ssh_retention_days: u32,
    // UI-Farbschema des Hauptfensters: "light" oder "dark".
    // serde-default, damit aeltere settings.json (ohne Feld) weiter laden.
    #[serde(default = "default_theme")]
    theme: String,
    // Vom Nutzer gewaehlter Screenshot-Speicherordner (absoluter Pfad).
    // Leer = Default (%USERPROFILE%\Pictures\SnipDrop). serde-default fuer aeltere
    // settings.json. Siehe output_directory() und SCREENSHOT_DIR.
    #[serde(default)]
    screenshot_dir: String,
    // Lifetime-Zaehler aller je erstellten Snips (backend-owned). Unabhaengig von
    // geloeschten Dateien — Quelle der Wahrheit fuer die Support-Popup-Meilensteine.
    #[serde(default)]
    capture_count: u32,
    // Hoechster Meilenstein, fuer den das Support-Popup bereits gezeigt wurde.
    // Verhindert, dass derselbe Meilenstein zweimal nervt. Vom Frontend gesetzt.
    #[serde(default)]
    support_milestone_shown: u32,
    // Hat der Nutzer das First-Run-Onboarding (Welcome-Fenster) abgeschlossen?
    // false = beim Start wird das Welcome-Fenster gezeigt. serde-default, damit
    // bestehende settings.json (vor dem Onboarding) das Fenster genau einmal sehen.
    #[serde(default)]
    onboarded: bool,
}

fn default_selection_color() -> String {
    "#ffffff".to_string()
}

fn default_theme() -> String {
    "light".to_string()
}

fn default_ssh_remote_dir() -> String {
    "/tmp".to_string()
}

impl Default for AppSettings {
    fn default() -> Self {
        // "paste" bildet das bisherige Verhalten ab (Ausblenden beim Einfügen).
        AppSettings {
            thumbnail_dismiss: "paste".to_string(),
            selection_color: default_selection_color(),
            ssh_host: String::new(),
            ssh_remote_dir: default_ssh_remote_dir(),
            ssh_identity_file: String::new(),
            ssh_auto: false,
            ssh_retention_days: 0,
            theme: default_theme(),
            screenshot_dir: String::new(),
            capture_count: 0,
            support_milestone_shown: 0,
            onboarded: false,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct VirtualDesktop {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

struct AppState {
    latest_shot: Mutex<Option<Shot>>,
    hotkey_status: Mutex<HotkeyStatus>,
    last_image_hash: Mutex<Option<u64>>,
    hotkey: Mutex<HotkeyConfig>,
    settings: Mutex<AppSettings>,
}

#[derive(Debug, Clone)]
struct CapturedImage {
    width: i32,
    height: i32,
    rgba: Vec<u8>,
    bgra: Vec<u8>,
}

#[derive(Debug, Clone, Copy)]
struct Selection {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

#[tauri::command]
fn latest_shot(state: tauri::State<AppState>) -> Result<Option<Shot>, String> {
    state
        .latest_shot
        .lock()
        .map(|shot| shot.clone())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn hotkey_status(state: tauri::State<AppState>) -> Result<HotkeyStatus, String> {
    state
        .hotkey_status
        .lock()
        .map(|status| status.clone())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_hotkey(state: tauri::State<AppState>) -> Result<HotkeyConfig, String> {
    state
        .hotkey
        .lock()
        .map(|hotkey| hotkey.clone())
        .map_err(|error| error.to_string())
}

// Setzt die vom Hook gelesenen Statics. Der Hotkey ist fest auf Win + Shift + S —
// es gibt bewusst keinen set_hotkey-Command mehr (eigene Kombis wie Alt+F
// kollidierten mit Windows-Hotkeys und dem WebView2-Fokus).
fn apply_hotkey(config: &HotkeyConfig) {
    HOTKEY_VK.store(config.vk, std::sync::atomic::Ordering::Relaxed);
    HOTKEY_MODS.store(config.mods, std::sync::atomic::Ordering::Relaxed);
}

fn hotkey_config_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("hotkey.json"))
}

#[tauri::command]
fn get_settings(state: tauri::State<AppState>) -> Result<AppSettings, String> {
    state
        .settings
        .lock()
        .map(|settings| settings.clone())
        .map_err(|error| error.to_string())
}

// Einstellungen setzen: Thumbnail-Ausblendeverhalten und/oder Auswahl-Farbe.
// Beide Felder sind optional — nur uebergebene Werte werden geaendert, der Rest
// bleibt wie er ist. Werte werden validiert, in den State geschrieben, persistiert.
#[tauri::command]
fn set_settings(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    thumbnail_dismiss: Option<String>,
    selection_color: Option<String>,
    ssh_host: Option<String>,
    ssh_remote_dir: Option<String>,
    ssh_identity_file: Option<String>,
    ssh_auto: Option<bool>,
    ssh_retention_days: Option<u32>,
    theme: Option<String>,
    screenshot_dir: Option<String>,
    support_milestone_shown: Option<u32>,
) -> Result<(), String> {
    let mut settings = state
        .settings
        .lock()
        .map_err(|error| error.to_string())?
        .clone();

    if let Some(dismiss) = thumbnail_dismiss {
        if !matches!(dismiss.as_str(), "timeout" | "paste" | "never") {
            return Err(format!("Invalid thumbnail mode: {dismiss}"));
        }
        settings.thumbnail_dismiss = dismiss;
    }

    if let Some(color) = selection_color {
        let parsed = parse_hex_color(&color).ok_or_else(|| format!("Invalid color: {color}"))?;
        SELECTION_COLOR.store(parsed, std::sync::atomic::Ordering::Relaxed);
        settings.selection_color = color;
    }

    if let Some(host) = ssh_host {
        let host = host.trim().to_string();
        // Whitespace im Host-String wuerde als zusaetzliche scp/ssh-Argumente
        // interpretiert — nicht zulassen. Leer ist erlaubt (= deaktiviert).
        if host.chars().any(char::is_whitespace) {
            return Err("SSH host must not contain spaces.".to_string());
        }
        settings.ssh_host = host;
    }

    if let Some(dir) = ssh_remote_dir {
        let dir = dir.trim().to_string();
        if dir.is_empty() {
            return Err("Remote directory must not be empty.".to_string());
        }
        settings.ssh_remote_dir = dir;
    }

    if let Some(identity) = ssh_identity_file {
        // Leer = kein expliziter Key (ssh waehlt selbst). Sonst: Datei muss existieren.
        let identity = identity.trim().to_string();
        if !identity.is_empty() && !std::path::Path::new(&identity).is_file() {
            return Err(format!("Key file not found: {identity}"));
        }
        settings.ssh_identity_file = identity;
    }

    if let Some(auto) = ssh_auto {
        settings.ssh_auto = auto;
    }

    if let Some(days) = ssh_retention_days {
        settings.ssh_retention_days = days;
    }

    if let Some(theme) = theme {
        if !matches!(theme.as_str(), "light" | "dark") {
            return Err(format!("Invalid theme: {theme}"));
        }
        settings.theme = theme;
    }

    if let Some(dir) = screenshot_dir {
        let dir = dir.trim().to_string();
        if dir.is_empty() {
            // Leer = zurueck auf Default (Pictures\SnipDrop).
            settings.screenshot_dir = String::new();
            if let Ok(mut current) = SCREENSHOT_DIR.lock() {
                current.clear();
            }
        } else {
            // Ordner muss existieren oder anlegbar sein, sonst landen Screenshots
            // ins Leere. Gleich anlegen, damit der erste Snip nicht scheitert.
            fs::create_dir_all(&dir)
                .map_err(|error| format!("Folder not usable: {dir} ({error})"))?;
            if !std::path::Path::new(&dir).is_dir() {
                return Err(format!("Not a folder: {dir}"));
            }
            if let Ok(mut current) = SCREENSHOT_DIR.lock() {
                *current = dir.clone();
            }
            // Ordner fuer das asset:-Protokoll freigeben, sonst koennen Thumbnail,
            // Galerie und Editor Bilder ausserhalb von Pictures nicht anzeigen
            // (Scope in tauri.conf.json ist nur $PICTURE/SnipDrop/**).
            let _ = app.asset_protocol_scope().allow_directory(&dir, true);
            settings.screenshot_dir = dir;
        }
    }

    if let Some(milestone) = support_milestone_shown {
        settings.support_milestone_shown = milestone;
    }

    {
        let mut current = state.settings.lock().map_err(|error| error.to_string())?;
        *current = settings.clone();
    }
    save_settings(&app, &settings);
    Ok(())
}

// Supporter-Seite (kostenlos + freiwilliger Beitrag, siehe Launch-Site).
// Konstante statt Parameter -> keine Shell-Injection moeglich; spaeter 1x aendern.
const SUPPORT_URL: &str = "https://snipdrop.app/support";

// Oeffnet die Supporter-Seite im Standard-Browser. rundll32 ruft den
// FileProtocolHandler ohne Shell-Parsing auf (sauberer als "cmd /C start").
#[tauri::command]
fn open_support_link() -> Result<(), String> {
    #[cfg(windows)]
    {
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", SUPPORT_URL])
            .spawn()
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

// First-Run-Onboarding abgeschlossen: Flag persistieren, damit das Welcome-Fenster
// kuenftig nicht mehr automatisch erscheint. Vom "Los geht's"-Button aufgerufen.
#[tauri::command]
fn complete_onboarding(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let to_save = {
        let mut settings = state.settings.lock().map_err(|error| error.to_string())?;
        settings.onboarded = true;
        settings.clone()
    };
    save_settings(&app, &to_save);
    // Welcome-Fenster schliessen und den Nutzer ins Hauptfenster fuehren.
    if let Some(welcome) = app.get_webview_window("welcome") {
        let _ = welcome.close();
    }
    show_main_window(&app);
    Ok(())
}

// Autostart-Status fuer das Onboarding/Settings abfragen (Windows-Run-Key via Plugin).
#[tauri::command]
fn get_autostart(app: tauri::AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

// Autostart aus dem Onboarding heraus setzen. Gleiche Logik wie der Tray-Eintrag.
#[tauri::command]
fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|error| error.to_string())
    } else {
        manager.disable().map_err(|error| error.to_string())
    }
}

// "#rrggbb" (oder "rrggbb") -> COLORREF-u32 im 0x00BBGGRR-Format fuer GDI.
fn parse_hex_color(hex: &str) -> Option<u32> {
    let h = hex.strip_prefix('#').unwrap_or(hex);
    if h.len() != 6 || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let r = u32::from_str_radix(&h[0..2], 16).ok()?;
    let g = u32::from_str_radix(&h[2..4], 16).ok()?;
    let b = u32::from_str_radix(&h[4..6], 16).ok()?;
    Some((b << 16) | (g << 8) | r)
}

fn settings_config_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("settings.json"))
}

fn load_settings(app: &tauri::AppHandle) -> Option<AppSettings> {
    let path = settings_config_path(app)?;
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice::<AppSettings>(&bytes).ok()
}

fn save_settings(app: &tauri::AppHandle, settings: &AppSettings) {
    let Some(path) = settings_config_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_vec_pretty(settings) {
        let _ = fs::write(path, json);
    }
}

#[tauri::command]
fn copy_latest(state: tauri::State<AppState>) -> Result<(), String> {
    let shot = state
        .latest_shot
        .lock()
        .map_err(|error| error.to_string())?
        .clone()
        .ok_or_else(|| "No screenshot available yet.".to_string())?;

    let bytes = fs::read(&shot.path).map_err(|error| error.to_string())?;
    let image = decode_png_as_rgba(&bytes)?;
    write_clipboard_image(&image, &bytes, &shot.path)
}

#[tauri::command]
fn copy_latest_path(state: tauri::State<AppState>) -> Result<(), String> {
    let shot = state
        .latest_shot
        .lock()
        .map_err(|error| error.to_string())?
        .clone()
        .ok_or_else(|| "No screenshot available yet.".to_string())?;

    write_clipboard_text(&shot.path)
}

// Ein Remote-Screenshot im SSH-Zielordner (fuer die SSH-Galerie).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteShot {
    name: String,
    path: String,
    size: u64,
    modified: u64,
}

// Gemeinsame ssh/scp-Optionen: nicht-interaktiv (BatchMode -> kein Passwort-Prompt),
// kurzer Connect-Timeout, optional ein expliziter Key. `-B` gilt nur fuer scp (ssh
// kennt das Flag nicht) -> ueber include_scp_batch steuern.
fn ssh_base_args(identity: &str, include_scp_batch: bool) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    if include_scp_batch {
        args.push("-B".into());
    }
    args.push("-o".into());
    args.push("BatchMode=yes".into());
    args.push("-o".into());
    args.push("ConnectTimeout=10".into());
    if !identity.is_empty() {
        args.push("-i".into());
        args.push(identity.to_string());
        args.push("-o".into());
        args.push("IdentitiesOnly=yes".into());
    }
    args
}

// Sicherheitswaechter fuer Remote-Pfade aus der SSH-Galerie, bevor sie in ein
// `scp`/`rm` gehen. Akzeptiert nur Pfade, deren Basename `snipdrop-<ziffern>.png`
// ist und die keine Whitespace-/Shell-Sonderzeichen enthalten -> kein versehentliches
// Loeschen fremder Dateien und keine Command-Injection.
fn is_safe_remote_shot(path: &str) -> bool {
    if path.is_empty()
        || path.contains(|c: char| c.is_control() || c.is_whitespace())
        || path.contains(['\'', '"', '`', '$', '\\', '|', ';', '&', '*', '?', '(', ')'])
    {
        return false;
    }
    let name = path.rsplit('/').next().unwrap_or("");
    let stem = match name.strip_suffix(".png") {
        Some(stem) => stem,
        None => return false,
    };
    match stem.strip_prefix("snipdrop-") {
        Some(digits) => !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()),
        None => false,
    }
}

// scp/ssh als Kindprozess vorbereiten. Unter Windows ohne aufblitzendes
// Konsolenfenster (CREATE_NO_WINDOW).
fn ssh_cli(program: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

// Datei per scp auf den Remote-Host laden und nach Erfolg den Remote-Pfad in die
// Zwischenablage legen ("clipssh"-Modell): so kann man das Bild in ein ueber SSH
// laufendes Tool (Claude Code, Editor) mit Ctrl+V einfuegen. scp blockiert
// (Netzwerk) -> eigener Thread, Ergebnis per Event ans Frontend ("ssh-send-ok" /
// "ssh-send-error"). Auth laeuft ausschliesslich ueber Keys/ssh-agent (BatchMode).
// Gemeinsam genutzt vom manuellen Sende-Button und vom Auto-SSH-Modus.
fn spawn_ssh_upload(
    app: tauri::AppHandle,
    host: String,
    remote_dir: String,
    identity: String,
    path: String,
) {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let remote_name = format!("snipdrop-{timestamp}.png");
    let remote_path = format!("{}/{}", remote_dir.trim_end_matches('/'), remote_name);
    let scp_target = format!("{host}:{remote_path}");

    thread::spawn(move || {
        let mut args = ssh_base_args(&identity, true);
        args.push(path.clone());
        args.push(scp_target.clone());

        let result = ssh_cli("scp").args(&args).output();

        match result {
            Ok(output) if output.status.success() => {
                // Remote-Pfad in die Zwischenablage -> Ctrl+V im Remote-Tool.
                if let Err(error) = write_clipboard_text(&remote_path) {
                    let _ = app.emit("ssh-send-error", error);
                    return;
                }
                let _ = app.emit("ssh-send-ok", remote_path);
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let message = stderr.trim();
                let message = if message.is_empty() {
                    "scp failed.".to_string()
                } else {
                    message.to_string()
                };
                let _ = app.emit("ssh-send-error", message);
            }
            Err(error) => {
                let _ = app.emit(
                    "ssh-send-error",
                    format!("Could not start scp: {error}"),
                );
            }
        }
    });
}

// Manueller "Per SSH senden"-Button: ein einzelnes Galerie-Bild hochladen.
#[tauri::command]
fn send_shot_to_ssh(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    path: String,
) -> Result<(), String> {
    let (host, remote_dir, identity) = {
        let settings = state.settings.lock().map_err(|error| error.to_string())?;
        (
            settings.ssh_host.clone(),
            settings.ssh_remote_dir.clone(),
            settings.ssh_identity_file.clone(),
        )
    };
    if host.is_empty() {
        return Err("Kein SSH-Host konfiguriert.".to_string());
    }
    if !std::path::Path::new(&path).is_file() {
        return Err("Screenshot file not found.".to_string());
    }

    spawn_ssh_upload(app, host, remote_dir, identity, path);
    Ok(())
}

// Verbindungstest fuer den "Verbindung testen"-Button: ssh <host> true.
#[tauri::command]
fn test_ssh_connection(state: tauri::State<AppState>) -> Result<(), String> {
    let (host, identity) = {
        let settings = state.settings.lock().map_err(|error| error.to_string())?;
        (settings.ssh_host.clone(), settings.ssh_identity_file.clone())
    };
    if host.is_empty() {
        return Err("Kein SSH-Host konfiguriert.".to_string());
    }

    let mut args = ssh_base_args(&identity, false);
    args.push(host.clone());
    args.push("true".into());

    let output = ssh_cli("ssh")
        .args(&args)
        .output()
        .map_err(|error| format!("Could not start ssh: {error}"))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let message = stderr.trim();
        Err(if message.is_empty() {
            "Connection failed.".to_string()
        } else {
            message.to_string()
        })
    }
}

// Remote-Ordner auflisten (SSH-Galerie). Ein Round-Trip: pro snipdrop-PNG eine Zeile
// `pfad|groesse|mtime` via `stat`. `[ -e ]` faengt den leeren Glob ab. Ist Retention
// aktiv (> 0), wird vorher einmal aufgeraeumt — sichtbar beim Oeffnen, nicht versteckt.
#[tauri::command]
fn list_remote_shots(state: tauri::State<AppState>) -> Result<Vec<RemoteShot>, String> {
    let (host, remote_dir, identity, retention) = {
        let settings = state.settings.lock().map_err(|error| error.to_string())?;
        (
            settings.ssh_host.clone(),
            settings.ssh_remote_dir.clone(),
            settings.ssh_identity_file.clone(),
            settings.ssh_retention_days,
        )
    };
    if host.is_empty() {
        return Err("Kein SSH-Host konfiguriert.".to_string());
    }

    let dir = remote_dir.trim_end_matches('/');
    // Das Verzeichnis wird einfachgequotet in den Remote-Befehl eingesetzt -> Zeichen
    // ablehnen, die das Quoting umgehen oder das stat-Parsing stoeren wuerden.
    if dir.is_empty() || dir.contains(['\'', '|']) || dir.contains(|c: char| c.is_control()) {
        return Err("Invalid remote directory.".to_string());
    }

    if retention > 0 {
        let clean_cmd = format!(
            "find '{dir}' -maxdepth 1 -name 'snipdrop-*.png' -mtime +{retention} -delete"
        );
        let mut args = ssh_base_args(&identity, false);
        args.push(host.clone());
        args.push(clean_cmd);
        let _ = ssh_cli("ssh").args(&args).output();
    }

    let list_cmd = format!(
        "for f in '{dir}'/snipdrop-*.png; do [ -e \"$f\" ] && stat -c '%n|%s|%Y' \"$f\"; done"
    );
    let mut args = ssh_base_args(&identity, false);
    args.push(host);
    args.push(list_cmd);
    let output = ssh_cli("ssh")
        .args(&args)
        .output()
        .map_err(|error| format!("Could not start ssh: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let message = stderr.trim();
        return Err(if message.is_empty() {
            "Remote list failed.".to_string()
        } else {
            message.to_string()
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut shots: Vec<RemoteShot> = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.splitn(3, '|').collect();
        if parts.len() != 3 {
            continue;
        }
        let path = parts[0].to_string();
        let size = parts[1].parse::<u64>().unwrap_or(0);
        let modified = parts[2].parse::<u64>().unwrap_or(0);
        let name = path.rsplit('/').next().unwrap_or(path.as_str()).to_string();
        shots.push(RemoteShot {
            name,
            path,
            size,
            modified,
        });
    }
    // Neueste zuerst.
    shots.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(shots)
}

// Ein einzelnes Remote-Bild fuer die Vorschau holen (nur auf Klick, nie eager):
// scp in einen lokalen Temp-Ordner, Rueckgabe = lokaler Pfad. Das Frontend zeigt es
// per convertFileSrc und kann darauf copy_shot (Bild kopieren) aufrufen.
#[tauri::command]
fn fetch_remote_shot(state: tauri::State<AppState>, path: String) -> Result<String, String> {
    if !is_safe_remote_shot(&path) {
        return Err("Invalid remote path.".to_string());
    }
    let (host, identity) = {
        let settings = state.settings.lock().map_err(|error| error.to_string())?;
        (settings.ssh_host.clone(), settings.ssh_identity_file.clone())
    };
    if host.is_empty() {
        return Err("Kein SSH-Host konfiguriert.".to_string());
    }

    let name = path.rsplit('/').next().unwrap_or("remote.png").to_string();
    let dir = std::env::temp_dir().join("snipdrop-remote");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let local = dir.join(&name);

    let mut args = ssh_base_args(&identity, true);
    args.push(format!("{host}:{path}"));
    args.push(local.to_string_lossy().to_string());
    let output = ssh_cli("scp")
        .args(&args)
        .output()
        .map_err(|error| format!("Could not start scp: {error}"))?;
    if output.status.success() {
        Ok(local.to_string_lossy().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let message = stderr.trim();
        Err(if message.is_empty() {
            "Download failed.".to_string()
        } else {
            message.to_string()
        })
    }
}

// Ein Remote-Bild auf dem Server loeschen (manuell aus der SSH-Galerie).
#[tauri::command]
fn delete_remote_shot(state: tauri::State<AppState>, path: String) -> Result<(), String> {
    if !is_safe_remote_shot(&path) {
        return Err("Invalid remote path.".to_string());
    }
    let (host, identity) = {
        let settings = state.settings.lock().map_err(|error| error.to_string())?;
        (settings.ssh_host.clone(), settings.ssh_identity_file.clone())
    };
    if host.is_empty() {
        return Err("Kein SSH-Host konfiguriert.".to_string());
    }

    // Pfad ist nach is_safe_remote_shot frei von Whitespace/Shell-Zeichen -> sicher als
    // eigenes Argument (ssh fuegt die Argumente mit Leerzeichen zusammen).
    let mut args = ssh_base_args(&identity, false);
    args.push(host);
    args.push("rm".into());
    args.push("-f".into());
    args.push("--".into());
    args.push(path);
    let output = ssh_cli("ssh")
        .args(&args)
        .output()
        .map_err(|error| format!("Could not start ssh: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let message = stderr.trim();
        Err(if message.is_empty() {
            "Delete failed.".to_string()
        } else {
            message.to_string()
        })
    }
}

// Beliebigen Text in die Zwischenablage legen (z. B. "Remote-Pfad kopieren").
#[tauri::command]
fn copy_text(text: String) -> Result<(), String> {
    write_clipboard_text(&text)
}

// Nativer Datei-Dialog zum Auswaehlen der privaten Key-Datei. Startet im
// ~/.ssh-Ordner. Gibt den gewaehlten Pfad zurueck (None = abgebrochen). Eigener
// Command -> kein Capability/Permission-Eintrag noetig (Plugin nur Rust-seitig genutzt).
#[tauri::command]
fn pick_ssh_key_file(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;

    let mut builder = app.dialog().file().set_title("Choose SSH key");
    if let Ok(home) = app.path().home_dir() {
        let ssh_dir = home.join(".ssh");
        if ssh_dir.is_dir() {
            builder = builder.set_directory(ssh_dir);
        }
    }

    builder
        .blocking_pick_file()
        .and_then(|file| file.into_path().ok())
        .map(|path| path.to_string_lossy().to_string())
}

// Nativer Ordner-Dialog fuer den Screenshot-Speicherort. Startet im aktuell
// genutzten Ausgabeordner. Gibt den gewaehlten absoluten Pfad zurueck (oder None
// bei Abbruch). Persistiert wird erst per set_settings { screenshotDir } im Frontend.
#[tauri::command]
fn pick_screenshot_dir(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;

    let mut builder = app.dialog().file().set_title("Choose screenshot folder");
    if let Ok(current) = output_directory() {
        if current.is_dir() {
            builder = builder.set_directory(current);
        }
    }

    builder
        .blocking_pick_folder()
        .and_then(|folder| folder.into_path().ok())
        .map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
fn reveal_latest(state: tauri::State<AppState>) -> Result<(), String> {
    let shot = state
        .latest_shot
        .lock()
        .map_err(|error| error.to_string())?
        .clone()
        .ok_or_else(|| "No screenshot available yet.".to_string())?;

    std::process::Command::new("explorer.exe")
        .arg(format!("/select,{}", shot.path))
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_shots() -> Result<Vec<ShotMeta>, String> {
    let dir = output_directory()?;
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        // Ordner existiert noch nicht (kein Screenshot bisher) -> leere Galerie.
        Err(_) => return Ok(Vec::new()),
    };

    let mut shots = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let is_png = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("png"))
            .unwrap_or(false);
        if !is_png {
            continue;
        }

        let metadata = match entry.metadata() {
            Ok(metadata) if metadata.is_file() => metadata,
            _ => continue,
        };

        // Maße billig aus dem PNG-Header lesen (keine Pixel dekodieren).
        let (width, height) = match read_png_dimensions(&path) {
            Ok(dimensions) => dimensions,
            Err(_) => continue,
        };

        let created_at = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs())
            .unwrap_or(0);

        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_string();
        let id = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or(&file_name)
            .to_string();

        shots.push(ShotMeta {
            id,
            path: path.to_string_lossy().to_string(),
            file_name,
            width,
            height,
            created_at,
        });
    }

    // Neueste zuerst.
    shots.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(shots)
}

#[tauri::command]
fn copy_shot(path: String) -> Result<(), String> {
    let bytes = fs::read(&path).map_err(|error| error.to_string())?;
    let image = decode_png_as_rgba(&bytes)?;
    write_clipboard_image(&image, &bytes, &path)
}

#[tauri::command]
fn open_screenshots_dir() -> Result<(), String> {
    open_output_dir()
}

#[tauri::command]
fn delete_shot(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(|error| error.to_string())
}

#[tauri::command]
fn dismiss_thumbnail(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(thumbnail) = app.get_webview_window("thumbnail") {
        thumbnail.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

// Klick aufs Thumbnail: Editor-Fenster anzeigen, Thumbnail verstecken.
#[tauri::command]
fn open_editor(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(thumbnail) = app.get_webview_window("thumbnail") {
        let _ = thumbnail.hide();
    }
    let editor = app
        .get_webview_window("editor")
        .ok_or_else(|| "Editor window not found.".to_string())?;
    // Editor lädt daraufhin den aktuellen Shot neu.
    let _ = editor.emit("editor-open", ());
    // show + unminimize + set_focus: holt das Fenster auch dann in den Vordergrund,
    // wenn es zuvor minimiert war (gleiches Muster wie show_main_window).
    editor.show().map_err(|error| error.to_string())?;
    let _ = editor.unminimize();
    editor.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

// Annotierte Kopie speichern: Original bleibt unangetastet, die Kopie <id>-edit.png
// versorgt Clipboard und Drag. Gibt den Pfad der Kopie zurück.
#[tauri::command]
fn save_annotated(
    state: tauri::State<AppState>,
    png_base64: String,
) -> Result<String, String> {
    let png_bytes = general_purpose::STANDARD
        .decode(png_base64.trim())
        .map_err(|error| error.to_string())?;

    let base = state
        .latest_shot
        .lock()
        .map_err(|error| error.to_string())?
        .clone()
        .ok_or_else(|| "No screenshot available yet.".to_string())?;

    // Basis-ID ohne bereits vorhandenes -edit-Suffix, damit wiederholtes Speichern
    // dieselbe Datei überschreibt statt -edit-edit.png zu erzeugen.
    let base_id = base.id.strip_suffix("-edit").unwrap_or(&base.id);
    let file_name = format!("{base_id}-edit.png");
    let output_dir = output_directory()?;
    fs::create_dir_all(&output_dir).map_err(|error| error.to_string())?;
    let edit_path = output_dir.join(&file_name);
    fs::write(&edit_path, &png_bytes).map_err(|error| error.to_string())?;

    let edit_path_str = edit_path.to_string_lossy().to_string();
    let image = decode_png_as_rgba(&png_bytes)?;
    write_clipboard_image(&image, &png_bytes, &edit_path_str)?;

    let edited_shot = Shot {
        id: format!("{base_id}-edit"),
        path: edit_path_str.clone(),
        file_name,
        data_url: format!(
            "data:image/png;base64,{}",
            general_purpose::STANDARD.encode(&png_bytes)
        ),
        width: image.width,
        height: image.height,
        created_at: base.created_at,
    };
    {
        let mut latest = state
            .latest_shot
            .lock()
            .map_err(|error| error.to_string())?;
        *latest = Some(edited_shot);
    }

    Ok(edit_path_str)
}

fn show_thumbnail(app: &tauri::AppHandle, shot: &Shot) -> Result<(), String> {
    let desktop = virtual_desktop();
    let thumbnail = app
        .get_webview_window("thumbnail")
        .ok_or_else(|| "Thumbnail window not found.".to_string())?;

    let max_width = 500.0;
    let max_height = 360.0;
    let scale = (max_width / shot.width as f64)
        .min(max_height / shot.height as f64)
        .min(1.0);
    let width = ((shot.width as f64 * scale).round() as i32).max(150);
    let height = ((shot.height as f64 * scale).round() as i32).max(110);
    thumbnail
        .set_size(tauri::PhysicalSize::new(width as u32, height as u32))
        .map_err(|error| error.to_string())?;
    thumbnail
        .set_position(tauri::PhysicalPosition::new(
            desktop.x + 28,
            desktop.y + desktop.height - height - 38,
        ))
        .map_err(|error| error.to_string())?;
    thumbnail
        .emit("thumbnail-shot", shot.clone())
        .map_err(|error| error.to_string())?;
    thumbnail.show().map_err(|error| error.to_string())?;

    Ok(())
}

fn output_directory() -> Result<PathBuf, String> {
    // Hat der Nutzer in den Settings einen eigenen Ordner gesetzt, gilt der direkt
    // (ohne SnipDrop-Unterordner — er hat den Zielordner bewusst gewaehlt).
    if let Ok(custom) = SCREENSHOT_DIR.lock() {
        let custom = custom.trim();
        if !custom.is_empty() {
            return Ok(PathBuf::from(custom));
        }
    }

    let user_profile = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .ok_or_else(|| "Could not find your home directory.".to_string())?;

    Ok(PathBuf::from(user_profile)
        .join("Pictures")
        .join("SnipDrop"))
}

fn open_output_dir() -> Result<(), String> {
    let dir = output_directory()?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    std::process::Command::new("explorer.exe")
        .arg(&dir)
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

fn hash_bytes(bytes: &[u8]) -> u64 {
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    hasher.finish()
}

fn encode_png(image: &CapturedImage) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    {
        let writer = BufWriter::new(&mut bytes);
        let mut encoder = png::Encoder::new(writer, image.width as u32, image.height as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        // Schnelle Kompression statt Default: bei einem Vollbild-/Multi-Monitor-Screenshot
        // ist die PNG-Kodierung der groesste Posten auf dem Weg zum Thumbnail. Fast spart
        // spuerbar Zeit; die Datei wird nur geringfuegig groesser.
        encoder.set_compression(png::Compression::Fast);
        let mut png_writer = encoder.write_header().map_err(|error| error.to_string())?;
        png_writer
            .write_image_data(&image.rgba)
            .map_err(|error| error.to_string())?;
    }
    Ok(bytes)
}

fn read_png_dimensions(path: &std::path::Path) -> Result<(i32, i32), String> {
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let decoder = png::Decoder::new(std::io::BufReader::new(file));
    // read_info liest nur den Header (IHDR), dekodiert keine Pixeldaten.
    let reader = decoder.read_info().map_err(|error| error.to_string())?;
    let info = reader.info();
    Ok((info.width as i32, info.height as i32))
}

fn decode_png_as_rgba(bytes: &[u8]) -> Result<CapturedImage, String> {
    let decoder = png::Decoder::new(bytes);
    let mut reader = decoder.read_info().map_err(|error| error.to_string())?;
    let mut rgba = vec![0; reader.output_buffer_size()];
    let info = reader
        .next_frame(&mut rgba)
        .map_err(|error| error.to_string())?;
    rgba.truncate(info.buffer_size());

    if info.color_type != png::ColorType::Rgba || info.bit_depth != png::BitDepth::Eight {
        return Err("PNG is not in the expected RGBA format.".to_string());
    }

    let mut bgra = rgba.clone();
    for pixel in bgra.chunks_exact_mut(4) {
        pixel.swap(0, 2);
        pixel[3] = 255;
    }

    Ok(CapturedImage {
        width: info.width as i32,
        height: info.height as i32,
        rgba,
        bgra,
    })
}

fn save_captured_image(app: &tauri::AppHandle, image: CapturedImage) -> Result<(), String> {
    let png_bytes = encode_png(&image)?;
    let state = app.state::<AppState>();
    let hash = hash_bytes(&png_bytes);
    {
        let mut last = state
            .last_image_hash
            .lock()
            .map_err(|error| error.to_string())?;
        if *last == Some(hash) {
            return Ok(());
        }
        *last = Some(hash);
    }

    let created_at = unix_timestamp();
    let output_dir = output_directory()?;
    fs::create_dir_all(&output_dir).map_err(|error| error.to_string())?;

    let id = format!("snipdrop-{created_at}");
    let file_name = format!("{id}.png");
    let path = output_dir.join(&file_name);
    fs::write(&path, &png_bytes).map_err(|error| error.to_string())?;

    let shot = Shot {
        id,
        path: path.to_string_lossy().to_string(),
        file_name,
        data_url: format!(
            "data:image/png;base64,{}",
            general_purpose::STANDARD.encode(&png_bytes)
        ),
        width: image.width,
        height: image.height,
        created_at,
    };

    {
        let mut latest = state
            .latest_shot
            .lock()
            .map_err(|error| error.to_string())?;
        *latest = Some(shot.clone());
    }

    // Thumbnail und Galerie laden das Bild per Asset-Protokoll (convertFileSrc) vom Pfad.
    // Den schweren Base64-data_url deshalb NICHT über IPC broadcasten — nur der Editor
    // braucht ihn, und der holt sich den vollständigen Shot per latest_shot.
    let light_shot = Shot {
        data_url: String::new(),
        ..shot
    };

    // Thumbnail zuerst zeigen — es erscheint, sobald die Datei geschrieben ist.
    show_thumbnail(app, &light_shot)?;

    // Clipboard erst danach befuellen: die grosse CF_DIB-Kopie (bei Vollbild zig MB) lag
    // bisher VOR dem Thumbnail auf dem kritischen Pfad und hat es ausgebremst. Ctrl+V ist
    // weiterhin praktisch sofort bereit (passiert ohnehin erst einen Moment spaeter).
    write_clipboard_image(&image, &png_bytes, &light_shot.path)?;

    let _ = app.emit("shot-created", light_shot);

    // Lifetime-Zaehler hochzaehlen, persistieren und ans Frontend melden (steuert
    // das Support-Popup an Meilensteinen). Lock vor save_settings wieder freigeben
    // (geklont), wie im set_settings-Muster.
    {
        let to_save = {
            let mut s = state.settings.lock().map_err(|error| error.to_string())?;
            s.capture_count = s.capture_count.saturating_add(1);
            s.clone()
        };
        save_settings(app, &to_save);
        let _ = app.emit("capture-count", to_save.capture_count);
    }

    // Auto-SSH-Modus: ist er aktiv und ein Host konfiguriert, den frischen Snip
    // gleich hochladen. spawn_ssh_upload ueberschreibt nach erfolgreichem scp das
    // oben gesetzte lokale Clipboard mit dem Remote-Pfad, sodass Ctrl+V im
    // SSH-Terminal direkt den Remote-Pfad liefert. Der Erfolgs-/Fehler-Toast
    // kommt ueber dieselben Events wie beim manuellen Sende-Button.
    let auto_ssh = {
        let settings = state.settings.lock().map_err(|error| error.to_string())?;
        if settings.ssh_auto && !settings.ssh_host.is_empty() {
            Some((
                settings.ssh_host.clone(),
                settings.ssh_remote_dir.clone(),
                settings.ssh_identity_file.clone(),
            ))
        } else {
            None
        }
    };
    if let Some((host, remote_dir, identity)) = auto_ssh {
        spawn_ssh_upload(
            app.clone(),
            host,
            remote_dir,
            identity,
            path.to_string_lossy().to_string(),
        );
    }

    Ok(())
}

#[cfg(windows)]
fn virtual_desktop() -> VirtualDesktop {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN,
    };

    unsafe {
        VirtualDesktop {
            x: GetSystemMetrics(SM_XVIRTUALSCREEN),
            y: GetSystemMetrics(SM_YVIRTUALSCREEN),
            width: GetSystemMetrics(SM_CXVIRTUALSCREEN),
            height: GetSystemMetrics(SM_CYVIRTUALSCREEN),
        }
    }
}

#[cfg(not(windows))]
fn virtual_desktop() -> VirtualDesktop {
    VirtualDesktop {
        x: 0,
        y: 0,
        width: 1280,
        height: 720,
    }
}

#[cfg(windows)]
fn start_hotkey_hook() -> Result<(), String> {
    use std::sync::atomic::AtomicBool;
    use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Threading::{
        GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_TIME_CRITICAL,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, GetMessageW, SetTimer, SetWindowsHookExW, TranslateMessage,
        UnhookWindowsHookEx, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_SYSKEYDOWN, WM_TIMER,
    };

    // Verhindert mehrfaches Auslösen, solange Strg+V gehalten wird (Auto-Repeat).
    static PASTE_LATCH: AtomicBool = AtomicBool::new(false);
    // Doppelrolle: (1) schluckt den zugehoerigen KEY-UP sicher, auch wenn die Modifier
    // vorher losgelassen wurden; (2) markiert "Hotkey gehalten", damit Auto-Repeat nicht
    // mehrere Captures anstoesst. Auf der ersten KEY-DOWN-Flanke gesetzt, beim KEY-UP geloescht.
    static SNIP_LATCH: AtomicBool = AtomicBool::new(false);
    // Vom Hook gesetzt, vom Capture-Worker abgearbeitet. Der Hook-Callback selbst macht
    // KEINE schwere Arbeit mehr (kein thread::spawn), damit er nie das LowLevelHooksTimeout
    // reisst — sonst entfernt Windows den Low-Level-Hook dauerhaft.
    static CAPTURE_REQUESTED: AtomicBool = AtomicBool::new(false);
    // True, solange der Worker tatsaechlich ein Capture/Overlay bearbeitet. Spam-Druecke
    // waehrend dieser Zeit werden zwar weiter geschluckt (kein Snipping Tool), stossen aber
    // KEIN weiteres Capture an — sonst staut sich eine Kette von Overlays auf ("5 s warten").
    static CAPTURE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);
    static CAPTURE_WORKER: std::sync::OnceLock<std::thread::Thread> = std::sync::OnceLock::new();

    unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        use std::sync::atomic::Ordering;
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            GetAsyncKeyState, VK_CONTROL, VK_LCONTROL, VK_LMENU, VK_LSHIFT, VK_LWIN, VK_RCONTROL,
            VK_RMENU, VK_RSHIFT, VK_RWIN, VK_V,
        };
        use windows::Win32::UI::WindowsAndMessaging::{
            CallNextHookEx, KBDLLHOOKSTRUCT, WM_KEYUP, WM_SYSKEYUP,
        };

        if code >= 0 {
            let is_key_down = wparam.0 as u32 == WM_KEYDOWN || wparam.0 as u32 == WM_SYSKEYDOWN;
            let is_key_up = wparam.0 as u32 == WM_KEYUP || wparam.0 as u32 == WM_SYSKEYUP;
            let info = *(lparam.0 as *const KBDLLHOOKSTRUCT);

            // Strg+V: Thumbnail automatisch wegswipen, sobald eingefügt wird.
            // WICHTIG: Tastendruck NICHT schlucken (kein return) — sonst bricht
            // das Einfügen in der Zielanwendung.
            if info.vkCode == VK_V.0 as u32 {
                let ctrl_down = GetAsyncKeyState(VK_CONTROL.0 as i32) < 0;
                if ctrl_down && is_key_down && !PASTE_LATCH.swap(true, Ordering::SeqCst) {
                    // WICHTIG: keinerlei blockierende Arbeit (get_webview_window/emit) im
                    // Hook selbst — sonst reißt Windows den LL-Hook nach Timeout ab und
                    // verschluckt das Strg+V. Deshalb in einen Thread auslagern und sofort
                    // weiterreichen (gleiche Strategie wie beim Snip-Hotkey).
                    if let Some(app) = APP_HANDLE.get().cloned() {
                        thread::spawn(move || {
                            if let Some(thumbnail) = app.get_webview_window("thumbnail") {
                                if thumbnail.is_visible().unwrap_or(false) {
                                    let _ = thumbnail.emit("thumbnail-dismiss", ());
                                }
                            }
                        });
                    }
                } else if is_key_up {
                    PASTE_LATCH.store(false, Ordering::SeqCst);
                }
            }

            // Snip-Hotkey aus den Statics — fest auf Win + Shift + S (keine UI-Aenderung mehr).
            let target_vk = HOTKEY_VK.load(Ordering::Relaxed);
            let target_mods = HOTKEY_MODS.load(Ordering::Relaxed);
            if target_vk != 0 && info.vkCode == target_vk {
                // Modifier-Ist-Zustand direkt physisch abfragen (GetAsyncKeyState), NICHT aus
                // einem selbst mitgezaehlten Status. Letzterer desynchronisiert beim schnellen
                // Spammen (verpasste/doppelte Hook-Events): dann bleibt mods_match faelschlich
                // false, SnipDrop schluckt Win+Shift+S nicht mehr -> Snipping Tool / "nichts
                // passiert". GetAsyncKeyState kennt keinen Drift und keine haengenden Bits.
                let down = |a: i32, b: i32| {
                    (GetAsyncKeyState(a) as u16 & 0x8000) != 0
                        || (GetAsyncKeyState(b) as u16 & 0x8000) != 0
                };
                let ctrl_down = down(VK_LCONTROL.0 as i32, VK_RCONTROL.0 as i32);
                let shift_down = down(VK_LSHIFT.0 as i32, VK_RSHIFT.0 as i32);
                let alt_down = down(VK_LMENU.0 as i32, VK_RMENU.0 as i32);
                let win_down = down(VK_LWIN.0 as i32, VK_RWIN.0 as i32);

                // Exakter Abgleich: geforderte Modifier müssen gedrückt sein, nicht
                // geforderte nicht — verhindert versehentliches Auslösen.
                let mods_match = ((target_mods & MOD_CTRL != 0) == ctrl_down)
                    && ((target_mods & MOD_SHIFT != 0) == shift_down)
                    && ((target_mods & MOD_ALT != 0) == alt_down)
                    && ((target_mods & MOD_WIN != 0) == win_down);

                if is_key_down && mods_match {
                    // Nur auf der ersten KEY-DOWN-Flanke (kein Auto-Repeat) Capture
                    // anfordern. Hot-Path bleibt minimal: Flag setzen + Worker wecken,
                    // KEINE schwere Arbeit im Hook (sonst Timeout -> Hook wird entfernt).
                    // Laeuft bereits ein Capture, NICHT erneut anfordern (sonst Overlay-Stau),
                    // den Tastendruck aber trotzdem schlucken (kein Snipping Tool).
                    if !SNIP_LATCH.swap(true, Ordering::SeqCst)
                        && !CAPTURE_IN_PROGRESS.load(Ordering::SeqCst)
                    {
                        CAPTURE_REQUESTED.store(true, Ordering::SeqCst);
                        if let Some(worker) = CAPTURE_WORKER.get() {
                            worker.unpark();
                        }
                    }
                    return LRESULT(1);
                }

                // Den zugehoerigen KEY-UP immer schlucken, sobald der KEY-DOWN geschluckt
                // wurde — unabhaengig davon, ob Win/Shift noch gehalten werden. Diese
                // Luecke (alleinstehender KEY-UP) hat sonst das Snipping Tool ausgeloest.
                if is_key_up && SNIP_LATCH.swap(false, Ordering::SeqCst) {
                    return LRESULT(1);
                }
            }
        }

        CallNextHookEx(None, code, wparam, lparam)
    }

    // Capture-Worker einmalig starten und schlafen legen; der Hook weckt ihn nur per
    // unpark. So macht der Hook-Callback praktisch nichts und kann das Hook-Timeout nie
    // reissen, selbst wenn der Prozess busy ist (Galerie scrollen -> Asset-Protokoll).
    let worker = thread::spawn(|| loop {
        thread::park();
        while CAPTURE_REQUESTED.swap(false, std::sync::atomic::Ordering::SeqCst) {
            let Some(app) = APP_HANDLE.get().cloned() else {
                continue;
            };
            CAPTURE_IN_PROGRESS.store(true, std::sync::atomic::Ordering::SeqCst);
            // Ist SnipDrops eigenes Fenster sichtbar, erst verstecken und dem Compositor
            // kurz Zeit zum Neuzeichnen geben — sonst landet es im Screenshot.
            if let Some(window) = app.get_webview_window("main") {
                if window.is_visible().unwrap_or(false) {
                    let _ = window.hide();
                    thread::sleep(Duration::from_millis(120));
                }
            }
            let outcome = run_native_capture(virtual_desktop());
            // Overlay ist zu (oder abgebrochen): Guard SOFORT freigeben, damit ein neuer
            // Win+Shift+S gleich wieder ein Capture anstossen kann. Das Speichern unten
            // blockiert nur noch diesen Worker-Thread, nicht den Hotkey — ein Druck waehrend
            // des Speicherns wird als CAPTURE_REQUESTED gemerkt und gleich danach abgearbeitet.
            CAPTURE_IN_PROGRESS.store(false, std::sync::atomic::Ordering::SeqCst);
            match outcome {
                Ok(Some(crop)) => {
                    if let Err(error) = save_captured_image(&app, crop) {
                        let _ = app.emit("capture-error", error);
                    }
                }
                Ok(None) => {}
                Err(error) => {
                    let _ = app.emit("capture-error", error);
                }
            }
        }
    });
    let _ = CAPTURE_WORKER.set(worker.thread().clone());

    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || unsafe {
        // Hook-Thread maximal priorisieren: Windows ueberspringt einen Low-Level-
        // Keyboard-Hook, wenn der installierende Thread nicht innerhalb des
        // LowLevelHooksTimeout reagiert. Ist SnipDrop im Vordergrund busy (Galerie
        // rendern/scrollen), wird dieser Thread sonst nicht rechtzeitig eingeplant und
        // Win+Shift+S rutscht durch zum Snipping Tool. Mit TIME_CRITICAL bekommt er
        // immer sofort CPU, der Hook greift damit auch bei fokussiertem SnipDrop.
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);

        let module = GetModuleHandleW(None).unwrap_or_default();
        let hmod = HINSTANCE(module.0);

        let mut hook = match SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), Some(hmod), 0) {
            Ok(hook) => {
                let _ = sender.send(Ok(()));
                hook
            }
            Err(error) => {
                let _ = sender.send(Err(error.to_string()));
                return;
            }
        };

        // Watchdog: Windows entfernt einen Low-Level-Hook bei einem Timeout STILL und
        // ohne Rueckmeldung (MSDN). Deshalb alle ~1 s neu installieren — so heilt sich
        // der Hook selbst, falls er zwischendurch entfernt wurde. Ein Thread-Timer
        // (hwnd = None) legt WM_TIMER in die Queue dieses Threads.
        let _ = SetTimer(None, 1, 1000, None);

        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).as_bool() {
            if message.message == WM_TIMER {
                // Erst den NEUEN Hook installieren, dann den alten entfernen. Andersherum
                // entstuende ein winziges Fenster ganz ohne Hook — ein Win+Shift+S genau dann
                // rutscht zu Windows durch und oeffnet das Snipping Tool (beim Spammen haeufig).
                if let Ok(fresh) = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), Some(hmod), 0)
                {
                    let _ = UnhookWindowsHookEx(hook);
                    hook = fresh;
                }
            }
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }

        let _ = UnhookWindowsHookEx(hook);
    });

    receiver
        .recv()
        .map_err(|error| format!("Could not start the hotkey hook: {error}"))?
}

#[cfg(not(windows))]
fn start_hotkey_hook() -> Result<(), String> {
    Err("SnipDrop capture is only available on Windows.".to_string())
}

// Capture + Auswahl-Overlay (die interaktive Phase). Gibt den fertigen Crop zurueck oder
// None bei Abbruch. Das Speichern (PNG/Clipboard/Thumbnail) macht bewusst der Aufrufer
// DANACH — so kann der Guard direkt nach dem Overlay fallen und ein neuer Hotkey sofort
// wieder greifen, ohne auf die Speicher-Phase zu warten.
#[cfg(windows)]
fn run_native_capture(desktop: VirtualDesktop) -> Result<Option<CapturedImage>, String> {
    let snapshot = capture_virtual_desktop(desktop)?;
    let bgra_for_overlay = snapshot.bgra.clone();
    let selection = run_selection_overlay(desktop, bgra_for_overlay)?;
    let Some(selection) = selection else {
        return Ok(None);
    };

    let crop = crop_image(&snapshot, desktop, selection)?;
    Ok(Some(crop))
}

#[cfg(windows)]
fn capture_virtual_desktop(desktop: VirtualDesktop) -> Result<CapturedImage, String> {
    use std::{mem, ptr};
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC,
        SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, HGDIOBJ,
        SRCCOPY,
    };

    unsafe {
        let screen_dc = GetDC(None);
        if screen_dc.0.is_null() {
            return Err("Could not open screen DC.".to_string());
        }

        let memory_dc = CreateCompatibleDC(Some(screen_dc));
        if memory_dc.0.is_null() {
            let _ = ReleaseDC(None, screen_dc);
            return Err("Could not create memory DC.".to_string());
        }

        let bitmap_info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: desktop.width,
                biHeight: -desktop.height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                biSizeImage: (desktop.width * desktop.height * 4) as u32,
                ..Default::default()
            },
            ..Default::default()
        };

        let mut bits: *mut std::ffi::c_void = ptr::null_mut();
        let bitmap = CreateDIBSection(
            Some(screen_dc),
            &bitmap_info,
            DIB_RGB_COLORS,
            &mut bits,
            None,
            0,
        )
        .map_err(|error| error.to_string())?;
        if bits.is_null() {
            let _ = DeleteDC(memory_dc);
            let _ = ReleaseDC(None, screen_dc);
            return Err("Could not create screenshot bitmap.".to_string());
        }

        let old = SelectObject(memory_dc, HGDIOBJ(bitmap.0));
        if old.0.is_null() {
            let _ = DeleteObject(HGDIOBJ(bitmap.0));
            let _ = DeleteDC(memory_dc);
            let _ = ReleaseDC(None, screen_dc);
            return Err("Could not select screenshot bitmap.".to_string());
        }

        BitBlt(
            memory_dc,
            0,
            0,
            desktop.width,
            desktop.height,
            Some(screen_dc),
            desktop.x,
            desktop.y,
            SRCCOPY | CAPTUREBLT,
        )
        .map_err(|error| error.to_string())?;

        let byte_len = desktop.width as usize * desktop.height as usize * 4;
        let bgra = std::slice::from_raw_parts(bits as *const u8, byte_len).to_vec();
        // rgba bewusst NICHT fuer den ganzen Frame berechnen: der Kanal-Swap ueber
        // ~2 Mio Pixel kostet auf dem kritischen Pfad ~1 s (Debug). rgba wird erst
        // nach der Auswahl gebraucht — dann nur fuer den kleinen Crop (siehe crop_image).

        let _ = SelectObject(memory_dc, old);
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        let _ = DeleteDC(memory_dc);
        let _ = ReleaseDC(None, screen_dc);

        Ok(CapturedImage {
            width: desktop.width,
            height: desktop.height,
            rgba: Vec::new(),
            bgra,
        })
    }
}

#[cfg(windows)]
fn crop_image(
    snapshot: &CapturedImage,
    desktop: VirtualDesktop,
    selection: Selection,
) -> Result<CapturedImage, String> {
    if selection.width < 2 || selection.height < 2 {
        return Err("Auswahl ist zu klein.".to_string());
    }

    let source_x = (selection.x - desktop.x).max(0) as usize;
    let source_y = (selection.y - desktop.y).max(0) as usize;
    let crop_width = selection.width.min(snapshot.width - source_x as i32) as usize;
    let crop_height = selection.height.min(snapshot.height - source_y as i32) as usize;
    let source_width = snapshot.width as usize;
    // Aus dem (immer vorhandenen) bgra-Vollbild den Auswahlbereich kopieren …
    let mut bgra = Vec::with_capacity(crop_width * crop_height * 4);
    for row in 0..crop_height {
        let start = ((source_y + row) * source_width + source_x) * 4;
        let end = start + crop_width * 4;
        bgra.extend_from_slice(&snapshot.bgra[start..end]);
    }
    // Alpha hart auf opak setzen — CAPTUREBLT liefert teils Alpha=0 (sonst transparentes DIB).
    for pixel in bgra.chunks_exact_mut(4) {
        pixel[3] = 255;
    }

    // … und nur diesen kleinen Crop nach rgba wandeln (nicht den ganzen Frame).
    let mut rgba = bgra.clone();
    for pixel in rgba.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }

    Ok(CapturedImage {
        width: crop_width as i32,
        height: crop_height as i32,
        rgba,
        bgra,
    })
}

// Geometrie des "Ganzer Bildschirm"-Buttons (pro Monitor, oben mittig).
// Quadratisch, da er nur noch ein Icon zeigt (kein Text mehr).
#[cfg(windows)]
const FULLSCREEN_BTN_WIDTH: i32 = 44;
#[cfg(windows)]
const FULLSCREEN_BTN_HEIGHT: i32 = 44;
#[cfg(windows)]
const FULLSCREEN_BTN_TOP_MARGIN: i32 = 24;

// Alle Monitor-Rechtecke in Virtual-Desktop-(Screen-)Koordinaten.
#[cfg(windows)]
fn enumerate_monitors() -> Vec<windows::Win32::Foundation::RECT> {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{LPARAM, RECT};
    use windows::Win32::Graphics::Gdi::{
        EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO,
    };

    unsafe extern "system" fn enum_proc(
        monitor: HMONITOR,
        _hdc: HDC,
        _clip: *mut RECT,
        data: LPARAM,
    ) -> BOOL {
        let monitors = &mut *(data.0 as *mut Vec<RECT>);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetMonitorInfoW(monitor, &mut info).as_bool() {
            monitors.push(info.rcMonitor);
        }
        BOOL(1)
    }

    let mut monitors: Vec<RECT> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(
            None,
            None,
            Some(enum_proc),
            LPARAM(&mut monitors as *mut Vec<RECT> as isize),
        );
    }
    monitors
}

// Button-Rechtecke in Fenster-/Client-Koordinaten (Screen-Koords minus Desktop-Ursprung),
// damit Zeichnen (WM_PAINT) und Hit-Test (WM_LBUTTONDOWN) identische Rechtecke nutzen.
#[cfg(windows)]
fn compute_button_rects(
    monitors: &[windows::Win32::Foundation::RECT],
    desktop: VirtualDesktop,
) -> Vec<windows::Win32::Foundation::RECT> {
    use windows::Win32::Foundation::RECT;
    monitors
        .iter()
        .map(|m| {
            let center_x = (m.left + m.right) / 2 - desktop.x;
            let top = m.top - desktop.y + FULLSCREEN_BTN_TOP_MARGIN;
            RECT {
                left: center_x - FULLSCREEN_BTN_WIDTH / 2,
                top,
                right: center_x + FULLSCREEN_BTN_WIDTH / 2,
                bottom: top + FULLSCREEN_BTN_HEIGHT,
            }
        })
        .collect()
}

// Malt den runden "Ganzer Bildschirm"-Button (nur Icon, kein Text) in den Off-Screen-Buffer
// (Doppelpufferung wie der Rest von WM_PAINT, daher kein Flackern). GDI-Objekte werden direkt
// wieder freigegeben.
#[cfg(windows)]
unsafe fn draw_fullscreen_button(
    hdc: windows::Win32::Graphics::Gdi::HDC,
    rect: windows::Win32::Foundation::RECT,
    hovered: bool,
) {
    use windows::Win32::Foundation::COLORREF;
    use windows::Win32::Graphics::Gdi::{
        CreatePen, CreateSolidBrush, DeleteObject, LineTo, MoveToEx, RoundRect, SelectObject,
        HGDIOBJ, PS_SOLID,
    };

    // Runder Button-Hintergrund.
    let fill = CreateSolidBrush(COLORREF(if hovered { 0x005a_5a5a } else { 0x0032_3232 }));
    let border = CreatePen(PS_SOLID, 1, COLORREF(0x00ff_ffff));
    let old_brush = SelectObject(hdc, HGDIOBJ(fill.0));
    let old_pen = SelectObject(hdc, HGDIOBJ(border.0));
    let _ = RoundRect(hdc, rect.left, rect.top, rect.right, rect.bottom, 22, 22);
    let _ = SelectObject(hdc, old_brush);
    let _ = SelectObject(hdc, old_pen);
    let _ = DeleteObject(HGDIOBJ(fill.0));
    let _ = DeleteObject(HGDIOBJ(border.0));

    // Vollbild-Icon: vier weisse Eck-Klammern (universelles "Fullscreen"-Symbol).
    let icon_pen = CreatePen(PS_SOLID, 2, COLORREF(0x00ff_ffff));
    let old_icon = SelectObject(hdc, HGDIOBJ(icon_pen.0));
    let cx = (rect.left + rect.right) / 2;
    let cy = (rect.top + rect.bottom) / 2;
    let (hw, hh, arm) = (9, 7, 6);
    let (l, r, t, b) = (cx - hw, cx + hw, cy - hh, cy + hh);
    // Jede Klammer als Polyline: zwei Arme, die in der Ecke zusammentreffen.
    let bracket = |x0: i32, y0: i32, x1: i32, y1: i32, x2: i32, y2: i32| unsafe {
        let _ = MoveToEx(hdc, x0, y0, None);
        let _ = LineTo(hdc, x1, y1);
        let _ = LineTo(hdc, x2, y2);
    };
    bracket(l, t + arm, l, t, l + arm, t); // oben links
    bracket(r - arm, t, r, t, r, t + arm); // oben rechts
    bracket(l, b - arm, l, b, l + arm, b); // unten links
    bracket(r - arm, b, r, b, r, b - arm); // unten rechts
    let _ = SelectObject(hdc, old_icon);
    let _ = DeleteObject(HGDIOBJ(icon_pen.0));
}

#[cfg(windows)]
struct OverlayState {
    desktop: VirtualDesktop,
    dimmed_bgra: Vec<u8>,
    // Ungedimmtes Original — wird in WM_PAINT nur innerhalb der Auswahl wieder hell gemalt.
    original_bgra: Vec<u8>,
    start: Option<(i32, i32)>,
    current: Option<(i32, i32)>,
    result: Option<Option<Selection>>,
    monitors: Vec<windows::Win32::Foundation::RECT>,
    button_rects: Vec<windows::Win32::Foundation::RECT>,
    hovered_button: Option<usize>,
}

#[cfg(windows)]
static OVERLAY_STATE: Mutex<Option<OverlayState>> = Mutex::new(None);

#[cfg(windows)]
fn run_selection_overlay(
    desktop: VirtualDesktop,
    mut bgra: Vec<u8>,
) -> Result<Option<Selection>, String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HINSTANCE;
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DispatchMessageW, GetMessageW, LoadCursorW, RegisterClassW, SetTimer,
        SetWindowPos, ShowWindow, TranslateMessage, CS_HREDRAW, CS_VREDRAW, HWND_TOPMOST, IDC_CROSS,
        MSG, SWP_NOACTIVATE, SWP_SHOWWINDOW, SW_SHOWNOACTIVATE, WINDOW_EX_STYLE, WNDCLASSW,
        WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
    };

    // Timer-ID fuer das fokus-unabhaengige Esc-Polling im Overlay.
    const ESCAPE_POLL_TIMER: usize = 1;

    // Dim-Faktor 62% einmal als Lookup-Table statt Multiplikation/Division pro Pixel.
    let dim_lut: [u8; 256] = core::array::from_fn(|i| ((i as u16 * 62) / 100) as u8);
    // Original vor dem Dimmen sichern — die Auswahl wird daraus wieder hell gemalt.
    let original_bgra = bgra.clone();
    for pixel in bgra.chunks_exact_mut(4) {
        pixel[0] = dim_lut[pixel[0] as usize];
        pixel[1] = dim_lut[pixel[1] as usize];
        pixel[2] = dim_lut[pixel[2] as usize];
        pixel[3] = 255;
    }

    let monitors = enumerate_monitors();
    let button_rects = compute_button_rects(&monitors, desktop);

    {
        let mut state = OVERLAY_STATE.lock().map_err(|error| error.to_string())?;
        *state = Some(OverlayState {
            desktop,
            dimmed_bgra: bgra,
            original_bgra,
            start: None,
            current: None,
            result: None,
            monitors,
            button_rects,
            hovered_button: None,
        });
    }

    unsafe {
        let module = GetModuleHandleW(None).unwrap_or_default();
        let class_name: Vec<u16> = "SnipDropNativeSelection\0".encode_utf16().collect();
        let crosshair = LoadCursorW(None, IDC_CROSS).unwrap_or_default();
        let window_class = WNDCLASSW {
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(selection_wndproc),
            hInstance: HINSTANCE(module.0),
            hCursor: crosshair,
            lpszClassName: PCWSTR(class_name.as_ptr()),
            ..Default::default()
        };
        RegisterClassW(&window_class);

        let window = CreateWindowExW(
            WINDOW_EX_STYLE(WS_EX_TOPMOST.0 | WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0),
            PCWSTR(class_name.as_ptr()),
            PCWSTR(class_name.as_ptr()),
            WS_POPUP,
            desktop.x,
            desktop.y,
            desktop.width,
            desktop.height,
            None,
            None,
            Some(HINSTANCE(module.0)),
            None,
        )
        .map_err(|error| error.to_string())?;

        let _ = ShowWindow(window, SW_SHOWNOACTIVATE);
        let _ = SetWindowPos(
            window,
            Some(HWND_TOPMOST),
            desktop.x,
            desktop.y,
            desktop.width,
            desktop.height,
            SWP_SHOWWINDOW | SWP_NOACTIVATE,
        );
        // Das Overlay erzwingt BEWUSST keinen Vordergrund/Fokus. Es ist WS_EX_NOACTIVATE
        // und deckt als Topmost-Fenster den ganzen Desktop ab: die Maus liegt waehrend der
        // Auswahl immer darueber, also kommen alle Maus-Events ohne Aktivierung an, und Esc
        // wird unten fokus-unabhaengig per Timer (GetAsyncKeyState) gepollt. Damit bleibt das
        // zuvor aktive Fremdfenster (z. B. VS Code) im Vordergrund — SnipDrop wird nie selbst
        // das aktive Fenster, sonst blockiert der Windows-Foreground-Lock das naechste Overlay
        // mehrere Sekunden ("es passiert nichts / dauert ewig").
        let _ = SetTimer(Some(window), ESCAPE_POLL_TIMER, 40, None);

        // Beenden NUR ueber WM_QUIT (PostQuitMessage im wndproc, sobald Auswahl/Abbruch
        // feststeht). NICHT zusaetzlich auf state.result pruefen und breaken: sonst bliebe
        // das von PostQuitMessage gepostete WM_QUIT in der Thread-Queue liegen (Schleife
        // wird vorher per break verlassen) und wuerde die GetMessage-Schleife des NAECHSTEN
        // Overlays sofort beenden -> Cursor blitzt kurz als Kreuz auf, dann nichts; jedes
        // zweite Win+Shift+S waere tot. GetMessage konsumiert das WM_QUIT und liefert false.
        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }

        let result = {
            let mut state = OVERLAY_STATE.lock().map_err(|error| error.to_string())?;
            state.take().and_then(|state| state.result).flatten()
        };

        let _ = windows::Win32::UI::WindowsAndMessaging::DestroyWindow(window);
        Ok(result)
    }
}

#[cfg(windows)]
unsafe extern "system" fn selection_wndproc(
    window: windows::Win32::Foundation::HWND,
    message: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    use std::mem;
    use windows::Win32::Foundation::{COLORREF, LRESULT, RECT};
    use windows::Win32::Graphics::Gdi::{
        BeginPaint, BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, CreateRoundRectRgn,
        DeleteDC, DeleteObject, EndPaint, ExtCreatePen, GetStockObject, InvalidateRect, RoundRect,
        SelectClipRgn, SelectObject, SetDIBitsToDevice, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
        BS_SOLID, DIB_RGB_COLORS, HGDIOBJ, LOGBRUSH, NULL_BRUSH, PAINTSTRUCT, PS_ENDCAP_FLAT,
        PS_GEOMETRIC, PS_JOIN_MITER, PS_USERSTYLE, SRCCOPY,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, ReleaseCapture, SetCapture, VK_ESCAPE,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        DefWindowProcW, PostQuitMessage, WM_ERASEBKGND, WM_KEYDOWN, WM_LBUTTONDOWN, WM_LBUTTONUP,
        WM_MOUSEMOVE, WM_PAINT, WM_RBUTTONDOWN, WM_TIMER,
    };

    fn point_from_lparam(lparam: windows::Win32::Foundation::LPARAM) -> (i32, i32) {
        let value = lparam.0 as u32;
        let x = (value & 0xffff) as i16 as i32;
        let y = ((value >> 16) & 0xffff) as i16 as i32;
        (x, y)
    }

    fn normalized_rect(start: (i32, i32), current: (i32, i32)) -> RECT {
        RECT {
            left: start.0.min(current.0),
            top: start.1.min(current.1),
            right: start.0.max(current.0),
            bottom: start.1.max(current.1),
        }
    }

    fn button_at(rects: &[RECT], point: (i32, i32)) -> Option<usize> {
        rects.iter().position(|r| {
            point.0 >= r.left && point.0 < r.right && point.1 >= r.top && point.1 < r.bottom
        })
    }

    match message {
        WM_PAINT => {
            let mut paint = PAINTSTRUCT::default();
            let hdc = BeginPaint(window, &mut paint);
            if let Ok(state_guard) = OVERLAY_STATE.lock() {
                if let Some(state) = state_guard.as_ref() {
                    let width = state.desktop.width;
                    let height = state.desktop.height;

                    // Alles in einen Off-Screen-Buffer komponieren und am Ende mit einem
                    // einzigen BitBlt aufs Fenster bringen — sonst flackert die Auswahl, weil
                    // der gedimmte Hintergrund und das Rechteck nacheinander direkt auf den
                    // Bildschirm gemalt wuerden.
                    let mem_dc = CreateCompatibleDC(Some(hdc));
                    let mem_bmp = CreateCompatibleBitmap(hdc, width, height);
                    let old_bmp = SelectObject(mem_dc, HGDIOBJ(mem_bmp.0));

                    let bitmap_info = BITMAPINFO {
                        bmiHeader: BITMAPINFOHEADER {
                            biSize: mem::size_of::<BITMAPINFOHEADER>() as u32,
                            biWidth: width,
                            biHeight: -height,
                            biPlanes: 1,
                            biBitCount: 32,
                            biCompression: BI_RGB.0,
                            biSizeImage: (width * height * 4) as u32,
                            ..Default::default()
                        },
                        ..Default::default()
                    };
                    let _ = SetDIBitsToDevice(
                        mem_dc,
                        0,
                        0,
                        width as u32,
                        height as u32,
                        0,
                        0,
                        0,
                        height as u32,
                        state.dimmed_bgra.as_ptr() as *const std::ffi::c_void,
                        &bitmap_info,
                        DIB_RGB_COLORS,
                    );

                    if let (Some(start), Some(current)) = (state.start, state.current) {
                        let rect = normalized_rect(start, current);
                        if rect.right - rect.left > 1 && rect.bottom - rect.top > 1 {
                            // Auswahl wieder hell: das ungedimmte Original NUR innerhalb der
                            // Auswahl (abgerundete Clip-Region wie die Umrandung) ueber den
                            // gedimmten Hintergrund malen. SetDIBitsToDevice respektiert die
                            // Clip-Region des DC.
                            let region = CreateRoundRectRgn(
                                rect.left,
                                rect.top,
                                rect.right + 1,
                                rect.bottom + 1,
                                16,
                                16,
                            );
                            let _ = SelectClipRgn(mem_dc, Some(region));
                            let _ = SetDIBitsToDevice(
                                mem_dc,
                                0,
                                0,
                                width as u32,
                                height as u32,
                                0,
                                0,
                                0,
                                height as u32,
                                state.original_bgra.as_ptr() as *const std::ffi::c_void,
                                &bitmap_info,
                                DIB_RGB_COLORS,
                            );
                            let _ = SelectClipRgn(mem_dc, None);
                            let _ = DeleteObject(HGDIOBJ(region.0));

                            // Gestrichelte weisse Umrandung: ein 2px breiter Pen muss
                            // geometrisch sein, damit PS_DASH ueberhaupt strichelt
                            // (kosmetische Pens stricheln nur bei Breite 1).
                            let brush = LOGBRUSH {
                                lbStyle: BS_SOLID,
                                lbColor: COLORREF(
                                    SELECTION_COLOR.load(std::sync::atomic::Ordering::Relaxed),
                                ),
                                lbHatch: 0,
                            };
                            // Eigenes Strichmuster [Strich, Luecke] in Pixeln — groessere
                            // Luecken fuer einen luftigeren Look.
                            let dash_pattern: [u32; 2] = [6, 10];
                            let pen = ExtCreatePen(
                                PS_GEOMETRIC | PS_USERSTYLE | PS_ENDCAP_FLAT | PS_JOIN_MITER,
                                2,
                                &brush,
                                Some(&dash_pattern),
                            );
                            let old_pen = SelectObject(mem_dc, HGDIOBJ(pen.0));
                            let old_brush = SelectObject(mem_dc, GetStockObject(NULL_BRUSH));
                            // Abgerundete Ecken (Durchmesser 16 = ~8px Radius) fuer einen
                            // moderneren Look.
                            let _ = RoundRect(
                                mem_dc,
                                rect.left,
                                rect.top,
                                rect.right,
                                rect.bottom,
                                16,
                                16,
                            );
                            let _ = SelectObject(mem_dc, old_brush);
                            let _ = SelectObject(mem_dc, old_pen);
                            let _ = DeleteObject(HGDIOBJ(pen.0));
                        }
                    }

                    // "Ganzer Bildschirm"-Button pro Monitor oben mittig zeichnen.
                    for (i, btn) in state.button_rects.iter().enumerate() {
                        draw_fullscreen_button(mem_dc, *btn, state.hovered_button == Some(i));
                    }

                    let _ = BitBlt(hdc, 0, 0, width, height, Some(mem_dc), 0, 0, SRCCOPY);

                    let _ = SelectObject(mem_dc, old_bmp);
                    let _ = DeleteObject(HGDIOBJ(mem_bmp.0));
                    let _ = DeleteDC(mem_dc);
                }
            }
            let _ = EndPaint(window, &paint);
            LRESULT(0)
        }
        WM_ERASEBKGND => {
            // Hintergrund nicht separat loeschen — der gesamte sichtbare Bereich wird in
            // WM_PAINT per BitBlt ueberschrieben. Verhindert Rest-Flackern.
            LRESULT(1)
        }
        WM_LBUTTONDOWN => {
            let point = point_from_lparam(lparam);
            // Klick auf einen "Ganzer Bildschirm"-Button: gesamten Monitor als Auswahl liefern,
            // statt eine Rechteck-Auswahl zu starten.
            let mut button_hit = false;
            if let Ok(mut state_guard) = OVERLAY_STATE.lock() {
                if let Some(state) = state_guard.as_mut() {
                    if let Some(index) = button_at(&state.button_rects, point) {
                        let monitor = state.monitors[index];
                        state.result = Some(Some(Selection {
                            x: monitor.left,
                            y: monitor.top,
                            width: monitor.right - monitor.left,
                            height: monitor.bottom - monitor.top,
                        }));
                        button_hit = true;
                    } else {
                        state.start = Some(point);
                        state.current = Some(point);
                    }
                }
            }
            if button_hit {
                let _ = ReleaseCapture();
                PostQuitMessage(0);
            } else {
                let _ = SetCapture(window);
            }
            LRESULT(0)
        }
        WM_MOUSEMOVE => {
            let point = point_from_lparam(lparam);
            if let Ok(mut state_guard) = OVERLAY_STATE.lock() {
                if let Some(state) = state_guard.as_mut() {
                    if state.start.is_some() {
                        state.current = Some(point);
                        let _ = InvalidateRect(Some(window), None, false);
                    } else {
                        // Hover-Highlight der Buttons, solange keine Auswahl laeuft.
                        let hovered = button_at(&state.button_rects, point);
                        if hovered != state.hovered_button {
                            state.hovered_button = hovered;
                            let _ = InvalidateRect(Some(window), None, false);
                        }
                    }
                }
            }
            LRESULT(0)
        }
        WM_LBUTTONUP => {
            let point = point_from_lparam(lparam);
            if let Ok(mut state_guard) = OVERLAY_STATE.lock() {
                if let Some(state) = state_guard.as_mut() {
                    state.current = Some(point);
                    if let Some(start) = state.start {
                        let rect = normalized_rect(start, point);
                        let width = rect.right - rect.left;
                        let height = rect.bottom - rect.top;
                        state.result = Some(if width >= 2 && height >= 2 {
                            Some(Selection {
                                x: state.desktop.x + rect.left,
                                y: state.desktop.y + rect.top,
                                width,
                                height,
                            })
                        } else {
                            None
                        });
                    } else {
                        state.result = Some(None);
                    }
                }
            }
            let _ = ReleaseCapture();
            PostQuitMessage(0);
            LRESULT(0)
        }
        WM_RBUTTONDOWN => {
            if let Ok(mut state_guard) = OVERLAY_STATE.lock() {
                if let Some(state) = state_guard.as_mut() {
                    state.result = Some(None);
                }
            }
            let _ = ReleaseCapture();
            PostQuitMessage(0);
            LRESULT(0)
        }
        WM_KEYDOWN if wparam.0 as u16 == VK_ESCAPE.0 => {
            if let Ok(mut state_guard) = OVERLAY_STATE.lock() {
                if let Some(state) = state_guard.as_mut() {
                    state.result = Some(None);
                }
            }
            let _ = ReleaseCapture();
            PostQuitMessage(0);
            LRESULT(0)
        }
        // Fokus-unabhaengiges Esc-Sicherheitsnetz: pollt den physischen Tasten-Zustand,
        // damit Esc das Overlay auch dann abbricht, wenn das Fenster (Randfall) keinen
        // Tastatur-Fokus bekommen hat und WM_KEYDOWN ausbleibt.
        WM_TIMER => {
            if (GetAsyncKeyState(VK_ESCAPE.0 as i32) as u16 & 0x8000) != 0 {
                if let Ok(mut state_guard) = OVERLAY_STATE.lock() {
                    if let Some(state) = state_guard.as_mut() {
                        state.result = Some(None);
                    }
                }
                let _ = ReleaseCapture();
                PostQuitMessage(0);
            }
            LRESULT(0)
        }
        _ => DefWindowProcW(window, message, wparam, lparam),
    }
}

#[cfg(windows)]
fn open_clipboard_with_retry() -> Result<(), String> {
    use windows::Win32::System::DataExchange::OpenClipboard;

    for attempt in 0..10 {
        if attempt > 0 {
            thread::sleep(Duration::from_millis(35));
        }
        if unsafe { OpenClipboard(None) }.is_ok() {
            return Ok(());
        }
    }

    Err("Could not open the clipboard.".to_string())
}

#[cfg(windows)]
fn write_clipboard_image(image: &CapturedImage, png_bytes: &[u8], path: &str) -> Result<(), String> {
    use std::{mem, ptr};
    use windows::core::PCWSTR;
    use windows::Win32::{
        Foundation::HANDLE,
        Graphics::Gdi::{BITMAPINFOHEADER, BI_RGB},
        System::{
            DataExchange::{
                CloseClipboard, EmptyClipboard, RegisterClipboardFormatW, SetClipboardData,
            },
            Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE},
            Ole::{CF_DIB, CF_HDROP, CF_UNICODETEXT},
        },
    };

    unsafe {
        open_clipboard_with_retry()?;
        EmptyClipboard().map_err(|error| error.to_string())?;

        let png_format_name: Vec<u16> = "PNG".encode_utf16().chain(std::iter::once(0)).collect();
        let png_format = RegisterClipboardFormatW(PCWSTR(png_format_name.as_ptr()));
        if png_format != 0 {
            let png_handle =
                GlobalAlloc(GMEM_MOVEABLE, png_bytes.len()).map_err(|error| error.to_string())?;
            let png_ptr = GlobalLock(png_handle);
            if png_ptr.is_null() {
                CloseClipboard().ok();
                return Err("Could not lock clipboard PNG memory.".to_string());
            }
            ptr::copy_nonoverlapping(png_bytes.as_ptr(), png_ptr as *mut u8, png_bytes.len());
            GlobalUnlock(png_handle).ok();
            SetClipboardData(png_format, Some(HANDLE(png_handle.0)))
                .map_err(|error| error.to_string())?;
        }

        let header_size = mem::size_of::<BITMAPINFOHEADER>();
        let bitmap_size = image.bgra.len();
        let row_len = image.width as usize * 4;
        let mut bottom_up_bgra = Vec::with_capacity(bitmap_size);
        for y in (0..image.height as usize).rev() {
            let start = y * row_len;
            bottom_up_bgra.extend_from_slice(&image.bgra[start..start + row_len]);
        }

        let dib_handle = GlobalAlloc(GMEM_MOVEABLE, header_size + bitmap_size)
            .map_err(|error| error.to_string())?;
        let dib_ptr = GlobalLock(dib_handle);
        if dib_ptr.is_null() {
            CloseClipboard().ok();
            return Err("Could not lock clipboard image memory.".to_string());
        }

        let header = BITMAPINFOHEADER {
            biSize: header_size as u32,
            biWidth: image.width,
            biHeight: image.height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            biSizeImage: bitmap_size as u32,
            ..Default::default()
        };

        ptr::copy_nonoverlapping(
            &header as *const BITMAPINFOHEADER as *const u8,
            dib_ptr as *mut u8,
            header_size,
        );
        ptr::copy_nonoverlapping(
            bottom_up_bgra.as_ptr(),
            (dib_ptr as *mut u8).add(header_size),
            bitmap_size,
        );
        GlobalUnlock(dib_handle).ok();

        SetClipboardData(CF_DIB.0 as u32, Some(HANDLE(dib_handle.0)))
            .map_err(|error| error.to_string())?;

        // Den Dateipfad als CF_UNICODETEXT ablegen. Das ist das entscheidende
        // Format fuer Terminals/CLI: die fuegen beim Strg+V nur Text ein und
        // schauen weder auf CF_DIB (Bitmap) noch CF_HDROP. Chat-Apps bevorzugen
        // weiter die Bitmap, also bleibt das Bild-Pasten unveraendert.
        if !path.is_empty() {
            let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
            let byte_len = wide.len() * mem::size_of::<u16>();
            let text_handle =
                GlobalAlloc(GMEM_MOVEABLE, byte_len).map_err(|error| error.to_string())?;
            let text_ptr = GlobalLock(text_handle);
            if text_ptr.is_null() {
                CloseClipboard().ok();
                return Err("Could not lock clipboard path-text memory.".to_string());
            }
            ptr::copy_nonoverlapping(wide.as_ptr() as *const u8, text_ptr as *mut u8, byte_len);
            GlobalUnlock(text_handle).ok();
            SetClipboardData(CF_UNICODETEXT.0 as u32, Some(HANDLE(text_handle.0)))
                .map_err(|error| error.to_string())?;
        }

        // Zusaetzlich den Dateipfad als CF_HDROP (File-Drop) ablegen, damit auch
        // Explorer und andere datei-orientierte Ziele den PNG-Pfad einfuegen.
        if !path.is_empty() {
            // DROPFILES-Header (20 Bytes) + doppelt-null-terminierte UTF-16-Pfadliste.
            let path_wide: Vec<u16> = path.encode_utf16().collect();
            let mut drop_buf: Vec<u8> = Vec::new();
            drop_buf.extend_from_slice(&20u32.to_le_bytes()); // pFiles: Offset der Liste
            drop_buf.extend_from_slice(&0i32.to_le_bytes()); // pt.x
            drop_buf.extend_from_slice(&0i32.to_le_bytes()); // pt.y
            drop_buf.extend_from_slice(&0i32.to_le_bytes()); // fNC
            drop_buf.extend_from_slice(&1i32.to_le_bytes()); // fWide = TRUE
            for unit in &path_wide {
                drop_buf.extend_from_slice(&unit.to_le_bytes());
            }
            drop_buf.extend_from_slice(&0u16.to_le_bytes()); // Null-Terminator des Pfads
            drop_buf.extend_from_slice(&0u16.to_le_bytes()); // doppeltes Null = Listenende

            let drop_handle =
                GlobalAlloc(GMEM_MOVEABLE, drop_buf.len()).map_err(|error| error.to_string())?;
            let drop_ptr = GlobalLock(drop_handle);
            if drop_ptr.is_null() {
                CloseClipboard().ok();
                return Err("Could not lock clipboard file-drop memory.".to_string());
            }
            ptr::copy_nonoverlapping(drop_buf.as_ptr(), drop_ptr as *mut u8, drop_buf.len());
            GlobalUnlock(drop_handle).ok();
            SetClipboardData(CF_HDROP.0 as u32, Some(HANDLE(drop_handle.0)))
                .map_err(|error| error.to_string())?;
        }

        CloseClipboard().map_err(|error| error.to_string())?;
    }

    Ok(())
}

#[cfg(not(windows))]
fn write_clipboard_image(_image: &CapturedImage, _png_bytes: &[u8], _path: &str) -> Result<(), String> {
    Err("Clipboard-Bilddaten sind nur unter Windows implementiert.".to_string())
}

#[cfg(windows)]
fn write_clipboard_text(text: &str) -> Result<(), String> {
    use std::{mem, ptr};
    use windows::Win32::{
        Foundation::HANDLE,
        System::{
            DataExchange::{CloseClipboard, EmptyClipboard, SetClipboardData},
            Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE},
            Ole::CF_UNICODETEXT,
        },
    };

    unsafe {
        open_clipboard_with_retry()?;
        EmptyClipboard().map_err(|error| error.to_string())?;

        let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        let byte_len = wide.len() * mem::size_of::<u16>();
        let handle = GlobalAlloc(GMEM_MOVEABLE, byte_len).map_err(|error| error.to_string())?;
        let ptr_out = GlobalLock(handle);
        if ptr_out.is_null() {
            CloseClipboard().ok();
            return Err("Could not lock clipboard text memory.".to_string());
        }
        ptr::copy_nonoverlapping(wide.as_ptr() as *const u8, ptr_out as *mut u8, byte_len);
        GlobalUnlock(handle).ok();
        SetClipboardData(CF_UNICODETEXT.0 as u32, Some(HANDLE(handle.0)))
            .map_err(|error| error.to_string())?;
        CloseClipboard().map_err(|error| error.to_string())?;
    }

    Ok(())
}

#[cfg(not(windows))]
fn write_clipboard_text(_text: &str) -> Result<(), String> {
    Err("Clipboard-Text ist nur unter Windows implementiert.".to_string())
}

fn build_tray_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<Menu<R>, String> {
    use tauri_plugin_autostart::ManagerExt;
    let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart_label = if autostart_on {
        "✓ Autostart beim Windows-Start"
    } else {
        "Autostart beim Windows-Start"
    };
    let open_item = MenuItem::with_id(app, "open", "Open SnipDrop", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let folder_item =
        MenuItem::with_id(app, "folder", "Screenshot-Ordner oeffnen", true, None::<&str>)
            .map_err(|error| error.to_string())?;
    let autostart_item =
        MenuItem::with_id(app, "autostart", autostart_label, true, None::<&str>)
            .map_err(|error| error.to_string())?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    Menu::with_items(app, &[&open_item, &folder_item, &autostart_item, &quit_item])
        .map_err(|error| error.to_string())
}

fn setup_tray(app: &tauri::AppHandle, tooltip: &str) -> Result<(), String> {
    let menu = build_tray_menu(app)?;

    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip(tooltip)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            "folder" => {
                let _ = open_output_dir();
            }
            "autostart" => {
                use tauri_plugin_autostart::ManagerExt;
                let manager = app.autolaunch();
                let _ = if manager.is_enabled().unwrap_or(false) {
                    manager.disable()
                } else {
                    manager.enable()
                };
                if let Ok(new_menu) = build_tray_menu(app) {
                    if let Some(tray) = app.tray_by_id("main") {
                        let _ = tray.set_menu(Some(new_menu));
                    }
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    // Eigenes, flaches Tray-Icon: das glaenzende 3D-Icon zerfaellt bei 16-24px
    // zu Matsch. tray.png ist eine flache, kontrastreiche Variante, die bei
    // kleinen Tray-Groessen scharf bleibt (statt das herunterskalierte
    // Fenster-Icon zu verwenden).
    builder = builder.icon(tauri::include_image!("icons/tray.png"));

    builder.build(app).map_err(|error| error.to_string())?;
    Ok(())
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn set_hotkey_status(app: &tauri::AppHandle, ok: bool, message: impl Into<String>) {
    let status = HotkeyStatus {
        ok,
        message: message.into(),
    };
    if let Ok(mut state_status) = app.state::<AppState>().hotkey_status.lock() {
        *state_status = status.clone();
    }
    let _ = app.emit("hotkey-status", status);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // MUSS als erstes Plugin registriert werden: faengt jeden weiteren Start ab,
        // bevor eine zweite snipdrop.exe ein eigenes Fenster/Tray aufbaut. Statt einer
        // neuen Instanz holt der Callback in der LAUFENDEN App das Fenster nach vorne.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            let needs_onboarding = app
                .state::<AppState>()
                .settings
                .lock()
                .map(|settings| !settings.onboarded)
                .unwrap_or(false);
            if needs_onboarding {
                if let Some(welcome) = app.get_webview_window("welcome") {
                    let _ = welcome.show();
                    let _ = welcome.set_focus();
                }
            } else {
                show_main_window(app);
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            // Windows-Autostart startet SnipDrop mit diesem Flag, damit der
            // Boot-Start lautlos im Tray bleibt. Ein manueller Start (Doppelklick,
            // Installer-"Run SnipDrop") hat das Flag NICHT und zeigt darum ein
            // Fenster — sonst landet der Nutzer im unsichtbaren Tray (siehe setup()).
            Some(vec!["--minimized"]),
        ))
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState {
            latest_shot: Mutex::new(None),
            hotkey_status: Mutex::new(HotkeyStatus {
                ok: false,
                message: "Hotkey-Hook wird gestartet.".to_string(),
            }),
            last_image_hash: Mutex::new(None),
            hotkey: Mutex::new(HotkeyConfig::default()),
            settings: Mutex::new(AppSettings::default()),
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let _ = APP_HANDLE.set(handle.clone());

            // Hotkey ist fest Win + Shift + S. Einen evtl. frueher gespeicherten
            // Custom-Hotkey (z. B. Alt+F) loeschen, damit er nicht weiter aktiv ist.
            if let Some(path) = hotkey_config_path(&handle) {
                let _ = fs::remove_file(path);
            }
            let hotkey = HotkeyConfig::default();
            apply_hotkey(&hotkey);
            if let Ok(mut current) = handle.state::<AppState>().hotkey.lock() {
                *current = hotkey.clone();
            }

            // Gespeicherte App-Einstellungen laden (falls vorhanden).
            let settings = load_settings(&handle).unwrap_or_default();
            // Vor dem Move in den State merken, ob das First-Run-Onboarding noch aussteht.
            let needs_onboarding = !settings.onboarded;
            if let Some(color) = parse_hex_color(&settings.selection_color) {
                SELECTION_COLOR.store(color, std::sync::atomic::Ordering::Relaxed);
            }
            if !settings.screenshot_dir.trim().is_empty() {
                if let Ok(mut current) = SCREENSHOT_DIR.lock() {
                    *current = settings.screenshot_dir.clone();
                }
                // Gespeicherten Custom-Ordner fuers asset:-Protokoll freigeben
                // (siehe set_settings) — sonst bleibt das Thumbnail nach Neustart leer.
                let _ = handle
                    .asset_protocol_scope()
                    .allow_directory(&settings.screenshot_dir, true);
            }
            if let Ok(mut current) = handle.state::<AppState>().settings.lock() {
                *current = settings;
            }

            let hook_result = start_hotkey_hook();
            let tooltip = match hook_result {
                Ok(()) => {
                    set_hotkey_status(
                        &handle,
                        true,
                        format!("Bereit: {} startet SnipDrop Rechteck-Snip.", hotkey.label),
                    );
                    "SnipDrop ready".to_string()
                }
                Err(error) => {
                    set_hotkey_status(
                        &handle,
                        false,
                        format!("Error: {} is not active.", hotkey.label),
                    );
                    let _ = handle.emit("capture-error", error);
                    show_main_window(&handle);
                    "SnipDrop - Hotkey error".to_string()
                }
            };
            setup_tray(&handle, &tooltip)?;

            // Thumbnail-Webview beim Start vorwaermen: ein verstecktes WebView2-Fenster
            // macht seinen Kaltstart (Prozess + React-Mount + Listener-Registrierung) erst
            // beim ersten show(). Ohne Vorwaermen erscheint das erste Thumbnail nach einem
            // Snip deshalb mit 1-3 s Verzoegerung. Wir zeigen es einmal weit off-screen,
            // erzwingen so den Kaltstart jetzt und verstecken es wieder, sobald es bereit ist.
            if let Some(thumbnail) = handle.get_webview_window("thumbnail") {
                let _ = thumbnail.set_position(tauri::PhysicalPosition::new(-10000, -10000));
                let _ = thumbnail.show();

                // Frontend meldet per "thumbnail-ready", sobald Mount + Listener stehen.
                let warm = thumbnail.clone();
                handle.once("thumbnail-ready", move |_| {
                    let _ = warm.hide();
                });

                // Fallback, falls das Event ausbleibt: nach 1500 ms verstecken — aber nur,
                // wenn noch kein echter Snip lief (sonst wuerde ein legitimes Thumbnail
                // weggeraeumt).
                let warm_fallback = thumbnail.clone();
                let state_handle = handle.clone();
                thread::spawn(move || {
                    thread::sleep(Duration::from_millis(1500));
                    let has_shot = state_handle
                        .state::<AppState>()
                        .latest_shot
                        .lock()
                        .map(|shot| shot.is_some())
                        .unwrap_or(false);
                    if !has_shot {
                        let _ = warm_fallback.hide();
                    }
                });
            }

            // Schliessen des Hauptfensters beendet SnipDrop nicht; die App bleibt
            // im Tray aktiv und faengt den Hotkey weiter nativ ab.
            if let Some(main) = app.get_webview_window("main") {
                let main_clone = main.clone();
                main.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = main_clone.hide();
                    }
                });
            }

            // Editor-Fenster schliesst nicht die App, sondern versteckt sich. Beim
            // Verstecken kehrt das Eck-Thumbnail (jetzt annotiert) zurueck, damit Drag
            // aus der Ecke weiter funktioniert.
            if let Some(editor) = app.get_webview_window("editor") {
                let editor_clone = editor.clone();
                let editor_handle = handle.clone();
                editor.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = editor_clone.hide();
                        let latest = editor_handle
                            .state::<AppState>()
                            .latest_shot
                            .lock()
                            .ok()
                            .and_then(|shot| shot.clone());
                        if let Some(shot) = latest {
                            let _ = show_thumbnail(&editor_handle, &shot);
                        }
                    }
                });
            }

            // First-Run-Onboarding: Das Welcome-Fenster nur beim allerersten Start
            // (onboarded == false) zeigen. Schliesst der Nutzer es ueber das X statt
            // ueber "Los geht's", markieren wir das Onboarding trotzdem als gesehen,
            // damit es nicht bei jedem Start erneut aufploppt.
            if let Some(welcome) = app.get_webview_window("welcome") {
                let welcome_handle = handle.clone();
                welcome.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { .. } = event {
                        let to_save = welcome_handle
                            .state::<AppState>()
                            .settings
                            .lock()
                            .ok()
                            .map(|mut settings| {
                                settings.onboarded = true;
                                settings.clone()
                            });
                        if let Some(settings) = to_save {
                            save_settings(&welcome_handle, &settings);
                        }
                    }
                });
                if needs_onboarding {
                    let _ = welcome.show();
                    let _ = welcome.set_focus();
                }
            }

            // Beim allerersten Start zeigt das Welcome-Fenster (oben). Ist der Nutzer
            // bereits eingefuehrt, soll trotzdem das Hauptfenster aufgehen, wenn er
            // SnipDrop MANUELL gestartet hat (Doppelklick / Installer-"Run SnipDrop") —
            // sonst verschwindet die App kommentarlos ins Tray und viele finden sie
            // dort nie. Nur der Windows-Autostart (mit --minimized) bleibt lautlos.
            let autostart_launch = std::env::args().any(|arg| arg == "--minimized");
            if !needs_onboarding && !autostart_launch {
                show_main_window(&handle);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            latest_shot,
            hotkey_status,
            copy_latest,
            copy_latest_path,
            send_shot_to_ssh,
            test_ssh_connection,
            list_remote_shots,
            fetch_remote_shot,
            delete_remote_shot,
            copy_text,
            pick_ssh_key_file,
            pick_screenshot_dir,
            reveal_latest,
            list_shots,
            copy_shot,
            open_screenshots_dir,
            delete_shot,
            dismiss_thumbnail,
            open_editor,
            save_annotated,
            get_hotkey,
            get_settings,
            set_settings,
            open_support_link,
            complete_onboarding,
            get_autostart,
            set_autostart
        ])
        .run(tauri::generate_context!())
        .expect("error while running SnipDrop");
}
