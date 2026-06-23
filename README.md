# SnipDrop

SnipDrop ist eine Windows-first Screenshot-App fuer Claude-Code-/Terminal-Workflows. Ein Screenshot wird einmal erstellt und danach je nach Ziel automatisch passend eingefuegt: als Bild in Chat/Web, als Pfad im Terminal oder als Datei per Drag-and-drop.

`Win + Shift + S` wird von SnipDrop selbst abgefangen: kein Windows Snipping Tool, keine Windows-Benachrichtigung und kein Clipboard-Watcher als primaere Capture-Quelle.

## V1-Status

- Release-Build und NSIS/MSI-Installer sind gebaut.
- Installierter Build wurde getestet: Tray, Hotkey, Capture, Paste/Drop und Annotation-Flow funktionieren.
- Uninstall-Test wurde erfolgreich durchgefuehrt.
- Offen vor einem oeffentlichen Download: README/MARKET-Finish abschliessen und Crash-/Fehler-Basics pruefen.

## Installation

Die aktuellen Installer liegen nach `npm run tauri build` hier:

```text
src-tauri\target\release\bundle\nsis\SnipDrop_0.1.0_x64-setup.exe
src-tauri\target\release\bundle\msi\SnipDrop_0.1.0_x64_en-US.msi
```

Fuer normale Windows-Downloads ist das NSIS-Setup die bevorzugte Variante.

## Verhalten

- **Ausloeser:** Standard ist `Win + Shift + S`; der Hotkey kann im Hauptfenster angepasst werden.
- **Auswahl:** natives borderless Win32-Toolwindow ueber dem virtuellen Desktop.
- **Abbruch:** `Esc` oder Rechtsklick, unabhaengig von Tauri/Webview-JavaScript.
- **Modus v1:** Rechteck-Auswahl.
- **Speicherort:** `%USERPROFILE%\Pictures\SnipDrop`, jeder Shot als PNG.
- **Autostart:** Im Hauptfenster umschaltbar.
- **Tray-Menue:** SnipDrop oeffnen, Screenshot-Ordner oeffnen, Beenden. Linksklick aufs Tray-Icon oeffnet das Status-Fenster. Schliessen des Fensters beendet die App nicht; sie laeuft im Hintergrund weiter.

## Clipboard, Paste und Drag

Nach dem Snip liegen mehrere Formate gleichzeitig in der Zwischenablage:

- `CF_DIB` + eigenes `PNG`-Format: Chat-/Bild-Apps fuegen mit `Ctrl + V` das Bild ein.
- `CF_UNICODETEXT` = PNG-Pfad: Terminals/CLIs fuegen mit `Ctrl + V` den Dateipfad als Text ein.
- `CF_HDROP` = PNG-Pfad: Explorer und datei-orientierte Ziele bekommen die Datei.

Das Thumbnail unten links zeigt nur den Screenshot. Drag vom Thumbnail startet ein echtes natives Drag-and-drop der PNG-Datei. Nach erfolgreichem Drop verschwindet das Thumbnail automatisch.

## Per SSH senden (Remote-Terminal-Workflow)

In einem SSH-Terminal nuetzt der lokale Pfad nichts — die Datei existiert auf dem Remote-Host nicht. Mit "Per SSH senden" laedt SnipDrop den Screenshot per `scp` auf einen Server und legt **den Remote-Pfad** in die Zwischenablage. So fuegt man mit `Ctrl + V` ein Bild in Tools ein, die ueber SSH laufen (z. B. Claude Code, OpenCode, Editoren), die den Bildpfad lesen und das Bild anhaengen.

- Ziel konfigurieren: Einstellungen → Tab **SSH** → Host (`server-alias` aus `~/.ssh/config` **oder** `user@host`) + Remote-Verzeichnis (Default `/tmp`) + optional **SSH-Key** (Pfad zur privaten Key-Datei). "Verbindung testen" prueft per `ssh <host> true`.
- SSH-Key-Feld: nur noetig, wenn der Key einen Nicht-Standard-Namen hat (nicht `id_ed25519`/`id_rsa`) und **nicht** in `~/.ssh/config` steht. Gesetzt → `scp`/`ssh -i <pfad> -o IdentitiesOnly=yes`. Leer → ssh waehlt selbst (Default-Keys / `ssh-agent` / `~/.ssh/config`).
- Aktion (manuell): Hover ueber ein Galerie-Bild → Sende-Button (oben rechts). Ein Toast meldet Erfolg/Fehler.
- Aktion (**Auto-Modus**): Im SSH-Tab den Schalter **Auto-Modus** aktivieren. Solange er an ist, wird **jeder neue Snip** automatisch hochgeladen und der **Remote-Pfad** statt des lokalen Pfads in die Zwischenablage gelegt. So liefert `Ctrl + V` direkt im SSH-Terminal den Remote-Pfad, ohne den Sende-Button. Der Schalter bleibt an, bis man ihn wieder ausschaltet; solange aktiv, landet jeder Screenshot auf dem Server (`/tmp` waechst). Erfolg/Fehler kommen ueber denselben Toast wie beim manuellen Versand.
- Transport: das in Windows eingebaute OpenSSH (`scp.exe`/`ssh.exe`), `BatchMode=yes` — Auth ausschliesslich ueber SSH-Keys / `ssh-agent`, **keine** Passwoerter in der App. Voraussetzung: der Host-Key ist bereits in `known_hosts` (einmal vorher manuell verbunden).
- Bewusst **kein** OSC-/Inline-Bildprotokoll (OSC 52/1337/Kitty): die spricht das Terminal-Programm selbst, ein Clipboard-Tool kann sie nicht in eine laufende SSH-Sitzung injizieren. Upload + Pfad funktioniert mit jedem Terminal und jeder Bildgroesse.

### SSH-Galerie (Remote-Ordner verwalten)

Im Hauptfenster hat die Galerie zwei Tabs: **Lokal** (die Snips in `Pictures\SnipDrop`) und **SSH** (die Screenshots im Remote-Ordner). Der SSH-Tab ist bewusst eine **schnelle Liste**, kein Thumbnail-Grid: pro Bild eine Zeile mit Name, Groesse und Datum. Das spart Bandbreite — ein ~6-MB-Screenshot wird nur geladen, wenn man ihn bewusst anklickt.

- **Listen:** Ein `ssh`-Aufruf liest den Remote-Ordner (`snipdrop-*.png`) per `stat`. Refresh-Button oben.
- **Vorschau:** Klick auf das Augen-Symbol laedt genau dieses eine Bild per `scp` in einen lokalen Temp-Ordner und zeigt es; von dort laesst es sich als Bild in die Zwischenablage kopieren.
- **Pfad kopieren:** legt den Remote-Pfad in die Zwischenablage (fuer `Ctrl + V` im SSH-Tool).
- **Loeschen:** entfernt das Bild nach Rueckfrage direkt auf dem Server (`ssh … rm`). SnipDrop loescht **nie** ungefragt fremde Dateien.
- **Sicherheit:** Jeder Remote-Pfad wird vor `scp`/`rm` geprueft (nur `snipdrop-<ziffern>.png`, keine Shell-Sonderzeichen) — kein versehentliches Loeschen anderer Dateien, keine Command-Injection.

### Optionale Aufbewahrung (Retention)

Wer den Auto-Modus dauerhaft nutzt, kann im SSH-Tab der Einstellungen festlegen: **Alte Remote-Screenshots loeschen nach N Tagen**. Beim Oeffnen des SSH-Tabs werden dann `snipdrop-*.png`, die aelter sind, per `find … -mtime` entfernt. **Default `0` = aus** — ohne explizite Eingabe loescht SnipDrop nie automatisch.

## Annotationen

Klick auf das Thumbnail oeffnet den Editor. V1 bietet einen einfachen roten Stift und Rueckgaengig. Beim Fertigstellen wird eine bearbeitete Kopie als `-edit.png` gespeichert. Danach nutzen `Ctrl + V` und Drag-and-drop diese bearbeitete Kopie.

## Architektur

SnipDrop installiert unter Windows einen `WH_KEYBOARD_LL` Hook. Wenn der konfigurierte Hotkey erkannt wird, wird der Windows-Handler unterdrueckt und SnipDrop startet den nativen Capture-Flow:

1. Virtuellen Desktop per GDI `BitBlt` erfassen.
2. Snapshot gedimmt in einem nativen Topmost-Toolwindow zeichnen.
3. Rechteck per Mouse-down/move/up normalisieren, inklusive Multi-Monitor-Koordinaten mit negativen Offsets.
4. Auswahl aus dem Desktop-Snapshot croppen.
5. PNG schreiben, Bild/Pfad/Drop-Daten in Clipboard legen, `latest_shot` aktualisieren, `shot-created` senden und Thumbnail anzeigen.

Es gibt bewusst kein Tauri/Webview-Vollbild-Overlay. Der Capture-Abbruch liegt auf Win32-Message-Ebene.

## Entwicklung

```powershell
npm install
npm run tauri dev
```

Release-Build inklusive Windows-Installer:

```powershell
npm run tauri build
```

## Grenzen

- Nur Windows.
- V1 kann Rechteck-Snips, keine Freeform-/Fenster-/Vollbildmodi.
- Kein OCR, kein Blur, kein Textwerkzeug, kein Cloud-Sync.
- Nicht signiert. Bei oeffentlichen Downloads ist SmartScreen-Warnung wahrscheinlich.
