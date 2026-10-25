#!/usr/bin/env bash
# WorkBuddy 每日签到启动器（Git Bash / WSL / 标准 bash）
# 自动定位 node：优先 WorkBuddy 托管 node，否则 PATH 上的 node
# 使用 POSIX 路径（/c/Users/...），避免反斜杠在 shell 中被当作转义符。
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHECKIN_JS="$SCRIPT_DIR/checkin.js"

NODE_BIN=""
# 1) WorkBuddy 托管 node（任意版本目录，不写死版本号）
if [ -n "${HOME:-}" ]; then
  for d in "$HOME"/.workbuddy/binaries/node/versions/*/; do
    if [ -x "${d}node.exe" ]; then NODE_BIN="${d}node.exe"; break; fi
  done
  # 兜底：WSL 风格挂载 /mnt/c/...
  if [ -z "$NODE_BIN" ]; then
    for d in /mnt/c/Users/*/.workbuddy/binaries/node/versions/*/; do
      if [ -x "${d}node.exe" ]; then NODE_BIN="${d}node.exe"; break; fi
    done
  fi
fi
# 2) 兜底：PATH 上的 node
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi
if [ -z "$NODE_BIN" ]; then
  echo "[FAIL] 未找到 node：请安装 Node.js 或确认 WorkBuddy 已安装" >&2
  exit 5
fi

exec "$NODE_BIN" "$CHECKIN_JS" "$@"
