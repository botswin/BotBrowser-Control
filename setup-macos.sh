#!/usr/bin/env bash
set -euo pipefail

NODE_VERSION="24.15.0"
INSTALL_DIR="${CONTROL_INSTALL_DIR:-$HOME/.botbrowser-control}"
NODE_DIR="$INSTALL_DIR/node"
REPO_DIR="$INSTALL_DIR/BotBrowser-Control"
REPO_ZIP_URL="${CONTROL_REPO_ZIP_URL:-https://github.com/botswin/BotBrowser-Control/archive/refs/heads/main.zip}"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/botbrowser-control.XXXXXX")"
STAGE_DIR=""
OLD_NODE_ARCHIVE=""
OLD_REPO_ARCHIVE=""
OLD_APP_ARCHIVE=""
CHILD_PID=""

cleanup() {
  status=$?
  if [ -n "$CHILD_PID" ]; then terminate_process_tree "$CHILD_PID"; fi
  if [ "$status" -ne 0 ] && [ -n "$OLD_APP_ARCHIVE" ] && [ -d "$OLD_APP_ARCHIVE" ] && [ ! -e "$HOME/Applications/BotBrowser Control.app" ]; then
    mv "$OLD_APP_ARCHIVE" "$HOME/Applications/BotBrowser Control.app" || echo "Could not restore previous app from $OLD_APP_ARCHIVE" >&2
  fi
  if [ "$status" -ne 0 ] && [ -n "$OLD_REPO_ARCHIVE" ] && [ -d "$OLD_REPO_ARCHIVE" ] && [ ! -e "$REPO_DIR" ]; then
    mv "$OLD_REPO_ARCHIVE" "$REPO_DIR" || echo "Could not restore previous install from $OLD_REPO_ARCHIVE" >&2
  fi
  if [ "$status" -ne 0 ] && [ -n "$OLD_NODE_ARCHIVE" ] && [ -d "$OLD_NODE_ARCHIVE" ] && [ ! -e "$NODE_DIR" ]; then
    mv "$OLD_NODE_ARCHIVE" "$NODE_DIR" || echo "Could not restore previous Node.js from $OLD_NODE_ARCHIVE" >&2
  fi
  if [ -n "$STAGE_DIR" ] && [ -d "$STAGE_DIR" ]; then rm -rf "$STAGE_DIR"; fi
  rm -rf "$TMP_DIR"
  return "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

terminate_process_tree() {
  local parent=$1 child
  for child in $(pgrep -P "$parent" 2>/dev/null || true); do
    terminate_process_tree "$child"
  done
  kill "$parent" 2>/dev/null || true
  if [ "$parent" = "$CHILD_PID" ]; then wait "$parent" 2>/dev/null || true; fi
}

run_with_heartbeat() {
  label=$1
  shift
  "$@" &
  CHILD_PID=$!
  elapsed=0
  while kill -0 "$CHILD_PID" 2>/dev/null; do
    sleep 1
    if kill -0 "$CHILD_PID" 2>/dev/null; then
      elapsed=$((elapsed + 1))
      if [ $((elapsed % 5)) -eq 0 ]; then echo "Still $label..."; fi
    fi
  done
  status=0
  wait "$CHILD_PID" || status=$?
  CHILD_PID=""
  return "$status"
}

command -v curl >/dev/null || { echo 'curl is required' >&2; exit 1; }
command -v unzip >/dev/null || { echo 'unzip is required' >&2; exit 1; }

case "$(uname -m)" in
  arm64) node_arch=arm64; build_arch=arm64 ;;
  x86_64) node_arch=x64; build_arch=x64 ;;
  *) echo "Unsupported macOS architecture: $(uname -m)" >&2; exit 1 ;;
esac

mkdir -p "$INSTALL_DIR"
echo "[1/6] Checking Node.js runtime..."
node_matches=0
if [ -x "$NODE_DIR/bin/node" ] && [ "$("$NODE_DIR/bin/node" --version)" = "v$NODE_VERSION" ] && [ "$("$NODE_DIR/bin/node" -p process.arch)" = "$node_arch" ]; then
  node_matches=1
fi
if [ -e "$NODE_DIR" ] && [ "$node_matches" -ne 1 ]; then
  stamp="$(date +%Y%m%d-%H%M%S)"
  suffix=0
  OLD_NODE_ARCHIVE="$INSTALL_DIR/node.previous.$stamp"
  while [ -e "$OLD_NODE_ARCHIVE" ]; do
    suffix=$((suffix + 1))
    OLD_NODE_ARCHIVE="$INSTALL_DIR/node.previous.$stamp.$suffix"
  done
  mv "$NODE_DIR" "$OLD_NODE_ARCHIVE"
fi
if [ ! -x "$NODE_DIR/bin/node" ]; then
  run_with_heartbeat "downloading Node.js" curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-${node_arch}.tar.gz" -o "$TMP_DIR/node.tar.gz"
  run_with_heartbeat "extracting Node.js" tar -xzf "$TMP_DIR/node.tar.gz" -C "$TMP_DIR"
  mv "$TMP_DIR/node-v${NODE_VERSION}-darwin-${node_arch}" "$NODE_DIR"
fi

echo "[2/6] Downloading BotBrowser Control..."
run_with_heartbeat "downloading BotBrowser Control" curl -fsSL "$REPO_ZIP_URL" -o "$TMP_DIR/control.zip"
STAGE_DIR="$(mktemp -d "$INSTALL_DIR/.BotBrowser-Control.stage.XXXXXX")"
mkdir "$STAGE_DIR/unpacked"
echo "[3/6] Unpacking BotBrowser Control..."
run_with_heartbeat "unpacking BotBrowser Control" unzip -q "$TMP_DIR/control.zip" -d "$STAGE_DIR/unpacked"
mv "$STAGE_DIR/unpacked/BotBrowser-Control-main" "$STAGE_DIR/repo"
export PATH="$NODE_DIR/bin:$PATH" NPM_CONFIG_UPDATE_NOTIFIER=false
cd "$STAGE_DIR/repo"
echo "[4/6] Installing Node.js dependencies (this may take several minutes)..."
run_with_heartbeat "installing Node.js dependencies" npm ci
echo "[5/6] Building BotBrowser Control (this may take several minutes)..."
run_with_heartbeat "building BotBrowser Control" npm run pack -- --mac --"$build_arch"
app="$(find "$STAGE_DIR/repo/dist" -maxdepth 3 -type d -name '*.app' -print -quit)"
[ -n "$app" ] || { echo 'macOS build produced no .app bundle' >&2; exit 1; }

if [ -e "$REPO_DIR" ]; then
  stamp="$(date +%Y%m%d-%H%M%S)"
  suffix=0
  OLD_REPO_ARCHIVE="$INSTALL_DIR/BotBrowser-Control.previous.$stamp"
  while [ -e "$OLD_REPO_ARCHIVE" ]; do
    suffix=$((suffix + 1))
    OLD_REPO_ARCHIVE="$INSTALL_DIR/BotBrowser-Control.previous.$stamp.$suffix"
  done
  mv "$REPO_DIR" "$OLD_REPO_ARCHIVE"
fi
mv "$STAGE_DIR/repo" "$REPO_DIR"

app="$(find "$REPO_DIR/dist" -maxdepth 3 -type d -name '*.app' -print -quit)"
if [ "${CONTROL_SKIP_SHORTCUTS:-0}" != "1" ]; then
  mkdir -p "$HOME/Applications"
  if [ -e "$HOME/Applications/BotBrowser Control.app" ]; then
    stamp="$(date +%Y%m%d-%H%M%S)"
    suffix=0
    OLD_APP_ARCHIVE="$HOME/Applications/BotBrowser Control.previous.$stamp.app"
    while [ -e "$OLD_APP_ARCHIVE" ]; do
      suffix=$((suffix + 1))
      OLD_APP_ARCHIVE="$HOME/Applications/BotBrowser Control.previous.$stamp.$suffix.app"
    done
    mv "$HOME/Applications/BotBrowser Control.app" "$OLD_APP_ARCHIVE"
  fi
  mv "$app" "$HOME/Applications/BotBrowser Control.app"
  app="$HOME/Applications/BotBrowser Control.app"
fi

if [ "${CONTROL_SKIP_LAUNCH:-0}" = "1" ]; then
  echo "[6/6] Installed BotBrowser Control; launch skipped."
  exit 0
fi
open "$app"
