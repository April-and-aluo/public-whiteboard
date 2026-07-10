#!/bin/bash
# ============================================
# auto-update.sh - 自动检测 GitHub 更新并部署
# 放置在服务器 ~/wb/auto-update.sh
# 配合 crontab 每 2 分钟检查一次
# ============================================

REPO_OWNER="april-and-aluo"
REPO_NAME="public-whiteboard"
BRANCH="main"
WORK_DIR="$HOME/wb"
PUBLIC_DIR="$WORK_DIR/public"
STATE_FILE="$WORK_DIR/.last-commit-hash"
LOG_FILE="$WORK_DIR/update.log"

# 需要同步的前端文件
FRONTEND_FILES=(
  "src/main.js"
  "src/yjs-sync.js"
  "src/canvas-engine.js"
  "src/index.html"
  "src/styles.css"
  "src/config.js"
  "src/cursor-layer.js"
  "src/export.js"
  "announcement.json"
)

# 需要同步的服务器文件
SERVER_FILES=(
  "server/combined.js"
)

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

# 获取 GitHub 最新 commit hash
# 优先使用 jsDelivr API（不限流），回退到 GitHub API（带认证）
AUTH_HEADER=""
if [ -n "$GH_TOKEN" ]; then
  AUTH_HEADER="-H \"Authorization: token ${GH_TOKEN}\""
fi

# 方法1: 通过 jsDelivr API 获取最新版本（不消耗 GitHub API 配额）
LATEST_HASH=$(curl -s "https://data.jsdelivr.com/v1/packages/gh/${REPO_OWNER}/${REPO_NAME}/resolved" 2>/dev/null | grep -o '"version":"[^"]*"' | head -1 | cut -d'"' -f4)

# 方法2: 如果 jsDelivr 失败，回退到 GitHub API
if [ -z "$LATEST_HASH" ]; then
  LATEST_HASH=$(curl -s ${AUTH_HEADER} "https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/commits/${BRANCH}" | grep '"sha"' | head -1 | cut -d'"' -f4)
fi

if [ -z "$LATEST_HASH" ]; then
  log "ERROR: 无法获取 GitHub commit hash"
  exit 1
fi

# 读取上次记录的 hash
LAST_HASH=""
if [ -f "$STATE_FILE" ]; then
  LAST_HASH=$(cat "$STATE_FILE")
fi

# 比较是否有更新
if [ "$LATEST_HASH" = "$LAST_HASH" ]; then
  # 无更新，静默退出
  exit 0
fi

log "检测到新更新: $LAST_HASH -> $LATEST_HASH"

# 下载前端文件到 public 目录
UPDATED=0
for file in "${FRONTEND_FILES[@]}"; do
  filename=$(basename "$file")
  url="https://cdn.jsdelivr.net/gh/${REPO_OWNER}/${REPO_NAME}@${LATEST_HASH}/${file}"
  
  # 如果是前端 src/ 下的文件，放到 public/
  if [[ "$file" == src/* ]]; then
    target="$PUBLIC_DIR/$filename"
  elif [[ "$file" == announcement.json ]]; then
    target="$PUBLIC_DIR/$filename"
  else
    target="$PUBLIC_DIR/$filename"
  fi
  
  curl -sL "$url" > "$target.tmp" 2>/dev/null
  if [ -s "$target.tmp" ]; then
    mv "$target.tmp" "$target"
    log "  更新: $file -> $target"
    UPDATED=$((UPDATED + 1))
  else
    rm -f "$target.tmp"
    log "  WARN: 下载失败 $file"
  fi
done

# 下载服务器文件
for file in "${SERVER_FILES[@]}"; do
  filename=$(basename "$file")
  url="https://cdn.jsdelivr.net/gh/${REPO_OWNER}/${REPO_NAME}@${LATEST_HASH}/${file}"
  target="$WORK_DIR/server.js"
  
  curl -sL "$url" > "$target.tmp" 2>/dev/null
  if [ -s "$target.tmp" ]; then
    mv "$target.tmp" "$target"
    log "  更新: $file -> $target"
    UPDATED=$((UPDATED + 1))
  else
    rm -f "$target.tmp"
    log "  WARN: 下载失败 $file"
  fi
done

# 更新 hash 记录
echo "$LATEST_HASH" > "$STATE_FILE"

if [ $UPDATED -gt 0 ]; then
  log "共更新 $UPDATED 个文件，重启服务..."
  sudo systemctl restart whiteboard
  log "服务已重启"
else
  log "无文件需要更新"
fi
