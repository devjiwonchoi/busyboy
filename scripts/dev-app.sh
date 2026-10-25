#!/bin/zsh
# Busyboy Dev: a macOS app icon that runs `pnpm dev:desktop` from this checkout.
#
#   pnpm dev:app:install     creates ~/Applications/Busyboy Dev.app for this checkout
#   zsh scripts/dev-app.sh   what the app runs on click
#
# A click pulls main (when the tree is clean), installs dependencies and starts
# dev:desktop. Clicking again while it runs brings the window forward. Quitting
# the window stops the dev servers. Logs go to ~/Library/Logs/Busyboy Dev/dev.log.
set -u

repo=${0:A:h:h}
desktop_dir="$repo/apps/desktop"
state_dir="$HOME/Library/Logs/Busyboy Dev"
log="$state_dir/dev.log"
pid_file="$state_dir/dev.pid"
app="$HOME/Applications/Busyboy Dev.app"
# Matches the dev Electron process by the flag dev-electron.mjs gives it. The
# trailing main.cjs skips dev-electron's own `pkill -f --t3code-dev-root=...`.
electron_pattern="--t3code-dev-root=$desktop_dir .*main\.cjs"
# Same bundle id apps/desktop/scripts/electron-launcher.mjs gives the dev Electron app.
repo_name=${(L)repo:t}
dev_bundle_id="dev.jiwon.busyboy.dev.${repo_name//[^a-z0-9]/}"

notify() {
  osascript -e "display notification \"$1\" with title \"Busyboy Dev\"" >/dev/null 2>&1
}

install_app() {
  local contents="$app/Contents"
  local icon_tmp=$(mktemp -d)
  local iconset="$icon_tmp/icon.iconset"

  rm -rf "$app"
  mkdir -p "$contents/MacOS" "$contents/Resources" "$iconset"

  for size in 16 32 128 256 512; do
    sips -z $size $size "$repo/assets/busyboy.png" --out "$iconset/icon_${size}x${size}.png" >/dev/null
    sips -z $((size * 2)) $((size * 2)) "$repo/assets/busyboy.png" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$iconset" -o "$contents/Resources/AppIcon.icns"
  rm -rf "$icon_tmp"

  # Finder starts apps without the login shell's PATH, so go through the
  # login shell to find node and pnpm.
  cat >"$contents/MacOS/busyboy-dev" <<EOF
#!/bin/sh
exec /bin/zsh -lic 'exec /bin/zsh "\$0"' '$repo/scripts/dev-app.sh'
EOF
  chmod +x "$contents/MacOS/busyboy-dev"

  # LSUIElement keeps the launcher out of the Dock; the dev Electron app shows there instead.
  cat >"$contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Busyboy Dev</string>
  <key>CFBundleDisplayName</key><string>Busyboy Dev</string>
  <key>CFBundleIdentifier</key><string>dev.jiwon.busyboy.devlauncher.$repo_name</string>
  <key>CFBundleExecutable</key><string>busyboy-dev</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
EOF

  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$app"
  echo "Installed $app (runs $repo)"
}

supervise() {
  echo $$ >"$pid_file"
  trap 'rm -f "$pid_file"' EXIT
  cd "$repo" || exit 1

  # Pull main first so a click runs the latest code. Local work is left alone.
  if [[ $(git branch --show-current) == main && -z $(git status --porcelain) ]]; then
    git pull --ff-only || echo "git pull failed; starting with the local code"
  fi

  if ! pnpm install; then
    notify "pnpm install failed. Opening the log."
    open "$log"
    exit 1
  fi

  notify "Starting dev:desktop…"

  # Run the dev tree in its own process group so it can be stopped as one.
  # zsh job control needs a terminal, so let perl create the group.
  perl -e 'setpgrp(0, 0); exec @ARGV' pnpm dev:desktop &
  local dev_pid=$!

  # Stop the dev servers once the window has been gone for 5 seconds. The grace
  # period covers dev-electron's restart after a main-process rebuild.
  local seen_window=false
  local missing_seconds=0
  while kill -0 $dev_pid 2>/dev/null; do
    if pgrep -f -- "$electron_pattern" >/dev/null; then
      seen_window=true
      missing_seconds=0
    elif $seen_window; then
      missing_seconds=$((missing_seconds + 1))
      if ((missing_seconds >= 5)); then
        break
      fi
    fi
    sleep 1
  done

  if ! kill -0 $dev_pid 2>/dev/null; then
    notify "dev:desktop exited. Opening the log."
    open "$log"
    exit 1
  fi

  echo "Window closed; stopping dev servers"
  kill -TERM -$dev_pid
  for _ in {1..10}; do
    if ! kill -0 $dev_pid 2>/dev/null; then
      exit 0
    fi
    sleep 1
  done
  kill -KILL -$dev_pid 2>/dev/null
}

mkdir -p "$state_dir"

case "${1:-}" in
  install)
    install_app
    ;;
  supervise)
    supervise
    ;;
  "")
    # Already running: bring the window forward instead of starting a second copy.
    if [[ -f $pid_file ]] && kill -0 "$(<"$pid_file")" 2>/dev/null; then
      if pgrep -f -- "$electron_pattern" >/dev/null; then
        open -b "$dev_bundle_id"
      else
        notify "Still starting…"
      fi
      exit 0
    fi

    : >"$log"
    nohup /bin/zsh "$0" supervise >>"$log" 2>&1 &!
    ;;
  *)
    echo "usage: zsh scripts/dev-app.sh [install]" >&2
    exit 1
    ;;
esac
