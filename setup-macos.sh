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

case "$(uname -m)" in
  arm64) node_arch=arm64; build_arch=arm64 ;;
  x86_64) node_arch=x64; build_arch=x64 ;;
  *) echo "Unsupported macOS architecture: $(uname -m)" >&2; exit 1 ;;
esac

if [ -x "$NODE_DIR/bin/node" ] && [ "$("$NODE_DIR/bin/node" --version)" != "v$NODE_VERSION" ]; then rm -rf "$NODE_DIR"; fi
mkdir -p "$INSTALL_DIR"
if [ ! -x "$NODE_DIR/bin/node" ]; then
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-${node_arch}.tar.gz" -o "$TMP_DIR/node.tar.gz"
  tar -xzf "$TMP_DIR/node.tar.gz" -C "$TMP_DIR"
  mv "$TMP_DIR/node-v${NODE_VERSION}-darwin-${node_arch}" "$NODE_DIR"
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
npm run build:mac -- --"$build_arch"
app="$(find "$REPO_DIR/dist" -maxdepth 3 -type d -name '*.app' -print -quit)"
[ -n "$app" ] || { echo 'macOS build produced no .app bundle' >&2; exit 1; }
mkdir -p "$HOME/Applications"
rm -rf "$HOME/Applications/BotBrowser Control.app"
mv "$app" "$HOME/Applications/BotBrowser Control.app"
open "$HOME/Applications/BotBrowser Control.app"
