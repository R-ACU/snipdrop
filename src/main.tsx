import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { check as checkUpdate } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  Settings,
  ArrowLeft,
  Minus,
  Square,
  Copy,
  X,
  Send,
  RefreshCw,
  Eye,
  Trash2,
  Server,
  Info,
  Lock,
  Download,
  CheckCircle2,
} from "lucide-react";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import logoUrl from "../design/snipdrop-icon-3d.png";
import { LangProvider, useLang, useT, type Lang, type TranslationKey } from "./i18n";
import "./styles.css";

type Shot = {
  id: string;
  path: string;
  fileName: string;
  dataUrl: string;
  width: number;
  height: number;
  createdAt: number;
};

type ShotMeta = {
  id: string;
  path: string;
  fileName: string;
  width: number;
  height: number;
  createdAt: number;
};

type HotkeyStatus = {
  ok: boolean;
  message: string;
};

// Ein Screenshot im Remote-SSH-Ordner (SSH-Galerie-Tab).
type RemoteShot = {
  name: string;
  path: string;
  size: number;
  modified: number;
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function formatDate(unixSeconds: number): string {
  if (!unixSeconds) return "";
  return new Date(unixSeconds * 1000).toLocaleString();
}

// Wie das Eck-Thumbnail verschwindet — muss mit dem Rust-Backend übereinstimmen.
type ThumbnailDismiss = "timeout" | "paste" | "never";

type AppSettings = {
  thumbnailDismiss: ThumbnailDismiss;
  selectionColor: string;
  sshHost: string;
  sshRemoteDir: string;
  sshIdentityFile: string;
  sshAuto: boolean;
  sshRetentionDays: number;
  theme: "light" | "dark";
  screenshotDir: string;
  captureCount: number;
  supportMilestoneShown: number;
};

// Capture-Meilensteine, an denen das Support-Popup erscheint (je genau einmal).
const SUPPORT_MILESTONES = [50, 100, 250, 500, 1000, 2500, 5000];

// Hoechster erreichter Meilenstein <= count (oder null, wenn keiner erreicht).
function reachedMilestone(count: number): number | null {
  let hit: number | null = null;
  for (const m of SUPPORT_MILESTONES) {
    if (count >= m) hit = m;
  }
  return hit;
}

// Auto-Ausblenden im "timeout"-Modus.
const THUMBNAIL_TIMEOUT_MS = 3000;

// Feedback-Versand läuft über Web3Forms (kein eigenes Backend nötig). Der Access-Key
// ist bei Web3Forms bewusst client-seitig/öffentlich (er routet nur an die Mailbox,
// die bei web3forms.com hinterlegt ist) — deshalb steht er hier offen im Client-Code.
const WEB3FORMS_ACCESS_KEY = "a3fede5c-b288-4015-81bf-b925e6e733bc";
const WEB3FORMS_ENDPOINT = "https://api.web3forms.com/submit";

const currentWindow = getCurrentWindow();

// Farbschema aufs Dokument anwenden (steuert die [data-theme="dark"]-CSS-Regeln).
function applyTheme(theme: string | undefined) {
  document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";
}

// Eigene Fensterleiste (frameless Window, decorations:false) — Clean-Style statt
// der Standard-Windows-Leiste. Die ganze Leiste ist Drag-Region; nur die Buttons
// reagieren auf Klicks.
function TitleBar() {
  const t = useT();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    void currentWindow.isMaximized().then(setMaximized).catch(() => {});
    const unlisten = currentWindow.onResized(() => {
      void currentWindow.isMaximized().then(setMaximized).catch(() => {});
    });
    return () => {
      void unlisten.then((callback) => callback());
    };
  }, []);

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-controls">
        <button
          type="button"
          className="titlebar-button"
          aria-label={t("titlebar.minimize")}
          title={t("titlebar.minimize")}
          onClick={() => void currentWindow.minimize().catch(() => {})}
        >
          <Minus size={16} strokeWidth={1.6} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="titlebar-button"
          aria-label={maximized ? t("titlebar.restore") : t("titlebar.maximize")}
          title={maximized ? t("titlebar.restore") : t("titlebar.maximize")}
          onClick={() => void currentWindow.toggleMaximize().catch(() => {})}
        >
          {maximized ? (
            <Copy size={13} strokeWidth={1.6} aria-hidden="true" />
          ) : (
            <Square size={13} strokeWidth={1.6} aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          className="titlebar-button danger"
          aria-label={t("titlebar.close")}
          title={t("titlebar.close")}
          onClick={() => void currentWindow.close().catch(() => {})}
        >
          <X size={16} strokeWidth={1.6} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function App() {
  if (currentWindow.label === "thumbnail") {
    return <ThumbnailDock />;
  }

  if (currentWindow.label === "editor") {
    return <EditorWindow />;
  }

  if (currentWindow.label === "welcome") {
    return <WelcomeWindow />;
  }

  return <MainWindow />;
}

// First-Run-Onboarding. Erscheint nur beim allerersten Start (Backend zeigt das
// "welcome"-Fenster, solange settings.onboarded == false). Zeigt die vier
// Kernschritte, bietet einen Autostart-Schalter und fuehrt per "Los geht's"
// (complete_onboarding) ins Hauptfenster.
function WelcomeWindow() {
  const t = useT();
  const [autostart, setAutostart] = useState(false);
  const [version, setVersion] = useState("");

  useEffect(() => {
    void invoke<boolean>("get_autostart").then(setAutostart).catch(() => {});
    void getVersion().then(setVersion).catch(() => {});
  }, []);

  const toggleAutostart = useCallback((next: boolean) => {
    setAutostart(next);
    void invoke("set_autostart", { enabled: next }).catch(() => {
      // Konnte nicht gesetzt werden -> Schalter wieder zuruecknehmen.
      setAutostart((prev) => !prev);
    });
  }, []);

  const finish = useCallback(() => {
    void invoke("complete_onboarding").catch(() => {});
  }, []);

  const steps: { key: string; titleKey: TranslationKey; bodyKey: TranslationKey }[] = [
    { key: "snip", titleKey: "welcome.step1.title", bodyKey: "welcome.step1.body" },
    { key: "paste", titleKey: "welcome.step2.title", bodyKey: "welcome.step2.body" },
    { key: "drag", titleKey: "welcome.step3.title", bodyKey: "welcome.step3.body" },
    { key: "annotate", titleKey: "welcome.step4.title", bodyKey: "welcome.step4.body" },
  ];

  return (
    <div className="welcome">
      <div className="welcome-titlebar" data-tauri-drag-region>
        <button
          type="button"
          className="titlebar-button danger"
          aria-label={t("titlebar.close")}
          title={t("titlebar.close")}
          onClick={() => void currentWindow.close().catch(() => {})}
        >
          <X size={16} strokeWidth={1.6} aria-hidden="true" />
        </button>
      </div>
      <div className="welcome-body">
        <img className="welcome-logo" src={logoUrl} alt="SnipDrop" />
        <h1 className="welcome-title">{t("welcome.title")}</h1>
        <p className="welcome-subtitle">{t("welcome.subtitle")}</p>
        <ol className="welcome-steps">
          {steps.map((step, index) => (
            <li key={step.key} className="welcome-step">
              <span className="welcome-step-num">{index + 1}</span>
              <div className="welcome-step-text">
                <strong>{t(step.titleKey)}</strong>
                <span>{t(step.bodyKey)}</span>
              </div>
            </li>
          ))}
        </ol>
        <label className="welcome-autostart">
          <input
            type="checkbox"
            checked={autostart}
            onChange={(event) => toggleAutostart(event.target.checked)}
          />
          <span>{t("welcome.autostart")}</span>
        </label>
        <button type="button" className="welcome-cta" onClick={finish}>
          {t("welcome.cta")}
        </button>
        {version ? <span className="welcome-version">v{version}</span> : null}
      </div>
    </div>
  );
}

function MainWindow() {
  const t = useT();
  const [shots, setShots] = useState<ShotMeta[]>([]);
  const [view, setView] = useState<"gallery" | "settings">("gallery");
  const [galleryTab, setGalleryTab] = useState<"local" | "ssh">("local");
  // Status/Anzahl der SSH-Galerie, hochgereicht für die Anzeige im Header.
  const [remoteInfo, setRemoteInfo] = useState<{
    status: "idle" | "loading" | "error";
    count: number;
  }>({ status: "idle", count: 0 });
  // Refresh-Funktion der SSH-Galerie, damit der Header-Button sie auslösen kann.
  const remoteRefreshRef = useRef<(() => void) | null>(null);
  const [hotkeyStatus, setHotkeyStatus] = useState<HotkeyStatus>({
    ok: true,
    message: "",
  });
  // Ist ein SSH-Ziel konfiguriert? Steuert, ob der "Per SSH senden"-Button aktiv ist.
  const [sshConfigured, setSshConfigured] = useState(false);
  // Kurzlebige Statusmeldung fuer den SSH-Versand (Erfolg/Fehler).
  const [toast, setToast] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const toastTimer = useRef<number | null>(null);

  // Lifetime-Zaehler (vom Backend) + Support-Popup-Steuerung.
  const [captureCount, setCaptureCount] = useState(0);
  const [popupMilestone, setPopupMilestone] = useState<number | null>(null);
  // Hoechster bereits gezeigter Meilenstein — verhindert doppeltes Nerven, auch
  // ueber Sessions hinweg (aus settings.json geladen, beim Trigger persistiert).
  const shownMilestoneRef = useRef(0);

  // Gleitender Unterstrich unter dem aktiven Galerie-Tab.
  const localTabRef = useRef<HTMLButtonElement>(null);
  const sshTabRef = useRef<HTMLButtonElement>(null);
  const [tabUnderline, setTabUnderline] = useState({ left: 0, width: 0 });
  useLayoutEffect(() => {
    if (view !== "gallery") return;
    const el = galleryTab === "ssh" ? sshTabRef.current : localTabRef.current;
    if (el) {
      setTabUnderline({ left: el.offsetLeft, width: el.offsetWidth });
    }
  }, [galleryTab, view]);

  const showToast = useCallback((kind: "ok" | "error", text: string) => {
    setToast({ kind, text });
    if (toastTimer.current !== null) {
      window.clearTimeout(toastTimer.current);
    }
    toastTimer.current = window.setTimeout(() => setToast(null), 4000);
  }, []);

  useEffect(() => {
    void invoke<ShotMeta[]>("list_shots").then(setShots).catch(() => {});
    void invoke<HotkeyStatus>("hotkey_status").then(setHotkeyStatus).catch(() => {});
    void invoke<AppSettings>("get_settings")
      .then((settings) => {
        setSshConfigured(Boolean(settings.sshHost));
        applyTheme(settings.theme);
        shownMilestoneRef.current = settings.supportMilestoneShown ?? 0;
        setCaptureCount(settings.captureCount ?? 0);
      })
      .catch(() => {});

    // Jeder neue Snip wandert sofort vorne in die Galerie.
    const unlistenShot = listen<Shot>("shot-created", (event) => {
      const shot = event.payload;
      setShots((prev) => [
        {
          id: shot.id,
          path: shot.path,
          fileName: shot.fileName,
          width: shot.width,
          height: shot.height,
          createdAt: shot.createdAt,
        },
        ...prev.filter((existing) => existing.path !== shot.path),
      ]);
    });
    const unlistenStatus = listen<HotkeyStatus>("hotkey-status", (event) =>
      setHotkeyStatus(event.payload),
    );

    // Lifetime-Zaehler vom Backend nach jedem neuen Snip.
    const unlistenCount = listen<number>("capture-count", (event) =>
      setCaptureCount(event.payload),
    );

    // Ergebnis des SSH-Versands (vom Backend nach dem scp-Lauf).
    const unlistenSshOk = listen<string>("ssh-send-ok", (event) =>
      showToast("ok", t("toast.sshOk", { path: event.payload })),
    );
    const unlistenSshError = listen<string>("ssh-send-error", (event) =>
      showToast("error", t("toast.sshError", { error: event.payload })),
    );

    // Das Fenster startet versteckt und mountet sehr früh — das hotkey-status-Event
    // kann dabei verpasst werden. Beim Fokussieren den echten Status frisch holen.
    const unlistenFocus = currentWindow.onFocusChanged(({ payload: focused }) => {
      if (focused) {
        void invoke<HotkeyStatus>("hotkey_status").then(setHotkeyStatus).catch(() => {});
      }
    });

    return () => {
      void unlistenShot.then((callback) => callback());
      void unlistenStatus.then((callback) => callback());
      void unlistenCount.then((callback) => callback());
      void unlistenSshOk.then((callback) => callback());
      void unlistenSshError.then((callback) => callback());
      void unlistenFocus.then((callback) => callback());
      if (toastTimer.current !== null) {
        window.clearTimeout(toastTimer.current);
      }
    };
  }, [showToast, t]);

  // Support-Popup ausloesen, sobald ein neuer Meilenstein erreicht ist. Den
  // Meilenstein sofort als "gezeigt" persistieren, damit es nie zweimal nervt —
  // egal wie der Nutzer das Popup am Ende schliesst.
  useEffect(() => {
    const milestone = reachedMilestone(captureCount);
    if (milestone !== null && milestone > shownMilestoneRef.current) {
      shownMilestoneRef.current = milestone;
      setPopupMilestone(milestone);
      void invoke("set_settings", { supportMilestoneShown: milestone }).catch(() => {});
    }
  }, [captureCount]);

  const removeShot = useCallback((id: string) => {
    setShots((prev) => prev.filter((shot) => shot.id !== id));
  }, []);

  const count = shots.length;

  return (
    <div className="app-window">
      <TitleBar />
      {view === "settings" ? (
        <SettingsView
          onBack={() => {
            setView("gallery");
            // Nach evtl. Aenderung im SSH-Tab den Button-Status auffrischen.
            void invoke<AppSettings>("get_settings")
              .then((settings) => setSshConfigured(Boolean(settings.sshHost)))
              .catch(() => {});
          }}
        />
      ) : (
        <main className="gallery-shell">
          <header className="gallery-header">
            <div className="gallery-brand">
              <img
                className="gallery-logo"
                src={logoUrl}
                alt="SnipDrop"
                draggable={false}
              />
              <nav className="gallery-tabs" role="tablist">
                <button
                  ref={localTabRef}
                  type="button"
                  role="tab"
                  aria-selected={galleryTab === "local"}
                  className={`gallery-tab${galleryTab === "local" ? " active" : ""}`}
                  onClick={() => setGalleryTab("local")}
                >
                  {t("gallery.tabLocal")}
                </button>
                <button
                  ref={sshTabRef}
                  type="button"
                  role="tab"
                  aria-selected={galleryTab === "ssh"}
                  className={`gallery-tab${galleryTab === "ssh" ? " active" : ""}`}
                  onClick={() => setGalleryTab("ssh")}
                >
                  SSH
                </button>
                <span
                  className="gallery-tab-underline"
                  aria-hidden="true"
                  style={{
                    transform: `translateX(${tabUnderline.left}px)`,
                    width: `${tabUnderline.width}px`,
                  }}
                />
              </nav>
              <span className="gallery-count">
                {galleryTab === "ssh"
                  ? remoteInfo.status === "loading"
                    ? t("common.loading")
                    : remoteInfo.status === "error"
                      ? t("gallery.onServer")
                      : remoteInfo.count === 0
                        ? t("gallery.noneOnServer")
                        : t("gallery.countOnServer", { count: remoteInfo.count })
                  : count === 0
                    ? t("gallery.noShots")
                    : t(count === 1 ? "gallery.shotsOne" : "gallery.shotsOther", { count })}
              </span>
            </div>
            <div className="gallery-actions">
              {galleryTab === "ssh" ? (
                <button
                  type="button"
                  className={`icon-button${
                    remoteInfo.status === "loading" ? " spinning" : ""
                  }`}
                  aria-label={t("common.refresh")}
                  title={t("common.refresh")}
                  disabled={remoteInfo.status === "loading"}
                  onClick={() => remoteRefreshRef.current?.()}
                >
                  <RefreshCw size={18} strokeWidth={1.7} aria-hidden="true" />
                </button>
              ) : null}
              <button
                type="button"
                className="icon-button"
                aria-label={t("common.settings")}
                title={t("common.settings")}
                onClick={() => setView("settings")}
              >
                <Settings size={18} strokeWidth={1.7} aria-hidden="true" />
              </button>
            </div>
          </header>

          {galleryTab === "local" ? (
            <>
              {!hotkeyStatus.ok ? (
                <div className="hotkey-warning" role="alert">
                  {hotkeyStatus.message || t("gallery.hotkeyInactive")}
                </div>
              ) : null}

              {count === 0 ? (
                <div className="gallery-empty">
                  <p className="gallery-empty-title">{t("gallery.emptyTitle")}</p>
                  <p className="gallery-empty-hint">
                    {t("gallery.emptyHintPrefix")}
                    <strong>Win + Shift + S</strong>
                    {t("gallery.emptyHintSuffix")}
                  </p>
                </div>
              ) : (
                <div className="gallery-grid">
                  {shots.map((shot) => (
                    <GalleryTile
                      key={shot.id}
                      shot={shot}
                      onDeleted={removeShot}
                      sshConfigured={sshConfigured}
                    />
                  ))}
                </div>
              )}
            </>
          ) : (
            <RemoteGallery
              sshConfigured={sshConfigured}
              showToast={showToast}
              onConfigure={() => setView("settings")}
              onInfo={setRemoteInfo}
              refreshRef={remoteRefreshRef}
            />
          )}
        </main>
      )}
      {toast ? (
        <div className={`ssh-toast ssh-toast-${toast.kind}`} role="status">
          {toast.text}
        </div>
      ) : null}
      {popupMilestone !== null ? (
        <SupportPopup
          onClose={() => setPopupMilestone(null)}
          onSupport={() => {
            void invoke("open_support_link").catch(() => {});
            showToast("ok", t("popup.thanks"));
            setPopupMilestone(null);
          }}
        />
      ) : null}
    </div>
  );
}

// Support-Popup an Capture-Meilensteinen: eine einfache Frage "Willst du mich
// unterstuetzen?" mit Ja/Nein. "Ja" oeffnet die Supporter-Seite, "Nein" (oder
// das X) schliesst das Popup.
function SupportPopup({
  onClose,
  onSupport,
}: {
  onClose: () => void;
  onSupport: () => void;
}) {
  const t = useT();

  return (
    <div className="support-overlay" role="dialog" aria-modal="true">
      <div className="support-dialog">
        <div className="support-titlebar">
          <img className="support-logo" src={logoUrl} alt="" aria-hidden />
          <span className="support-title">{t("popup.askTitle")}</span>
          <button className="support-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="support-body">
          <p className="support-text">{t("popup.askBody")}</p>
          <div className="support-actions">
            <button className="support-yes" onClick={onSupport}>
              {t("popup.yes")}
            </button>
            <button className="support-no" onClick={onClose}>
              {t("popup.no")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function GalleryTile({
  shot,
  onDeleted,
  sshConfigured,
}: {
  shot: ShotMeta;
  onDeleted: (id: string) => void;
  sshConfigured: boolean;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const didDrag = useRef(false);
  const copiedTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copiedTimer.current !== null) {
        window.clearTimeout(copiedTimer.current);
      }
    };
  }, []);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    dragStart.current = { x: event.clientX, y: event.clientY };
    didDrag.current = false;
  }, []);

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragStart.current || didDrag.current) {
        return;
      }
      const dx = event.clientX - dragStart.current.x;
      const dy = event.clientY - dragStart.current.y;
      // Erst ab ~6px Bewegung wird es ein echtes Datei-Drag (sonst zählt es als Klick).
      if (Math.hypot(dx, dy) > 6) {
        didDrag.current = true;
        startDrag({ item: [shot.path], icon: shot.path }).catch(() => {});
      }
    },
    [shot.path],
  );

  const onClick = useCallback(() => {
    if (didDrag.current) {
      didDrag.current = false;
      return;
    }
    void invoke("copy_shot", { path: shot.path })
      .then(() => {
        setCopied(true);
        if (copiedTimer.current !== null) {
          window.clearTimeout(copiedTimer.current);
        }
        copiedTimer.current = window.setTimeout(() => setCopied(false), 1100);
      })
      .catch(() => {});
  }, [shot.path]);

  const onDelete = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      void invoke("delete_shot", { path: shot.path })
        .then(() => onDeleted(shot.id))
        .catch(() => {});
    },
    [shot.id, shot.path, onDeleted],
  );

  // Per SSH senden: laedt das Bild hoch, Backend meldet Erfolg/Fehler per Event (Toast).
  const onSendSsh = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      void invoke("send_shot_to_ssh", { path: shot.path }).catch(() => {});
    },
    [shot.path],
  );

  return (
    <div
      className={`gallery-tile${copied ? " copied" : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onClick={onClick}
      title={t("tile.hint")}
    >
      <img src={convertFileSrc(shot.path)} alt="" draggable={false} loading="lazy" />
      <button
        type="button"
        className="tile-ssh"
        aria-label={t("tile.sendSsh")}
        title={sshConfigured ? t("tile.sendSshTitle") : t("tile.sendSshDisabled")}
        disabled={!sshConfigured}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={onSendSsh}
      >
        <Send size={14} strokeWidth={1.8} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="tile-delete"
        aria-label={t("tile.delete")}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={onDelete}
      >
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
          <path
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m2 0v12a1 1 0 01-1 1H7a1 1 0 01-1-1V7"
          />
        </svg>
      </button>
      <span className="tile-copied" aria-hidden={!copied}>
        {t("tile.copied")}
      </span>
    </div>
  );
}

const THUMBNAIL_OPTIONS: { value: ThumbnailDismiss; labelKey: TranslationKey; hintKey: TranslationKey }[] = [
  { value: "timeout", labelKey: "thumb.timeout.label", hintKey: "thumb.timeout.hint" },
  { value: "paste", labelKey: "thumb.paste.label", hintKey: "thumb.paste.hint" },
  { value: "never", labelKey: "thumb.never.label", hintKey: "thumb.never.hint" },
];

// Vorgaben für die Auswahl-Rahmenfarbe; jede Wunschfarbe geht zusätzlich per Color-Picker.
const SELECTION_COLORS: { value: string; labelKey: TranslationKey }[] = [
  { value: "#ffffff", labelKey: "color.white" },
  { value: "#3b82f6", labelKey: "color.blue" },
  { value: "#ec4899", labelKey: "color.pink" },
  { value: "#22c55e", labelKey: "color.green" },
  { value: "#f97316", labelKey: "color.orange" },
  { value: "#ef4444", labelKey: "color.red" },
];

// SSH-Galerie: zeigt die Screenshots im Remote-Ordner als schnelle Liste (ein
// `ssh ls`-Round-Trip, keine eager Bild-Downloads). Ein Bild wird nur geladen, wenn
// man "Vorschau" klickt. Löschen passiert manuell mit Bestätigung (destruktiv auf dem
// Server). Kein Auto-Löschen — das ist optional über die Retention-Einstellung.
function RemoteGallery({
  sshConfigured,
  showToast,
  onConfigure,
  onInfo,
  refreshRef,
}: {
  sshConfigured: boolean;
  showToast: (kind: "ok" | "error", text: string) => void;
  onConfigure: () => void;
  onInfo: (info: { status: "idle" | "loading" | "error"; count: number }) => void;
  refreshRef: React.MutableRefObject<(() => void) | null>;
}) {
  const t = useT();
  const [shots, setShots] = useState<RemoteShot[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ path: string; localPath: string } | null>(null);

  // Status + Anzahl in den Header hochreichen (dort steht die Zählung).
  useEffect(() => {
    onInfo({ status, count: shots.length });
  }, [status, shots.length, onInfo]);

  const refresh = useCallback(() => {
    if (!sshConfigured) return;
    setStatus("loading");
    void invoke<RemoteShot[]>("list_remote_shots")
      .then((list) => {
        setShots(list);
        setStatus("idle");
      })
      .catch((error) => {
        setErrorMsg(String(error ?? t("common.error")));
        setStatus("error");
      });
  }, [sshConfigured, t]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Refresh dem Header-Button zur Verfügung stellen.
  useEffect(() => {
    refreshRef.current = refresh;
    return () => {
      refreshRef.current = null;
    };
  }, [refresh, refreshRef]);

  const onPreview = useCallback(
    (shot: RemoteShot) => {
      setBusyPath(shot.path);
      void invoke<string>("fetch_remote_shot", { path: shot.path })
        .then((localPath) => setPreview({ path: shot.path, localPath }))
        .catch((error) => showToast("error", t("remote.previewFailed", { error: String(error) })))
        .finally(() => setBusyPath(null));
    },
    [showToast, t],
  );

  const onCopyPath = useCallback(
    (shot: RemoteShot) => {
      void invoke("copy_text", { text: shot.path })
        .then(() => showToast("ok", t("remote.pathCopied", { path: shot.path })))
        .catch((error) => showToast("error", t("remote.copyFailed", { error: String(error) })));
    },
    [showToast, t],
  );

  const onCopyImage = useCallback(
    (localPath: string) => {
      void invoke("copy_shot", { path: localPath })
        .then(() => showToast("ok", t("remote.imageOnClipboard")))
        .catch((error) => showToast("error", t("remote.copyFailed", { error: String(error) })));
    },
    [showToast, t],
  );

  const onDelete = useCallback(
    (shot: RemoteShot) => {
      const confirmed = window.confirm(t("remote.confirmDelete", { path: shot.path }));
      if (!confirmed) return;
      setBusyPath(shot.path);
      void invoke("delete_remote_shot", { path: shot.path })
        .then(() => {
          setShots((prev) => prev.filter((entry) => entry.path !== shot.path));
          setPreview((prev) => (prev?.path === shot.path ? null : prev));
          showToast("ok", t("remote.deletedOnServer"));
        })
        .catch((error) => showToast("error", t("remote.deleteFailed", { error: String(error) })))
        .finally(() => setBusyPath(null));
    },
    [showToast, t],
  );

  if (!sshConfigured) {
    return (
      <div className="gallery-empty">
        <Server size={26} strokeWidth={1.5} aria-hidden="true" />
        <p className="gallery-empty-title">{t("remote.noTargetTitle")}</p>
        <p className="gallery-empty-hint">{t("remote.noTargetHint")}</p>
        <button type="button" className="folder-button" onClick={onConfigure}>
          {t("remote.setupInSettings")}
        </button>
      </div>
    );
  }

  return (
    <div className="remote-shell">
      {status === "error" ? (
        <div className="hotkey-warning" role="alert">
          {errorMsg || t("remote.listFailed")}
        </div>
      ) : status === "loading" ? (
        <div className="remote-list" aria-busy="true" aria-label={t("remote.loadingAria")}>
          {Array.from({ length: 5 }).map((_, index) => (
            <div className="remote-row remote-row-skeleton" key={index}>
              <div className="remote-row-text">
                <span className="skeleton-line skeleton-name" />
                <span className="skeleton-line skeleton-meta" />
              </div>
              <div className="remote-row-actions">
                <span className="skeleton-dot" />
                <span className="skeleton-dot" />
                <span className="skeleton-dot" />
              </div>
            </div>
          ))}
        </div>
      ) : shots.length === 0 ? (
        <div className="gallery-empty">
          <p className="gallery-empty-title">{t("remote.emptyTitle")}</p>
          <p className="gallery-empty-hint">{t("remote.emptyHint")}</p>
        </div>
      ) : (
        <div className="remote-list">
          {shots.map((shot) => (
            <div className="remote-row" key={shot.path}>
              <div className="remote-row-text">
                <span className="remote-row-name">{shot.name}</span>
                <span className="remote-row-meta">
                  {formatBytes(shot.size)} · {formatDate(shot.modified)}
                </span>
              </div>
              <div className="remote-row-actions">
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t("remote.preview")}
                  title={t("remote.previewLoad")}
                  disabled={busyPath === shot.path}
                  onClick={() => onPreview(shot)}
                >
                  <Eye size={16} strokeWidth={1.7} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t("remote.copyPath")}
                  title={t("remote.copyRemotePath")}
                  onClick={() => onCopyPath(shot)}
                >
                  <Copy size={16} strokeWidth={1.7} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="icon-button danger"
                  aria-label={t("remote.delete")}
                  title={t("remote.deleteOnServer")}
                  disabled={busyPath === shot.path}
                  onClick={() => onDelete(shot)}
                >
                  <Trash2 size={16} strokeWidth={1.7} aria-hidden="true" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {preview ? (
        <div className="remote-preview" role="dialog" aria-label={t("remote.previewDialog")}>
          <div className="remote-preview-bar">
            <span className="remote-preview-name">{preview.path.split("/").pop()}</span>
            <div className="remote-row-actions">
              <button
                type="button"
                className="icon-button"
                aria-label={t("remote.copyImage")}
                title={t("remote.copyImageTitle")}
                onClick={() => onCopyImage(preview.localPath)}
              >
                <Copy size={16} strokeWidth={1.7} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={t("remote.closePreview")}
                title={t("common.close")}
                onClick={() => setPreview(null)}
              >
                <X size={16} strokeWidth={1.7} aria-hidden="true" />
              </button>
            </div>
          </div>
          <img className="remote-preview-img" src={convertFileSrc(preview.localPath)} alt="" />
        </div>
      ) : null}
    </div>
  );
}

// Kleines eingekreistes "i": zeigt beim Hover/Fokus eine Erklärung, ohne den
// Screen mit Dauer-Text zu fluten. `placement` kippt die Sprechblase nach oben,
// wenn das Feld ganz unten steht (sonst würde die Blase abgeschnitten).
function InfoTip({
  children,
  placement = "down",
}: {
  children: React.ReactNode;
  placement?: "down" | "up";
}) {
  const t = useT();
  return (
    <span className={`infotip infotip-${placement}`} tabIndex={0} aria-label={t("common.info")}>
      <Info className="infotip-icon" size={14} strokeWidth={2} aria-hidden="true" />
      <span className="infotip-bubble" role="tooltip">
        {children}
      </span>
    </span>
  );
}

// Zustand des Update-Bereichs in den Einstellungen. Der Updater-Flow ist eine
// kleine Zustandsmaschine: idle → checking → (uptodate | available) → downloading
// → installing → relaunch, mit error als Quereinstieg.
type UpdateUi =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "uptodate" }
  | { kind: "available"; version: string; notes: string }
  | { kind: "downloading"; version: string; notes: string; percent: number }
  | { kind: "installing"; version: string; notes: string }
  | { kind: "error"; message: string };

function SettingsView({ onBack }: { onBack: () => void }) {
  const t = useT();
  const [lang, setLang] = useLang();
  const [section, setSection] = useState<
    "general" | "thumbnail" | "design" | "ssh" | "feedback"
  >("general");
  const [dismiss, setDismiss] = useState<ThumbnailDismiss>("paste");
  const [selectionColor, setSelectionColor] = useState("#ffffff");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [version, setVersion] = useState("");
  const [update, setUpdate] = useState<UpdateUi>({ kind: "idle" });
  // Das vom Updater zurückgegebene Update-Objekt (für downloadAndInstall) halten wir
  // außerhalb des States, da es Methoden trägt und nicht serialisierbar ist.
  const pendingUpdate = useRef<Awaited<ReturnType<typeof checkUpdate>> | null>(null);
  const [sshHost, setSshHost] = useState("");
  const [sshRemoteDir, setSshRemoteDir] = useState("/tmp");
  const [sshIdentityFile, setSshIdentityFile] = useState("");
  const [sshAuto, setSshAuto] = useState(false);
  const [sshRetentionDays, setSshRetentionDays] = useState(0);
  const [screenshotDir, setScreenshotDir] = useState("");
  const [sshTest, setSshTest] = useState<
    { state: "idle" | "testing" } | { state: "ok" } | { state: "error"; message: string }
  >({ state: "idle" });

  // Feedback-Formular (Sektion "Feedback" ganz unten in der Sidebar).
  const [feedbackMessage, setFeedbackMessage] = useState("");
  const [feedbackEmail, setFeedbackEmail] = useState("");
  const [feedbackStatus, setFeedbackStatus] = useState<
    | { state: "idle" | "sending" | "ok" }
    | { state: "error"; message: string }
  >({ state: "idle" });

  useEffect(() => {
    void invoke<AppSettings>("get_settings")
      .then((settings) => {
        setDismiss(settings.thumbnailDismiss);
        if (settings.selectionColor) setSelectionColor(settings.selectionColor);
        setSshHost(settings.sshHost ?? "");
        if (settings.sshRemoteDir) setSshRemoteDir(settings.sshRemoteDir);
        setSshIdentityFile(settings.sshIdentityFile ?? "");
        setSshAuto(Boolean(settings.sshAuto));
        setSshRetentionDays(Number(settings.sshRetentionDays) || 0);
        setScreenshotDir(settings.screenshotDir ?? "");
        setTheme(settings.theme === "dark" ? "dark" : "light");
        applyTheme(settings.theme);
      })
      .catch(() => {});
    void getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);

  // Esc schließt die Einstellungen (zurück zur Galerie) — Standard-Erwartung.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  // Gleitender blauer Akzent-Balken am aktiven Sidebar-Tab (wie der Galerie-
  // Unterstrich, nur vertikal). Position/Höhe aus dem aktiven Button gemessen.
  const tabRefs = useRef<Partial<Record<typeof section, HTMLButtonElement | null>>>({});
  const [tabBar, setTabBar] = useState({ top: 0, height: 0 });
  const [tabBarReady, setTabBarReady] = useState(false);

  useLayoutEffect(() => {
    const el = tabRefs.current[section];
    if (el) setTabBar({ top: el.offsetTop + 7, height: el.offsetHeight - 14 });
  }, [section]);

  // Erst nach dem ersten Messen die Animation freischalten (kein Aufploppen beim Öffnen).
  useEffect(() => {
    setTabBarReady(true);
  }, []);

  const chooseDismiss = useCallback((value: ThumbnailDismiss) => {
    setDismiss(value);
    void invoke("set_settings", { thumbnailDismiss: value }).catch(() => {});
  }, []);

  const chooseColor = useCallback((value: string) => {
    setSelectionColor(value);
    void invoke("set_settings", { selectionColor: value }).catch(() => {});
  }, []);

  // Dark Mode umschalten: sofort anwenden + persistieren, bei Fehler zuruecknehmen.
  const toggleTheme = useCallback(() => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    applyTheme(next);
    void invoke("set_settings", { theme: next }).catch(() => {
      setTheme(theme);
      applyTheme(theme);
    });
  }, [theme]);

  // SSH-Felder erst beim Verlassen des Inputs persistieren (kein Schreiben pro Tastendruck).
  const saveSshHost = useCallback(() => {
    setSshTest({ state: "idle" });
    void invoke("set_settings", { sshHost }).catch(() => {});
  }, [sshHost]);

  const saveSshRemoteDir = useCallback(() => {
    void invoke("set_settings", { sshRemoteDir }).catch(() => {});
  }, [sshRemoteDir]);

  // Key-Pfad wird im Backend auf Existenz geprueft -> Fehler ggf. im Test-Slot zeigen.
  const saveSshIdentity = useCallback(() => {
    setSshTest({ state: "idle" });
    void invoke("set_settings", { sshIdentityFile }).catch((error) =>
      setSshTest({ state: "error", message: String(error ?? "Fehler") }),
    );
  }, [sshIdentityFile]);

  // Nativer Ordner-Dialog fuer den Screenshot-Speicherort. Backend legt den Ordner
  // bei Bedarf an und validiert ihn; bei Fehler State zuruecknehmen.
  const pickScreenshotDir = useCallback(() => {
    void invoke<string | null>("pick_screenshot_dir")
      .then((picked) => {
        if (!picked) return;
        const previous = screenshotDir;
        setScreenshotDir(picked);
        return invoke("set_settings", { screenshotDir: picked }).catch((error) => {
          setScreenshotDir(previous);
          throw error;
        });
      })
      .catch(() => {});
  }, [screenshotDir]);

  // Zurueck auf den Standardordner (Pictures\SnipDrop): leeren String speichern.
  const resetScreenshotDir = useCallback(() => {
    const previous = screenshotDir;
    setScreenshotDir("");
    void invoke("set_settings", { screenshotDir: "" }).catch(() => setScreenshotDir(previous));
  }, [screenshotDir]);

  // Nativer Datei-Dialog (startet in ~/.ssh); gewaehlten Pfad uebernehmen + speichern.
  const pickSshKey = useCallback(() => {
    void invoke<string | null>("pick_ssh_key_file")
      .then((picked) => {
        if (!picked) return;
        setSshIdentityFile(picked);
        setSshTest({ state: "idle" });
        return invoke("set_settings", { sshIdentityFile: picked });
      })
      .catch((error) => setSshTest({ state: "error", message: String(error ?? "Fehler") }));
  }, []);

  // Auto-Modus umschalten: optimistisch setzen, bei Backend-Fehler zuruecknehmen.
  const toggleSshAuto = useCallback(() => {
    const next = !sshAuto;
    setSshAuto(next);
    void invoke("set_settings", { sshAuto: next }).catch(() => setSshAuto(!next));
  }, [sshAuto]);

  // Retention erst beim Verlassen des Felds speichern; negative Werte auf 0 klemmen.
  const saveSshRetention = useCallback(() => {
    const days = Math.max(0, Math.floor(sshRetentionDays || 0));
    setSshRetentionDays(days);
    void invoke("set_settings", { sshRetentionDays: days }).catch(() => {});
  }, [sshRetentionDays]);

  const testSshConnection = useCallback(() => {
    // Host/Key vor dem Test sicher persistieren, dann Backend pruefen lassen.
    void invoke("set_settings", { sshHost, sshRemoteDir, sshIdentityFile })
      .then(() => {
        setSshTest({ state: "testing" });
        return invoke("test_ssh_connection");
      })
      .then(() => setSshTest({ state: "ok" }))
      .catch((error) =>
        setSshTest({ state: "error", message: String(error ?? "Fehler") }),
      );
  }, [sshHost, sshRemoteDir, sshIdentityFile]);

  // Feedback per Web3Forms verschicken. Version (und später der Lizenzkey) werden
  // automatisch angehängt — der User muss nur den Text schreiben, die Mail optional.
  const submitFeedback = useCallback(() => {
    const message = feedbackMessage.trim();
    if (!message) return;

    setFeedbackStatus({ state: "sending" });
    void fetch(WEB3FORMS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        access_key: WEB3FORMS_ACCESS_KEY,
        subject: `SnipDrop Feedback${version ? ` · v${version}` : ""}`,
        from_name: "SnipDrop",
        // Optionale Antwort-Mail des Users (Web3Forms setzt sie als Reply-To).
        email: feedbackEmail.trim() || undefined,
        message,
        // Automatische Metadaten — sagen dir, aus welcher Version (und später von
        // welchem Lizenzkey) das Feedback kommt.
        snipdrop_version: version || t("settings.feedbackUnknown"),
        license_key: "free", // TODO: echten Lemon-Squeezy-Key anhängen, sobald die Key-Validierung steht.
      }),
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (response.ok && data?.success !== false) {
          setFeedbackStatus({ state: "ok" });
          setFeedbackMessage("");
          setFeedbackEmail("");
        } else {
          setFeedbackStatus({
            state: "error",
            message: String(data?.message ?? t("settings.feedbackFailed")),
          });
        }
      })
      .catch((error) =>
        setFeedbackStatus({
          state: "error",
          message: t("settings.feedbackNoConnection", { error: String(error ?? t("common.error")) }),
        }),
      );
  }, [feedbackMessage, feedbackEmail, version, t]);

  // Auf GitHub-Releases nach einer neueren Version suchen. Das Updater-Plugin
  // vergleicht die laufende Version mit latest.json und gibt das Update zurück
  // (oder null, wenn alles aktuell ist).
  const checkForUpdates = useCallback(() => {
    setUpdate({ kind: "checking" });
    void checkUpdate()
      .then((found) => {
        if (!found) {
          pendingUpdate.current = null;
          setUpdate({ kind: "uptodate" });
          return;
        }
        pendingUpdate.current = found;
        setUpdate({
          kind: "available",
          version: found.version,
          notes: (found.body ?? "").trim(),
        });
      })
      .catch((error) =>
        setUpdate({ kind: "error", message: String(error ?? "Fehler") }),
      );
  }, []);

  // Das gefundene Update herunterladen, signaturgeprüft installieren und die App
  // neu starten. Der Fortschritt kommt häppchenweise über das Event-Callback.
  const installUpdate = useCallback(() => {
    const found = pendingUpdate.current;
    if (!found) return;
    const notes = (found.body ?? "").trim();
    let downloaded = 0;
    let total = 0;
    setUpdate({ kind: "downloading", version: found.version, notes, percent: 0 });
    void found
      .downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? 0;
            break;
          case "Progress": {
            downloaded += event.data.chunkLength;
            const percent =
              total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
            setUpdate({ kind: "downloading", version: found.version, notes, percent });
            break;
          }
          case "Finished":
            setUpdate({ kind: "installing", version: found.version, notes });
            break;
        }
      })
      .then(() => relaunch())
      .catch((error) =>
        setUpdate({ kind: "error", message: String(error ?? "Fehler") }),
      );
  }, []);

  return (
    <main className="settings-shell">
      <header className="settings-header">
        <button
          type="button"
          className="settings-back"
          aria-label={t("settings.backToGallery")}
          title={t("settings.back")}
          onClick={onBack}
        >
          <ArrowLeft size={19} strokeWidth={2.2} aria-hidden="true" />
        </button>
        <h1>{t("settings.title")}</h1>
      </header>

      <div className="settings-body">
        <nav className="settings-sidebar">
          <span
            className="settings-tab-indicator"
            style={{
              transform: `translateY(${tabBar.top}px)`,
              height: tabBar.height,
              transition: tabBarReady
                ? "transform 260ms cubic-bezier(0.4, 0, 0.2, 1), height 260ms cubic-bezier(0.4, 0, 0.2, 1)"
                : "none",
            }}
            aria-hidden="true"
          />
          <button
            type="button"
            ref={(el) => {
              tabRefs.current.general = el;
            }}
            className={`settings-tab${section === "general" ? " active" : ""}`}
            onClick={() => setSection("general")}
          >
            {t("settings.tab.general")}
          </button>
          <button
            type="button"
            ref={(el) => {
              tabRefs.current.thumbnail = el;
            }}
            className={`settings-tab${section === "thumbnail" ? " active" : ""}`}
            onClick={() => setSection("thumbnail")}
          >
            {t("settings.tab.thumbnail")}
          </button>
          <button
            type="button"
            ref={(el) => {
              tabRefs.current.design = el;
            }}
            className={`settings-tab${section === "design" ? " active" : ""}`}
            onClick={() => setSection("design")}
          >
            {t("settings.tab.design")}
          </button>
          <button
            type="button"
            ref={(el) => {
              tabRefs.current.ssh = el;
            }}
            className={`settings-tab${section === "ssh" ? " active" : ""}`}
            onClick={() => setSection("ssh")}
          >
            {t("settings.tab.ssh")}
            {sshHost.trim() ? (
              <span
                className="settings-tab-dot"
                title={t("settings.sshConfigured")}
                aria-label={t("settings.sshConfigured")}
              />
            ) : null}
          </button>
          <button
            type="button"
            ref={(el) => {
              tabRefs.current.feedback = el;
            }}
            className={`settings-tab settings-tab-bottom${section === "feedback" ? " active" : ""}`}
            onClick={() => setSection("feedback")}
          >
            {t("settings.tab.feedback")}
          </button>
        </nav>

        <section className="settings-content">
          {section === "general" && (
            <>
              <div className="settings-row">
                <div className="settings-row-text">
                  <span className="settings-row-title-line">
                    <span className="settings-row-title">{t("settings.language")}</span>
                    <InfoTip>{t("settings.languageInfo")}</InfoTip>
                  </span>
                </div>
                <select
                  className="settings-select"
                  value={lang}
                  onChange={(event) => setLang(event.target.value as Lang)}
                  aria-label={t("settings.language")}
                >
                  <option value="en">English</option>
                  <option value="de">Deutsch</option>
                </select>
              </div>

              <div className="settings-row">
                <div className="settings-row-text">
                  <span className="settings-row-title-line">
                    <span className="settings-row-title">{t("settings.hotkey")}</span>
                    <InfoTip>{t("settings.hotkeyInfo")}</InfoTip>
                  </span>
                </div>
                <span className="hotkey-fixed">
                  <Lock size={12} strokeWidth={2.2} aria-hidden="true" />
                  Win + Shift + S
                </span>
              </div>

              <div className="settings-row">
                <div className="settings-row-text">
                  <span className="settings-row-title-line">
                    <span className="settings-row-title">{t("settings.screenshotFolder")}</span>
                    <InfoTip>
                      {t("settings.screenshotFolderInfo")}
                      <code>Pictures\SnipDrop</code>.
                    </InfoTip>
                  </span>
                  <span className="settings-row-path" title={screenshotDir || undefined}>
                    {screenshotDir || t("settings.folderDefault")}
                  </span>
                </div>
                <div className="settings-row-actions">
                  {screenshotDir ? (
                    <button
                      type="button"
                      className="folder-reset"
                      onClick={resetScreenshotDir}
                    >
                      {t("settings.resetFolder")}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="folder-button"
                    onClick={() => void invoke("open_screenshots_dir").catch(() => {})}
                  >
                    {t("settings.openFolder")}
                  </button>
                  <button
                    type="button"
                    className="folder-button"
                    onClick={pickScreenshotDir}
                  >
                    {t("settings.chooseFolder")}
                  </button>
                </div>
              </div>

              <div className="settings-update">
                <div className="settings-group-head">
                  <span className="settings-group-title">{t("settings.updateTitle")}</span>
                  <InfoTip>{t("settings.updateInfo")}</InfoTip>
                </div>

                <div className="settings-update-row">
                  <span className="settings-update-current">
                    {version ? `SnipDrop v${version}` : "SnipDrop"}
                  </span>
                  <button
                    type="button"
                    className="folder-button"
                    onClick={checkForUpdates}
                    disabled={
                      update.kind === "checking" ||
                      update.kind === "downloading" ||
                      update.kind === "installing"
                    }
                  >
                    <RefreshCw
                      size={14}
                      strokeWidth={2.2}
                      aria-hidden="true"
                      className={update.kind === "checking" ? "spin" : undefined}
                    />
                    {update.kind === "checking"
                      ? t("settings.checking")
                      : t("settings.checkUpdates")}
                  </button>
                </div>

                {update.kind === "uptodate" && (
                  <p className="settings-update-status ok">
                    <CheckCircle2 size={15} strokeWidth={2.2} aria-hidden="true" />
                    {t("settings.upToDate")}
                  </p>
                )}

                {update.kind === "error" && (
                  <p className="settings-update-status error">
                    {t("settings.updateError", { error: update.message })}
                  </p>
                )}

                {(update.kind === "available" ||
                  update.kind === "downloading" ||
                  update.kind === "installing") && (
                  <div className="settings-update-panel">
                    <div className="settings-update-panel-head">
                      <Download size={15} strokeWidth={2.2} aria-hidden="true" />
                      <span>{t("settings.updateAvailable", { version: update.version })}</span>
                    </div>

                    {update.notes ? (
                      <div className="settings-update-notes">
                        <span className="settings-update-notes-label">
                          {t("settings.updateNotes")}
                        </span>
                        <pre>{update.notes}</pre>
                      </div>
                    ) : null}

                    {update.kind === "available" && (
                      <button
                        type="button"
                        className="settings-update-install"
                        onClick={installUpdate}
                      >
                        <Download size={15} strokeWidth={2.2} aria-hidden="true" />
                        {t("settings.updateInstall")}
                      </button>
                    )}

                    {update.kind === "downloading" && (
                      <div className="settings-update-progress">
                        <div className="settings-update-progress-track">
                          <div
                            className="settings-update-progress-fill"
                            style={{ width: `${update.percent}%` }}
                          />
                        </div>
                        <span>
                          {t("settings.updateDownloading", { percent: update.percent })}
                        </span>
                      </div>
                    )}

                    {update.kind === "installing" && (
                      <p className="settings-update-status">
                        {t("settings.updateInstalling")} · {t("settings.updateRestartHint")}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </>
          )}

          {section === "thumbnail" && (
            <div className="settings-group">
              <div className="settings-group-head">
                <span className="settings-group-title">{t("settings.thumbTitle")}</span>
                <InfoTip>{t("settings.thumbInfo")}</InfoTip>
              </div>
              <div className="settings-choices">
                {THUMBNAIL_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`settings-choice${dismiss === option.value ? " active" : ""}`}
                    onClick={() => chooseDismiss(option.value)}
                  >
                    <span className="settings-choice-mark" aria-hidden="true" />
                    <span className="settings-choice-text">
                      <span className="settings-choice-label">{t(option.labelKey)}</span>
                      <span className="settings-choice-hint">{t(option.hintKey)}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {section === "design" && (
            <>
            <div className="settings-row">
              <div className="settings-row-text">
                <span className="settings-row-title-line">
                  <span className="settings-row-title">{t("settings.darkMode")}</span>
                  <InfoTip>{t("settings.darkModeInfo")}</InfoTip>
                </span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={theme === "dark"}
                aria-label={t("settings.darkMode")}
                className={`toggle${theme === "dark" ? " on" : ""}`}
                onClick={toggleTheme}
              >
                <span className="toggle-knob" />
              </button>
            </div>

            <div className="settings-group">
              <div className="settings-group-head">
                <span className="settings-group-title">{t("settings.selectionFrame")}</span>
                <InfoTip>{t("settings.selectionFrameInfo")}</InfoTip>
              </div>
              <div className="color-swatches">
                {SELECTION_COLORS.map((color) => (
                  <button
                    key={color.value}
                    type="button"
                    className={`color-swatch${
                      selectionColor.toLowerCase() === color.value ? " active" : ""
                    }`}
                    style={{ background: color.value }}
                    onClick={() => chooseColor(color.value)}
                    title={t(color.labelKey)}
                    aria-label={t(color.labelKey)}
                  />
                ))}
                <label className="color-custom" title={t("color.customTitle")}>
                  <input
                    type="color"
                    value={selectionColor}
                    onChange={(event) => chooseColor(event.target.value)}
                  />
                  <span>{t("color.custom")}</span>
                </label>
              </div>
              <div className="selection-preview" aria-hidden="true">
                <span
                  className="selection-preview-box"
                  style={{ borderColor: selectionColor }}
                />
              </div>
            </div>
            </>
          )}

          {section === "ssh" && (
            <div className="settings-group">
              <div className="settings-group-head">
                <span className="settings-group-title">{t("settings.sshTitle")}</span>
                <InfoTip>{t("settings.sshInfo")}</InfoTip>
              </div>
              <span className="settings-group-hint">{t("settings.sshHint")}</span>

              <label className="settings-field">
                <span className="settings-field-label-row">
                  <span className="settings-field-label">{t("settings.sshHost")}</span>
                  <InfoTip>{t("settings.sshHostInfo")}</InfoTip>
                </span>
                <input
                  type="text"
                  className="settings-input"
                  placeholder={t("settings.sshHostPlaceholder")}
                  value={sshHost}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  onChange={(event) => setSshHost(event.target.value)}
                  onBlur={saveSshHost}
                />
              </label>

              <label className="settings-field">
                <span className="settings-field-label-row">
                  <span className="settings-field-label">{t("settings.sshRemoteDir")}</span>
                  <InfoTip>{t("settings.sshRemoteDirInfo")}</InfoTip>
                </span>
                <input
                  type="text"
                  className="settings-input"
                  placeholder="/tmp"
                  value={sshRemoteDir}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  onChange={(event) => setSshRemoteDir(event.target.value)}
                  onBlur={saveSshRemoteDir}
                />
              </label>

              <label className="settings-field">
                <span className="settings-field-label-row">
                  <span className="settings-field-label">{t("settings.sshKey")}</span>
                  <InfoTip>{t("settings.sshKeyInfo")}</InfoTip>
                </span>
                <div className="settings-input-row">
                  <input
                    type="text"
                    className="settings-input"
                    placeholder={t("settings.sshKeyPlaceholder")}
                    value={sshIdentityFile}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    onChange={(event) => setSshIdentityFile(event.target.value)}
                    onBlur={saveSshIdentity}
                  />
                  <button type="button" className="folder-button" onClick={pickSshKey}>
                    {t("settings.browse")}
                  </button>
                </div>
              </label>

              <div className="settings-test-row">
                <button
                  type="button"
                  className="folder-button"
                  disabled={!sshHost.trim() || sshTest.state === "testing"}
                  onClick={testSshConnection}
                >
                  {sshTest.state === "testing" ? t("settings.testing") : t("settings.testConnection")}
                </button>
                {sshTest.state === "ok" ? (
                  <span className="settings-test-ok">{t("settings.connectionOk")}</span>
                ) : null}
                {sshTest.state === "error" ? (
                  <span className="settings-test-error">✗ {sshTest.message}</span>
                ) : null}
              </div>

              <div className="settings-choices">
                <button
                  type="button"
                  className={`settings-choice${sshAuto ? " active" : ""}`}
                  role="switch"
                  aria-checked={sshAuto}
                  disabled={!sshHost.trim()}
                  onClick={toggleSshAuto}
                >
                  <span className="settings-choice-mark" aria-hidden="true" />
                  <span className="settings-choice-text">
                    <span className="settings-choice-label">{t("settings.autoMode")}</span>
                    <span className="settings-choice-hint">
                      {t("settings.autoModeHintPrefix")}
                      <strong>{t("settings.autoModeHintWarn")}</strong>
                      {t("settings.autoModeHintSuffix")}
                    </span>
                  </span>
                </button>
              </div>

              <label className="settings-field">
                <span className="settings-field-label-row">
                  <span className="settings-field-label">
                    {t("settings.retentionLabel")}
                  </span>
                  <InfoTip placement="up">
                    {t("settings.retentionInfoPrefix")}
                    <strong>{t("settings.retentionInfoBold")}</strong>
                    {t("settings.retentionInfoSuffix")}
                  </InfoTip>
                </span>
                <div className="settings-input-row">
                  <input
                    type="number"
                    min={0}
                    className="settings-input settings-input-narrow"
                    value={sshRetentionDays}
                    onChange={(event) =>
                      setSshRetentionDays(Number(event.target.value))
                    }
                    onBlur={saveSshRetention}
                  />
                  <span className="settings-field-suffix">{t("settings.days")}</span>
                </div>
              </label>
            </div>
          )}

          {section === "feedback" && (
            <div className="settings-group">
              <div className="settings-group-head">
                <span className="settings-group-title">{t("settings.feedbackTitle")}</span>
                <InfoTip>{t("settings.feedbackInfo")}</InfoTip>
              </div>
              <span className="settings-group-hint">{t("settings.feedbackHint")}</span>

              <label className="settings-field">
                <span className="settings-field-label">{t("settings.feedbackMessage")}</span>
                <textarea
                  className="settings-input settings-textarea"
                  placeholder={t("settings.feedbackPlaceholder")}
                  rows={5}
                  value={feedbackMessage}
                  onChange={(event) => {
                    setFeedbackMessage(event.target.value);
                    if (feedbackStatus.state !== "idle") {
                      setFeedbackStatus({ state: "idle" });
                    }
                  }}
                />
              </label>

              <label className="settings-field">
                <span className="settings-field-label-row">
                  <span className="settings-field-label">{t("settings.feedbackEmail")}</span>
                  <InfoTip placement="up">{t("settings.feedbackEmailInfo")}</InfoTip>
                </span>
                <input
                  type="email"
                  className="settings-input"
                  placeholder="du@example.com"
                  value={feedbackEmail}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  onChange={(event) => setFeedbackEmail(event.target.value)}
                />
              </label>

              <div className="settings-test-row">
                <button
                  type="button"
                  className="folder-button"
                  disabled={
                    !feedbackMessage.trim() || feedbackStatus.state === "sending"
                  }
                  onClick={submitFeedback}
                >
                  {feedbackStatus.state === "sending" ? t("settings.sending") : t("settings.sendFeedback")}
                </button>
                {feedbackStatus.state === "ok" ? (
                  <span className="settings-test-ok">{t("settings.feedbackThanks")}</span>
                ) : null}
                {feedbackStatus.state === "error" ? (
                  <span className="settings-test-error">✗ {feedbackStatus.message}</span>
                ) : null}
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function ThumbnailDock() {
  const t = useT();
  const [shot, setShot] = useState<Shot | null>(null);
  const [isFresh, setIsFresh] = useState(false);
  const [isDismissing, setIsDismissing] = useState(false);
  const [dragError, setDragError] = useState("");
  // Ist ein SSH-Ziel konfiguriert? Steuert, ob der Sende-Button erscheint.
  const [sshConfigured, setSshConfigured] = useState(false);
  // Merkt sich, ob der laufende SSH-Versand vom Thumbnail-Button ausgeloest wurde —
  // damit nur dann automatisch ausgeblendet wird (nicht bei einem Galerie-Versand,
  // dessen Erfolgs-Event ebenfalls an dieses Fenster gebroadcastet wird).
  const sentFromThumbnail = useRef(false);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const didDrag = useRef(false);
  // Aktueller Ausblende-Modus (vom Settings-Screen gesetzt) — als Ref, damit die
  // einmalig registrierten Listener immer den frischen Wert sehen.
  const dismissMode = useRef<ThumbnailDismiss>("paste");
  const autoHideTimer = useRef<number | null>(null);

  const clearAutoHide = useCallback(() => {
    if (autoHideTimer.current !== null) {
      window.clearTimeout(autoHideTimer.current);
      autoHideTimer.current = null;
    }
  }, []);

  // Nach links wegswipen, dann das Fenster verstecken (gemeinsamer Pfad für
  // Auto-Timeout und Paste-Dismiss).
  const dismissWithSwipe = useCallback(() => {
    clearAutoHide();
    setIsDismissing(true);
    window.setTimeout(() => {
      void invoke("dismiss_thumbnail");
      setIsDismissing(false);
    }, 220);
  }, [clearAutoHide]);

  useEffect(() => {
    void invoke<Shot | null>("latest_shot").then((latest) => {
      if (latest) {
        setShot(latest);
      }
    });
    void invoke<AppSettings>("get_settings")
      .then((settings) => {
        dismissMode.current = settings.thumbnailDismiss;
        setSshConfigured(Boolean(settings.sshHost));
      })
      .catch(() => {});

    const unlistenShot = listen<Shot>("thumbnail-shot", (event) => {
      setShot(event.payload);
      setIsDismissing(false);
      setIsFresh(true);
      setDragError("");
      sentFromThumbnail.current = false;
      window.setTimeout(() => setIsFresh(false), 5000);
      // Modus frisch lesen und das Ausblende-Verhalten für diesen Snip festlegen.
      clearAutoHide();
      void invoke<AppSettings>("get_settings")
        .then((settings) => {
          dismissMode.current = settings.thumbnailDismiss;
          setSshConfigured(Boolean(settings.sshHost));
          if (settings.thumbnailDismiss === "timeout") {
            autoHideTimer.current = window.setTimeout(
              dismissWithSwipe,
              THUMBNAIL_TIMEOUT_MS,
            );
          }
        })
        .catch(() => {});
    });

    // Strg+V im Zielfenster (vom Rust-Hook erkannt): nur im "paste"-Modus ausblenden.
    const unlistenDismiss = listen("thumbnail-dismiss", () => {
      if (dismissMode.current === "paste") {
        dismissWithSwipe();
      }
    });

    // Ergebnis eines vom Thumbnail-Button gestarteten SSH-Versands. Bei Erfolg
    // wegswipen (das Bild ist auf dem Server), bei Fehler die Meldung zeigen und
    // das Thumbnail stehen lassen, damit man es erneut versuchen kann.
    const unlistenSshOk = listen("ssh-send-ok", () => {
      if (sentFromThumbnail.current) {
        sentFromThumbnail.current = false;
        dismissWithSwipe();
      }
    });
    const unlistenSshError = listen<string>("ssh-send-error", (event) => {
      if (sentFromThumbnail.current) {
        sentFromThumbnail.current = false;
        setDragError(event.payload || "SSH error");
      }
    });

    // Backend wärmt dieses Webview beim Start off-screen vor. Sobald Mount + Listener
    // stehen, Bescheid geben, damit das Vorwärm-Fenster sofort wieder versteckt wird —
    // ab jetzt ist das erste echte Thumbnail verzögerungsfrei.
    void getCurrentWindow().emit("thumbnail-ready");

    return () => {
      clearAutoHide();
      void unlistenShot.then((callback) => callback());
      void unlistenDismiss.then((callback) => callback());
      void unlistenSshOk.then((callback) => callback());
      void unlistenSshError.then((callback) => callback());
    };
  }, [clearAutoHide, dismissWithSwipe]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!shot || event.button !== 0) {
        return;
      }
      event.preventDefault();
      setDragError("");
      dragStart.current = { x: event.clientX, y: event.clientY };
      didDrag.current = false;
    },
    [shot],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // Nur bei gedrueckter linker Maustaste; bloszes Drueberfahren (buttons === 0)
      // darf keinen Drag ausloesen und raeumt eine veraltete Startposition weg.
      if (event.buttons !== 1) {
        dragStart.current = null;
        return;
      }
      if (!shot || !dragStart.current || didDrag.current) {
        return;
      }
      const dx = event.clientX - dragStart.current.x;
      const dy = event.clientY - dragStart.current.y;
      // Erst ab ~6px Bewegung wird es ein echtes Datei-Drag (sonst zählt es als Klick).
      if (Math.hypot(dx, dy) > 6) {
        didDrag.current = true;
        // Echtes natives OLE-Drag-&-Drop: die PNG-Datei wird ins Ziel (Chat, Explorer,
        // Bildeditor) gezogen. Nach erfolgreichem Drop verschwindet das Thumbnail.
        startDrag({ item: [shot.path], icon: shot.path }, (payload) => {
          if (payload.result === "Dropped") {
            void invoke("dismiss_thumbnail");
          }
        }).catch((err) => setDragError(String(err)));
      }
    },
    [shot],
  );

  const onClick = useCallback(() => {
    // Echter Klick (kein Drag) öffnet den Editor zum Annotieren.
    dragStart.current = null;
    if (didDrag.current) {
      didDrag.current = false;
      return;
    }
    void invoke("open_editor").catch((err) => setDragError(String(err)));
  }, []);

  // Per SSH senden direkt aus dem Thumbnail: hochladen, dann verschwindet das
  // Thumbnail nach dem Erfolgs-Event automatisch (siehe ssh-send-ok-Listener).
  const onSendSsh = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      if (!shot) return;
      setDragError("");
      clearAutoHide();
      sentFromThumbnail.current = true;
      void invoke("send_shot_to_ssh", { path: shot.path }).catch((err) => {
        sentFromThumbnail.current = false;
        setDragError(String(err));
      });
    },
    [shot, clearAutoHide],
  );

  if (!shot) {
    return <div className="thumbnail-shell loading">SnipDrop</div>;
  }

  const aspectRatio = shot.width > 0 && shot.height > 0 ? `${shot.width} / ${shot.height}` : "16 / 10";

  return (
    <div className={`thumbnail-shell ${isFresh ? "fresh" : ""} ${isDismissing ? "dismissing" : ""}`}>
      <div
        className="thumbnail-card"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onClick={onClick}
        title={t("dock.editHint")}
        style={{ aspectRatio }}
      >
        <img src={convertFileSrc(shot.path)} alt="" draggable={false} decoding="async" />
      </div>
      {sshConfigured ? (
        <button
          className="thumbnail-ssh"
          type="button"
          aria-label={t("tile.sendSsh")}
          title={t("tile.sendSshTitle")}
          onClick={onSendSsh}
        >
          <Send size={13} strokeWidth={1.9} aria-hidden="true" />
        </button>
      ) : null}
      <button
        className="close-button"
        type="button"
        aria-label={t("dock.close")}
        onClick={() => invoke("dismiss_thumbnail")}
      >
        x
      </button>
      {dragError ? <div className="drag-error">{dragError}</div> : null}
    </div>
  );
}

const PEN_COLOR = "#ff2d2d";
const UNDO_LIMIT = 10;

function EditorWindow() {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const lastPoint = useRef<{ x: number; y: number } | null>(null);
  const undoStack = useRef<ImageData[]>([]);
  const editPath = useRef<string | null>(null);
  const [hasShot, setHasShot] = useState(false);
  const [saving, setSaving] = useState(false);

  const loadShot = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const shot = await invoke<Shot | null>("latest_shot").catch(() => null);
    if (!shot) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = new Image();
    img.onload = () => {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      undoStack.current = [];
      // Wird der Editor mit einem bereits annotierten Shot geöffnet, zeigt sein
      // Pfad schon auf die Edit-Kopie; sonst legt der erste Strich sie an.
      editPath.current = shot.id.endsWith("-edit") ? shot.path : null;
      setHasShot(true);
    };
    img.src = shot.dataUrl;
  }, []);

  const save = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setSaving(true);
    const pngBase64 = canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
    try {
      editPath.current = await invoke<string>("save_annotated", { pngBase64 });
    } catch {
      /* Fehler beim Speichern ignorieren — nächster Strich versucht es erneut. */
    }
    setSaving(false);
  }, []);

  const undo = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const previous = undoStack.current.pop();
    if (!previous) return;
    ctx.putImageData(previous, 0, 0);
    void save();
  }, [save]);

  useEffect(() => {
    // Theme aus den Settings übernehmen, damit der Editor zum Hauptfenster passt.
    void invoke<AppSettings>("get_settings")
      .then((settings) => applyTheme(settings.theme))
      .catch(() => {});
    void loadShot();
    const unlisten = listen("editor-open", () => void loadShot());
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      void unlisten.then((callback) => callback());
      window.removeEventListener("keydown", onKey);
    };
  }, [loadShot, undo]);

  const pointFromEvent = (canvas: HTMLCanvasElement, event: React.PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height),
    };
  };

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || event.button !== 0) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    // Schnappschuss für Rückgängig (begrenzte Tiefe, damit der Speicher klein bleibt).
    undoStack.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    if (undoStack.current.length > UNDO_LIMIT) undoStack.current.shift();
    ctx.strokeStyle = PEN_COLOR;
    ctx.lineWidth = Math.max(3, Math.round(canvas.width / 320));
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    drawing.current = true;
    const point = pointFromEvent(canvas, event);
    lastPoint.current = point;
    // Ein einzelner Klick setzt einen Punkt.
    ctx.beginPath();
    ctx.moveTo(point.x, point.y);
    ctx.lineTo(point.x + 0.01, point.y + 0.01);
    ctx.stroke();
  }, []);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!drawing.current || !canvas || !ctx || !lastPoint.current) return;
    const point = pointFromEvent(canvas, event);
    ctx.beginPath();
    ctx.moveTo(lastPoint.current.x, lastPoint.current.y);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
    lastPoint.current = point;
  }, []);

  const endStroke = useCallback(() => {
    if (!drawing.current) return;
    drawing.current = false;
    lastPoint.current = null;
    void save();
  }, [save]);

  const onDragOut = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const drag = (path: string) => {
      void startDrag({ item: [path], icon: path }).catch(() => {});
    };
    if (editPath.current) {
      drag(editPath.current);
    } else {
      void invoke<Shot | null>("latest_shot")
        .then((shot) => shot && drag(shot.path))
        .catch(() => {});
    }
  }, []);

  return (
    <div className="editor-shell">
      <div className="editor-toolbar">
        <span className="editor-brand">{t("editor.brand")}</span>
        <div className="editor-tools">
          <span className="editor-pen" aria-hidden="true" />
          <button type="button" className="editor-button" onClick={undo}>
            {t("editor.undo")}
          </button>
          <button
            type="button"
            className="editor-button"
            onPointerDown={onDragOut}
            title={t("editor.dragTitle")}
          >
            {t("editor.drag")}
          </button>
          <button
            type="button"
            className="editor-button primary"
            onClick={() => void getCurrentWindow().close()}
          >
            {t("editor.done")}
          </button>
        </div>
        <span className={`editor-status${saving ? " active" : ""}`}>
          {saving ? t("editor.saving") : t("editor.saved")}
        </span>
      </div>
      <div className="editor-canvas-wrap">
        {hasShot ? null : <span className="editor-placeholder">{t("editor.noShot")}</span>}
        <canvas
          ref={canvasRef}
          className="editor-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endStroke}
          onPointerLeave={endStroke}
          onPointerCancel={endStroke}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LangProvider>
      <App />
    </LangProvider>
  </React.StrictMode>,
);
