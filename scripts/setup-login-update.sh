#!/usr/bin/env bash
# Richtet einen Launch-Agent ein, der bei jeder Anmeldung nach einer neuen
# Unibox-Version sucht und sie installiert. Die App prüft beim Start selbst;
# das hier deckt den Fall ab, dass sie tagelang offen bleibt oder gar nicht
# gestartet wird.
#
#   scripts/setup-login-update.sh            # einrichten
#   scripts/setup-login-update.sh --remove   # wieder entfernen
set -euo pipefail

LABEL="ch.hedinger.unibox.update"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/unibox-update.log"
INSTALLER="/Applications/Unibox.app/Contents/Resources/install.sh"
DOMAIN="gui/$(id -u)"

if [ "${1:-}" = "--remove" ]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Launch-Agent entfernt."
  exit 0
fi

[ -f "$INSTALLER" ] || { echo "Unibox ist nicht installiert: $INSTALLER fehlt." >&2; exit 1; }

mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
cat > "$PLIST" <<PLISTXML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$INSTALLER</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
PLISTXML

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "Launch-Agent eingerichtet: prüft bei jeder Anmeldung, Protokoll in $LOG."
