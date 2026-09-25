#!/usr/bin/env bash
set -euo pipefail

export DISPLAY="${DISPLAY:-:99}"
if [[ -z "${BROWSER_VNC_PASSWORD:-}" ]]; then
  echo 'Browser desktop disabled: set BROWSER_VNC_PASSWORD to enable browser-page clicking.'
  exec node src/server.js
fi

mkdir -p /tmp/runtime
Xvfb "$DISPLAY" -screen 0 1365x768x24 -nolisten tcp > /tmp/runtime/xvfb.log 2>&1 &
fluxbox > /tmp/runtime/fluxbox.log 2>&1 &

x11vnc -storepasswd "$BROWSER_VNC_PASSWORD" /tmp/runtime/vnc.pass >/dev/null
x11vnc -display "$DISPLAY" -rfbauth /tmp/runtime/vnc.pass -rfbport 5900 -forever -shared -localhost > /tmp/runtime/x11vnc.log 2>&1 &
websockify --web=/usr/share/novnc 6080 localhost:5900 > /tmp/runtime/novnc.log 2>&1 &

exec node src/server.js
