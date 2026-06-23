import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

// Sprachumschaltung für SnipDrop. Englisch ist die Standardsprache; Deutsch ist
// über die Einstellungen wählbar. Die Wahl wird in localStorage gehalten (alle
// Fenster teilen denselben Origin, also gilt sie app-weit ohne Backend-Änderung).

export type Lang = "en" | "de";

const STORAGE_KEY = "snipdrop.lang";
const DEFAULT_LANG: Lang = "en";

// Englisch ist die Basis (definiert die gültigen Keys); Deutsch spiegelt sie.
const en = {
  // Titlebar
  "titlebar.minimize": "Minimize",
  "titlebar.restore": "Restore",
  "titlebar.maximize": "Maximize",
  "titlebar.close": "Close",

  // Common
  "common.loading": "Loading…",
  "common.refresh": "Refresh",
  "common.settings": "Settings",
  "common.error": "Error",
  "common.close": "Close",
  "common.info": "Info",

  // Gallery
  "gallery.tabLocal": "Local",
  "gallery.onServer": "On the server",
  "gallery.noneOnServer": "None on the server",
  "gallery.countOnServer": "{count} on the server",
  "gallery.noShots": "No screenshots",
  "gallery.shotsOne": "{count} screenshot",
  "gallery.shotsOther": "{count} screenshots",
  "gallery.hotkeyInactive": "Win + Shift + S is not active.",
  "gallery.emptyTitle": "No screenshots yet",
  "gallery.emptyHintPrefix": "Press ",
  "gallery.emptyHintSuffix": " and drag a rectangle.",

  // Toasts
  "toast.sshOk": "Copied to server · path on clipboard: {path}",
  "toast.sshError": "SSH transfer failed: {error}",

  // Gallery tile
  "tile.hint": "Click to copy · drag for drag & drop",
  "tile.sendSsh": "Send via SSH",
  "tile.sendSshTitle": "Upload to the server via SSH · remote path to the clipboard",
  "tile.sendSshDisabled": "Configure SSH in the settings first",
  "tile.delete": "Move to trash",
  "tile.copied": "Copied ✓",

  // Thumbnail dismiss options
  "thumb.timeout.label": "Hide after 3 seconds",
  "thumb.timeout.hint": "The thumbnail disappears automatically shortly after the snip.",
  "thumb.paste.label": "Hide on paste",
  "thumb.paste.hint": "Stays until you paste the screenshot with Ctrl + V.",
  "thumb.never.label": "Never hide automatically",
  "thumb.never.hint": "Stays until you close it with × or take the next snip.",

  // Selection colors
  "color.white": "White",
  "color.blue": "Blue",
  "color.pink": "Pink",
  "color.green": "Green",
  "color.orange": "Orange",
  "color.red": "Red",
  "color.custom": "Custom",
  "color.customTitle": "Choose your own color",

  // Remote gallery
  "remote.previewFailed": "Preview failed: {error}",
  "remote.pathCopied": "Path copied: {path}",
  "remote.copyFailed": "Copy failed: {error}",
  "remote.imageOnClipboard": "Image on the clipboard",
  "remote.confirmDelete": "Delete on the server?\n{path}",
  "remote.deletedOnServer": "Deleted on the server",
  "remote.deleteFailed": "Delete failed: {error}",
  "remote.noTargetTitle": "No SSH target configured",
  "remote.noTargetHint": "Set up an SSH host in the settings, then you'll see the screenshots on your server here.",
  "remote.setupInSettings": "Set up in the settings",
  "remote.listFailed": "Remote list failed.",
  "remote.loadingAria": "Loading screenshots from the server",
  "remote.emptyTitle": "No screenshots on the server",
  "remote.emptyHint": "Enable SSH auto mode or use the send button, then snips land here.",
  "remote.preview": "Preview",
  "remote.previewLoad": "Load preview",
  "remote.copyPath": "Copy path",
  "remote.copyRemotePath": "Copy remote path",
  "remote.delete": "Delete",
  "remote.deleteOnServer": "Delete on the server",
  "remote.previewDialog": "Preview",
  "remote.copyImage": "Copy image",
  "remote.copyImageTitle": "Image to the clipboard",
  "remote.closePreview": "Close preview",

  // Settings — shell
  "settings.title": "Settings",
  "settings.back": "Back",
  "settings.backToGallery": "Back to the gallery",
  "settings.tab.general": "General",
  "settings.tab.thumbnail": "Thumbnail",
  "settings.tab.design": "Design",
  "settings.tab.ssh": "SSH",
  "settings.tab.feedback": "Feedback",
  "settings.sshConfigured": "SSH target configured",

  // Settings — general
  "settings.language": "Language",
  "settings.languageInfo": "Display language of the app. English is the default; German is available here.",
  "settings.hotkey": "Hotkey",
  "settings.hotkeyInfo": "Shortcut that starts the rectangle snip. Hard-wired so SnipDrop reliably intercepts the Windows Snipping Tool.",
  "settings.screenshotFolder": "Screenshot folder",
  "settings.screenshotFolderInfo": "All snips land under ",
  "settings.openFolder": "Open folder",
  "settings.chooseFolder": "Change…",
  "settings.resetFolder": "Reset to default",
  "settings.folderDefault": "Default — Pictures\\SnipDrop",

  // Settings — thumbnail
  "settings.thumbTitle": "Thumbnail at the bottom left",
  "settings.thumbInfo": "When the small preview disappears after a snip.",
  "settings.thumbSizeTitle": "Thumbnail size",
  "settings.thumbSizeInfo": "How large the corner preview appears (100% = default). Applies to the next snip.",

  // Settings — design
  "settings.darkMode": "Dark theme",
  "settings.darkModeInfo": "Dark color scheme for gallery and settings.",
  "settings.selectionFrame": "Selection frame",
  "settings.selectionFrameInfo": "Color of the dashed line that outlines the rectangle while snipping (Win + Shift + S).",

  // Settings — SSH
  "settings.sshTitle": "Send via SSH",
  "settings.sshInfo": "Uploads a screenshot via scp to a server and puts the remote path on the clipboard. That way you paste images with Ctrl + V into tools running over SSH (e.g. Claude Code). Auth uses your existing SSH keys / the ssh-agent.",
  "settings.sshHint": "Push a screenshot to a server via scp — the remote path lands on the clipboard.",
  "settings.sshHost": "Host",
  "settings.sshHostInfo": "Alias from ~/.ssh/config or user@host — e.g. root@198.51.100.23.",
  "settings.sshHostPlaceholder": "server-alias  or  user@host",
  "settings.sshRemoteDir": "Remote directory",
  "settings.sshRemoteDirInfo": "Target folder on the server the screenshot is uploaded to. The default /tmp is enough for the paste workflow.",
  "settings.sshKey": "SSH key (optional)",
  "settings.sshKeyInfo": "Only needed if your key has a non-standard name and isn't in ~/.ssh/config. Empty = ssh chooses by itself (default keys / ssh-agent / config).",
  "settings.sshKeyPlaceholder": "empty = automatic · or choose a file",
  "settings.browse": "Browse…",
  "settings.testing": "Testing…",
  "settings.testConnection": "Test connection",
  "settings.connectionOk": "✓ Connection works",
  "settings.autoMode": "Auto mode",
  "settings.autoModeHintPrefix": "Upload every snip automatically — Ctrl + V in the SSH terminal gives you the remote path directly, without the send button. ",
  "settings.autoModeHintWarn": "Caution:",
  "settings.autoModeHintSuffix": " while active, every screenshot lands on the server.",
  "settings.retentionLabel": "Delete old remote screenshots after",
  "settings.retentionInfoPrefix": "When opening the SSH tab, screenshots older than this many days are deleted. ",
  "settings.retentionInfoBold": "0 = off",
  "settings.retentionInfoSuffix": " (SnipDrop never deletes on its own). Only affects snipdrop-*.png in the remote folder.",
  "settings.days": "days",

  // Settings — feedback
  "settings.feedbackTitle": "Send feedback",
  "settings.feedbackInfo": "Goes straight to Remo. Version (and your license key, if any) are attached automatically — you only need to write the text.",
  "settings.feedbackHint": "Idea, bug or wish? Write it here. Your email only if you want a reply.",
  "settings.feedbackMessage": "Message",
  "settings.feedbackPlaceholder": "What works well, what's missing, what's annoying?",
  "settings.feedbackEmail": "Your email (optional)",
  "settings.feedbackEmailInfo": "Only for a reply. Without an email the feedback still arrives, but you won't get a response.",
  "settings.sending": "Sending…",
  "settings.sendFeedback": "Send feedback",
  "settings.feedbackThanks": "✓ Thanks, got it!",
  "settings.feedbackNotSetUp": "Sending is not set up yet (access key missing).",
  "settings.feedbackUnknown": "unknown",
  "settings.feedbackFailed": "Sending failed.",
  "settings.feedbackNoConnection": "No connection: {error}",

  // Updates
  "settings.updateTitle": "Updates",
  "settings.updateInfo": "SnipDrop checks GitHub for new versions and installs them in one click.",
  "settings.checkUpdates": "Check for updates",
  "settings.checking": "Checking…",
  "settings.upToDate": "You're on the latest version.",
  "settings.updateAvailable": "Version {version} is available",
  "settings.updateNotes": "What's new",
  "settings.updateInstall": "Install now",
  "settings.updateDownloading": "Downloading… {percent}%",
  "settings.updateInstalling": "Installing…",
  "update.badgeTitle": "Update available",
  "settings.updateRestartHint": "SnipDrop restarts when it's done.",
  "settings.updateError": "Update check failed: {error}",

  // Thumbnail dock
  "dock.editHint": "Click to edit · drag for drag & drop",
  "dock.close": "Close thumbnail",

  // Editor
  "editor.brand": "SnipDrop · Annotate",
  "editor.undo": "Undo",
  "editor.drag": "Drag",
  "editor.dragTitle": "Hold and drag into a target window",
  "editor.done": "Done",
  "editor.saving": "Saving…",
  "editor.saved": "Saved automatically",
  "editor.noShot": "No screenshot loaded",

  // Support-Popup (an Capture-Meilensteinen)
  "popup.askTitle": "Enjoying SnipDrop?",
  "popup.askBody":
    "SnipDrop is free and it stays that way. If it saves you time, you can chip in a few bucks to keep it going. No pressure either way.",
  "popup.yes": "Sure, I'll help",
  "popup.no": "Not now",
  "popup.thanks": "You're the best. Thank you!",

  // Welcome / first-run onboarding
  "welcome.title": "Welcome to SnipDrop",
  "welcome.subtitle": "One screenshot, pasted the right way everywhere. Here's the whole app in four steps.",
  "welcome.step1.title": "Snip with Win + Shift + S",
  "welcome.step1.body": "Press the hotkey and drag a rectangle. SnipDrop handles it natively — the Windows Snipping Tool stays out of the way.",
  "welcome.step2.title": "Paste with Ctrl + V",
  "welcome.step2.body": "In a terminal you get the file path, in a chat or browser you get the image — automatically, depending on where you paste.",
  "welcome.step3.title": "Drag from the corner",
  "welcome.step3.body": "The thumbnail in the bottom-left lets you drag the screenshot straight into Explorer, a chat or an upload field.",
  "welcome.step4.title": "Click the thumbnail to edit",
  "welcome.step4.body": "Click the thumbnail to mark it up. After that, paste and drag use your annotated version.",
  "welcome.autostart": "Start SnipDrop automatically with Windows",
  "welcome.cta": "Let's go",
} as const;

export type TranslationKey = keyof typeof en;

const de: Record<TranslationKey, string> = {
  "titlebar.minimize": "Minimieren",
  "titlebar.restore": "Wiederherstellen",
  "titlebar.maximize": "Maximieren",
  "titlebar.close": "Schließen",

  "common.loading": "Lädt…",
  "common.refresh": "Aktualisieren",
  "common.settings": "Einstellungen",
  "common.error": "Fehler",
  "common.close": "Schließen",
  "common.info": "Info",

  "gallery.tabLocal": "Lokal",
  "gallery.onServer": "Auf dem Server",
  "gallery.noneOnServer": "Keine auf dem Server",
  "gallery.countOnServer": "{count} auf dem Server",
  "gallery.noShots": "Keine Screenshots",
  "gallery.shotsOne": "{count} Screenshot",
  "gallery.shotsOther": "{count} Screenshots",
  "gallery.hotkeyInactive": "Win + Shift + S ist nicht aktiv.",
  "gallery.emptyTitle": "Noch keine Screenshots",
  "gallery.emptyHintPrefix": "Drück ",
  "gallery.emptyHintSuffix": " und zieh ein Rechteck.",

  "toast.sshOk": "Auf Server kopiert · Pfad in Zwischenablage: {path}",
  "toast.sshError": "SSH-Versand fehlgeschlagen: {error}",

  "tile.hint": "Klicken zum Kopieren · Ziehen für Drag & Drop",
  "tile.sendSsh": "Per SSH senden",
  "tile.sendSshTitle": "Per SSH auf den Server laden · Remote-Pfad in die Zwischenablage",
  "tile.sendSshDisabled": "Erst SSH in den Einstellungen konfigurieren",
  "tile.delete": "In den Papierkorb",
  "tile.copied": "Kopiert ✓",

  "thumb.timeout.label": "Nach 3 Sekunden ausblenden",
  "thumb.timeout.hint": "Das Thumbnail verschwindet automatisch kurz nach dem Snip.",
  "thumb.paste.label": "Beim Einfügen ausblenden",
  "thumb.paste.hint": "Bleibt stehen, bis du den Screenshot mit Strg + V einfügst.",
  "thumb.never.label": "Nie automatisch ausblenden",
  "thumb.never.hint": "Bleibt, bis du es per × schließt oder den nächsten Snip machst.",

  "color.white": "Weiß",
  "color.blue": "Blau",
  "color.pink": "Pink",
  "color.green": "Grün",
  "color.orange": "Orange",
  "color.red": "Rot",
  "color.custom": "Eigene",
  "color.customTitle": "Eigene Farbe wählen",

  "remote.previewFailed": "Vorschau fehlgeschlagen: {error}",
  "remote.pathCopied": "Pfad kopiert: {path}",
  "remote.copyFailed": "Kopieren fehlgeschlagen: {error}",
  "remote.imageOnClipboard": "Bild in der Zwischenablage",
  "remote.confirmDelete": "Auf dem Server löschen?\n{path}",
  "remote.deletedOnServer": "Auf dem Server gelöscht",
  "remote.deleteFailed": "Löschen fehlgeschlagen: {error}",
  "remote.noTargetTitle": "Kein SSH-Ziel eingerichtet",
  "remote.noTargetHint": "Richte in den Einstellungen einen SSH-Host ein, dann siehst du hier die Screenshots auf deinem Server.",
  "remote.setupInSettings": "In den Einstellungen einrichten",
  "remote.listFailed": "Remote-Liste fehlgeschlagen.",
  "remote.loadingAria": "Lädt Screenshots vom Server",
  "remote.emptyTitle": "Keine Screenshots auf dem Server",
  "remote.emptyHint": "Aktiviere den SSH-Auto-Modus oder nutze den Sende-Button, dann landen Snips hier.",
  "remote.preview": "Vorschau",
  "remote.previewLoad": "Vorschau laden",
  "remote.copyPath": "Pfad kopieren",
  "remote.copyRemotePath": "Remote-Pfad kopieren",
  "remote.delete": "Löschen",
  "remote.deleteOnServer": "Auf dem Server löschen",
  "remote.previewDialog": "Vorschau",
  "remote.copyImage": "Bild kopieren",
  "remote.copyImageTitle": "Bild in die Zwischenablage",
  "remote.closePreview": "Vorschau schließen",

  "settings.title": "Einstellungen",
  "settings.back": "Zurück",
  "settings.backToGallery": "Zurück zur Galerie",
  "settings.tab.general": "Allgemein",
  "settings.tab.thumbnail": "Thumbnail",
  "settings.tab.design": "Design",
  "settings.tab.ssh": "SSH",
  "settings.tab.feedback": "Feedback",
  "settings.sshConfigured": "SSH-Ziel konfiguriert",

  "settings.language": "Sprache",
  "settings.languageInfo": "Anzeigesprache der App. Englisch ist Standard; Deutsch ist hier wählbar.",
  "settings.hotkey": "Hotkey",
  "settings.hotkeyInfo": "Tastenkürzel, das den Rechteck-Snip startet. Fest verdrahtet, damit SnipDrop das Windows-Snipping-Tool zuverlässig abfängt.",
  "settings.screenshotFolder": "Screenshot-Ordner",
  "settings.screenshotFolderInfo": "Alle Snips landen unter ",
  "settings.openFolder": "Ordner öffnen",
  "settings.chooseFolder": "Ordner wählen…",
  "settings.resetFolder": "Auf Standard zurücksetzen",
  "settings.folderDefault": "Standard — Pictures\\SnipDrop",

  "settings.thumbTitle": "Thumbnail unten links",
  "settings.thumbInfo": "Wann das kleine Vorschaubild nach einem Snip verschwindet.",
  "settings.thumbSizeTitle": "Thumbnail-Größe",
  "settings.thumbSizeInfo": "Wie groß das Eck-Vorschaubild erscheint (100% = Standard). Gilt ab dem nächsten Snip.",

  "settings.darkMode": "Dunkles Design",
  "settings.darkModeInfo": "Dunkles Farbschema für Galerie und Einstellungen.",
  "settings.selectionFrame": "Auswahl-Rahmen",
  "settings.selectionFrameInfo": "Farbe der gestrichelten Linie, die beim Snippen (Win + Shift + S) das Rechteck umrandet.",

  "settings.sshTitle": "Per SSH senden",
  "settings.sshInfo": "Lädt einen Screenshot per scp auf einen Server und legt den Remote-Pfad in die Zwischenablage. So fügst du Bilder mit Strg + V in Tools ein, die über SSH laufen (z. B. Claude Code). Auth läuft über deine bestehenden SSH-Keys / den ssh-agent.",
  "settings.sshHint": "Screenshot per scp auf einen Server schieben — der Remote-Pfad landet in der Zwischenablage.",
  "settings.sshHost": "Host",
  "settings.sshHostInfo": "Alias aus ~/.ssh/config oder user@host — z. B. root@198.51.100.23.",
  "settings.sshHostPlaceholder": "server-alias  oder  user@host",
  "settings.sshRemoteDir": "Remote-Verzeichnis",
  "settings.sshRemoteDirInfo": "Zielordner auf dem Server, in den der Screenshot hochgeladen wird. Default /tmp reicht für den Paste-Workflow.",
  "settings.sshKey": "SSH-Key (optional)",
  "settings.sshKeyInfo": "Nur nötig, wenn dein Key einen Nicht-Standard-Namen hat und nicht in ~/.ssh/config steht. Leer = ssh wählt selbst (Default-Keys / ssh-agent / config).",
  "settings.sshKeyPlaceholder": "leer = automatisch · oder Datei wählen",
  "settings.browse": "Durchsuchen…",
  "settings.testing": "Teste…",
  "settings.testConnection": "Verbindung testen",
  "settings.connectionOk": "✓ Verbindung steht",
  "settings.autoMode": "Auto-Modus",
  "settings.autoModeHintPrefix": "Jeden Snip automatisch hochladen — Strg + V im SSH-Terminal liefert direkt den Remote-Pfad, ohne Sende-Button. ",
  "settings.autoModeHintWarn": "Achtung:",
  "settings.autoModeHintSuffix": " solange aktiv, landet jeder Screenshot auf dem Server.",
  "settings.retentionLabel": "Alte Remote-Screenshots löschen nach",
  "settings.retentionInfoPrefix": "Beim Öffnen des SSH-Tabs werden Screenshots gelöscht, die älter als so viele Tage sind. ",
  "settings.retentionInfoBold": "0 = aus",
  "settings.retentionInfoSuffix": " (SnipDrop löscht nie von selbst). Betrifft nur snipdrop-*.png im Remote-Ordner.",
  "settings.days": "Tagen",

  "settings.feedbackTitle": "Feedback senden",
  "settings.feedbackInfo": "Geht direkt an Remo. Version (und ggf. dein Lizenzkey) werden automatisch mitgeschickt — du musst nichts ausfüllen außer dem Text.",
  "settings.feedbackHint": "Idee, Bug oder Wunsch? Schreib's rein. Deine Mail nur, wenn du eine Antwort möchtest.",
  "settings.feedbackMessage": "Nachricht",
  "settings.feedbackPlaceholder": "Was funktioniert gut, was fehlt, was nervt?",
  "settings.feedbackEmail": "Deine E-Mail (optional)",
  "settings.feedbackEmailInfo": "Nur für eine Antwort. Ohne Mail kommt das Feedback trotzdem an, aber du bekommst keine Rückmeldung.",
  "settings.sending": "Sende…",
  "settings.sendFeedback": "Feedback senden",
  "settings.feedbackThanks": "✓ Danke, ist angekommen!",
  "settings.feedbackNotSetUp": "Versand ist noch nicht eingerichtet (Access-Key fehlt).",
  "settings.feedbackUnknown": "unbekannt",
  "settings.feedbackFailed": "Versand fehlgeschlagen.",
  "settings.feedbackNoConnection": "Keine Verbindung: {error}",

  "settings.updateTitle": "Updates",
  "settings.updateInfo": "SnipDrop sucht auf GitHub nach neuen Versionen und installiert sie mit einem Klick.",
  "settings.checkUpdates": "Nach Updates suchen",
  "settings.checking": "Suche…",
  "settings.upToDate": "Du hast die neueste Version.",
  "settings.updateAvailable": "Version {version} ist verfügbar",
  "settings.updateNotes": "Was ist neu",
  "settings.updateInstall": "Jetzt installieren",
  "settings.updateDownloading": "Lade… {percent}%",
  "settings.updateInstalling": "Installiere…",
  "settings.updateRestartHint": "SnipDrop startet danach neu.",
  "settings.updateError": "Update-Suche fehlgeschlagen: {error}",
  "update.badgeTitle": "Update verfügbar",

  "dock.editHint": "Klicken zum Bearbeiten · Ziehen für Drag & Drop",
  "dock.close": "Thumbnail schließen",

  "editor.brand": "SnipDrop · Markieren",
  "editor.undo": "Rückgängig",
  "editor.drag": "Ziehen",
  "editor.dragTitle": "Halten und in ein Zielfenster ziehen",
  "editor.done": "Fertig",
  "editor.saving": "Speichere…",
  "editor.saved": "Automatisch gespeichert",
  "editor.noShot": "Kein Screenshot geladen",

  // Support-Popup (an Capture-Meilensteinen)
  "popup.askTitle": "Magst du SnipDrop?",
  "popup.askBody":
    "SnipDrop ist kostenlos und bleibt es auch. Wenn es dir Zeit spart, kannst du mit ein paar Euro helfen, dass es weitergeht. Kein Muss.",
  "popup.yes": "Klar, ich helfe",
  "popup.no": "Jetzt nicht",
  "popup.thanks": "Du bist super. Danke!",

  // Welcome / First-Run-Onboarding
  "welcome.title": "Willkommen bei SnipDrop",
  "welcome.subtitle": "Ein Screenshot, überall richtig eingefügt. Die ganze App in vier Schritten.",
  "welcome.step1.title": "Snippen mit Win + Shift + S",
  "welcome.step1.body": "Hotkey drücken und ein Rechteck ziehen. SnipDrop fängt das nativ ab — das Windows-Snipping-Tool bleibt außen vor.",
  "welcome.step2.title": "Einfügen mit Strg + V",
  "welcome.step2.body": "Im Terminal bekommst du den Dateipfad, in Chat oder Browser das Bild — automatisch, je nachdem wo du einfügst.",
  "welcome.step3.title": "Aus der Ecke ziehen",
  "welcome.step3.body": "Das Thumbnail unten links zieht den Screenshot direkt in Explorer, Chat oder ein Upload-Feld.",
  "welcome.step4.title": "Thumbnail anklicken zum Bearbeiten",
  "welcome.step4.body": "Klick aufs Thumbnail, um zu markieren. Danach nutzen Einfügen und Drag deine bearbeitete Version.",
  "welcome.autostart": "SnipDrop automatisch mit Windows starten",
  "welcome.cta": "Los geht's",
};

const dictionaries: Record<Lang, Record<TranslationKey, string>> = { en, de };

export type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;

function translate(lang: Lang, key: TranslationKey, vars?: Record<string, string | number>): string {
  const template = dictionaries[lang][key] ?? dictionaries[DEFAULT_LANG][key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    name in vars ? String(vars[name]) : match,
  );
}

function readStoredLang(): Lang {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === "de" || stored === "en" ? stored : DEFAULT_LANG;
  } catch {
    return DEFAULT_LANG;
  }
}

type LangContextValue = {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: Translate;
};

const LangContext = createContext<LangContextValue | null>(null);

export function LangProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => readStoredLang());

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  // Wechselt eine andere App-Instanz (z. B. anderes Fenster) die Sprache, ziehen
  // wir nach — localStorage-"storage"-Events feuern fensterübergreifend.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) {
        setLangState(readStoredLang());
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* localStorage nicht verfügbar — Sprache gilt dann nur für diese Sitzung. */
    }
  }, []);

  const value = useMemo<LangContextValue>(
    () => ({ lang, setLang, t: (key, vars) => translate(lang, key, vars) }),
    [lang, setLang],
  );

  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

function useLangContext(): LangContextValue {
  const ctx = useContext(LangContext);
  if (!ctx) {
    // Fallback ohne Provider (sollte nicht vorkommen): Default-Sprache, kein Persist.
    return {
      lang: DEFAULT_LANG,
      setLang: () => {},
      t: (key, vars) => translate(DEFAULT_LANG, key, vars),
    };
  }
  return ctx;
}

export function useT(): Translate {
  return useLangContext().t;
}

export function useLang(): [Lang, (lang: Lang) => void] {
  const { lang, setLang } = useLangContext();
  return [lang, setLang];
}
