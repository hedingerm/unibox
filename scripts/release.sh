#!/usr/bin/env bash
# Baut eine neue Version und veröffentlicht sie als GitHub-Release.
#
#   bun run release            # 0.1.0 -> 0.1.1
#   bun run release minor      # 0.1.0 -> 0.2.0
#   bun run release 1.4.0      # explizite Version
#   bun run release patch --no-checks
#
# Voraussetzung: sauberer Worktree, `gh auth login`.
set -euo pipefail
cd "$(dirname "$0")/.."

BUMP="patch"
CHECKS=1
for arg in "$@"; do
  case "$arg" in
    --no-checks) CHECKS=0 ;;
    major|minor|patch) BUMP="$arg" ;;
    [0-9]*.[0-9]*.[0-9]*) BUMP="$arg" ;;
    *) echo "Unbekanntes Argument: $arg" >&2; exit 1 ;;
  esac
done

if [ -n "$(git status --porcelain)" ]; then
  echo "Worktree ist nicht sauber — bitte erst committen." >&2
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
REPO="hedingerm/unibox"

if [ "$CHECKS" -eq 1 ]; then
  echo "==> typecheck + tests"
  bun run typecheck
  bun run test
fi

VERSION="$(node --input-type=commonjs -e '
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const arg = process.argv[1];
let next;
if (/^\d+\.\d+\.\d+$/.test(arg)) {
  next = arg;
} else {
  const [ma, mi, pa] = pkg.version.split(".").map(Number);
  next = arg === "major" ? `${ma + 1}.0.0` : arg === "minor" ? `${ma}.${mi + 1}.0` : `${ma}.${mi}.${pa + 1}`;
}
pkg.version = next;
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
process.stdout.write(next);
' "$BUMP")"

if git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null; then
  git checkout -- package.json
  echo "Tag v$VERSION existiert bereits." >&2
  exit 1
fi

echo "==> Release v$VERSION"
git add package.json
git commit -m "Release v$VERSION"
git tag -a "v$VERSION" -m "Unibox v$VERSION"
git push origin "$BRANCH"
git push origin "v$VERSION"

echo "==> build"
bun run dist

# Das Hochladen macht gh, nicht electron-builder: dessen Publisher legt pro
# Ziel-Artefakt parallel ein Release an und rennt in ein 422.
echo "==> upload"
gh release create "v$VERSION" --repo "$REPO" --title "v$VERSION" --generate-notes \
  "dist/Unibox-$VERSION-arm64.dmg" "dist/Unibox-$VERSION-arm64.zip"

echo
echo "Fertig: $(gh release view "v$VERSION" --repo "$REPO" --json url -q .url)"
echo "Auf jedem Mac aktualisieren mit: scripts/install.sh"
