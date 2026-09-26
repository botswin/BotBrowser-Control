#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-latest}"
MANIFEST_URL="${CONTROL_MANIFEST_URL:-https://github.com/botswin/BotBrowser-Control/releases/latest/download/manifest.json}"
INSTALL_DIR="${CONTROL_INSTALL_DIR:-$HOME/Applications}"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/botbrowser-control.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

command -v curl >/dev/null || { echo 'curl is required' >&2; exit 1; }
command -v shasum >/dev/null || { echo 'shasum is required' >&2; exit 1; }
command -v unzip >/dev/null || { echo 'unzip is required' >&2; exit 1; }
command -v node >/dev/null || { echo 'node is required to read the manifest' >&2; exit 1; }

case "$(uname -m)" in
  arm64) arch=arm64 ;;
  x86_64) arch=x64 ;;
  *) echo "Unsupported macOS architecture: $(uname -m)" >&2; exit 1 ;;
esac

manifest="$TMP_DIR/manifest.json"
curl -fsSL "$MANIFEST_URL" -o "$manifest"
asset="$(node -e 'const fs=require("fs"); const m=JSON.parse(fs.readFileSync(process.argv[1])); const v=process.argv[2], a=process.argv[3]; const x=(m.assets||[]).filter(x=>x.platform==="darwin"&&x.arch===a&&(v==="latest"||x.version===v)&&/\.zip$/i.test(x.name)); if(x.length!==1) process.exit(2); process.stdout.write(JSON.stringify(x[0]));' "$manifest" "$VERSION" "$arch")" || { echo "No unique macOS $arch asset for $VERSION" >&2; exit 1; }
url="$(printf '%s' "$asset" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).url')"
sha="$(printf '%s' "$asset" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).sha256')"
name="$(printf '%s' "$asset" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).name')"

archive="$TMP_DIR/$name"
curl -fsSL "$url" -o "$archive"
printf '%s  %s\n' "$sha" "$archive" | shasum -a 256 -c -
mkdir -p "$INSTALL_DIR"
unzip -q "$archive" -d "$TMP_DIR/app"
app="$(find "$TMP_DIR/app" -maxdepth 2 -name '*.app' -print -quit)"
[ -n "$app" ] || { echo 'Release ZIP contains no .app bundle' >&2; exit 1; }
target="$INSTALL_DIR/$(basename "$app")"
rm -rf "$target"
mv "$app" "$target"
open "$target"
echo "Installed BotBrowser Control $VERSION ($arch) to $target"
