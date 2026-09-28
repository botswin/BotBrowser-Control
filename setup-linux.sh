#!/usr/bin/env bash
set -euo pipefail

NODE_VERSION="24.15.0"
INSTALL_DIR="${CONTROL_INSTALL_DIR:-$HOME/.botbrowser-control}"
NODE_DIR="$INSTALL_DIR/node"
REPO_DIR="$INSTALL_DIR/BotBrowser-Control"
REPO_ZIP_URL="${CONTROL_REPO_ZIP_URL:-https://github.com/botswin/BotBrowser-Control/archive/refs/heads/main.zip}"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/botbrowser-control.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

command -v curl >/dev/null || { echo 'curl is required' >&2; exit 1; }
command -v unzip >/dev/null || { echo 'unzip is required' >&2; exit 1; }
command -v xz >/dev/null || { echo 'xz is required' >&2; exit 1; }

case "$(uname -m)" in
  x86_64|amd64) node_arch=x64; build_arch=x64 ;;
  aarch64|arm64) node_arch=arm64; build_arch=arm64 ;;
  *) echo "Unsupported Linux architecture: $(uname -m)" >&2; exit 1 ;;
esac

if [ -x "$NODE_DIR/bin/node" ] && [ "$("$NODE_DIR/bin/node" --version)" != "v$NODE_VERSION" ]; then rm -rf "$NODE_DIR"; fi
mkdir -p "$INSTALL_DIR"
if [ ! -x "$NODE_DIR/bin/node" ]; then
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" -o "$TMP_DIR/node.tar.xz"
  tar -xJf "$TMP_DIR/node.tar.xz" -C "$TMP_DIR"
  mv "$TMP_DIR/node-v${NODE_VERSION}-linux-${node_arch}" "$NODE_DIR"
fi

rm -rf "$REPO_DIR"
curl -fsSL "$REPO_ZIP_URL" -o "$TMP_DIR/control.zip"
unzip -q "$TMP_DIR/control.zip" -d "$INSTALL_DIR"
mv "$INSTALL_DIR/BotBrowser-Control-main" "$REPO_DIR"
export PATH="$NODE_DIR/bin:$PATH" NPM_CONFIG_UPDATE_NOTIFIER=false
cd "$REPO_DIR"
echo "[4/6] Installing Node.js dependencies (this may take several minutes)..."
npm ci
echo "[5/6] Building BotBrowser Control (this may take several minutes)..."
npm run build:linux -- --"$build_arch"
app="$(find "$REPO_DIR/dist" -maxdepth 3 -type f -name '*.AppImage' -print -quit)"
[ -n "$app" ] || { echo 'Linux build produced no AppImage' >&2; exit 1; }
chmod +x "$app"
mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications"
ln -sfn "$app" "$HOME/.local/bin/botbrowser-control"
cat > "$HOME/.local/share/applications/botbrowser-control.desktop" <<EOF
[Desktop Entry]
Name=BotBrowser Control
Exec=$HOME/.local/bin/botbrowser-control
Terminal=false
Type=Application
Categories=Utility;Network;
EOF
echo "[6/6] Launching BotBrowser Control..."
exec "$app"
