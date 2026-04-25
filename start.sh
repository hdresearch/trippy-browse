#!/bin/bash
export PATH=/usr/local/bin:$PATH

echo "[start] Cleaning up..."
killall -9 Xvfb node nginx chrome google-chrome 2>/dev/null || true
sleep 1
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 /tmp/chrome-profile/SingletonLock

echo "[start] Starting Xvfb..."
Xvfb :99 -screen 0 1280x900x24 -ac -nolisten tcp &
sleep 1
export DISPLAY=:99

echo "[start] Starting nginx..."
cp /app/nginx.conf /etc/nginx/sites-available/default
nginx -t 2>&1
service nginx start 2>&1 || nginx 2>&1 || true

echo "[start] Starting Chrome..."
mkdir -p /tmp/chrome-profile
google-chrome-stable \
  --no-sandbox --disable-gpu \
  --enable-features=CanvasDrawElement \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-profile \
  --window-size=1280,900 \
  --no-first-run --disable-default-apps \
  --disable-background-networking --disable-sync \
  --disable-translate --disable-extensions \
  --kiosk --disable-infobars --test-type \
  about:blank > /dev/null 2>&1 &
sleep 3

echo "[start] Starting control server..."
cd /app && node control-server.js > /tmp/control-server.log 2>&1 &
CTRL_PID=$!
sleep 2

echo "[start] All running. PID=$CTRL_PID"
wait $CTRL_PID 2>/dev/null
