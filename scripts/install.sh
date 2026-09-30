#!/usr/bin/env bash
# Installiert bzw. aktualisiert Unibox aus dem letzten GitHub-Release.
#
#   scripts/install.sh             # nur wenn eine neuere Version vorliegt
#   scripts/install.sh --force     # immer neu installieren
#   scripts/install.sh --quit      # eine laufende Instanz beenden statt abbrechen
#   scripts/install.sh --relaunch  # beenden, ersetzen, neu starten (so ruft die App sich selbst auf)
#
# Voraussetzung: gh (`gh auth login`).
set -euo pipefail

REPO="hedingerm/unibox"
APP="/Applications/Unibox.app"
ARCH="$(uname -m)"
FORCE=0
RELAUNCH=0
QUIT=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --relaunch) RELAUNCH=1; QUIT=1 ;;
    --quit) QUIT=1 ;;
    *) echo "Unbekanntes Argument: $arg" >&2; exit 1 ;;
  esac
done

# Ein aus dem Dock gestartetes Programm erbt ein nacktes PATH — `command -v gh`
# findet dort nichts, und der Aufruf aus der App scheiterte still. Deshalb die
# üblichen Orte direkt absuchen; die App reicht ihren Fund als UNIBOX_GH_PATH
# durch.
resolve_gh() {
  if [ -n "${UNIBOX_GH_PATH:-}" ] && [ -x "$UNIBOX_GH_PATH" ]; then
    echo "$UNIBOX_GH_PATH"
    return
  fi
  for candidate in /opt/homebrew/bin/gh /usr/local/bin/gh /usr/bin/gh "$HOME/.local/bin/gh" "$HOME/bin/gh"; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return
    fi
  done
  command -v gh 2>/dev/null || true
}

GH="$(resolve_gh)"
[ -n "$GH" ] || { echo "gh CLI fehlt: brew install gh" >&2; exit 1; }
"$GH" auth status >/dev/null 2>&1 || { echo "Nicht eingeloggt: gh auth login" >&2; exit 1; }

# Scheitert das Update, steht der Nutzer sonst ohne App da: die App hat sich für
# den Austausch schon beendet.
cleanup() {
  status=$?
  [ -n "${TMP:-}" ] && rm -rf "$TMP"
  if [ "$status" -ne 0 ] && [ "$RELAUNCH" -eq 1 ] && [ -d "$APP" ]; then
    echo "Update fehlgeschlagen — die bestehende Version wird wieder gestartet." >&2
    open -a "$APP" || true
  fi
}
trap cleanup EXIT

TAG="$("$GH" release view --repo "$REPO" --json tagName -q .tagName 2>/dev/null || true)"
[ -n "$TAG" ] || { echo "Noch kein Release in $REPO." >&2; exit 1; }
LATEST="${TAG#v}"
INSTALLED="$(defaults read "$APP/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || true)"

if [ -n "$INSTALLED" ] && [ "$INSTALLED" = "$LATEST" ] && [ "$FORCE" -eq 0 ]; then
  echo "Unibox $INSTALLED ist bereits aktuell."
  exit 0
fi

# Vor dem Download prüfen: 135 MB zu holen und dann am laufenden Prozess zu
# scheitern wäre reine Verschwendung.
if [ "$QUIT" -eq 0 ] && pgrep -f "$APP/Contents/MacOS/Unibox" >/dev/null 2>&1; then
  echo "Unibox läuft — beenden und erneut ausführen (oder --quit)." >&2
  exit 1
fi

echo "==> ${INSTALLED:-(neu)} -> $LATEST"
TMP="$(mktemp -d)"

"$GH" release download "$TAG" --repo "$REPO" --pattern "*-$ARCH.zip" --dir "$TMP"
ZIP="$(find "$TMP" -maxdepth 1 -name '*.zip' | head -1)"
[ -n "$ZIP" ] || { echo "Kein Build für $ARCH im Release $TAG." >&2; exit 1; }

# ditto statt unzip: erhält Symlinks und Signatur im .app-Bundle.
ditto -xk "$ZIP" "$TMP/extract"
NEW="$(find "$TMP/extract" -maxdepth 1 -name '*.app' | head -1)"
[ -n "$NEW" ] || { echo "Kein .app-Bundle im Archiv." >&2; exit 1; }

# Erst jetzt beenden, mit dem fertigen Bundle in der Hand: das Fenster ist nur
# so lange zu, wie das Austauschen dauert. Ein laufender Prozess, dem man das
# Bundle wegzieht, lädt beim nächsten Start nicht mehr vollständig.
if pgrep -f "$APP/Contents/MacOS/Unibox" >/dev/null 2>&1; then
  osascript -e 'quit app "Unibox"' >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do
    pgrep -f "$APP/Contents/MacOS/Unibox" >/dev/null 2>&1 || break
    sleep 0.5
  done
  if pgrep -f "$APP/Contents/MacOS/Unibox" >/dev/null 2>&1; then
    echo "Unibox lässt sich nicht beenden — Update abgebrochen." >&2
    exit 1
  fi
fi

rm -rf "$APP"
ditto "$NEW" "$APP"
# Ad-hoc signiert und nicht notarisiert — Gatekeeper würde sonst blockieren.
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

echo "Unibox $LATEST installiert nach $APP."
if [ "$RELAUNCH" -eq 1 ]; then
  open -a "$APP"
fi
