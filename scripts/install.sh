#!/usr/bin/env bash
# Installiert bzw. aktualisiert Unibox aus dem letzten GitHub-Release.
# macOS: /Applications/Unibox.app. Linux: ~/.local/share/unibox, dazu ein
# Starter-Eintrag (.desktop) und ~/.local/bin/unibox.
#
#   scripts/install.sh             # nur wenn eine neuere Version vorliegt
#   scripts/install.sh --force     # immer neu installieren
#   scripts/install.sh --quit      # eine laufende Instanz beenden statt abbrechen
#   scripts/install.sh --relaunch  # beenden, ersetzen, neu starten (so ruft die App sich selbst auf)
#   scripts/install.sh --archive=dist/Unibox-1.2.3-x64.tar.gz  # lokalen Build installieren, ohne GitHub
#
# Voraussetzung: gh (`gh auth login`), ausser mit --archive.
set -euo pipefail

REPO="hedingerm/unibox"
OS="$(uname -s)"
ARCH="$(uname -m)"
if [ "$OS" = "Darwin" ]; then
  APP="/Applications/Unibox.app"
  BIN="$APP/Contents/MacOS/Unibox"
  ASSET="*-$ARCH.zip"
else
  APP="${XDG_DATA_HOME:-$HOME/.local/share}/unibox"
  BIN="$APP/unibox"
  # electron-builder benennt nach Node-Arch, nicht nach uname.
  case "$ARCH" in
    x86_64) ASSET="*-x64.tar.gz" ;;
    aarch64) ASSET="*-arm64.tar.gz" ;;
    *) echo "Nicht unterstützte Architektur: $ARCH" >&2; exit 1 ;;
  esac
fi
FORCE=0
RELAUNCH=0
QUIT=0
LOCAL=""
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --relaunch) RELAUNCH=1; QUIT=1 ;;
    --quit) QUIT=1 ;;
    --archive=*) LOCAL="$(realpath "${arg#--archive=}")" ;;
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
  for candidate in /opt/homebrew/bin/gh /usr/local/bin/gh /usr/bin/gh "$HOME/.local/bin/gh" "$HOME/.local/share/mise/shims/gh" "$HOME/bin/gh"; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return
    fi
  done
  command -v gh 2>/dev/null || true
}

if [ -z "$LOCAL" ]; then
  GH="$(resolve_gh)"
  if [ -z "$GH" ]; then
    [ "$OS" = "Darwin" ] && echo "gh CLI fehlt: brew install gh" >&2 || echo "gh CLI fehlt: sudo pacman -S github-cli" >&2
    exit 1
  fi
  "$GH" auth status >/dev/null 2>&1 || { echo "Nicht eingeloggt: gh auth login" >&2; exit 1; }
fi

# Scheitert das Update, steht der Nutzer sonst ohne App da: die App hat sich für
# den Austausch schon beendet.
cleanup() {
  status=$?
  [ -n "${TMP:-}" ] && rm -rf "$TMP"
  if [ "$status" -ne 0 ] && [ "$RELAUNCH" -eq 1 ] && [ -d "$APP" ]; then
    echo "Update fehlgeschlagen — die bestehende Version wird wieder gestartet." >&2
    launch || true
  fi
}

launch() {
  if [ "$OS" = "Darwin" ]; then
    open -a "$APP"
  else
    setsid -f "$BIN" >/dev/null 2>&1 </dev/null
  fi
}
trap cleanup EXIT

if [ -n "$LOCAL" ]; then
  [ -f "$LOCAL" ] || { echo "Archiv fehlt: $LOCAL" >&2; exit 1; }
  # Die Version steht im Dateinamen, den electron-builder vergibt.
  LATEST="$(basename "$LOCAL" | sed -nE 's/^Unibox-([0-9]+\.[0-9]+\.[0-9]+)-.*/\1/p')"
  [ -n "$LATEST" ] || { echo "Keine Version im Dateinamen: $LOCAL" >&2; exit 1; }
else
  TAG="$("$GH" release view --repo "$REPO" --json tagName -q .tagName 2>/dev/null || true)"
  [ -n "$TAG" ] || { echo "Noch kein Release in $REPO." >&2; exit 1; }
  LATEST="${TAG#v}"
  # Jedes OS hängt seinen Build einzeln an: fehlt unserer noch, ist nichts zu tun.
  if ! "$GH" release view "$TAG" --repo "$REPO" --json assets -q '.assets[].name' | grep -q -e "${ASSET#\*}$"; then
    echo "Release $TAG hat noch keinen Build für $OS/$ARCH — nichts zu tun."
    exit 0
  fi
fi
if [ "$OS" = "Darwin" ]; then
  INSTALLED="$(defaults read "$APP/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || true)"
else
  # Das Tarball trägt keine lesbare Version — install.sh legt sie selbst ab.
  INSTALLED="$(cat "$APP/.version" 2>/dev/null || true)"
fi

if [ -n "$INSTALLED" ] && [ "$INSTALLED" = "$LATEST" ] && [ "$FORCE" -eq 0 ]; then
  echo "Unibox $INSTALLED ist bereits aktuell."
  exit 0
fi

# Vor dem Download prüfen: 135 MB zu holen und dann am laufenden Prozess zu
# scheitern wäre reine Verschwendung.
if [ "$QUIT" -eq 0 ] && pgrep -f "$BIN" >/dev/null 2>&1; then
  echo "Unibox läuft — beenden und erneut ausführen (oder --quit)." >&2
  exit 1
fi

echo "==> ${INSTALLED:-(neu)} -> $LATEST"
TMP="$(mktemp -d)"

if [ -n "$LOCAL" ]; then
  ARCHIVE="$LOCAL"
else
  "$GH" release download "$TAG" --repo "$REPO" --pattern "$ASSET" --dir "$TMP"
  ARCHIVE="$(find "$TMP" -maxdepth 1 -name "$ASSET" | head -1)"
  [ -n "$ARCHIVE" ] || { echo "Kein Build für $OS/$ARCH im Release $TAG." >&2; exit 1; }
fi

mkdir -p "$TMP/extract"
if [ "$OS" = "Darwin" ]; then
  # ditto statt unzip: erhält Symlinks und Signatur im .app-Bundle.
  ditto -xk "$ARCHIVE" "$TMP/extract"
  NEW="$(find "$TMP/extract" -maxdepth 1 -name '*.app' | head -1)"
else
  tar -xzf "$ARCHIVE" -C "$TMP/extract"
  NEW="$(dirname "$(find "$TMP/extract" -maxdepth 2 -type f -name unibox | head -1)")"
fi
[ -n "$NEW" ] && [ "$NEW" != "." ] || { echo "Keine App im Archiv." >&2; exit 1; }

# Erst jetzt beenden, mit dem fertigen Bundle in der Hand: das Fenster ist nur
# so lange zu, wie das Austauschen dauert. Ein laufender Prozess, dem man das
# Bundle wegzieht, lädt beim nächsten Start nicht mehr vollständig.
if pgrep -f "$BIN" >/dev/null 2>&1; then
  if [ "$OS" = "Darwin" ]; then
    osascript -e 'quit app "Unibox"' >/dev/null 2>&1 || true
  else
    pkill -TERM -f "$BIN" >/dev/null 2>&1 || true
  fi
  for _ in $(seq 1 20); do
    pgrep -f "$BIN" >/dev/null 2>&1 || break
    sleep 0.5
  done
  if pgrep -f "$BIN" >/dev/null 2>&1; then
    echo "Unibox lässt sich nicht beenden — Update abgebrochen." >&2
    exit 1
  fi
fi

rm -rf "$APP"
if [ "$OS" = "Darwin" ]; then
  ditto "$NEW" "$APP"
  # Ad-hoc signiert und nicht notarisiert — Gatekeeper würde sonst blockieren.
  xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
else
  mkdir -p "$(dirname "$APP")"
  mv "$NEW" "$APP"
  echo "$LATEST" > "$APP/.version"
  # Starter-Eintrag und Befehl. Der Dateiname unibox.desktop ist zugleich
  # die Wayland-App-ID, über die Hyprland Fenster und Icon zuordnet.
  DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
  mkdir -p "$DATA/applications" "$HOME/.local/bin"
  ln -sf "$BIN" "$HOME/.local/bin/unibox"
  cat > "$DATA/applications/unibox.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Unibox
Comment=Gmail und Resend in einer Inbox
Exec=$BIN
Icon=$APP/resources/icon.png
Terminal=false
Categories=Office;Email;Network;
StartupWMClass=unibox
DESKTOP
  update-desktop-database "$DATA/applications" >/dev/null 2>&1 || true
fi

echo "Unibox $LATEST installiert nach $APP."
if [ "$RELAUNCH" -eq 1 ]; then
  launch
fi
