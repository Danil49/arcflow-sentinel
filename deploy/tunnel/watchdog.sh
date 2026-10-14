#!/usr/bin/env sh
# Tunnel watchdog for the home server (docs/self-hosting-ssh.md, Stage 7).
# Checks the public site end to end (VPS -> tunnel -> app). After 3 consecutive failures it
# restarts frpc, and restarts the app containers if the app itself is not answering locally.
# Run every minute by tunnel-watchdog.timer.
set -u
URL="${SENTINEL_PUBLIC_URL:?set SENTINEL_PUBLIC_URL, e.g. https://sentinel.example.com}"
STATE=/var/lib/sentinel-watchdog/failures
APP_DIR="${SENTINEL_APP_DIR:-/opt/arcflow-sentinel}"
mkdir -p "$(dirname "$STATE")"

if curl -fsS -m 10 -o /dev/null "$URL/api/health/live"; then
  echo 0 > "$STATE"
  exit 0
fi

n=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$STATE"
echo "public health check failed ($n in a row)"
[ "$n" -lt 3 ] && exit 0

if curl -fsS -m 5 -o /dev/null http://127.0.0.1:3000/api/health/live; then
  echo "app answers locally: restarting frpc"
  systemctl restart frpc
else
  echo "app not answering locally: restarting containers, then frpc"
  (cd "$APP_DIR" && docker compose -f compose.yaml -f compose.tunnel.yaml up -d) || true
  systemctl restart frpc
fi
echo 0 > "$STATE"
