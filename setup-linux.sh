#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-latest}"
MANIFEST_URL="${CONTROL_MANIFEST_URL:-https://github.com/botswin/BotBrowser-Control/releases/latest/download/manifest.json}"
INSTALL_DIR="${CONTROL_INSTALL_DIR:-$HOME/.local/share/botbrowser-control}"
BIN_DIR="${HOME}/.local/bin"
APP_DIR="${HOME}/.local/share/applications"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/botbrowser-control.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

command -v curl >/dev/null || { echo 'curl is required' >&2; exit 1; }
command -v sha256sum >/dev/null || { echo 'sha256sum is required' >&2; exit 1; }
command -v node >/dev/null || { echo 'node is required to read the manifest' >&2; exit 1; }

arch="$(uname -m)"
case "$arch" in
  x86_64|amd64) arch=x64; asset_ext=AppImage ;;
  aarch64|arm64) arch=arm64; asset_ext=AppImage ;;
  *) echo "Unsupported Linux architecture: $arch" >&2; exit 1 ;;
esac

manifest="$TMP_DIR/manifest.json"
curl -fsSL "$MANIFEST_URL" -o "$manifest"
asset="$(node -e 'const fs=require("fs"); const m=JSON.parse(fs.readFileSync(process.argv[1])); const v=process.argv[2], a=process.argv[3]; const x=(m.assets||[]).filter(x=>x.platform==="linux"&&x.arch===a&&(v==="latest"||x.version===v)&&/AppImage$/i.test(x.name)); if(x.length!==1) process.exit(2); process.stdout.write(JSON.stringify(x[0]));' "$manifest" "$VERSION" "$arch")" || { echo "No unique Linux $arch asset for $VERSION" >&2; exit 1; }
url="$(printf '%s' "$asset" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).url')"
sha="$(printf '%s' "$asset" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).sha256')"
name="$(printf '%s' "$asset" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).name')"

archive="$TMP_DIR/$name"
curl -fsSL "$url" -o "$archive"
printf '%s  %s\n' "$sha" "$archive" | sha256sum -c -
mkdir -p "$INSTALL_DIR" "$BIN_DIR" "$APP_DIR"
target="$INSTALL_DIR/$name"
install -m 0755 "$archive" "$target"
ln -sfn "$target" "$BIN_DIR/botbrowser-control"
cat > "$APP_DIR/botbrowser-control.desktop" <<EOF
[Desktop Entry]
Name=BotBrowser Control
Exec=$BIN_DIR/botbrowser-control
Terminal=false
Type=Application
Categories=Utility;Network;
EOF
echo "Installed BotBrowser Control $VERSION ($arch) to $target"
