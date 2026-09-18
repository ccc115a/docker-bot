#!/bin/bash

# ./web.sh                 # 3000 被 Docker 佔了，你這台請用下面這行
# PORT=3100 ./web.sh       # 開 http://localhost:3100，直接彈瀏覽器
set -x

# 預設 3100：本機 3000 已被另一個 Docker 專案（選課系統）佔用
PORT="${PORT:-3100}"
PIDFILE="/tmp/docker-bot-web.pid"

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "web already running at http://localhost:${PORT}"
  [ -z "$NO_BROWSER" ] && open "http://localhost:${PORT}" || true
  exit 0
fi

curl -s --max-time 5 http://localhost:11434/api/tags > /dev/null \
  || echo "WARN: ollama not reachable; run ollama signin first"

# 網站版 shell 跑在 Docker 裡：先確保 shellbox 常駐容器在線
docker compose up -d shellbox 2>&1 | tail -n 2 \
  || echo "WARN: shellbox 啟動失敗，網站的 run_shell 會報錯"

node web/server.mjs &
echo $! > "$PIDFILE"

sleep 1
# 健康檢查要驗內容（不能只看 curl exit code，別人的服務也會回 200）
if ! curl -s --max-time 5 "http://localhost:${PORT}/api/models" | grep -q '"models"'; then
  echo
  echo "ERROR: port ${PORT} 上的不是我們的 server（3000 是選課系統的）；換個 PORT 再試：PORT=3100 ./web.sh"
  kill "$(cat "$PIDFILE")" 2>/dev/null || true
  rm -f "$PIDFILE"
  exit 1
fi
curl -s --max-time 5 "http://localhost:${PORT}/api/models" | head -c 300; echo

[ -z "$NO_BROWSER" ] && open "http://localhost:${PORT}" || true
echo "web running at http://localhost:${PORT} (pid $(cat "$PIDFILE")); stop with: kill $(cat "$PIDFILE")"
